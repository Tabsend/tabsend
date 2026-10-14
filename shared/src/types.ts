/**
 * Tabsend — shared/ contract types  (source of truth for the monorepo)
 * ---------------------------------------------------------------------------
 * Every package imports these; nothing here imports from a package. The server,
 * the extension, the Android app, and the console all agree
 * on the wire by agreeing on this file.
 *
 * Provenance: PRD §6.3 (data model), §6.5 (API surface), §6.1 (reliability),
 * and Decisions 0001–0009. Where this file *reconciles* a stale bit of the PRD
 * with a later decision, the comment says so — those are the exact spots the
 * "lock shared/ contracts" pass exists to nail down.
 *
 * This is one file for reviewability; it splits cleanly along the `// ===`
 * section headers into endpoints.ts / messages.ts / pairing.ts / auth.ts /
 * settings.ts / crypto.ts / api.ts / ws.ts / view.ts when the repo grows.
 */

// ===========================================================================
// 0. Primitives & branded IDs
// ===========================================================================

/**
 * Branded strings so an EndpointId can never be passed where a MessageId is
 * expected — cheap insurance for a routing system where mixing source/target
 * IDs is a nasty, silent bug. At runtime they're just strings.
 */
type Brand<T, B extends string> = T & { readonly __brand: B };

export type GroupId = Brand<string, 'GroupId'>;
export type EndpointId = Brand<string, 'EndpointId'>;
export type MessageId = Brand<string, 'MessageId'>;
export type DeviceToken = Brand<string, 'DeviceToken'>;
export type PairingCodeValue = Brand<string, 'PairingCode'>;

/** ISO-8601 in UTC, e.g. "2026-07-16T18:30:00.000Z". Always UTC on the wire. */
export type IsoTimestamp = Brand<string, 'IsoTimestamp'>;

// ===========================================================================
// 1. Enumerations  (as const-unions, not TS enums — friendlier on the wire)
// ===========================================================================

/**
 * What kind of thing an endpoint is. Matches PRD §6.3 `kind`. `console`
 * endpoints pair like any device but are EXCLUDED from every target list and
 * chooser — they exist to receive E2E history copies, never user sends. [0010]
 */
export type EndpointKind = 'extension' | 'mobile' | 'console';

/** Browser family for the default label + glyph. `other` and `null` allowed. [0004] */
export type BrowserFamily =
  | 'chrome' | 'firefox' | 'edge' | 'brave' | 'opera' | 'vivaldi' | 'arc' | 'other';

/** Best-effort OS, captured from the user agent at pairing. [0004] */
export type Platform = 'macos' | 'windows' | 'linux' | 'android' | 'ios' | 'unknown';

/**
 * Presence is BINARY and server-derived from heartbeat / push-subscription
 * freshness — never a field the client sets. `lastSeenAt` carries the nuance.
 * Presence is non-gating: an `offline` target is still a valid send target. [0001]
 */
export type PresenceStatus = 'online' | 'offline';

/** Toolbar left-click behavior. Client-local setting; default 'chooser'. [0008] */
export type ToolbarClickMode = 'chooser' | 'quicksend';

/**
 * Server-side lifecycle of a message row. The CLIENT never shows most of these;
 * it derives "sent" vs "queued" from the target's presence at send time (so the
 * toast is instant, no round-trip). See §6 view model + reliability §6.1.
 */
export type MessageState = 'queued' | 'delivered' | 'acked' | 'expired';

/**
 * Billing plan on the group. Free needs no email; Pro attaches one. [0003]
 *
 * RETIRED [0029]: only `DeviceGroup.plan` ever referenced this, and nothing on the
 * wire emits or reads a DeviceGroup. The relay knows no plan at all — see the note
 * on DeviceGroup in §8. Kept because this file is a locked contract.
 */
export type Plan = 'free' | 'pro';

// ===========================================================================
// 2. Push subscriptions  (the wake channel — transport per [0006])
// ===========================================================================

/** Standard VAPID Web Push subscription (Chrome/Firefox extensions, UnifiedPush-over-WebPush). */
export interface WebPushSubscription {
  transport: 'webpush';
  endpoint: string;                 // push service URL
  keys: { p256dh: string; auth: string };
}

/** UnifiedPush endpoint (self-hostable Android path); a bare delivery URL. [0006] */
export interface UnifiedPushSubscription {
  transport: 'unifiedpush';
  endpoint: string;
}

/** FCM fallback for stock-Android users with no UnifiedPush distributor. [0006] */
export interface FcmSubscription {
  transport: 'fcm';
  token: string;
}

/**
 * No push at all [0015]. The endpoint is reached by the WS fast path (§11) while
 * its app is alive, and by its own polling otherwise — the relay never wakes it.
 * This is the Android default (pairing must not require a distributor app);
 * `wake()` is a no-op and never counts toward push_failures.
 */
export interface NoPushSubscription {
  transport: 'none';
}

/**
 * The phone wake-up path, through the project's wake-up forwarder [0032]
 * (HOSTED_PLAN §6, PLANS P-5 option 1). iOS freezes a backgrounded app, so the only
 * reliable wake is APNs, and APNs takes instructions only from a key Apple issues per
 * developer account — which cannot be handed to self-hosters. A relay therefore asks
 * the forwarder to ring the phone, and the phone then fetches from that same relay.
 * Since ADR-0034 an Android phone on a build with Google push uses this same transport,
 * rung through FCM instead; the relay cannot tell the two apart and does not need to.
 *
 * The app hands the relay ONE thing: the wake token the forwarder minted for it.
 * There is deliberately NO url/endpoint field here, and there never will be. The relay
 * rings the forwarder its OPERATOR configured (`WAKE_FORWARDER_URL`), never one a
 * registration named: a client-supplied URL would make every register call an SSRF
 * lever on the relay. That is the difference from `webpush`, where the endpoint is
 * chosen by the browser's push service and so must ride the wire (and is guarded by
 * `push-egress.ts` because of it).
 *
 * A relay with no forwarder configured REFUSES this transport at registration rather
 * than accepting it and silently never ringing. `ServerConfigResponse.wakeForwarder`
 * is the hint a client reads first, so it can register `{transport:'none'}` and drain
 * on open instead of discovering the refusal.
 *
 * Metadata cost, stated wherever this path is described: the forwarder learns that a
 * device received something, and when. Never what.
 */
export interface ForwarderSubscription {
  transport: 'forwarder';
  wakeToken: string;                // minted by the forwarder, held by the relay
}

export type PushSubscription =
  | WebPushSubscription
  | UnifiedPushSubscription
  | FcmSubscription
  | NoPushSubscription
  | ForwarderSubscription;

// ===========================================================================
// 3. Endpoint  (the addressable unit — PRD §6.3, [0004])
// ===========================================================================

/**
 * An opaque per-profile install. Two profiles of the same browser are two
 * endpoints. No profile/hostname auto-detection. [0004]
 *
 * This is the *target-facing* identity — what everyone else in the group sees
 * about this endpoint when choosing it as a destination. Send-side preferences
 * (which target THIS endpoint usually sends to) live in `SourcePrefs`, not here.
 */
export interface Endpoint {
  id: EndpointId;
  groupId: GroupId;
  kind: EndpointKind;
  browser: BrowserFamily | null;    // null for console / unknown
  platform: Platform;

  /** User-editable; defaults to `${browser} · ${device}`, device set at pairing. [0004] */
  label: string;

  /**
   * The DEVICE this endpoint lives on, as a grouping hint (e.g. "MacBook Pro").
   * ADDITIVE [5-ext, dogfood pass-2 #1]: the endpoint naming model splits the
   * label into a user-named BROWSER and a device tie, so a group with 3 Macs ×
   * 3 browsers stays tidy and a joining browser can SELECT an existing device.
   * Optional — endpoints registered before this field keep working (the `label`
   * remains the authoritative display string; `deviceName` only powers grouping
   * and the "which device is this?" join step). Absent ⇒ ungrouped.
   */
  deviceName?: string;

  /** Public key others seal link payloads to. Published to the group at pairing. [0005] */
  e2ePubkey: string;

  /** Server-derived presence; do not set client-side. */
  presence: PresenceStatus;
  lastSeenAt: IsoTimestamp;

  createdAt: IsoTimestamp;

  // NOTE: `push_subscription` from PRD §6.3 is intentionally NOT exposed on the
  // shared Endpoint — it's a server-held secret used to wake the endpoint, never
  // shipped to peers. It travels only on register/heartbeat (see §7).
}

/**
 * Send-side preferences for one source endpoint. Per-source, not global —
 * what you send FROM Chrome-Work differs from what you send FROM your phone. [0002]
 *
 * DEVICE-LOCAL [0009]: stored in extension/app local storage, never on the relay.
 * It's per-source and only this endpoint reads it; a reinstalled profile is a new
 * endpoint anyway (0004), and keeping it local avoids retaining send-pattern
 * metadata on the relay. `recentTargetIds` is updated locally on each send.
 * (Can be promoted to an optional server mirror later without a wire change.)
 */
export interface SourcePrefs {
  /** The favored destination. null until the first send establishes MRU. [0002] */
  primaryTargetId: EndpointId | null;
  /** When true, `primaryTargetId` stops tracking MRU (user pinned it). [0002] */
  primaryPinned: boolean;
  /** Most-recently-used targets, most-recent first. Drives chooser ordering. [0002] */
  recentTargetIds: EndpointId[];
}

// ===========================================================================
// 4. Payload & E2E envelope  (link content is ALWAYS encrypted — [0005])
// ===========================================================================

/**
 * The plaintext "tab" — url PLUS context. Exists only inside the client, before
 * sealing and after opening. Title/favicon ride INSIDE the ciphertext so E2E
 * doesn't kill previews (the sender already holds them). [0005], PRD §5A.
 */
export interface SendPayload {
  url: string;
  title?: string;
  favicon?: string;                 // data: URL or origin favicon URL, best-effort
  /** Stamped by the sender; lets the target render "sent 3m ago" without server time. */
  sentAt: IsoTimestamp;
  /**
   * Present ONLY in console history copies [0010]: the endpoint the original
   * send targeted, so the console can render "Chrome · Work → Pixel · Phone".
   * Lives inside the ciphertext, so the relay learns nothing beyond the routing
   * rows it already holds. Absent on real (tab-opening) sends.
   */
  historyOf?: { targetEndpointId: EndpointId };
  /**
   * Present when this tab was sent as part of a multi-tab selection: a random
   * id shared by every tab of the batch, plus how many tabs the batch holds.
   * Lets receivers group the batch (one summary notification, one stacked
   * thread) instead of posting N unrelated alerts. Rides INSIDE the ciphertext;
   * the relay sees only N independent items. Absent on single-tab sends, and
   * receivers that don't know the field ignore it, so it is fully optional.
   */
  batch?: { id: string; count: number };
}

/**
 * A `SendPayload` encrypted AND authenticated to ONE target with the sender's
 * key (libsodium crypto_box). The relay stores/forwards only this — it never
 * sees a URL, and cannot forge one (it has no sender key), so it can't inject
 * links. Multi-target send encrypts once per target. [0005][0009]
 */
export interface EncryptedEnvelope {
  /** Algorithm tag so we can rotate crypto later (e.g. to HPKE) without ambiguity. [0009] */
  alg: 'x25519-xsalsa20-poly1305/box';  // libsodium crypto_box — AUTHENTICATED; no forward secrecy needed for one-shot links [0005][0009]
  /** Fingerprint of the SENDER pubkey — recipient verifies the message really came from this group endpoint (blocks relay link-injection). [0009] */
  senderKeyId: string;
  /** Fingerprint of the target pubkey this was sealed to — detects stale keys after re-pair. [0005] */
  targetKeyId: string;
  /** Per-message random 24-byte nonce (base64), required by crypto_box. [0009] */
  nonce: string;
  /** Base64 ciphertext of the JSON-encoded SendPayload. */
  ciphertext: string;
}

/**
 * Something sealed to the GROUP history key rather than to one endpoint [0028].
 *
 * `crypto_secretbox` (XSalsa20-Poly1305) — the symmetric half of the `crypto_box`
 * every client already implements, so ADR-0028 introduces no new primitive. There
 * is no `senderKeyId` to check: anyone holding the group key could have written
 * it, and everyone holding it is by definition a paired device. Content
 * authenticity for a *tab* still rests on the per-target `EncryptedEnvelope`;
 * this is the record of that send, not the send itself.
 */
export interface GroupSealed {
  alg: 'xsalsa20-poly1305/secretbox';
  /**
   * Which group key sealed this. A device holds a SET of keys — rotation keeps
   * old ones so old history stays readable — so a blob has to name its own, or
   * every reader would be guessing by trial decryption.
   */
  keyId: string;
  /** Per-blob random 24-byte nonce (base64). */
  nonce: string;
  /** Base64 ciphertext of a JSON-encoded HistoryRecord. */
  ciphertext: string;
}

/**
 * What a history blob decrypts to [0028]. The labels are SNAPSHOTS taken at send
 * time: a history entry has to still read correctly after a device is renamed or
 * leaves the group, and the relay's routing row only carries ids.
 */
export interface HistoryRecord {
  payload: SendPayload;
  sourceLabelAtSend: string;
  targetLabelAtSend: string;
}

// ===========================================================================
// 5. Message  (routing envelope — PRD §6.3 reconciled with [0005])
// ===========================================================================

/**
 * RECONCILIATION: PRD §6.3 modeled `url`/`title` as nullable columns. Under
 * [0005] (E2E always on, no plaintext mode) those columns are vestigial — the
 * server never holds link content. So the wire Message carries ONLY routing +
 * the opaque envelope + timestamps. This is the intended lock.
 */
export interface Message {
  /** Client-generated (UUID) so outbound-queue retries dedupe server-side. Idempotency key. PRD §6.1 */
  id: MessageId;
  groupId: GroupId;
  sourceEndpointId: EndpointId;
  targetEndpointId: EndpointId;

  envelope: EncryptedEnvelope;

  createdAt: IsoTimestamp;
  /** now + TTL (default 7d, configurable). Written BEFORE any delivery attempt. PRD §6.1 */
  expiresAt: IsoTimestamp;
  deliveredAt: IsoTimestamp | null;
  ackedAt: IsoTimestamp | null;
}

// ===========================================================================
// 6. Chooser view model  (the UI contract — mirrors INTERACTION_FLOWS §3.1)
// ===========================================================================

/** One row in the rich chooser: an endpoint plus its computed adornments. */
export interface ChooserTarget {
  endpoint: Endpoint;
  isPrimary: boolean;               // ★ pinned/primary, sorts first [0002]
  isPinned: boolean;
  isRecent: boolean;                // in SourcePrefs.recentTargetIds
  /** Precomputed human string for offline rows, e.g. "last seen 2h ago". */
  lastSeenLabel?: string;
}

/** Non-empty only; drives the conditional "⏳ N waiting for …" row. [0008] */
export interface PendingSummary {
  targetEndpointId: EndpointId;
  count: number;
}

/**
 * Everything the chooser needs to render a frame. Built client-side from the
 * endpoint list (minus self), this endpoint's SourcePrefs, and any pending
 * outbound/queued messages. Ordering already applied: primary → recents → rest. [0002]
 */
export interface ChooserViewModel {
  targets: ChooserTarget[];         // self + console-kind endpoints excluded [0002][0010]
  pending: PendingSummary[];        // [] when nothing is queued
}

// ===========================================================================
// 7. Client-local settings  (device-only; NEVER synced to the group)
// ===========================================================================

/**
 * Chrome/Firefox commands are declared in the manifest and rebound by the user
 * via the browser's own shortcuts UI — the extension can't fully set them. These
 * fields MIRROR current bindings for display; `null` = unbound. [0001], [0008]
 */
export interface HotkeyBindings {
  openChooser: string | null;       // default suggestion "Ctrl+Shift+S"
  sendToPrimary: string | null;     // optional blind-fire; unbound by default [0002]
}

/** Per-install preferences. Stored in extension/app local storage, not the relay. [0008] */
export interface ClientSettings {
  toolbarClickMode: ToolbarClickMode;   // 'chooser' default; 'quicksend' opt-in [0008]
  showSuccessToast: boolean;            // error toasts always show regardless
  showPendingRow: boolean;              // the conditional queued row [0008]
  contextMenusVisible: boolean;         // hide page/link menu items [0001]
  searchThreshold: number;              // show chooser search when targets > N
  hotkeys: HotkeyBindings;
  notifyOnReceive: boolean;             // pop-up notification on a received tab; badge is always on [P-7 addendum]
}

export const DEFAULT_CLIENT_SETTINGS: ClientSettings = {
  toolbarClickMode: 'chooser',
  showSuccessToast: true,
  showPendingRow: true,
  contextMenusVisible: true,
  searchThreshold: 7,
  hotkeys: { openChooser: 'Ctrl+Shift+S', sendToPrimary: null },
  notifyOnReceive: true,
};

// ===========================================================================
// 8. Group & auth  (account-less device group — [0003])
// ===========================================================================

/**
 * The identity everyone shares. No email/password required to exist. [0003]
 *
 * RETIRED FIELDS [0029]: `plan` and `hasEmail` are leftovers from the original
 * account-shaped data model. Nothing has ever put a DeviceGroup on the wire — no
 * route returns one, no client parses one — and the relay stopped writing the
 * columns behind them in [0029]: per-group state on the relay is caps as explicit
 * values and nothing else, so "the relay knows no plan" is literally true and the
 * group→plan mapping lives only in the closed control plane (HOSTED_PLAN §2.2).
 * They stay declared because removing a field from a locked contract is not an
 * additive change [0009]. Nothing should start emitting them.
 */
export interface DeviceGroup {
  id: GroupId;
  createdAt: IsoTimestamp;
  plan: Plan;                       // RETIRED [0029] — never emitted (see above)
  /** True once an email is attached for Pro billing — optional. [0003] */
  hasEmail: boolean;                // RETIRED [0029] — never emitted (see above)
}

/**
 * NO RECOVERY CREDENTIAL [0021]. There is deliberately no recovery phrase, key, or
 * escape hatch. Getting a device (back) into a group is always the same one path:
 * an already-paired device mints a complete pairing link. If literally every device is gone,
 * the group holds nothing recoverable anyway — its remaining endpoints are dead and
 * its history is E2E-sealed to keys that no longer exist [0005] — so the answer is
 * to create a fresh group against the same relay, not to restore an empty one.
 */

// ===========================================================================
// 9. Pairing  (complete link / QR — first-class onboarding, [0003][0024])
// ===========================================================================

/** Internal short-lived join secret. It is never presented separately to a person. */
export interface PairingCode {
  code: PairingCodeValue;           // embedded inside the complete link/QR
  groupId: GroupId;
  createdAt: IsoTimestamp;
  expiresAt: IsoTimestamp;          // short (minutes)
  consumedAt: IsoTimestamp | null;  // one-time use
}

/**
 * What both the QR and copyable pairing link encode. [0009, 0024]
 * The three values form one indivisible user credential: the relay address says
 * where to connect, the secret authorises one join, and the optional fingerprint
 * supplies the trust anchor for a self-signed relay.
 */
export interface PairingPayload {
  relayUrl: string;
  code: PairingCodeValue;
  /**
   * Optional client-specific routes for a relay that deliberately exposes more
   * than one transport. A self-signed LAN relay uses HTTPS for native apps (which
   * can pin its key) and HTTP for browser clients (which cannot). They remain in
   * the fragment with the secret, so opening `/pair` never leaks route selection
   * or the pairing code into a request/access log.
   *
   * Ordinary hosted/domain relays omit both: one CA-trusted HTTPS URL works for
   * every client, preserving the original compact link and UX.
   */
  browserRelayUrl?: string;
  nativeRelayUrl?: string;
  /**
   * base64url SHA-256 of the relay's TLS certificate public key (SPKI DER).
   * Present ONLY when the relay serves its own self-signed certificate
   * (TLS_SELF_SIGNED mode). The pairing channel is the out-of-band trust
   * anchor — SSH-fingerprint style: the joining device pins this key and
   * accepts that certificate and only that one. Absent on plain-HTTP relays
   * and relays behind a real CA certificate, where normal TLS validation
   * applies. [P-3]
   */
  certFingerprint?: string;
}

/**
 * Canonical copy-paste pairing link. The code sits in the URL *fragment* so it's
 * never sent to a server in a request path or access log. The joining device
 * parses the origin as the relay and the fragment as the code. [0009]
 * e.g. https://relay.example/pair#c=ABC123
 * With a self-signed relay the fingerprint rides in the same fragment:
 * https://192.168.1.20:8787/pair#c=ABC123&fp=BASE64URL
 * (Clients that predate `fp` would mis-read such a link — acceptable skew,
 * because without the pin they could not complete the TLS handshake anyway.)
 */
export const PAIRING_LINK = (p: PairingPayload): string =>
  `${p.relayUrl.replace(/\/$/, '')}/pair#c=${p.code}${p.certFingerprint ? `&fp=${p.certFingerprint}` : ''}${p.browserRelayUrl && p.browserRelayUrl !== p.relayUrl ? `&browser=${encodeURIComponent(p.browserRelayUrl)}` : ''}${p.nativeRelayUrl && p.nativeRelayUrl !== p.relayUrl ? `&native=${encodeURIComponent(p.nativeRelayUrl)}` : ''}`;

// ===========================================================================
// 10. REST API contracts  (PRD §6.5)
// ===========================================================================
//
// NAMING [0009, decided]: routes are `/v1/endpoints/*` — aligned with the model
// and the differentiator (0004). PRD §6.5 updated to match. The per-endpoint
// token keeps the name `device_token` (colloquial; not worth the churn).

// ---------------------------------------------------------------------------
// 10a. Auth  [Chunk 2 lock] — every route EXCEPT POST /v1/endpoints/register
// requires `Authorization: Bearer <deviceToken>`. The token is the per-endpoint
// credential minted at register/join (RegisterResponse.deviceToken); it both
// authenticates the caller AND identifies which endpoint is acting, so a token
// for endpoint A can never act as endpoint B.
// ---------------------------------------------------------------------------

/** The HTTP auth scheme for all authenticated routes. */
export const AUTH_SCHEME = 'Bearer' as const;
/** The header (lower-cased, as Node/Fastify expose it) carrying the device token. */
export const AUTH_HEADER = 'authorization' as const;
/** Build the `Authorization` header value from a device token. */
export const bearerAuth = (token: DeviceToken): string => `${AUTH_SCHEME} ${token}`;

// ---------------------------------------------------------------------------
// 10b. Error envelope  [Chunk 2 lock] — the ONE shape every non-2xx JSON error
// response takes, with a small closed set of machine-readable codes. Clients
// switch on `error.code`; `error.message` is human-facing and MAY change. The
// per-item send rejections (SendResponse.rejected) are their OWN reason set and
// are NOT errors — a partially-accepted send is still HTTP 200.
// ---------------------------------------------------------------------------

export type ApiErrorCode =
  | 'unauthorized'          // missing or invalid Bearer device token (401)
  | 'endpoint_removed'      // this endpoint was DELIBERATELY removed from its group (401)
  | 'forbidden'             // not allowed to act on this resource / as this endpoint, or to create a group on a provisioned-groups relay (403) [0029]
  | 'not_found'             // endpoint, message, or route target absent or not visible to the caller (404)
  | 'invalid_request'       // malformed body, missing field, or bad enum value (400)
  | 'invalid_pairing_code'  // link's internal secret unknown, expired, or already consumed (400)
  | 'group_exists'          // this relay already hosts a group and is single-group (409) [0022]
  | 'limit_reached'         // a per-group limit refuses this call: the endpoint cap on register, the live-link limit on pairing (409) [0030, 0031]
  | 'rate_limited'          // per-IP window on the auth-free register route is spent; carries Retry-After (429)
  | 'internal';             // unexpected server error (500)

/** Body of every non-2xx JSON response from the relay. */
export interface ApiError {
  error: { code: ApiErrorCode; message: string };
}

/**
 * Is this failure proof that the endpoint should stop being paired?
 *
 * Only `endpoint_removed` is. A bare `unauthorized` means the relay does not
 * recognise the token, which is ALSO what a relay says after being restarted on
 * an empty database or restored from a backup — so treating it as removal
 * un-pairs healthy devices and throws away their queued sends. When in doubt,
 * keep the pairing: re-pairing is manual work for a person, and on a phone it
 * may not be possible at all without another device to hand.
 */
export function isDefinitiveRemoval(code: ApiErrorCode): boolean {
  return code === 'endpoint_removed';
}

// ---------------------------------------------------------------------------
// 10c. Relay config discovery  [Chunk 4c lock] — the one UNauthenticated read a
// client needs before it can subscribe to Web Push. The VAPID *public* key is
// not a secret: it IS the `applicationServerKey` the browser passes to
// pushManager.subscribe(). Kept tiny + capability-shaped so the relay can grow
// more discoverable capabilities later without a new route.
// ---------------------------------------------------------------------------

/** GET /v1/config — relay capabilities. No auth. */
export interface ServerConfigResponse {
  /** VAPID public key (base64url), or "" when this relay has push disabled. */
  vapidPublicKey: string;
  /**
   * Wire protocol this relay speaks. ABSENT on relays predating protocol
   * discovery — read it through `relayProtocol()`, which treats absent as 1.
   */
  protocol?: number;
  /**
   * Oldest client protocol this relay still accepts. Absent ⇒ 1 (accepts all).
   * Lets a relay refuse clients it can no longer serve *by name*, instead of
   * letting them fail somewhere downstream as a confusing transport error.
   *
   * Keep this LOW and move it rarely: every bump is a device that stops working
   * until someone installs a build by hand. `recommendedClientProtocol` is the
   * knob for "should update"; this one means "cannot work".
   */
  minClientProtocol?: number;
  /**
   * Protocol below which a client is outdated but still fully functional. Absent
   * ⇒ same as `minClientProtocol` (nothing to nag about). The band between
   * recommended and min is the forgiving zone: the client warns and keeps
   * working, so an upgrade is something the user schedules rather than an outage
   * they discover.
   */
  recommendedClientProtocol?: number;
  /** Human-facing relay build id, for bug reports. Never parsed. */
  relayVersion?: string;
  /**
   * Will this relay accept a NEW group right now? [0022]
   *
   * False on a single-group relay that already hosts one — the normal steady state
   * of a self-hosted relay. Clients read this before showing onboarding so they can
   * offer "join with a pairing link" instead of "create a group", rather than letting
   * the user pick create and discover the `group_exists` refusal afterwards.
   *
   * Absent on relays predating this field; read it as TRUE (the old behaviour, where
   * any register without a code created a group). It is a UI hint, never the
   * enforcement — the relay decides on the register call itself.
   *
   * Deliberately NOT secret: it says only "in use / not in use", never how many
   * groups, who is in them, or any id. A relay already reveals it is a relay.
   */
  acceptsNewGroups?: boolean;
  /**
   * Can this relay ring a phone through the wake-up forwarder? [0032, 0034]
   *
   * Present and true ONLY where the operator set `WAKE_FORWARDER_URL`. A phone app
   * reads it before registering and picks its transport from the answer: with a
   * forwarder, `{transport:'forwarder'}` and background delivery; without one,
   * `{transport:'none'}`, where an iPhone drains on open and an Android phone keeps its
   * own connection (the pre-forwarder behaviour). Relays predating this field omit it, which reads as
   * false, which is exactly right — they have no forwarder either.
   *
   * A UI hint, never the enforcement, exactly like `acceptsNewGroups`: the register
   * call decides, and a relay without a forwarder refuses the `forwarder` transport
   * with a message saying so. The hint exists so that refusal is something a client
   * can avoid rather than something it has to hit.
   *
   * Deliberately a boolean and never the URL. Which forwarder a relay rings is its
   * operator's business, no client needs it to work, and publishing it would put an
   * internal address in an UNauthenticated response.
   */
  wakeForwarder?: boolean;
  /**
   * Stable random id minted on this relay's first boot and never changed.
   * NOT a credential and NOT secret — it exists so a client can tell "the
   * same relay at a new address" from "a different relay" without re-pairing:
   * before adopting a changed relay URL, fetch /v1/config there and require
   * the stored relayId to match (then prove it with an authenticated call).
   * Absent on relays predating it, which read as "cannot verify" — clients
   * should then warn rather than refuse. [P-4]
   */
  relayId?: string;
}

/**
 * The wire protocol this build of Tabsend speaks. Bump for a breaking wire
 * change or an onboarding flow that requires relay support; additive fields do
 * not need it.
 */
export const CLIENT_PROTOCOL = 3;

/**
 * Oldest relay protocol a current client can use. Protocol v3 makes the complete
 * pairing link the only public credential; v2 relays expose a detached short code
 * that cannot identify the relay or carry its optional TLS trust pin.
 */
export const MIN_RELAY_PROTOCOL = 3;

/** Protocol discovery is newer than the first relays; absent means the original, 1. */
export function relayProtocol(config: ServerConfigResponse): number {
  return config.protocol ?? 1;
}

/**
 * Whether this client and that relay can talk, and if not, which side is behind.
 *
 * Version skew used to surface as a transport failure — the client blamed the
 * network and told the user to check a relay that was running fine (dogfood
 * 2026-07-26). Naming the stale side is the whole point: "update the app" and
 * "update the relay" are different actions by different people.
 */
export type ProtocolCheck =
  /** Fully compatible. `outdated` ⇒ works now, but an update is available. */
  | { ok: true; outdated?: { clientProtocol: number; recommended: number } }
  | { ok: false; stale: 'client'; clientProtocol: number; relayRequires: number }
  | { ok: false; stale: 'relay'; relayProtocol: number; clientRequires: number };

export function checkProtocol(config: ServerConfigResponse): ProtocolCheck {
  const relay = relayProtocol(config);
  const relayRequires = config.minClientProtocol ?? 1;
  if (CLIENT_PROTOCOL < relayRequires) {
    return { ok: false, stale: 'client', clientProtocol: CLIENT_PROTOCOL, relayRequires };
  }
  if (relay < MIN_RELAY_PROTOCOL) {
    return { ok: false, stale: 'relay', relayProtocol: relay, clientRequires: MIN_RELAY_PROTOCOL };
  }
  // Soft band: old enough to nag, new enough to work. Never blocks — a version
  // check that stops a working setup is worse than the skew it guards against.
  const recommended = config.recommendedClientProtocol ?? relayRequires;
  if (CLIENT_PROTOCOL < recommended) {
    return { ok: true, outdated: { clientProtocol: CLIENT_PROTOCOL, recommended } };
  }
  return { ok: true };
}

/** POST /v1/endpoints/register — create a group (no code) OR join one (with code). */
export interface RegisterRequest {
  label: string;
  kind: EndpointKind;
  browser: BrowserFamily | null;
  platform: Platform;
  pushSubscription: PushSubscription;
  e2ePubkey: string;
  /** Optional device grouping hint (ADDITIVE, see Endpoint.deviceName). [5-ext] */
  deviceName?: string;
  /** Present ⇒ join an existing group; absent ⇒ create a new group (first endpoint). [0003] */
  pairingCode?: PairingCodeValue;
}
export interface RegisterResponse {
  endpointId: EndpointId;
  groupId: GroupId;
  deviceToken: DeviceToken;          // long-lived; the ONLY credential the client stores [0003]
  /**
   * The label actually stored. ADDITIVE: the relay makes labels distinct within a
   * group (see `uniqueLabel`), so a client that registered "Chrome" into a group
   * that already had one gets "Chrome 2" back here. Mirror it locally — otherwise
   * this device shows itself one name while every other device sees another.
   * Absent from an older relay ⇒ the label was taken as sent.
   */
  label?: string;
}

/** POST /v1/endpoints/:id/heartbeat — refresh presence + (optionally) push subscription. */
export interface HeartbeatRequest {
  pushSubscription?: PushSubscription;   // resend if it rotated
}
export interface HeartbeatResponse {
  presence: PresenceStatus;
  serverTime: IsoTimestamp;
}

/** GET /v1/endpoints — every endpoint in the group (client filters self for targets). */
export type ListEndpointsResponse = Endpoint[];

/**
 * PATCH /v1/endpoints/:id — rename (self or any endpoint in the group). `label`
 * is the display string; `deviceName` (ADDITIVE, optional) updates the device
 * grouping tie in the same call — set at the join "which device is this?" step
 * and editable later. Omit `deviceName` to leave the existing tie untouched. [5-ext]
 */
export interface UpdateEndpointRequest {
  label: string;
  deviceName?: string;
}

/** DELETE /v1/endpoints/:id — remove an endpoint from the group. (no body) */

// NOTE [0009]: no `/prefs` endpoint. SourcePrefs is DEVICE-LOCAL (see §3) — the
// relay never stores primary/pin/MRU. Promote to an optional server mirror later
// only if the console ever needs to display a source's default target.

/**
 * POST /v1/messages — one HTTP call fans out to N targets. Because of E2E the
 * CLIENT seals per target, so the body carries pre-sealed items, one per target. [0005]
 */
export interface SendItem {
  id: MessageId;                    // client-generated UUID → idempotent [PRD §6.1]
  targetEndpointId: EndpointId;
  envelope: EncryptedEnvelope;      // sealed to THIS target's pubkey
  /**
   * The group-history copy of this same tab [0028]. Optional: a sender that
   * predates ADR-0028, or a group with no history key yet, simply omits it and
   * everything else behaves exactly as before.
   *
   * Sealed to the GROUP key rather than to one endpoint's key, which is the whole
   * point — one blob that every paired device can read, instead of one copy per
   * device. The relay stores it opaquely beside the routing row and never holds
   * the key.
   */
  history?: GroupSealed;
}
export interface SendRequest { items: SendItem[] }
/**
 * `not_in_group` is RETIRED AS AN ANSWER [0029] and kept only as a literal: the
 * relay no longer emits it, here or on `/v1/group-keys`. Answering it told a
 * sender that a guessed endpoint id was real but in SOMEONE ELSE'S group, which
 * on a multi-tenant relay is an existence oracle (HOSTED_PLAN §4.6). A target
 * outside the caller's group now answers `unknown_target`, byte for byte the same
 * as an id that was never issued. Clients keep their copy for it — dropping the
 * literal would be a breaking change [0009], and an older relay still sends it.
 */
export type SendRejectionReason =
  | 'unknown_target'   // no such endpoint in the caller's group (or none anywhere) [0029]
  | 'expired_key'      // the envelope is sealed to a key the target has replaced
  | 'not_in_group'     // RETIRED as an answer [0029]; kept as a literal, never emitted
  | 'limit_reached';   // a per-group cap would be exceeded by this item [0030]

/**
 * Which cap refused the item, alongside `limit_reached` [0030] (HOSTED_PLAN §4.3).
 *
 * ONE reason literal plus this named detail, rather than four literals. Every
 * client carries a HAND-MAINTAINED copy table for these reasons (`strings.ts`,
 * `SendFeedback.kt`, `SendFeedback.swift`), and the TypeScript ones switch on the
 * union exhaustively — so each new literal costs four edits and a compile break,
 * while a fifth cap later costs nothing here. A client that ignores this field
 * still says something true; a client that cannot match a literal says nothing.
 *
 * CLIENT CONTRACT, settled when the copy for these was written: `limit_reached`
 * is the one per-item reason that is NOT final, and a client must HOLD the
 * refused item rather than drop it. Every cap here clears itself — the send
 * window rolls over within `CAP_SEND_WINDOW_SECONDS`, and the queue caps drain as
 * the target reads its tabs, as stored history leaves its retention window, or as
 * the sweeper expires either — so the item belongs in the same source-side
 * outbound queue that carries a tab through an outage, and is retried on the
 * drain cadence that queue already has. That is the reason it is enough to match
 * the REASON: `limit` only chooses which wait the copy names. Every other reason
 * keeps its final semantics.
 */
export type GroupLimit =
  | 'endpoints'          // how many endpoints the group may hold
  | 'queued_messages'    // undelivered messages held for the group
  | 'queued_bytes'       // stored bytes: queued envelopes + retained history [0030 amended]
  | 'sends_per_window';  // accepted sends per rolling relay window

export interface SendResponse {
  accepted: MessageId[];            // persisted + push attempted
  rejected: Array<{
    id: MessageId;
    reason: SendRejectionReason;
    /** Set ONLY with `limit_reached`, and always then: which cap said no [0030]. */
    limit?: GroupLimit;
  }>;
}

/** GET /v1/messages?pending=1 — pending messages for the CALLING endpoint. */
export type PendingMessagesResponse = Message[];

/**
 * One row of the group's shared history [0028]: the relay's own routing facts,
 * plus the opaque blob only paired devices can read.
 *
 * This is the whole point of ADR-0028 in one shape. `deliveredAt`/`ackedAt` are
 * metadata the relay has always held, which is what lets a client say "this never
 * arrived" honestly rather than inferring it. `blob` is content the relay cannot
 * read, which is what lets ANY device show the tab rather than only the two ends.
 */
export interface HistoryEntry {
  id: MessageId;
  sourceEndpointId: EndpointId;
  targetEndpointId: EndpointId;
  createdAt: IsoTimestamp;
  expiresAt: IsoTimestamp;
  /** Set once the relay handed it to the target. */
  deliveredAt: IsoTimestamp | null;
  /** Set once the target confirmed it. Null past `expiresAt` means it never arrived. */
  ackedAt: IsoTimestamp | null;
  blob: GroupSealed;
}

/**
 * GET /v1/history — the CALLING endpoint's whole group, newest first, capped by
 * the relay's history window. Every paired device sees the same list, including
 * transfers it was neither end of.
 */
export type HistoryResponse = HistoryEntry[];

// --- group history key distribution [0028] --------------------------------
//
// Deliberately its OWN route rather than an ordinary message. A control message
// travelling as a tab is a tab as far as every already-shipped client is
// concerned: Android's `SendPayload.url` is non-null, so one without a URL fails
// to parse, is skipped WITHOUT an ack, and retries on every drain until it
// expires; iOS would show the user "Unsupported link blocked". A separate route
// is invisible to a client that does not know to poll it, which is exactly the
// forward compatibility this needs.

/** One copy of the group history key, sealed to ONE endpoint's X25519 key. */
export interface GroupKeyDelivery {
  /** Client-generated UUID — idempotent, like a MessageId. */
  id: string;
  /** Who sealed it. The envelope's `senderKeyId` is what actually proves it. */
  sourceEndpointId: EndpointId;
  /**
   * `crypto_box` sealed to the recipient's published `e2ePubkey`, exactly like a
   * tab. Its plaintext is a JSON `GroupKeyRecord`.
   */
  envelope: EncryptedEnvelope;
  createdAt: IsoTimestamp;
}

/** What a `GroupKeyDelivery` envelope decrypts to. */
export interface GroupKeyRecord {
  /** 32 random bytes, base64. */
  key: string;
  /**
   * Fingerprint of `key`, so two devices can agree which key is which without
   * comparing secrets, and so a blob can name the key that sealed it.
   */
  keyId: string;
  /**
   * When this key came into being. Newest wins when a device holds several
   * (`createdAt` first, `keyId` as a deterministic tiebreak) — which is what
   * makes rotation and a two-devices-generated-at-once collision the same case.
   */
  createdAt: IsoTimestamp;
  /**
   * The ids of the devices that had left, or been removed, when this key was
   * minted to replace the one they held: the minter's debt (`rotateFor` in the
   * new-device watch). A device that owes a rotation stands down only for a key
   * that names every one of its own departed ids, so a key that merely arrived
   * later does not count (`SECURITY_REVIEW.md` X14, ADR-0028 amendment
   * 2026-10-13). Absent on a group's first key. At most 32 ids; see
   * `isAcceptableDeparted` in `keyrecord.ts` for the exact shape.
   */
  departed?: string[];
}

/** POST /v1/group-keys — hand the group key to endpoints that lack it. */
export interface GroupKeyRequest {
  items: Array<{ id: string; targetEndpointId: EndpointId; envelope: EncryptedEnvelope }>;
}
export interface GroupKeyResponse {
  accepted: string[];
  // Literally the same reason set as SendResponse, now by NAME rather than by a
  // copied union [0030] — the two drifting apart is what breaks a client that maps
  // both through one function. One member is inert here: `not_in_group`, the retired
  // answer nobody emits [0029].
  //
  // `limit_reached` IS emitted here [0030 amended 2026-09-05, revised 2026-10-01], in
  // two shapes and no others: with `limit: 'sends_per_window'` when the group's send
  // window is spent, and with NO `limit` at all when the target already holds the most
  // key copies the relay keeps for one device (64), which is a structural bound rather
  // than one of the group's caps. It used to be emitted nowhere on this route, on the
  // grounds that refusing a group-history key would break key distribution for a group
  // that is merely full — which is still true of the QUEUE caps and is still why they
  // do not apply. What was missing is that nothing else applied either, so the route
  // was an unmetered place to store bytes. Both refusals clear on their own (the window
  // rolls over; old copies leave at the history cutoff), and every client that uploads
  // keys remembers only the ids the relay ACCEPTED, so a refused copy is re-offered on
  // the next wake rather than marked done.
  rejected: Array<{ id: string; reason: SendRejectionReason; limit?: GroupLimit }>;
}

/** GET /v1/group-keys — every copy sealed TO the calling endpoint. */
export type GroupKeysResponse = GroupKeyDelivery[];

/**
 * GET /v1/messages?outbox=1 — the CALLING endpoint's sent-but-unacked messages,
 * as a routing projection (no envelopes). Rebuilds the chooser's ⏳ pending row
 * across restarts; live drain comes from the WS `acked` event. [0010]
 */
export type OutboxMessagesResponse = Array<
  Pick<Message, 'id' | 'targetEndpointId' | 'createdAt' | 'expiresAt' | 'deliveredAt'>
>;

/** POST /v1/messages/:id/ack — target confirms open; server deletes payload. (no body) */

/**
 * POST /v1/pairing — an already-paired device mints a complete pairing link.
 *
 * The short database secret remains inside the link fragment. It is deliberately
 * not returned as a separate field: the relay address and optional TLS pin are
 * required parts of the credential, not optional context for a typable code.
 */
export interface CreatePairingResponse {
  /** Backward-compatible native/QR presentation. */
  link: string;
  /** Copy/paste presentation for browser clients. Absent on older relays. */
  browserLink?: string;
  expiresAt: IsoTimestamp;
}

// ===========================================================================
// 11. WebSocket fast path  (WS /v1/stream — latency only, never correctness)
// ===========================================================================
//
// If the socket is down, nothing breaks: push+queue still deliver. [0001][PRD §6.1]

/** Server → client events. */
export type ServerStreamEvent =
  /** A message is available. Carries the full envelope for sub-second open (no GET round-trip). */
  | { type: 'message'; message: Message }
  /** A target's presence flipped — update the dots without a poll. */
  | { type: 'presence'; endpointId: EndpointId; presence: PresenceStatus; lastSeenAt: IsoTimestamp }
  /** The group's endpoint list changed → rebuild context menus + chooser. [0001] */
  | { type: 'endpoint_added'; endpoint: Endpoint }
  | { type: 'endpoint_removed'; endpointId: EndpointId }
  | { type: 'endpoint_updated'; endpoint: Endpoint }
  /** Sent to the SOURCE endpoint when a target acks — drains the ⏳ pending row without polling. [0010] */
  | { type: 'acked'; messageId: MessageId; targetEndpointId: EndpointId; ackedAt: IsoTimestamp }
  | { type: 'pong' };

/** Client → server events. (Acks still go over REST for durability.) */
export type ClientStreamEvent =
  | { type: 'hello'; deviceToken: DeviceToken }
  | { type: 'ping' };

/**
 * WS lifecycle  [Chunk 2 lock]:
 * - The client sends `{ type: 'hello', deviceToken }` as its FIRST frame. The
 *   server authenticates it, marks the endpoint present, and only then streams
 *   ServerStreamEvents; a socket that is unauthenticated or presents a bad token
 *   is closed without ever receiving events.
 * - The client pings every WS_CLIENT_PING_INTERVAL_SECONDS; the server replies
 *   `{ type: 'pong' }`. A hello or ping also refreshes presence (§1).
 * - The socket is LATENCY-ONLY: on any drop the client reconnects (with backoff)
 *   and pulls `GET /v1/messages?pending=1`. Nothing depends on it for
 *   correctness — push + queue always deliver. [0001][PRD §6.1]
 */

// ===========================================================================
// 12. Constants
// ===========================================================================

export const DEFAULT_MESSAGE_TTL_DAYS = 7;      // PRD §6.1
export const PAIRING_CODE_TTL_MINUTES = 10;     // short-lived join window
export const API_VERSION = 'v1' as const;

/** lastSeenAt within this window ⇒ presence 'online'. Server-derived; heartbeat/
 *  reconnect cadence MUST be shorter than this so a live endpoint never flaps. [Chunk 2] */
export const PRESENCE_ONLINE_THRESHOLD_SECONDS = 90;
/** Client → server ping cadence on the fast-path WebSocket (§11). [Chunk 2] */
export const WS_CLIENT_PING_INTERVAL_SECONDS = 30;
