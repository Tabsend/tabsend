import type {
  ClientSettings,
  Endpoint,
  GroupKeyRecord,
  NewDeviceWatch,
  PushSubscription,
  SourcePrefs,
} from '@tabsend/shared'
import { DEFAULT_CLIENT_SETTINGS } from '@tabsend/shared'
import { ext } from './ext'
import type { RelayHealth } from './health'
import type {
  HistoryRow,
  Identity,
  InboxItem,
  OutboundItem,
  PendingUndo,
  Registration,
  SeenMessage,
} from './model'

/**
 * Typed accessors over ext.storage.local. Every persistent bit of the
 * extension lives here behind a named key.
 */

const KEYS = {
  identity: 'identity',
  registration: 'registration',
  prefs: 'prefs',
  seen: 'seen',
  inbox: 'inbox',
  unreadReceived: 'unreadReceived',
  outbound: 'outbound',
  endpoints: 'endpointsCache',
  endpointsAt: 'endpointsCacheAt',
  newDeviceWatch: 'newDeviceWatch',
  pushSubscription: 'pushSubscription',
  pushVapidKey: 'pushVapidKey',
  settings: 'settings',
  settingsVersion: 'settingsVersion',
  pendingUndo: 'pendingUndo',
  lastRelayUrl: 'lastRelayUrl',
  pendingRelayUrl: 'pendingRelayUrl',
  pendingPairingLink: 'pendingPairingLink',
  removedNotice: 'removedNotice',
  authWarning: 'authWarning',
  relayHealth: 'relayHealth',
  groupKeys: 'groupKeys',
  groupKeysDelivered: 'groupKeysDelivered',
  history: 'history',
  historyAnnounced: 'historyAnnounced',
  historyUnsupportedAt: 'historyUnsupportedAt',
} as const

/** Keep opened-message ids around for twice the default TTL, then prune. */
export const SEEN_RETENTION_MS = 14 * 24 * 60 * 60 * 1000

async function get<T>(key: string): Promise<T | undefined> {
  const bag = await ext.storage.local.get(key)
  return bag[key] as T | undefined
}

async function set(key: string, value: unknown): Promise<void> {
  await ext.storage.local.set({ [key]: value })
}

async function remove(keys: string[]): Promise<void> {
  await ext.storage.local.remove(keys)
}

export const getIdentity = () => get<Identity>(KEYS.identity)
export const setIdentity = (v: Identity) => set(KEYS.identity, v)

export const getRegistration = () => get<Registration>(KEYS.registration)
export const setRegistration = (v: Registration) => set(KEYS.registration, v)

export async function getPrefs(): Promise<SourcePrefs> {
  return (
    (await get<SourcePrefs>(KEYS.prefs)) ?? {
      primaryTargetId: null,
      primaryPinned: false,
      recentTargetIds: [],
    }
  )
}
export const setPrefs = (v: SourcePrefs) => set(KEYS.prefs, v)

export async function getSeen(): Promise<SeenMessage[]> {
  return (await get<SeenMessage[]>(KEYS.seen)) ?? []
}
export const setSeen = (v: SeenMessage[]) => set(KEYS.seen, v)

/**
 * Received tabs, newest first, capped at HISTORY_MAX by lib/history.ts [P-7].
 * The storage KEY keeps its P-7 name so upgrading does not throw away rows a
 * user already has; the surface it feeds is now called History [ADR-0028].
 */
export async function getInbox(): Promise<InboxItem[]> {
  return (await get<InboxItem[]>(KEYS.inbox)) ?? []
}
export const setInbox = (v: InboxItem[]) => set(KEYS.inbox, v)

/**
 * The group history keyring [ADR-0028 §6] — a SET of keys, not one, which is
 * what makes rotation, a two-devices-minted-at-once race, and a device that has
 * been off for a month all the same case. Never leaves this install except
 * sealed to another endpoint's published key.
 */
export async function getGroupKeys(): Promise<GroupKeyRecord[]> {
  return (await get<GroupKeyRecord[]>(KEYS.groupKeys)) ?? []
}
export const setGroupKeys = (v: GroupKeyRecord[]) => set(KEYS.groupKeys, v)

/**
 * `keyId:endpointId` pairs this browser has already handed to the relay, so a
 * wake does not re-post every copy every time. Local-only and safe to lose: the
 * relay dedupes on the same deterministic delivery id, and a copy is not
 * consumed on read, so the worst case of losing this is a redundant POST.
 */
export async function getDeliveredKeys(): Promise<string[]> {
  return (await get<string[]>(KEYS.groupKeysDelivered)) ?? []
}
export const setDeliveredKeys = (v: string[]) => set(KEYS.groupKeysDelivered, v)

/**
 * The offline cache of the relay's group history [ADR-0028 §8]. The RELAY is
 * authoritative now; this exists so the page renders instantly and still says
 * something true while the relay is unreachable.
 */
export async function getHistory(): Promise<HistoryRow[]> {
  return (await get<HistoryRow[]>(KEYS.history)) ?? []
}
export const setHistory = (v: HistoryRow[]) => set(KEYS.history, v)

/**
 * Message ids this browser has already told the user never arrived. Persisted
 * because the alarm re-reads the same expired rows on every wake for the rest of
 * the retention window, and being told once is help while being told hourly is
 * an alarm nobody can silence.
 */
export async function getAnnouncedHistory(): Promise<string[]> {
  return (await get<string[]>(KEYS.historyAnnounced)) ?? []
}
export const setAnnouncedHistory = (v: string[]) => set(KEYS.historyAnnounced, v)

/**
 * When this browser last found the relay too old for ADR-0028, in epoch ms.
 *
 * Not a permanent verdict: the realistic order is that the extension updates
 * itself and the relay is updated by hand some time later, so this backs the
 * probing off rather than giving up. Cleared by the first call that works.
 */
export const getHistoryUnsupportedAt = () => get<number>(KEYS.historyUnsupportedAt)
export const setHistoryUnsupportedAt = (v: number) => set(KEYS.historyUnsupportedAt, v)
export const clearHistoryUnsupportedAt = () => remove([KEYS.historyUnsupportedAt])

/**
 * How many received tabs haven't been looked at yet — drives the toolbar
 * badge [P-7 addendum: a browser opening a tab was assumed to be signal
 * enough, until dogfooding showed one landing in an unfocused window is as
 * easy to miss as a phone notification]. Bumped by notify.ts on delivery,
 * zeroed by the history page once it is actually looked at.
 *
 * Counts RECEIVED arrivals only, not every history row: a send this browser
 * made, or a transfer between two other devices, is not something it needs to
 * be told about. Kept across a relay switch, like `inbox` itself: it counts
 * device-local history, not relay credentials.
 */
export async function getUnreadReceived(): Promise<number> {
  return (await get<number>(KEYS.unreadReceived)) ?? 0
}
export const setUnreadReceived = (v: number) => set(KEYS.unreadReceived, v)

export async function getOutbound(): Promise<OutboundItem[]> {
  return (await get<OutboundItem[]>(KEYS.outbound)) ?? []
}
export const setOutbound = (v: OutboundItem[]) => set(KEYS.outbound, v)

let outboundWrites: Promise<unknown> = Promise.resolve()

/**
 * Read the outbound queue, change it, and write it back, one change at a time
 * (SECURITY_REVIEW L4). A drain, a new send, a cancel and a re-target can all
 * be under way in the same second; two of them each writing back the queue they
 * read would silently undo the other. `change` must be quick and must not wait
 * on the network: everything slow happens before, and only its result is
 * applied here. Resolves to the queue as written.
 */
export function updateOutbound(
  change: (queue: OutboundItem[]) => OutboundItem[],
): Promise<OutboundItem[]> {
  const run = outboundWrites.then(async () => {
    const next = change(await getOutbound())
    await setOutbound(next)
    return next
  })
  outboundWrites = run.catch(() => undefined)
  return run
}

/**
 * Last-known group endpoint list. Cached so a send can seal to a target's key
 * (and the chooser can render) even while the relay is briefly unreachable.
 */
export async function getCachedEndpoints(): Promise<Endpoint[]> {
  return (await get<Endpoint[]>(KEYS.endpoints)) ?? []
}

/**
 * When the cached list was last taken FROM THE RELAY, in epoch ms.
 *
 * Every writer of the cache has just completed a `listEndpoints`, so this is the
 * age of the whole snapshot — and `presence` is the part of it that decays: a
 * green dot is the relay's verdict at that instant, not a standing fact. Absent
 * on installs that cached before this key existed, which reads as "unknown", the
 * safe answer.
 */
export const getCachedEndpointsAt = () => get<number>(KEYS.endpointsAt)

export async function setCachedEndpoints(v: Endpoint[]): Promise<void> {
  await set(KEYS.endpoints, v)
  await set(KEYS.endpointsAt, Date.now())
}

/**
 * The "new device joined" record (PLANS.md P-10): the device ids in the last
 * list this browser accepted, and the joined devices nobody has answered yet.
 * Written only by background/newdevices.ts.
 */
export const getNewDeviceWatch = () => get<NewDeviceWatch>(KEYS.newDeviceWatch)
export const setNewDeviceWatch = (v: NewDeviceWatch) => set(KEYS.newDeviceWatch, v)

/**
 * The real Web Push subscription once we've subscribed (Chunk 4c). Absent until
 * then; the heartbeat loop rotates whatever is stored here to the relay,
 * replacing the register-time placeholder. `null` marks "we tried and push is
 * unavailable here" (e.g. Chromium without a push service) so we don't retry
 * forever in a session.
 */
export const getPushSubscription = () => get<PushSubscription | null>(KEYS.pushSubscription)
export const setPushSubscription = (v: PushSubscription | null) => set(KEYS.pushSubscription, v)

/**
 * The relay VAPID public key the stored subscription was created against. When
 * the relay's key rotates (self-hoster regenerates keys), the stored/browser
 * subscription is DEAD — pushes 403 — so the client must detect the mismatch
 * and resubscribe (push.ts). Kept alongside the subscription for that check.
 */
export const getPushVapidKey = () => get<string>(KEYS.pushVapidKey)
export const setPushVapidKey = (v: string) => set(KEYS.pushVapidKey, v)

/**
 * This extension's settings defaults: the shared ones, except that the arrival
 * notification is ON [P-7 addendum, amended 2026-10-07]. A received tab lands in
 * the background of whichever window was last focused, and the badge alone left
 * people with nothing telling them that, or where, it arrived.
 */
export const EXTENSION_DEFAULT_SETTINGS: ClientSettings = {
  ...DEFAULT_CLIENT_SETTINGS,
  notifyOnReceive: true,
}

/**
 * What the stored `settings` blob means.
 *  - 1 (no `settingsVersion` key): the WHOLE merged object, defaults included,
 *    rewritten on every change. A value equal to the default cannot be told
 *    apart from one the user chose, so a default could never safely change.
 *  - 2: only the keys the user has actually set. Absent means "never touched",
 *    and reads whatever the current default is.
 */
export const SETTINGS_VERSION = 2

/**
 * The defaults a version-1 blob was written against, frozen here so that a
 * later change to any default cannot change what this migration does.
 */
const V1_DEFAULTS: ClientSettings = {
  toolbarClickMode: 'chooser',
  showSuccessToast: true,
  showPendingRow: true,
  contextMenusVisible: true,
  searchThreshold: 7,
  hotkeys: { openChooser: 'Ctrl+Shift+S', sendToPrimary: null },
  notifyOnReceive: false,
}

/**
 * Version 1 → 2: keep only the values that differ from the defaults of the day.
 * Those are the only ones that prove a choice; a value equal to the old default
 * is indistinguishable from "never touched", because changing ANY setting wrote
 * all of them. In practice this is what turns the arrival notification on for
 * an install whose stored `notifyOnReceive: false` was the old default, and it
 * also turns it on for anyone who did switch it on and then off again; there is
 * no way to tell those apart in a version-1 blob (decided 2026-10-07, before
 * v0.7.0 reached any store). An explicit choice made from now on is kept.
 */
export function migrateSettingsV1(
  stored: Partial<ClientSettings> | undefined,
): Partial<ClientSettings> | undefined {
  if (!stored) return stored
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(stored)) {
    const old = (V1_DEFAULTS as unknown as Record<string, unknown>)[key]
    if (JSON.stringify(value) !== JSON.stringify(old)) out[key] = value
  }
  return out as Partial<ClientSettings>
}

/**
 * The keys the user has set, migrated to the current meaning on first read.
 * Lazy (not an onInstalled step) so no reader can ever see a version-1 blob
 * through the version-2 lens, whichever wake gets here first.
 */
export async function getStoredSettings(): Promise<Partial<ClientSettings>> {
  const bag = await ext.storage.local.get([KEYS.settings, KEYS.settingsVersion])
  let stored = bag[KEYS.settings] as Partial<ClientSettings> | undefined
  const version = (bag[KEYS.settingsVersion] as number | undefined) ?? 1
  if (version < SETTINGS_VERSION) {
    stored = migrateSettingsV1(stored)
    await ext.storage.local.set({
      ...(stored ? { [KEYS.settings]: stored } : {}),
      [KEYS.settingsVersion]: SETTINGS_VERSION,
    })
  }
  return stored ?? {}
}

/**
 * Per-install client settings (ADR-0008 §7). Device-local, never synced. Merged
 * over the shipped defaults so a new setting added later, or a default that
 * changes, reads sanely on an old stored blob.
 */
export async function getSettings(): Promise<ClientSettings> {
  return { ...EXTENSION_DEFAULT_SETTINGS, ...(await getStoredSettings()) }
}

/** Persist only what the user set (see SETTINGS_VERSION), never the defaults. */
export const setStoredSettings = (v: Partial<ClientSettings>) =>
  ext.storage.local.set({ [KEYS.settings]: v, [KEYS.settingsVersion]: SETTINGS_VERSION })

/**
 * The single armed undo-send (ADR-0008, amended to add a 4s undo window). Held
 * locally with a `dispatchAt`; a click of "Undo" clears it before dispatch, so
 * nothing is ever sent to retract. Persisted (not just an in-SW timer) so a SW
 * suspension inside the window can't lose the send — a later wake dispatches it.
 */
export const getPendingUndo = () => get<PendingUndo | null>(KEYS.pendingUndo)
export const setPendingUndo = (v: PendingUndo | null) => set(KEYS.pendingUndo, v)

/**
 * The relay URL of the registration we most recently left (relay switch). Kept so
 * onboarding can offer it back as a one-click refill — NOT as a pre-filled value,
 * since leaving it was the point — after `clearRegistrationState()` has wiped the
 * registration itself.
 */
export const getLastRelayUrl = () => get<string>(KEYS.lastRelayUrl)
export const setLastRelayUrl = (v: string) => set(KEYS.lastRelayUrl, v)

/**
 * The relay the user is on their way TO: they typed this address in settings, the
 * probe found a different relay there, and they chose to start fresh on it. Unlike
 * `lastRelayUrl` this one IS pre-filled by onboarding — it's a deliberate, just-typed
 * destination, not a leftover. Cleared by the registration that consumes it, or by
 * the user abandoning the move (`cancelSwitch`).
 *
 * Its presence alongside a live registration is what makes a relay move
 * interruptible: the old pairing is untouched until the new one is granted, so
 * closing the setup tab costs nothing (dogfood 2026-08-05).
 */
export const getPendingRelayUrl = () => get<string>(KEYS.pendingRelayUrl)
export const setPendingRelayUrl = (v: string) => set(KEYS.pendingRelayUrl, v)
export const clearPendingRelayUrl = () => remove([KEYS.pendingRelayUrl])

/**
 * The pairing link the user had already pasted when they started the move, kept
 * verbatim so onboarding can pre-fill it. The settings field normalizes what it
 * is given down to a relay base URL (`normalizeRelayUrl` drops the `#c=` secret),
 * so without this the one thing needed on the very next screen was the one thing
 * thrown away between them (dogfood 2026-08-05). Stored raw: the fragment also
 * carries the cert fingerprint and browser route hint, and re-deriving those from
 * a base URL is impossible.
 */
export const getPendingPairingLink = () => get<string>(KEYS.pendingPairingLink)
export const setPendingPairingLink = (v: string) => set(KEYS.pendingPairingLink, v)
export const clearPendingPairingLink = () => remove([KEYS.pendingPairingLink])

/**
 * Set when the relay tells us our device token is dead (401) while we thought
 * we were registered — i.e. this browser was removed from its group by another
 * device. Survives `clearRegistrationState()` (it isn't in that key list) so
 * onboarding can explain why it landed back on the connect screen; a fresh
 * registration clears it.
 */
export const getRemovedNotice = () => get<boolean>(KEYS.removedNotice)
export const setRemovedNotice = (v: boolean) => set(KEYS.removedNotice, v)
export const clearRemovedNotice = () => remove([KEYS.removedNotice])

/**
 * The relay is rejecting our token but has NOT confirmed we were removed. Set
 * instead of wiping, because the same 401 comes from a relay restarted on an
 * empty database — a state that fixes itself, and one we must not respond to by
 * destroying the pairing and the outbound queue. Cleared on the next call that
 * authenticates successfully.
 */
export const getAuthWarning = () => get<boolean>(KEYS.authWarning)
export const setAuthWarning = (v: boolean) => set(KEYS.authWarning, v)
export const clearAuthWarning = () => remove([KEYS.authWarning])

/**
 * Whether the relay is answering, and since when. Persisted (not just held in
 * the service worker) precisely because the worker dies between sends: without
 * this, a chooser opened ten minutes into an outage has no idea an outage is
 * happening and renders as if everything is fine.
 */
export const getRelayHealth = () => get<RelayHealth>(KEYS.relayHealth)
export const setRelayHealth = (v: RelayHealth) => set(KEYS.relayHealth, v)

/**
 * Drop every RELAY-SCOPED bit of local state (relay switch / unpair). The device
 * token, endpoint id, group id, cached endpoints, push subscription (+ its VAPID
 * key), source prefs (MRU/primary are old-relay endpoint ids), the source-side
 * outbound queue (envelopes sealed to old-relay keys) and any armed undo are all
 * meaningless on a different relay, so they go together.
 * DELIBERATELY KEPT: `identity` (the device keypair is not relay-scoped and is
 * reused across registrations) and `settings` (device-local preferences). `seen`
 * is harmless either way and left untouched. `inbox` is kept too: those are tabs
 * the user received and this browser already opened, not relay credentials, and
 * wiping someone's record of them because they changed relay address would be
 * data loss they never asked for. Its rows carry label SNAPSHOTS, so they still
 * read correctly with the old group gone.
 * The group keyring and the cached group history GO, because both belong to a
 * GROUP: leaving a relay means a different group whose history this browser can
 * neither read nor be part of, and holding its keys afterwards is a credential
 * kept past its purpose. Note this never runs on an in-place address change
 * [P-4] — same relay, same group, so history survives moving house.
 */
export async function clearRegistrationState(): Promise<void> {
  await remove([
    KEYS.registration,
    KEYS.prefs,
    KEYS.endpoints,
    KEYS.endpointsAt,
    KEYS.newDeviceWatch,
    KEYS.pushSubscription,
    KEYS.pushVapidKey,
    KEYS.outbound,
    KEYS.pendingUndo,
    KEYS.relayHealth,
    KEYS.groupKeys,
    KEYS.groupKeysDelivered,
    KEYS.history,
    KEYS.historyAnnounced,
    KEYS.historyUnsupportedAt,
  ])
}
