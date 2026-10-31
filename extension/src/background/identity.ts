import {
  browserNameFromLabel,
  checkProtocol,
  detectBrowser,
  detectPlatform,
  endpointLabel,
  type NoPushSubscription,
  type RegisterRequest,
  type ServerConfigResponse,
  uniqueBrowserName,
} from '@tabsend/shared'
import {
  ApiClientError,
  deleteEndpoint,
  getConfig,
  listEndpoints,
  probeEndpoints,
  register,
  updateEndpoint,
} from '../lib/api'
import { generateKeyPair, keyId } from '../lib/crypto'
import type {
  Identity,
  PendingSwitch,
  Registration,
  RelayChangeResult,
  RelayProbe,
  StateView,
} from '../lib/model'
import { normalizeRelayUrl } from '../lib/relay-url'
import {
  clearAuthWarning,
  clearPendingPairingLink,
  clearPendingRelayUrl,
  clearRegistrationState,
  clearRemovedNotice,
  getIdentity,
  getLastRelayUrl,
  getPendingPairingLink,
  getPendingRelayUrl,
  getRegistration,
  getRemovedNotice,
  setAuthWarning,
  setIdentity,
  setLastRelayUrl,
  setPairingVouch,
  setPendingPairingLink,
  setPendingRelayUrl,
  setRegistration,
  setRemovedNotice,
  updateOutbound,
} from '../lib/storage'
import {
  DEVICE_LIMIT_LINE,
  NOT_REGISTERED_ERROR,
  relayChangeCopy,
  SETUP_DOCS_URL,
} from '../lib/strings'
import { relayHealth } from './health'
import { recordRemovedEndpoint } from './newdevices'

// No default relay URL: there is nothing sensible to default to. A relay is
// whichever one you run, and the old `http://localhost:8787` default shipped a
// loopback address — unreachable from every other device — as the app's own
// suggestion. First run asks, and the setup copy gives the examples.

/**
 * Registration itself carries no push subscription — a real one (if any) is
 * subscribed asynchronously afterward and rotated in via the heartbeat (see
 * ensurePushSubscription/heartbeatNow). `{transport:'none'}` is the wire shape
 * for "no wake channel yet, or ever" (ADR-0015, same as Android's default):
 * the relay's `wake()` no-ops on it and it never counts toward push_failures.
 * Until a real subscription lands, this endpoint is reached by the WS fast
 * path while a background page is alive, and by polling otherwise.
 */
const NO_PUSH: NoPushSubscription = { transport: 'none' }

/**
 * Turn a register/join failure into human copy (dogfood pass-1 #1). A raw
 * `fetch` rejection (relay unreachable) used to surface as "Failed to fetch";
 * name the relay and say what to do. A relay error envelope carries its own
 * human message already.
 *
 * The one code that does not: `limit_reached`, the device cap refusing this
 * browser a place in the group [0030]. It gets the client's own sentence,
 * because the fix is a thing to DO and the copy for it is a cross-client
 * decision, not the relay's to word differently on every deployment.
 */
function humanRegisterError(err: unknown, relayUrl: string): Error {
  if (err instanceof ApiClientError) {
    if (err.code === 'limit_reached') return new Error(DEVICE_LIMIT_LINE)
    return new Error(err.message)
  }
  if (err instanceof ProtocolMismatchError) return err
  return new Error(
    `Couldn't reach the relay at ${relayUrl}. Check the address and that the relay is running. Setup guide: ${SETUP_DOCS_URL}`,
  )
}

/**
 * The relay answered, and we can't talk to it. A distinct type so it survives
 * `humanRegisterError` with its own words: an incompatible relay is reachable by
 * definition, and describing it as unreachable sends the user to check the one
 * thing that is fine (dogfood 2026-07-26).
 */
export class ProtocolMismatchError extends Error {}

/**
 * Handshake before registering. Runs first because /v1/config is unauthenticated
 * and cheap, and because the alternative is discovering the mismatch halfway
 * through registration, where it looks like a malformed request instead.
 * Returns the config so callers can capture `relayId` (persisted alongside the
 * registration, it later lets an address change verify "same relay" [P-4]).
 */
async function assertProtocolCompatible(relayUrl: string): Promise<ServerConfigResponse> {
  const config = await getConfig(relayUrl)
  const check = checkProtocol(config)
  if (check.ok) return config
  throw new ProtocolMismatchError(
    check.stale === 'client'
      ? `This version of Tabsend is too old for that relay (extension speaks v${check.clientProtocol}, relay needs v${check.relayRequires}). Update the extension, then try again.`
      : `That relay is running an older version of Tabsend than this extension (relay speaks v${check.relayProtocol}, extension needs v${check.clientRequires}). Update the relay, then try again.`,
  )
}

/** Create the X25519 keypair once and reuse it for the life of the install. */
export async function ensureIdentity(): Promise<Identity> {
  const existing = await getIdentity()
  if (existing) return existing
  const kp = await generateKeyPair()
  const identity: Identity = {
    publicKey: kp.publicKey,
    privateKey: kp.privateKey,
    keyId: await keyId(kp.publicKey),
  }
  await setIdentity(identity)
  return identity
}

function baseRegisterRequest(
  identity: Identity,
  browserName: string,
  deviceName: string,
): RegisterRequest {
  const browser = detectBrowser()
  const platform = detectPlatform()
  const req: RegisterRequest = {
    label: endpointLabel(browserName, deviceName),
    kind: 'extension',
    browser,
    platform,
    pushSubscription: NO_PUSH,
    e2ePubkey: identity.publicKey,
  }
  if (deviceName) req.deviceName = deviceName
  return req
}

interface RegisterIds {
  endpointId: string
  groupId: string
  deviceToken: string
  /** The label the relay actually stored — set when its dedupe changed ours. */
  label?: string
}

/**
 * Give up the registration this browser is LEAVING, now that the new relay has
 * granted one. Called from `persistRegistration`, i.e. strictly after the
 * replacement exists.
 *
 * The order is the whole point. This used to run first, from `switchToRelay`, so
 * choosing a different relay unpaired the browser the moment it was chosen —
 * and abandoning the setup that followed left it on no relay at all, with the
 * settings page still advertising the group it had just been thrown out of
 * (dogfood 2026-08-05). Nothing is given up until something replaces it.
 *
 * Best-effort DELETE of the old endpoint so we don't linger as a ghost in the
 * old group; a relay that has gone away drops stale endpoints on its own. The
 * local wipe is what matters, and it clears exactly the relay-scoped keys
 * (tokens, prefs, cached endpoints, the outbound queue sealed to old-relay
 * keys), all of which mean nothing on the new relay.
 */
async function retirePrevious(previous: Registration): Promise<void> {
  try {
    await deleteEndpoint(previous.relayUrl, previous.deviceToken, previous.endpointId)
  } catch {
    // Old relay unreachable / token already gone — the local wipe still stands.
  }
  await setLastRelayUrl(previous.relayUrl)
  await clearRegistrationState()
}

async function persistRegistration(
  relayUrl: string,
  browserName: string,
  deviceName: string,
  req: RegisterRequest,
  res: RegisterIds,
  relayId?: string,
  vouched?: readonly string[],
): Promise<Registration> {
  // Read BEFORE anything is written: this is the registration being replaced,
  // and from here on the storage keys it owns are about to be reused.
  const previous = await getRegistration()
  if (previous) await retirePrevious(previous)
  // With no pairing to retire, tabs held under an earlier one can still be
  // queued: a send that failed just after an unpair is queued after its wipe.
  // Sealed for another group's devices, they must not be offered for sending
  // into this one (L4).
  else await updateOutbound(() => [])
  // The relay's label wins: it de-duplicates within the group (`uniqueLabel`), so
  // it may have stored something other than what we sent. Keeping our own copy
  // would show this browser one name while every other device sees another.
  const label = res.label ?? req.label
  const registration: Registration = {
    endpointId: res.endpointId,
    groupId: res.groupId,
    deviceToken: res.deviceToken,
    relayUrl,
    label,
    // On the JOIN path the provisional label IS the browser name (the device tie
    // comes later), so a relay-side rename there renamed the browser too.
    browserName: deviceName ? browserName : label,
    deviceName,
    kind: req.kind,
    browser: req.browser,
    platform: req.platform,
    registeredAt: new Date().toISOString(),
  }
  if (relayId) registration.relayId = relayId
  // The devices the pairing link vouched for (P-23). After the old pairing's state is
  // wiped and before this registration exists, so no list of it is judged without them.
  if (vouched && vouched.length > 0) {
    await setPairingVouch({ endpointId: res.endpointId, tags: [...vouched] })
  }
  await setRegistration(registration)
  // A fresh registration supersedes any "removed from your last group" notice,
  // and consumes the move that sent us here (if this run came from one) — both
  // the destination and the link that was carried along with it.
  await clearRemovedNotice()
  await clearPendingRelayUrl()
  await clearPendingPairingLink()
  return registration
}

/**
 * Ask a relay what onboarding it can still offer, BEFORE the user picks (ADR-0022).
 *
 * A single-group relay that already hosts its group cannot accept a "create"; offering
 * the choice anyway means the user picks the wrong one and meets a refusal after typing
 * two names. `acceptsNewGroups` is absent on relays predating the field — treated as
 * true, i.e. the old behaviour of offering both.
 *
 * Never throws: this only decides which affordances to show, and a relay we cannot reach
 * is a problem for the register call to report properly (with its own wording), not for
 * a hint to pre-empt.
 */
export async function probeOnboarding(relayUrl: string): Promise<{ canCreate: boolean }> {
  try {
    const config = await getConfig(normalizeRelayUrl(relayUrl))
    return { canCreate: config.acceptsNewGroups !== false }
  } catch {
    return { canCreate: true }
  }
}

/**
 * First run: create a brand-new device group. The user has named the browser
 * AND the device (no existing devices to select).
 */
export async function createGroup(
  relayUrl: string,
  browserName: string,
  deviceName: string,
): Promise<StateView> {
  relayUrl = normalizeRelayUrl(relayUrl)
  const identity = await ensureIdentity()
  const req = baseRegisterRequest(identity, browserName, deviceName)
  let res: RegisterIds
  let config: ServerConfigResponse
  try {
    config = await assertProtocolCompatible(relayUrl)
    res = await register(relayUrl, req)
  } catch (err) {
    throw humanRegisterError(err, relayUrl)
  }
  await clearAuthWarning()
  await persistRegistration(relayUrl, browserName, deviceName, req, res, config.relayId)
  return getState()
}

/**
 * Join an existing group. The device tie is chosen AFTER auth (setDeviceName),
 * because the list of existing devices can only be fetched once in the group —
 * so we register with a provisional label of just the browser name.
 */
export async function joinGroup(
  relayUrl: string,
  code: string,
  browserName: string,
  vouched?: readonly string[],
): Promise<StateView> {
  relayUrl = normalizeRelayUrl(relayUrl)
  const identity = await ensureIdentity()
  const req: RegisterRequest = {
    ...baseRegisterRequest(identity, browserName, ''),
    pairingCode: code as RegisterRequest['pairingCode'],
  }
  let res: RegisterIds
  let config: ServerConfigResponse
  try {
    config = await assertProtocolCompatible(relayUrl)
    res = await register(relayUrl, req)
  } catch (err) {
    throw humanRegisterError(err, relayUrl)
  }
  await clearAuthWarning()
  await persistRegistration(relayUrl, browserName, '', req, res, config.relayId, vouched)
  return getState()
}

/**
 * Set (or change) this endpoint's device tie after join. Recomputes the label
 * from the stored browser name, patches the relay, and updates local state.
 *
 * This is also the ONE moment where a collision can be detected and fixed
 * without asking the user anything: the device tie is the last unknown, and we
 * are in the group, so the other endpoints are readable. A browser we couldn't
 * identify falls back to a shared guess, so two of them on one machine would
 * otherwise both land as the same label — we quietly become "<name> 2" instead
 * and the page says so. A relay read that fails is not fatal: a duplicate name
 * is cosmetic, a blocked setup is not, so we proceed with the name as typed.
 */
export async function setDeviceName(deviceName: string): Promise<StateView> {
  const reg = await getRegistration()
  if (!reg) throw new Error(NOT_REGISTERED_ERROR)

  let browserName = reg.browserName
  try {
    const others = await listEndpoints(reg.relayUrl, reg.deviceToken)
    browserName = uniqueBrowserName(
      browserName,
      deviceName,
      others.filter((e) => e.id !== reg.endpointId).map((e) => e.label),
    )
  } catch {
    // Offline or relay hiccup — keep the typed name; the user can rename later.
  }

  let label = endpointLabel(browserName, deviceName)
  try {
    // The relay de-duplicates too, and its view is the complete one — adopt what
    // it stored rather than what we asked for.
    const stored = await updateEndpoint(reg.relayUrl, reg.deviceToken, reg.endpointId, {
      label,
      deviceName,
    })
    if (stored?.label && stored.label !== label) {
      label = stored.label
      browserName = browserNameFromLabel(label)
    }
  } catch (err) {
    throw humanRegisterError(err, reg.relayUrl)
  }
  await setRegistration({ ...reg, browserName, label, deviceName })
  return getState()
}

/** Rename ANY endpoint in the group by free label (dogfood pass-2 #1). */
export async function renameEndpoint(endpointId: string, label: string): Promise<void> {
  const reg = await getRegistration()
  if (!reg) throw new Error(NOT_REGISTERED_ERROR)
  const clean = label.trim()
  if (!clean) throw new Error('A device needs a name.')
  const stored = await updateEndpoint(reg.relayUrl, reg.deviceToken, endpointId, { label: clean })
  // Keep the local self label in step when we renamed ourselves — using the
  // relay's label, which its dedupe may have suffixed.
  if (endpointId === reg.endpointId) {
    const effective = stored?.label || clean
    await setRegistration({
      ...reg,
      label: effective,
      browserName: browserNameFromLabel(effective),
    })
  }
}

/** Remove an endpoint from the group. */
export async function removeEndpoint(endpointId: string): Promise<void> {
  const reg = await getRegistration()
  if (!reg) throw new Error(NOT_REGISTERED_ERROR)
  try {
    await deleteEndpoint(reg.relayUrl, reg.deviceToken, endpointId)
  } catch (err) {
    // "Not found" means it is already gone, which is what was asked for: the same
    // reading the phones take. Anything else may have left it in the group.
    if (!(err instanceof ApiClientError && err.status === 404)) throw err
  }
  // The relay said yes; only the relay says the device is gone. Record the removal
  // here rather than waiting for a list to show it, so a relay that keeps the device
  // listed cannot keep it on the history key (SECURITY_REVIEW X13).
  await recordRemovedEndpoint(reg.endpointId, endpointId)
}

/**
 * The relay PROVED this endpoint was removed from its group (`endpoint_removed`).
 * It is already gone server-side, so there's nothing left to delete; drop the
 * local relay-scoped state (same wipe as resetRegistration) and remember why, so
 * onboarding can say what happened instead of this install quietly failing every
 * send/poll forever. Idempotent: a second rejection arriving before the first
 * wipe lands is a no-op (no registration left to clear).
 *
 * Only ever call this for a DEFINITIVE removal — see `handleAuthRejection`.
 */
export async function handleRemoval(): Promise<void> {
  const reg = await getRegistration()
  if (!reg) return
  await setLastRelayUrl(reg.relayUrl)
  await setRemovedNotice(true)
  await clearRegistrationState()
}

/**
 * An authenticated call came back 401. Whether that means anything destructive
 * depends entirely on WHY.
 *
 * `endpoint_removed` is proof: another device kicked this one out, and keeping
 * the registration would just fail forever. A bare `unauthorized` is not proof —
 * it is equally what a relay says after being restarted on an empty database or
 * restored from a backup, and this install used to unpair itself and destroy its
 * outbound queue on exactly that (dogfood 2026-07-26). So hold everything,
 * surface it, and let the retry succeed once the relay is itself again. Nothing
 * is lost by waiting; re-pairing is manual work, and on a phone it can be
 * impossible without a second device to hand.
 *
 * `token` is the one that was refused. A refusal of any OTHER token is about a
 * pairing this browser already gave up: moving relays retires the old endpoint,
 * and a poll or heartbeat sent to the old relay just before the move comes back
 * "removed" just after it. Acting on that wiped the NEW pairing mid-setup, and
 * the device step failed with "not registered" (dogfood 2026-10-30).
 */
export async function handleAuthRejection(definitive: boolean, token: string): Promise<void> {
  const reg = await getRegistration()
  if (!reg || reg.deviceToken !== token) return
  if (definitive) {
    await handleRemoval()
    return
  }
  await setAuthWarning(true)
}

/**
 * Unpair outright: leave the group and keep no relay at all. The relay URL isn't
 * a setting we can just edit — the device token/endpoint/group are all issued by
 * the current relay and mean nothing on another — so this drops every
 * relay-scoped bit of local state (keeping the device keypair + settings) and
 * remembers the old URL so onboarding can offer it back. Best-effort DELETE of
 * our own endpoint first so we don't linger as a ghost in the old group; ignored
 * if the relay is already unreachable.
 *
 * NOT the relay-move path any more. Moving is `switchToRelay` (record) plus
 * `retirePrevious` (give up, once the new relay has accepted), which never
 * leaves the browser with nothing.
 */
export async function resetRegistration(): Promise<void> {
  const reg = await getRegistration()
  // An unpair ends any move in progress either way: there is no longer a
  // registration for it to replace, and the destination is not what was asked for.
  await cancelSwitch()
  if (!reg) return
  try {
    await deleteEndpoint(reg.relayUrl, reg.deviceToken, reg.endpointId)
  } catch {
    // Old relay unreachable / token already gone — the local wipe below is what
    // matters; the old relay drops stale endpoints on its own.
  }
  await setLastRelayUrl(reg.relayUrl)
  await clearRegistrationState()
}

/**
 * Classify an address the user typed, WITHOUT touching anything: is this our own
 * relay at a new URL, or a different relay entirely?
 *
 * This is the whole point of the merged relay flow. The extension can already tell
 * the two apart — `relayId` plus an authenticated probe is proof — so it must not
 * make the user classify their own situation from a paragraph of explanation and
 * then punish a wrong guess with an error. Ask once, detect, and name what was
 * found (dogfood 2026-07-29: moving a dev relay to a mini PC read as broken rather
 * than mis-routed, because the UI put the taxonomy before the answer).
 *
 * Verdicts map 1:1 to what the UI can offer next:
 *   same        → "switch" (commit via changeRelayUrl; devices stay paired)
 *   different   → "start fresh here" (re-register; every device re-pairs)
 *   unreachable → nothing to offer but a re-check
 *   error       → a relay that answered and still can't be used (protocol, 5xx)
 */
export async function probeRelay(input: string): Promise<RelayProbe> {
  const reg = await getRegistration()
  if (!reg) throw new Error(NOT_REGISTERED_ERROR)
  const relayUrl = normalizeRelayUrl(input)

  let config: ServerConfigResponse
  try {
    // Protocol first: a relay too old/new to talk to is neither "yours" nor a
    // usable destination, and finding that out AFTER re-pairing would be cruel.
    config = await assertProtocolCompatible(relayUrl)
  } catch (err) {
    if (err instanceof ProtocolMismatchError)
      return { verdict: 'error', relayUrl, detail: err.message }
    return { verdict: 'unreachable', relayUrl }
  }

  // Provably not ours — don't even send the token to it.
  if (reg.relayId && config.relayId && reg.relayId !== config.relayId) {
    return { verdict: 'different', relayUrl }
  }

  try {
    await probeEndpoints(relayUrl, reg.deviceToken)
  } catch (err) {
    if (err instanceof ApiClientError && err.status === 401)
      return { verdict: 'different', relayUrl }
    if (err instanceof ApiClientError) return { verdict: 'error', relayUrl, detail: err.message }
    return { verdict: 'unreachable', relayUrl }
  }

  // `verified` false ⇒ one side predates relayId, so identity rests on the token
  // check alone. Still "same", with a caveat the UI states rather than hides.
  return { verdict: 'same', relayUrl, verified: Boolean(reg.relayId && config.relayId) }
}

/**
 * Begin a move to a relay the user has just chosen. RECORDS the destination; it
 * does not leave anything. The current registration survives untouched until the
 * new relay grants one (`persistRegistration` → `retirePrevious`), so this is
 * reversible right up to that moment and `cancelSwitch` is a complete undo.
 *
 * It used to unpair here, immediately, on the reasoning that a token issued by one
 * relay means nothing on another — true, but it made an intention cost a pairing.
 * A user who opened setup, saw it wanted a link they no longer had, and closed the
 * tab was left on no relay at all (dogfood 2026-08-05).
 *
 * The two carried values are the hand-off to onboarding: the address they typed,
 * and the pairing link they pasted, when what they pasted was a complete one. The
 * settings field normalizes a link down to its base URL, so passing only the
 * address here would throw away the credentials the very next screen asks for.
 */
export async function switchToRelay(input: string, pairingLink?: string): Promise<void> {
  const relayUrl = normalizeRelayUrl(input)
  await setPendingRelayUrl(relayUrl)
  if (pairingLink) {
    await setPendingPairingLink(pairingLink)
  } else {
    // A move started without a link must not inherit the last one: it would
    // pre-fill credentials for a relay the user is no longer heading to.
    await clearPendingPairingLink()
  }
}

/**
 * Abandon a move that was started and not finished. Nothing was given up to
 * start it, so there is nothing to restore — dropping the destination is the
 * whole undo, and a still-registered browser simply carries on where it was.
 */
export async function cancelSwitch(): Promise<void> {
  await clearPendingRelayUrl()
  await clearPendingPairingLink()
}

/**
 * The move recorded by `switchToRelay`, if one is outstanding. Suppressed when it
 * names the relay already in use: that is a move that finished (or was undone by
 * the address itself changing), and offering to "continue" it would send the user
 * to re-pair with the relay they are happily on.
 */
async function pendingSwitch(currentRelayUrl?: string): Promise<PendingSwitch | undefined> {
  const relayUrl = await getPendingRelayUrl()
  if (!relayUrl || relayUrl === currentRelayUrl) return undefined
  const pairingLink = await getPendingPairingLink()
  return { relayUrl, ...(pairingLink ? { pairingLink } : {}) }
}

/**
 * Change the relay ADDRESS in place — same relay instance, new URL (DHCP lease,
 * LAN → tunnel, domain move) — without the re-pair that `resetRegistration`
 * costs [P-4]. Storage is only touched after the candidate URL proves itself:
 *   1. it answers /v1/config (unreachable ⇒ nothing changed);
 *   2. its relayId matches ours, when BOTH sides have one (mismatch ⇒ it's a
 *      different relay ⇒ refuse);
 *   3. it recognises our device token on an authenticated call (401 ⇒ refuse).
 * `verified` is false when a relayId was absent on either side — the token
 * check still passed, so the UI shows a soft caveat, not an error.
 *
 * The caller (rpc.ts) re-points the wake channels after this commits.
 */
export async function changeRelayUrl(input: string): Promise<RelayChangeResult> {
  const reg = await getRegistration()
  if (!reg) throw new Error(NOT_REGISTERED_ERROR)
  const relayUrl = normalizeRelayUrl(input)

  let config: ServerConfigResponse
  try {
    config = await getConfig(relayUrl)
  } catch {
    throw new Error(relayChangeCopy.unreachable(relayUrl))
  }

  if (reg.relayId && config.relayId && reg.relayId !== config.relayId) {
    throw new Error(relayChangeCopy.differentRelay())
  }

  // Authenticated proof: a relay that mints different tokens can't fake this.
  try {
    await probeEndpoints(relayUrl, reg.deviceToken)
  } catch (err) {
    if (err instanceof ApiClientError && err.status === 401) {
      throw new Error(relayChangeCopy.tokenRejected())
    }
    if (err instanceof ApiClientError) {
      throw new Error(relayChangeCopy.probeFailed(err.message))
    }
    throw new Error(relayChangeCopy.unreachable(relayUrl))
  }

  const verified = Boolean(reg.relayId && config.relayId)
  const next: Registration = { ...reg, relayUrl }
  // Backfill the id when the relay gained one since we registered.
  if (config.relayId) next.relayId = config.relayId
  await setRegistration(next)
  return { relayUrl, verified }
}

/**
 * The snapshot the first-run / popup pages render from.
 *
 * Unregistered, the relay field starts EMPTY unless the user is mid-move. It used
 * to be pre-filled with the previous relay, or the dev default
 * `http://localhost:8787` on a fresh install — both wrong as defaults: the previous
 * relay is the one address you just chose to leave, and a loopback URL is a relay no
 * other device can reach, presented as the app's own recommendation (dogfood
 * 2026-07-29). Two carried values, deliberately not equal in weight:
 *   pendingRelayUrl  → PRE-FILLED. Just typed in settings; arriving here is the
 *                      second half of that action, not a new decision.
 *   previousRelayUrl → offered as a "use it again" click. Leaving it was the point.
 */
export async function getState(): Promise<StateView> {
  const registration = await getRegistration()
  if (!registration) {
    const pending = await pendingSwitch()
    const previousRelayUrl = await getLastRelayUrl()
    const removedNotice = (await getRemovedNotice()) ?? false
    return {
      registered: false,
      relayUrl: pending?.relayUrl ?? '',
      ...(previousRelayUrl ? { previousRelayUrl } : {}),
      ...(removedNotice ? { removedNotice } : {}),
      ...(pending ? { pendingSwitch: pending } : {}),
    }
  }
  const view: StateView = {
    registered: true,
    relayUrl: registration.relayUrl,
    endpointId: registration.endpointId,
    groupId: registration.groupId,
    selfLabel: registration.label,
    browserName: registration.browserName,
    deviceName: registration.deviceName,
  }
  if (registration.registeredAt) view.registeredAt = registration.registeredAt
  // A registered browser can be mid-move: the destination is recorded, the
  // current pairing is intact, and both surfaces need to say so.
  const pending = await pendingSwitch(registration.relayUrl)
  if (pending) view.pendingSwitch = pending
  // The options page shows the relay address; without this it showed it exactly
  // the same way whether the relay was answering or had been dead for an hour.
  const health = await relayHealth()
  if (health) view.relay = health
  return view
}
