import {
  type CreatePairingResponse,
  type IsoTimestamp,
  type SendPayload,
  vouchTags,
  withVouch,
} from '@tabsend/shared'
import { mintPairing } from '../lib/api'
import { ext } from '../lib/ext'
import type { PairingView, RpcRequest, RpcResponse } from '../lib/model'
import {
  classifyMintFailure,
  isLoopbackRelayUrl,
  pairingLinkRelayUrl,
  parsePairingInput,
} from '../lib/pairing'
import { IS_FIREFOX } from '../lib/platform'
import { getCachedEndpoints, getSettings } from '../lib/storage'
import { pairingErrorLine, pairingRoutesLine } from '../lib/strings'
import { clearBadge } from './badge'
import { buildChooserView, buildDevicesView } from './endpoints'
import { refreshFirefoxWs } from './fxwake'
import { dismissGroupReset, stopPendingGroupReset } from './groupreset'
import { resetRelayHealthCache } from './health'
import { heartbeatNow } from './heartbeat'
import { refreshHistory } from './history'
import {
  cancelSwitch,
  changeRelayUrl,
  createGroup,
  getState,
  joinGroup,
  probeOnboarding,
  probeRelay,
  removeEndpoint,
  renameEndpoint,
  resetRegistration,
  setDeviceName,
  switchToRelay,
} from './identity'
import { rebuildMenus } from './menus'
import {
  confirmNewDeviceNotice,
  confirmReviewAnswer,
  currentDeviceWatch,
  dismissVanishedNotice,
} from './newdevices'
import { ensureOffscreen, pushConfigToOffscreen } from './offscreen'
import { setPrimary } from './prefs'
import { ensurePushSubscription } from './push'
import { pollPending } from './receive'
import {
  cancelHeldTab,
  processOutbound,
  retargetHeldTab,
  selectedTabCount,
  sendToTarget,
} from './send'
import { currentSession } from './session'
import { updateSettings } from './settings'
import { dismissUnreachable } from './unreachable'

/**
 * The page <-> service-worker RPC. The popup and first-run pages are thin
 * views; every decision runs here in the SW so there is exactly one pipeline
 * (INTERACTION_FLOWS §1) regardless of surface.
 */
export async function handleRpc(req: RpcRequest): Promise<RpcResponse> {
  try {
    switch (req.type) {
      case 'getState': {
        return { ok: true, state: await getState() }
      }
      case 'createGroup': {
        const state = await createGroup(req.relayUrl, req.browserName, req.deviceName)
        await afterRegistration()
        return { ok: true, state }
      }
      case 'joinGroup': {
        const state = await joinGroup(req.relayUrl, req.code, req.browserName, req.vouched)
        await afterRegistration()
        return { ok: true, state }
      }
      case 'setDevice': {
        const state = await setDeviceName(req.deviceName)
        await rebuildMenus()
        return { ok: true, state }
      }
      case 'resetRegistration': {
        await resetRegistration()
        await afterReset()
        return { ok: true }
      }
      case 'getDevices': {
        return { ok: true, devices: await buildDevicesView() }
      }
      case 'renameEndpoint': {
        await renameEndpoint(req.endpointId, req.label)
        await rebuildMenus()
        return { ok: true }
      }
      case 'removeEndpoint': {
        await removeEndpoint(req.endpointId)
        await rebuildMenus()
        return { ok: true }
      }
      case 'confirmNewDevice': {
        await confirmNewDeviceNotice(req.endpointId)
        return { ok: true }
      }
      case 'confirmReview': {
        await confirmReviewAnswer()
        return { ok: true }
      }
      case 'dismissVanished': {
        await dismissVanishedNotice(req.endpointId)
        return { ok: true }
      }
      case 'dismissUnreachable': {
        await dismissUnreachable(req.endpointId)
        return { ok: true }
      }
      case 'stopGroupReset': {
        await stopPendingGroupReset()
        return { ok: true }
      }
      case 'dismissGroupReset': {
        await dismissGroupReset(req.requestedAt)
        return { ok: true }
      }
      case 'getChooser': {
        const chooser = await buildChooserView(req.cached ? { cached: true } : {})
        // Everything below is work the popup's render does NOT depend on, so it
        // must not sit in front of the response. `rebuildMenus` in particular
        // awaited a session read, a settings read, a `contextMenus.removeAll()`
        // and one `create()` per target — all of it between the chooser view
        // being ready and the popup being handed it.
        void rebuildMenus().catch(() => undefined)
        // The popup opening is a user-visible moment — drain anything pending NOW
        // (spike guidance: pull on every wake, and this is the cheapest wake we get).
        // Skipped on the cached pass: the networked one follows immediately.
        if (!req.cached) {
          void pollPending().catch(() => undefined)
          void processOutbound().catch(() => undefined)
          // The cheapest wake we get is also where group history catches up
          // [ADR-0028]: keys are collected and handed on, and the timeline the
          // footer's History button opens is already fresh when it opens.
          void refreshHistory().catch(() => undefined)
        }
        return { ok: true, chooser }
      }
      case 'getSelection': {
        // The chooser's variant-A banner: how many tabs a row click would send.
        return { ok: true, selection: { count: await selectedTabCount() } }
      }
      case 'sendTo': {
        // The chooser shows its own outcome panel, so the in-page banner goes up
        // alongside this response rather than in front of it.
        const send = await sendToTarget(req.targetEndpointId, undefined, { reportAsync: true })
        return { ok: true, send }
      }
      case 'sendAgain': {
        // The history page shows its own outcome, so the in-page banner goes up
        // alongside this response rather than in front of it.
        const send = await sendToTarget(req.targetEndpointId, resendPayload(req.payload), {
          reportAsync: true,
        })
        // A re-send is a new row in the group's history, so pick it up rather
        // than leaving the page showing only the failure it was started from.
        void refreshHistory().catch(() => undefined)
        return { ok: true, send }
      }
      case 'getSettings': {
        return { ok: true, settings: await getSettings() }
      }
      case 'setSettings': {
        return { ok: true, settings: await updateSettings(req.settings) }
      }
      case 'setPrimary': {
        await setPrimary(req.targetEndpointId, req.pinned)
        return { ok: true }
      }
      case 'mintPairing': {
        const session = await currentSession()
        // Every failure here is re-thrown as USER copy: the pages show whatever
        // message comes back verbatim, and a bare "Failed to fetch" tells the
        // user nothing about the relay being down.
        if (!session) throw new Error(pairingErrorLine({ kind: 'unregistered' }))
        const { registration } = session
        let res: CreatePairingResponse
        try {
          res = await mintPairing(registration.relayUrl, registration.deviceToken)
        } catch (err) {
          throw new Error(pairingErrorLine(classifyMintFailure(err, registration.relayUrl)))
        }
        // The devices this browser has accepted ride along in the link, so the new
        // device asks only about the ones that do not match (P-23). The relay
        // made the link but never sees what is added to its fragment.
        const tags = vouchTags(
          await currentDeviceWatch(),
          await getCachedEndpoints(),
          registration.endpointId,
        )
        const copyLink = withVouch(res.browserLink ?? res.link, tags)
        const parsed = parsePairingInput(copyLink)
        if (!parsed) throw new Error('The relay returned an invalid setup link.')
        const qrLink = withVouch(res.link, tags)
        const qrParsed = parsePairingInput(qrLink)
        if (!qrParsed) throw new Error('The relay returned an invalid QR setup link.')
        const qrRelayUrl = pairingLinkRelayUrl(qrLink)
        if (!qrRelayUrl) throw new Error('The relay returned an invalid QR pairing route.')
        const pairing: PairingView = {
          relayUrl: parsed.relayUrl,
          link: copyLink,
          qrLink,
          expiresAt: res.expiresAt,
          ...(parsed.relayUrl !== qrRelayUrl
            ? { routeNote: pairingRoutesLine(parsed.relayUrl, qrRelayUrl) }
            : {}),
          // The relay names its own address; an unconfigured dev relay names a
          // loopback one, and only the minting surface can say so in time.
          localOnly: isLoopbackRelayUrl(qrRelayUrl),
        }
        return { ok: true, pairing }
      }
      case 'probeRelay': {
        // Read-only by construction: identity.ts touches no storage here, so a
        // probe can be re-run freely and the UI can render the verdict before
        // asking for anything.
        return { ok: true, probe: await probeRelay(req.relayUrl) }
      }
      case 'switchToRelay': {
        // The "different relay" branch. Records where the user is heading and
        // nothing else: the current registration, its wake channels and its
        // outbound queue all stay up, because the move is not committed until
        // the new relay accepts this browser. No afterReset here — there is
        // nothing to tear down, and tearing down a live pairing to open a setup
        // screen is exactly the trap this replaced.
        await switchToRelay(req.relayUrl, req.pairingLink)
        return { ok: true, state: await getState() }
      }
      case 'cancelSwitch': {
        await cancelSwitch()
        return { ok: true, state: await getState() }
      }
      case 'changeRelayUrl': {
        // Same relay, new address [P-4]: identity.ts verifies the candidate and
        // commits only the URL; the wake channels then need re-pointing at it,
        // which is exactly what afterRegistration does (poll, WS/push, heartbeat,
        // offscreen config, menus) — reuse it.
        const relayChange = await changeRelayUrl(req.relayUrl)
        await afterRegistration()
        return { ok: true, relayChange }
      }
      case 'pollNow': {
        await pollPending()
        await processOutbound()
        return { ok: true }
      }
      case 'refreshHistory': {
        await refreshHistory()
        return { ok: true }
      }
      case 'probeOnboarding': {
        return { ok: true, onboarding: await probeOnboarding(req.relayUrl) }
      }
      case 'cancelHeld': {
        // Nothing is sent, nothing is withdrawn from the relay, and no wake
        // channel is touched: the tab is simply forgotten here. The chooser
        // re-renders from storage on its next open, and repaints the list itself
        // straight away, so this needs to answer nothing but "done".
        await cancelHeldTab(req.id)
        return { ok: true }
      }
      case 'retargetHeld': {
        // The tab is re-sealed for the new device and queued in the old one's
        // place. The drain then sends it, off the popup's path: with the relay
        // out of reach that is a wait, and the popup should not sit through it.
        const moved = await retargetHeldTab(req.id, req.targetEndpointId)
        if (moved) void processOutbound().catch(() => undefined)
        return { ok: true, moved }
      }
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Re-stamp a history payload for a fresh send [ADR-0028 §8].
 *
 * Two fields must not survive a re-send. `sentAt` is what every receiving client
 * renders as "sent 3m ago", and carrying a week-old stamp would make a tab that
 * just arrived look like one that had been queued for days. `batch` groups tabs
 * of ONE multi-tab send; re-sending one of them alone would promise a receiver a
 * batch of N that is never coming.
 */
function resendPayload(payload: SendPayload): SendPayload {
  const { batch: _batch, ...rest } = payload
  return { ...rest, sentAt: new Date().toISOString() as IsoTimestamp }
}

/**
 * After register/join: pull the endpoint list, bring up the wake channels (real
 * push subscription + offscreen WS), rotate the subscription to the relay, and
 * build menus right away.
 *
 * Push setup is started here and NOT awaited [ROADMAP, found 2026-10-01]. Chrome's
 * subscribe can stall for half a minute while the browser registers with its push
 * service, and the page that called this waited with it: "Pair this browser" did
 * nothing for 30 seconds. Nothing on the next screen needs push. Any authenticated
 * call already marks this browser online, and the offscreen socket and polling
 * deliver without it. The heartbeat after it carries the new subscription to the
 * relay; if the worker stops first, its next start runs the same setup (index.ts).
 */
async function afterRegistration(): Promise<void> {
  // The relay (or at least its address) just changed — any cached verdict is
  // about a different relay and must not leak into the new one's first render.
  resetRelayHealthCache()
  try {
    await pollPending()
  } catch {
    // non-fatal — the alarm retries
  }
  if (IS_FIREFOX) {
    // No push, no offscreen — point the event-page WS at the new registration.
    await refreshFirefoxWs()
    await heartbeatNow()
  } else {
    void ensurePushSubscription()
      .then(() => heartbeatNow())
      .catch(() => undefined)
    await ensureOffscreen()
    // The doc may predate this registration (or hold a stale relay) — refresh it.
    await pushConfigToOffscreen()
  }
  await rebuildMenus()
}

/**
 * After a registration is cleared (relay switch, or the relay telling us our
 * token is dead because another device removed us — see index.ts's
 * unauthorized handler): tear the wake channels down so nothing keeps
 * hammering the OLD relay with a now-invalid token, and drop all the
 * registered-state UI. The channels come back up on the next register/join
 * (afterRegistration) pointed at the new relay.
 */
export async function afterReset(): Promise<void> {
  if (IS_FIREFOX) {
    // No registration now → refreshFirefoxWs drops the event-page socket.
    await refreshFirefoxWs()
  } else {
    // Close the offscreen doc that holds the WS; ensureOffscreen recreates it
    // after the next registration.
    try {
      await ext.offscreen?.closeDocument?.()
    } catch {
      // No document open (or API absent) — nothing to close.
    }
  }
  resetRelayHealthCache()
  clearBadge()
  await rebuildMenus()
}
