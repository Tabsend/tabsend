import type { ServerStreamEvent } from '@tabsend/shared'
import { setAuthorizedHandler, setUnauthorizedHandler } from '../lib/api'
import { ready as cryptoReady } from '../lib/crypto'
import { ext } from '../lib/ext'
import type { RpcRequest, RpcResponse } from '../lib/model'
import { IS_FIREFOX } from '../lib/platform'
import { clearAuthWarning, getUnreadReceived } from '../lib/storage'
import { registerUnreadBadgeSync, setUnreadBadge } from './badge'
import { firefoxReconnect, refreshFirefoxWs, startFirefoxWake } from './fxwake'
import { registerRelayHealthTracking } from './health'
import { heartbeatNow } from './heartbeat'
import { refreshHistory } from './history'
import { handleAuthRejection } from './identity'
import { handleMenuClick, rebuildMenus } from './menus'
import { registerNotificationClickHandler } from './notify'
import { currentWsConfig, ensureOffscreen, isNeedConfig } from './offscreen'
import { ensurePushSubscription, registerPushListener } from './push'
import { flushUndo, quickSend, undoSend } from './quicksend'
import { pollPending } from './receive'
import { afterReset, handleRpc } from './rpc'
import { clearRetryAlarm, ensurePollAlarm, POLL_ALARM, RETRY_ALARM } from './scheduler'
import { processOutbound } from './send'
import { currentSession } from './session'
import { applyToolbarMode } from './settings'
import { handleStreamEvent, registerChooserPort } from './stream'

/**
 * Platform split (transport spike). Chrome: Web Push wakes the suspended SW + an
 * offscreen document holds the fast-path WS. Firefox: NO Push API, NO offscreen —
 * the event page holds the WS itself and wakes on alarms + user-activity events.
 * Both funnel through the one idempotent deliver loop in receive.ts. The dead
 * branch tree-shakes out per build via the `__TABSEND_PLATFORM__` define.
 */

/**
 * MV3 service worker entry. Listeners are registered synchronously at top level
 * (an MV3 requirement — the SW is re-run from scratch on every wake and Chrome
 * only re-delivers events to listeners registered in the first turn).
 *
 * Receive model (Chunk 4): real Web Push wakes the SW (push handler pulls
 * pending); an offscreen-document WebSocket delivers instantly while foreground;
 * boot/alarm/popup polls are the always-on backstop. Every path funnels through
 * the one idempotent deliver loop in receive.ts, so nothing double-opens.
 */

// --- wake channel (registered synchronously — MV3/event-page requirement) ---
if (IS_FIREFOX) {
  startFirefoxWake() // event page holds the WS + wakes on tab/window activity
} else {
  registerPushListener() // Chrome: Web Push tickles the SW
}

// --- relay reachability ------------------------------------------------------
// Registered before anything can make a call, so the very first failure of a
// cold boot is recorded rather than lost. Every authenticated call votes.
registerRelayHealthTracking()

// --- received-tab indicator [P-7 addendum] ------------------------------
// The badge stays correct even when a page (not this SW) is the one that
// clears it — see inbox.ts, which writes storage directly.
registerUnreadBadgeSync()
registerNotificationClickHandler()

// --- removed-from-group detection ---------------------------------------
// Any authenticated call (heartbeat, poll, send, rename, …) can discover the
// relay is refusing our token. Only a DEFINITIVE removal resets local state the
// way a relay switch does; an ambiguous 401 is held (see identity.ts).
// Mirror of the warning flag, so the common case (every call succeeding) costs
// no storage writes — we only touch it on an actual transition.
let authWarned = false
setAuthorizedHandler(() => {
  if (!authWarned) return
  authWarned = false
  void clearAuthWarning()
})
setUnauthorizedHandler((definitive) => {
  if (!definitive) authWarned = true
  // Only a proven removal resets local state; an unrecognised token is held so a
  // relay that comes back to itself (restart, restore) finds the pairing intact.
  void handleAuthRejection(definitive).then(afterReset)
})

// --- messages: RPC from pages, AND forwarded WS events from the offscreen doc -
interface WsEnvelope {
  __tabsendWs: true
  event: ServerStreamEvent
}
function isWsEnvelope(message: unknown): message is WsEnvelope {
  return typeof message === 'object' && message !== null && '__tabsendWs' in message
}

/** The in-page toast's "Undo" button messages this to cancel the armed send. */
function isUndoMessage(message: unknown): message is { __tabsendUndo: true; id: string } {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as { __tabsendUndo?: boolean }).__tabsendUndo === true
  )
}

ext.runtime.onMessage.addListener(
  (message: unknown, sender, sendResponse: (r: unknown) => void) => {
    if (isWsEnvelope(message)) {
      void handleStreamEvent(message.event)
      return false // no response channel needed
    }
    if (isUndoMessage(message)) {
      // Only from the tab the banner was drawn on (L8): `sender.tab` is set by
      // the browser, not by the page.
      void undoSend(message.id, sender.tab?.id)
      return false
    }
    if (isNeedConfig(message)) {
      // The offscreen doc can't read storage — hand it the relay/token config.
      void currentWsConfig().then((config) => sendResponse({ config }))
      return true
    }
    void handleRpc(message as RpcRequest).then((r: RpcResponse) => sendResponse(r))
    return true // keep the channel open for the async response
  },
)

// --- toolbar icon click (Quick-send mode; no-op in Chooser mode where the
// popup opens instead) + hotkeys (ADR-0008 §2.2/§2.5) -------------------------
ext.action?.onClicked?.addListener(() => {
  void quickSend()
})
ext.commands?.onCommand?.addListener((command: string) => {
  // The "open chooser" hotkey is the native _execute_action (no listener needed).
  if (command === 'send-to-primary') void quickSend()
})

// --- live popup ports (presence/ack/endpoint changes refresh an open popup) --
ext.runtime.onConnect.addListener((port) => {
  if (port.name === 'chooser') registerChooserPort(port)
})

// --- install / boot ---------------------------------------------------------
ext.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    void ext.tabs.create({ url: ext.runtime.getURL('firstrun.html') })
  }
  void bootstrap()
})

// Fires on every browser start with the extension enabled.
ext.runtime.onStartup.addListener(() => {
  void bootstrap()
})

// --- alarms ------------------------------------------------------------------
ext.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === POLL_ALARM) {
    void pollPending()
    void processOutbound()
    void flushUndo() // durable fallback if the worker died inside an undo window
    void heartbeatNow()
    // Group history [ADR-0028]: collect keys, hand out copies, refresh the cached
    // timeline, and announce anything of ours that never arrived. Unawaited and
    // last — it is a record of what the product did, never a step of doing it.
    void refreshHistory().catch(() => undefined)
    if (IS_FIREFOX)
      firefoxReconnect() // spike §3b: alarm → reconnect (poll drains)
    else void ensureOffscreen()
    void rebuildMenus()
  } else if (alarm.name === RETRY_ALARM) {
    void processOutbound().then((remaining) => {
      if (!remaining) void clearRetryAlarm()
    })
  }
})

// --- context menus -----------------------------------------------------------
ext.contextMenus.onClicked.addListener((info, tab) => {
  void handleMenuClick(info, tab)
})

/**
 * Runs on every SW boot (top-level await is fine in a module SW; the listeners
 * above are already registered). Pull pending FIRST — a message may have arrived
 * while we were asleep (spike §6: pull on every boot, not only on push) — then
 * bring up the wake channels (real push subscription + offscreen WS) and rotate
 * the subscription to the relay via heartbeat.
 */
async function bootstrap(): Promise<void> {
  // Warm libsodium's runtime now rather than on the first seal. It initialises
  // lazily, and the only thing that reaches it is `seal()` — so the wait landed
  // between a chooser click and the POST it should have started, once per
  // service-worker lifetime. Unawaited: nothing here depends on it, and a send
  // arriving first simply awaits the same promise.
  void cryptoReady().catch(() => undefined)
  await ensurePollAlarm()
  const session = await currentSession()
  if (!session) {
    await applyToolbarMode() // still reflect the icon setting when unregistered
    setUnreadBadge(await getUnreadReceived()) // a fresh SW starts with no in-memory count
    return
  }
  // DELIVERY FIRST — the reliability-critical cold-boot path (spike §6). Nothing
  // cosmetic (toolbar mode, wake channels) may delay pulling a queued tab.
  await pollPending()
  await processOutbound()
  await flushUndo() // dispatch anything held past its undo window while we slept
  await applyToolbarMode() // reflect the saved Chooser/Quick-send setting on the icon
  // Re-prime the badge from storage too: pollPending() only touches it when THIS
  // pass delivered something new, and a fresh SW's in-memory count always starts
  // at 0 regardless of what was already unread from before it woke.
  setUnreadBadge(await getUnreadReceived())
  if (IS_FIREFOX) {
    await refreshFirefoxWs() // bring up the event-page WS with the current relay/token
  } else {
    await ensurePushSubscription()
  }
  await heartbeatNow()
  if (!IS_FIREFOX) await ensureOffscreen()
  await rebuildMenus()
  // Last, and unawaited: a boot that spent its time on group history instead of
  // on a queued tab would have the priorities backwards [ADR-0028].
  void refreshHistory().catch(() => undefined)
}

void bootstrap()
