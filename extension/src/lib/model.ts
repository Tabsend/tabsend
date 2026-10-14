import type {
  BrowserFamily,
  ClientSettings,
  EncryptedEnvelope,
  Endpoint,
  EndpointKind,
  GroupSealed,
  NewDeviceNotice,
  Platform,
  SendPayload,
} from '@tabsend/shared'
import type { RelayHealth } from './health'
import type { SendFailure } from './strings'

/**
 * Internal (device-local) shapes and the page <-> service-worker RPC contract.
 * None of this is on the wire — the wire is @tabsend/shared. This is the
 * extension's own storage model and message protocol.
 */

/** X25519 keypair for this install (base64 strings). */
export interface Identity {
  publicKey: string
  privateKey: string
  /** keyId(publicKey) — cached so we don't recompute the fingerprint each send. */
  keyId: string
}

/**
 * What this install got back from register/join, plus its own descriptors.
 * Naming model (dogfood pass-2 #1): the label is a user-named BROWSER tied to a
 * DEVICE, stored split so a rename can recompute `${browserName} · ${deviceName}`
 * and the device tie can be selected/changed independently.
 */
export interface Registration {
  endpointId: string
  groupId: string
  deviceToken: string
  relayUrl: string
  /** Display label = endpointLabel(browserName, deviceName). */
  label: string
  /** User-named browser, e.g. "Dia", "Work Chrome". */
  browserName: string
  /** Device tie, e.g. "MacBook Pro M1 Pro". '' until the join device step sets it. */
  deviceName: string
  kind: EndpointKind
  browser: BrowserFamily | null
  platform: Platform
  /**
   * The relay instance's stable id (/v1/config `relayId`), captured at
   * registration. Lets a later ADDRESS change verify "same relay, new URL"
   * before adopting it [P-4]. Absent when the relay predates relayId.
   */
  relayId?: string
  /**
   * ISO — when this install registered on the relay. Only used to age the
   * "alone in your group" notice out of a freshly created group (policy.ts
   * `shouldWarnSoloGroup`). Absent on registrations made before this field.
   */
  registeredAt?: string
}

/** One message we've already opened (idempotency set, pruned by age). */
export interface SeenMessage {
  id: string
  /** epoch ms we first opened it. */
  ts: number
}

/**
 * One tab this browser RECEIVED, kept device-locally so it outlives the thing it
 * arrived in [P-7]. See lib/history.ts for the record/group rules.
 *
 * The relay deletes a message's payload the moment we ack it, so this is the only
 * copy that exists after delivery. It holds plaintext the browser has already
 * opened in a tab; nothing extra reaches the relay, which still only ever sees
 * ciphertext.
 *
 * ADR-0028 made the RELAY's group history the authoritative list, but did not
 * make this redundant. It is what still answers "what arrived here" against a
 * relay that predates the ADR, one serving no history (`HISTORY_RETENTION_DAYS=0`),
 * or one that is simply down — and it fills in the content of a history row whose
 * group key this browser does not hold. `mergeHistory` folds the two together.
 */
export interface InboxItem {
  /** The relay message id — the dedupe key, same one the seen-set uses. */
  id: string
  url: string
  title?: string
  favicon?: string
  /** The sender's label as it read WHEN THIS ARRIVED (survives a later rename). */
  sourceLabel: string
  /** ISO — when the sender hit send (SendPayload.sentAt). */
  sentAt: string
  /** epoch ms — when this browser recorded it. */
  receivedAt: number
  /** The multi-tab send this belonged to, when it was one (SendPayload.batch). */
  batch?: { id: string; count: number }
}

/**
 * One row of the merged history timeline [ADR-0028 §8]: sent and received
 * together, newest first, on every client.
 *
 * Built from a relay `HistoryEntry` (plus its decrypted blob, when we hold the
 * key) or from the device-local received record, and the two are merged by
 * message id. The content fields are optional TOGETHER: a row whose blob we
 * cannot open is metadata-only, and still a true record of the transfer.
 */
export interface HistoryRow {
  /** The relay message id — the merge key between the two sources. */
  id: string
  /** Which end of this transfer this browser was on (drives the mail glyph). */
  direction: 'sent' | 'received' | 'other'
  /** What became of it, from the relay's own routing facts. */
  state: 'arrived' | 'waiting' | 'never-arrived'
  /** Empty only on a local-only received row, where the relay told us nothing. */
  sourceEndpointId: string
  /** Who it went to. "Send again" re-sends to exactly this endpoint. */
  targetEndpointId: string
  /** Both ends as they read AT SEND, so a rename never rewrites the past. */
  sourceLabel: string
  targetLabel: string
  /** ISO — the sender's stamp when readable, else the relay's creation time. */
  sentAt: string
  /** ISO — the RELAY's clock, so skewed devices still sort into one order. */
  sortAt: string
  /** Absent ⇒ metadata-only: a real transfer whose group key we do not hold. */
  url?: string
  title?: string
  favicon?: string
  /** The multi-tab send this belonged to, when it was one (SendPayload.batch). */
  batch?: { id: string; count: number }
}

/** A send that couldn't reach the relay and is awaiting retry (source-side queue). */
export interface OutboundItem {
  id: string
  targetEndpointId: string
  envelope: EncryptedEnvelope
  /** ISO — when the user hit send. */
  createdAt: string
  attempts: number
  /**
   * The group-history blob sealed alongside this item's envelope [ADR-0028].
   * Held WITH the item so a send that drains hours later still writes its
   * history row: the blob is sealed at capture time, and rebuilding it at drain
   * time would need a group key and both labels that may since have changed.
   */
  groupHistory?: GroupSealed
  /**
   * True for a console history copy [ADR-0010], not the tab the user sent. Kept
   * out of anything the user counts — a single send with one console paired
   * would otherwise read as "2 tabs waiting", which is just wrong.
   */
  history?: boolean
  /**
   * On a history copy, the id of the real send it copies.
   *
   * Recorded so a copy can never outlive the thing it is a copy OF. A cancelled
   * or given-up-on tab whose copy stayed queued would eventually put a row in
   * the console's history for a tab that was never sent anywhere — a record of
   * something that did not happen, which is worse than the missing row
   * "best-effort" already permits (see lib/outbound.ts).
   */
  copyOf?: string
  /**
   * What this held tab IS, in plaintext, for showing it back to the user.
   *
   * The envelope is sealed to the target's key, so a queue built only from
   * envelopes can be counted but never described — "⏳ 2 waiting" and no way to
   * find out which two. These live device-locally alongside the envelope and go
   * when the item drains; nothing extra reaches the relay, which still only ever
   * sees ciphertext. The tab they describe is open on this machine anyway.
   */
  title?: string
  url?: string
}

/**
 * A blind-fire send (quick-send / hotkey) held for the 4s undo window before it
 * actually leaves the machine (ADR-0008, amended). An undo is a pure local
 * delete; a dispatch re-runs the normal send path with the captured payload —
 * so NOTHING is ever transmitted that would need retracting.
 */
export interface PendingUndo {
  /** Correlation token for the banner's Undo button (not a message id). */
  id: string
  targetEndpointId: string
  targetLabel: string
  /** One per tab — a multi-tab quick-send holds and dispatches the whole batch. */
  payloads: SendPayload[]
  /** epoch ms — dispatch once now ≥ this (unless undone first). */
  dispatchAt: number
  /**
   * The tab the send was fired from. Persisted with the hold so the OUTCOME
   * banner lands back on that tab even when the service worker was torn down
   * inside the undo window — the delayed report is exactly the case where the
   * "active tab" is no longer the tab the user sent.
   */
  tabId?: number
}

// --- page <-> SW RPC ------------------------------------------------------

export type RpcRequest =
  | { type: 'getState' }
  | { type: 'createGroup'; relayUrl: string; browserName: string; deviceName: string }
  | { type: 'joinGroup'; relayUrl: string; code: string; browserName: string }
  | { type: 'setDevice'; deviceName: string }
  | { type: 'resetRegistration' }
  | { type: 'getDevices' }
  | { type: 'renameEndpoint'; endpointId: string; label: string }
  | { type: 'removeEndpoint'; endpointId: string }
  // "Yes, it's mine" on a new-device banner (PLANS.md P-10). Local only.
  | { type: 'confirmNewDevice'; endpointId: string }
  | { type: 'confirmReview' }
  | { type: 'dismissVanished'; endpointId: string }
  // `cached` builds the view with no network at all, so the popup can paint
  // last-known rows immediately and re-render when the networked build lands.
  | { type: 'getChooser'; cached?: boolean }
  // How many tabs are highlighted right now — the chooser's variant-A banner
  // ("N tabs selected"). Its own call, not part of getChooser: the count is a
  // tabs.query away and must not wait on the endpoint fetch.
  | { type: 'getSelection' }
  | { type: 'sendTo'; targetEndpointId: string }
  // "Send again" on a history row that never arrived [ADR-0028 §8]. Carries the
  // payload because the tab it came from is long closed — being able to offer
  // this at all is the point of keeping a readable copy of what was sent.
  | { type: 'sendAgain'; targetEndpointId: string; payload: SendPayload }
  | { type: 'getSettings' }
  | { type: 'setSettings'; settings: Partial<ClientSettings> }
  | { type: 'setPrimary'; targetEndpointId: string; pinned: boolean }
  | { type: 'mintPairing' }
  | { type: 'probeRelay'; relayUrl: string }
  | { type: 'changeRelayUrl'; relayUrl: string }
  // `pairingLink` is whatever the user had already pasted, when it was a
  // complete link — carried through so onboarding doesn't ask for it twice.
  | { type: 'switchToRelay'; relayUrl: string; pairingLink?: string }
  | { type: 'cancelSwitch' }
  | { type: 'pollNow' }
  // Pull the group's history now [ADR-0028]. The History page renders from the
  // cache regardless, so this only ever shortens the wait; a worker that is
  // asleep, stale, or on an older relay costs the page nothing.
  | { type: 'refreshHistory' }
  | { type: 'probeOnboarding'; relayUrl: string }
  // Abandon one tab the outbound queue is holding. A pure local delete, in the
  // same spirit as the undo window: nothing is transmitted, because there is
  // nothing to retract (INTERACTION_FLOWS §4f).
  | { type: 'cancelHeld'; id: string }

/** A relay move the user began in settings and has not completed. */
export interface PendingSwitch {
  /** Where they are heading. Already normalized. */
  relayUrl: string
  /** The complete pairing link they had pasted, when they pasted one. */
  pairingLink?: string
}

/** Snapshot the popup/first-run pages render from. */
export interface StateView {
  registered: boolean
  /** The relay in use. Empty while unregistered — first run asks, it never guesses. */
  relayUrl: string
  /**
   * The relay this browser was on before it left one (unregistered only). Offered
   * as a "use it again" click, NOT pre-filled: whoever just chose "Connect to a
   * different relay…" meant to leave it, so defaulting back to it is wrong — but
   * so is making a mis-click cost a retyped URL.
   */
  previousRelayUrl?: string
  endpointId?: string
  groupId?: string
  selfLabel?: string
  /** The user-named browser + device tie, for the rename UI. */
  browserName?: string
  deviceName?: string
  /** ISO registration time, when known — ages the solo-group notice in. */
  registeredAt?: string
  /** Unregistered because another device removed this browser from the group. */
  removedNotice?: boolean
  /**
   * A move to another relay that was started and not finished. Present ALONGSIDE
   * a live registration: choosing a different relay in settings no longer tears
   * the current one down, it only records where the user is heading, so this is
   * the whole record of an in-flight move. Both surfaces read it — settings to
   * offer "continue" or "cancel", onboarding to say what finishing will cost.
   */
  pendingSwitch?: PendingSwitch
  /** Whether `relayUrl` is currently answering — the options page says so. */
  relay?: RelayHealth
}

/** One row in the manage-devices surface (all endpoints, incl. self). */
export interface DeviceRow {
  endpointId: string
  label: string
  deviceName?: string
  isSelf: boolean
  /** Online AND recently enough confirmed to say so — false whenever unknown. */
  online: boolean
  /** False when the endpoint snapshot is too old to claim presence from. */
  presenceKnown: boolean
  /** e.g. "online", "last seen 2h ago", or "inactive" past the stale horizon. */
  presenceLabel: string
}

/**
 * The manage-devices view (INTERACTION_FLOWS §7 devices). `existingDeviceNames`
 * powers the join "which device is this?" step (CREATE or SELECT). [pass-2 #1/#4]
 */
export interface DevicesView {
  registered: boolean
  selfEndpointId?: string
  devices: DeviceRow[]
  existingDeviceNames: string[]
  /** Joined devices this browser has not answered yet (PLANS.md P-10). */
  newDevices: NewDeviceNotice[]
  /** The first look: the other devices in the first list, waiting for one answer (GH6). */
  review: NewDeviceNotice[]
  /** Announced as new, never answered, then gone from the list (GH7). */
  vanished: NewDeviceNotice[]
}

export interface ChooserRow {
  endpoint: Endpoint
  isPrimary: boolean
  isRecent: boolean
  /** Offline past the stale horizon (policy.ts) — likely a reinstalled/abandoned
   *  profile. Still a valid target (presence non-gating); just visibly aged. */
  stale: boolean
  /**
   * Whether `endpoint.presence` is recent enough to show as fact. False once the
   * cached snapshot outlives the relay's own online window (policy.ts), which is
   * what happens during an outage — the dot then says "unknown" instead of
   * repeating a verdict nobody can check.
   */
  presenceKnown: boolean
}

/** One tab still sitting on this browser, for the "waiting here" list. */
export interface HeldTab {
  id: string
  targetEndpointId: string
  title?: string
  url?: string
  /** ISO — when the user hit send. */
  createdAt: string
}

export interface ChooserView {
  registered: boolean
  targets: ChooserRow[]
  /** Sent-but-unacked AT THE RELAY — it has these; the target is just asleep. */
  pending: Array<{ targetEndpointId: string; count: number }>
  /**
   * Still on THIS browser because the relay hasn't taken them. A different
   * promise from `pending`, and the only list that can name the tabs.
   */
  held: HeldTab[]
  /** Current per-source primary (ADR-0002) — for the options primary-target UI. */
  primaryTargetId?: string
  primaryPinned: boolean
  /**
   * The relay's reachability, so the chooser can explain a standing outage
   * instead of rendering a normal-looking device list (from the cache) while
   * nothing can actually be delivered.
   */
  relay?: RelayHealth
  /** Joined devices this browser has not answered yet (PLANS.md P-10). */
  newDevices: NewDeviceNotice[]
  /** The first look: the other devices in the first list, waiting for one answer (GH6). */
  review: NewDeviceNotice[]
  /** Announced as new, never answered, then gone from the list (GH7). */
  vanished: NewDeviceNotice[]
}

export interface SendResult {
  /**
   * The tab is safe: either accepted by the relay/helper, or held in the local
   * outbound queue for retry. NOT the same as "delivered" — check `failure`
   * before telling anyone it was sent.
   */
  ok: boolean
  /** true when accepted by the relay but the target was offline (queued to deliver on wake). */
  queued: boolean
  /** true when the source itself couldn't reach the relay (held in the outbound queue). */
  offline: boolean
  targetLabel?: string
  /** Title of the page that was sent — so feedback can name the tab, not just the target. */
  title?: string
  /** Its favicon, so the title reads as a page rather than as another sentence. */
  favicon?: string
  error?: string
  /**
   * Why this send is not with the relay yet, when it isn't. Present on BOTH hard
   * errors and queued-locally outcomes; its absence is the only proof a surface
   * has that "Sent" is a true statement.
   */
  failure?: SendFailure
  /**
   * How many tabs this send carried, when it was a multi-tab selection. Absent
   * on single sends, so their results stay exactly today's shape.
   */
  count?: number
  /**
   * Of `count`, how many the relay refused. Present only on batches; equal to
   * `count` when the whole batch was refused, smaller on a partial delivery —
   * the case feedback must never round up to "Sent N tabs".
   */
  rejectedCount?: number
}

export interface PairingView {
  relayUrl: string
  link: string
  /**
   * Native-app presentation; falls back to link against an older relay.
   *
   * Optional because the PAGE cannot assume the worker that answered it is the
   * same build as itself: an unpacked extension rebuilt under a running Chromium
   * serves fresh pages from disk while the cached service worker keeps running,
   * and a pre-0.5 worker's response has no `qrLink` at all.
   */
  qrLink?: string
  expiresAt: string
  /** Explanation when copy and QR intentionally advertise different relay doors. */
  routeNote?: string
  /**
   * true when `relayUrl` is loopback, so the link can only ever work for another
   * client on this same machine — never a phone. Surfaced beside the QR, because
   * otherwise the dead end is only discovered on the scanning device.
   */
  localOnly: boolean
}

/**
 * What a typed relay address turned out to be, established WITHOUT committing
 * anything (`probeRelay`). The settings flow asks for one address and renders the
 * verdict, instead of asking the user to pick "same relay" vs "different relay"
 * from a description first — the extension can tell, so it should.
 */
export type RelayProbe =
  /** Our own relay, reachable at this URL. `verified` false ⇒ one side predates
   *  relayId, so the token check alone carries it — a caveat, not a failure. */
  | { verdict: 'same'; relayUrl: string; verified: boolean }
  /** A relay that has no record of this browser: moving there costs a re-pair. */
  | { verdict: 'different'; relayUrl: string }
  /** Nothing answered. */
  | { verdict: 'unreachable'; relayUrl: string }
  /** Answered, but unusable as-is (protocol mismatch, relay-side error). */
  | { verdict: 'error'; relayUrl: string; detail: string }

/** Outcome of an in-place relay ADDRESS change (same relay, new URL) [P-4]. */
export interface RelayChangeResult {
  /** The normalized URL now in use. */
  relayUrl: string
  /**
   * true when BOTH sides had a relayId and they matched. false means the old
   * relay predated relayId, so identity rests on the token check alone — the
   * UI shows a soft caveat, not an error.
   */
  verified: boolean
}

export type RpcResponse =
  | { ok: true; state: StateView }
  | { ok: true; chooser: ChooserView }
  | { ok: true; devices: DevicesView }
  | { ok: true; send: SendResult }
  | { ok: true; selection: { count: number } }
  | { ok: true; pairing: PairingView }
  | { ok: true; relayChange: RelayChangeResult }
  | { ok: true; probe: RelayProbe }
  | { ok: true; settings: ClientSettings }
  | { ok: true; onboarding: { canCreate: boolean } }
  | { ok: true }
  | { ok: false; error: string }
