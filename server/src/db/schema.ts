import type { Selectable } from 'kysely'

/**
 * Kysely table interfaces — written dialect-agnostically (TEXT for timestamps as
 * ISO-8601 UTC, which sorts chronologically; INTEGER 0/1 for booleans). The
 * Postgres dialect (Chunk 4a) reuses these interfaces unchanged.
 *
 * Presence is NOT a column: it's derived from `last_seen_at` + live WS at read
 * time. Push subscriptions live on the endpoint row but are NEVER projected to
 * peers (see mappers.toEndpoint).
 */
export interface GroupsTable {
  id: string
  created_at: string
  /**
   * RETIRED [0029]. Both date from the original account-shaped model, were written
   * once ('free', 0) and never read, and are no longer created on a fresh database.
   * A database predating [0029] still HAS them, so they stay declared and OPTIONAL:
   * optional is the honest shape when the column may or may not be there, and it is
   * what lets an INSERT omit them. Never read either one — the relay knows no plan
   * (HOSTED_PLAN §2.2). See `legacyGroupDefaults` for the write side.
   */
  plan?: string
  has_email?: number
  /**
   * Per-group cap OVERRIDES [0030] (HOSTED_PLAN §4.3). NULL means "no override,
   * use the relay-wide default from env"; a number wins over that default, and
   * `<= 0` means unlimited — the same "0 switches it off" spelling `RATE_LIMIT_MAX`
   * already uses, so an operator does not have to learn a second convention.
   *
   * Explicit values on the group row, and nothing else: the relay knows no plans
   * and no accounts (HOSTED_PLAN §2.2, [0029]), so a cap here is a number somebody
   * set, never a tier the relay has to interpret. Written by `setGroupCapOverrides`
   * (caps.ts), which is what the §4.2 provisioning API will call.
   */
  cap_endpoints: number | null
  cap_queued_messages: number | null
  cap_queued_bytes: number | null
  cap_sends_per_window: number | null
  /**
   * When this group's tenancy was suspended [0031] (HOSTED_PLAN §5), or NULL while
   * it is running normally. A TIMESTAMP rather than a flag because "since when" is
   * the question an operator actually asks, and a grace period is counted from it.
   *
   * Suspension stops the group ACCEPTING work — sends, joins, new pairing links —
   * and stops nothing else: devices stay paired, queued tabs still drain, acks still
   * erase ciphertext, history still reads. The failure mode being avoided is a card
   * expiring on holiday and somebody's devices silently unpairing themselves. Set
   * only through the provisioning API (routes/provisioning.ts); nothing a client
   * does can change it.
   */
  suspended_at: string | null
  /**
   * A RESET THAT WAITS (PLANS P-18 item 12): the control plane has scheduled this
   * group to be replaced by a fresh, empty one, and every paired device gets the
   * wait to see it and stop it. All three NULL on a group nobody ever asked to reset.
   *
   * A reset is PENDING exactly while `reset_requested_at` and `reset_at` are both
   * set: `reset_requested_at` is when the control plane asked, `reset_at` is when it
   * means to carry it out. Set only through the provisioning API; cleared by the
   * control plane (the account owner cancelled) or by any device in the group (Stop).
   *
   * `reset_stopped_at` is when a DEVICE last stopped one, kept after the pending pair
   * is cleared so the control plane can tell "a device said no" from "nobody acted".
   * A new schedule clears it; the account owner cancelling leaves it alone.
   *
   * The relay never starts a reset on its own. When the time comes the control plane
   * calls `reset/run`, which deletes the group only if the reset is still pending and
   * due, then makes a new group and its first link: ADR-0021's own remedy. Nothing
   * here opens a way into THIS group.
   * Group-level timestamps, not per-device facts, so they may appear in usage.
   */
  reset_requested_at: string | null
  reset_at: string | null
  reset_stopped_at: string | null
}

export interface EndpointsTable {
  id: string
  group_id: string
  kind: string
  browser: string | null
  platform: string
  label: string
  /** Device grouping hint (ADDITIVE, 5-ext). Nullable — pre-existing rows are null. */
  device_name: string | null
  e2e_pubkey: string
  /** JSON-encoded PushSubscription — server-held secret, the wake channel. */
  push_subscription: string
  /** Consecutive 404/410 push failures. At the dead threshold the relay stops waking
   *  this subscription (client heartbeat rotates a fresh one → resets to 0). ADDITIVE (6b). */
  push_failures: number
  /** SHA-256(base64url) of the device token; the raw token is never stored. */
  device_token_hash: string
  last_seen_at: string
  created_at: string
}

export interface MessagesTable {
  /** Client-generated (MessageId) — primary key, so replays dedupe server-side. */
  id: string
  group_id: string
  source_endpoint_id: string
  target_endpoint_id: string
  /** JSON-encoded EncryptedEnvelope; nulled on ack (routing row is retained). */
  envelope: string | null
  /**
   * JSON-encoded GroupSealed — the group-history copy of this send [0028].
   *
   * Deliberately NOT nulled on ack, unlike `envelope`: the envelope exists to be
   * delivered once, this exists to be read for the history window. Null for a
   * send from a client predating ADR-0028, or from a group with no history key.
   * Opaque to the relay either way; it holds no key that can open it.
   */
  history_blob: string | null
  created_at: string
  expires_at: string
  delivered_at: string | null
  acked_at: string | null
}

/**
 * One copy of a group's history key, sealed to one endpoint [0028].
 *
 * Its own table rather than the message queue: this is control traffic, not a
 * tab, and routing it as a tab would make every already-shipped client try to
 * open it. Rows are NOT deleted on read — a device that fetches and then crashes
 * before persisting must be able to fetch again — so the sweeper ages them out.
 */
export interface GroupKeysTable {
  /** Client-generated UUID; primary key, so a replay dedupes server-side. */
  id: string
  group_id: string
  source_endpoint_id: string
  target_endpoint_id: string
  /** JSON-encoded EncryptedEnvelope, sealed to the target's e2ePubkey. Opaque here. */
  envelope: string
  created_at: string
}

export interface PairingCodesTable {
  code: string
  group_id: string
  created_at: string
  expires_at: string
  consumed_at: string | null
}

/**
 * Endpoints deliberately removed from a group — a tombstone, kept so the relay can
 * tell "you were kicked out" apart from "I have never heard of this token".
 *
 * Both look identical at the endpoints table: the row is simply absent. Clients
 * used to read that single ambiguous 401 as removal and unpair themselves, so a
 * relay restored from backup or restarted on an empty database silently
 * un-paired every device and dropped their queued sends. Only a token matching a
 * tombstone is proof of removal; anything else is an unknown token, and the
 * client is told to hold on to its pairing.
 */
export interface RemovedEndpointsTable {
  /** SHA-256(base64url) of the removed endpoint's device token. */
  device_token_hash: string
  endpoint_id: string
  group_id: string
  removed_at: string
}

/**
 * Relay-scoped key/value facts (ADDITIVE, P-4). Holds stable identity material:
 * `relay_id` and the auto-provisioned VAPID keypair. Neither is overwritten, so
 * address changes/restarts preserve relay identity and browser push subscriptions.
 */
export interface MetaTable {
  key: string
  value: string
}

/**
 * The shared counter store [0030] (HOSTED_PLAN §4.4): every fixed-window count the
 * relay enforces, in the database instead of in one process's memory.
 *
 * Before this, the register rate limiter kept its buckets in a `Map`, documented as
 * per-instance-honest because the relay is a single-instance deployment (ADR-0012).
 * That is still true of the WebSocket hub, but a LIMIT is different in kind: two
 * relay processes over one database would each hand out the full budget, and nothing
 * anywhere would say so. Here the budget is one row, and both processes contend for it.
 *
 * Keyed (scope, key, window_start) so unrelated limits cannot collide:
 *  - `register_ip`  — key is the client IP (RATE_LIMIT_MAX / RATE_LIMIT_WINDOW_SECONDS)
 *  - `group_sends`  — key is the group id (the sends-per-window cap, §4.3)
 *
 * `window_end` is stored rather than derived so the sweeper can drop expired rows
 * without knowing what window length produced them — a window length changed by an
 * operator between boots must not strand rows nobody can date.
 */
export interface QuotaCountersTable {
  /** Which limit this counts. Namespaces the key, so an IP and a group id never meet. */
  scope: string
  /** The subject being counted: a client IP, a group id. Opaque to the store. */
  key: string
  /** ISO-8601 UTC start of the fixed window, aligned to a multiple of its length. */
  window_start: string
  /** ISO-8601 UTC end of that window; the sweeper's only clock. */
  window_end: string
  /** Hits recorded in this window. Only ever incremented, and only by the database. */
  hits: number
}

/**
 * Which group a control-plane `Idempotency-Key` already brought into being [0031]
 * (HOSTED_PLAN §4.2).
 *
 * `POST /admin/provisioning/groups` is the one route where a retry is expensive: a
 * signup that times out and is retried would otherwise leave the account owning two
 * tenancies, one of which nobody ever names again. The key is the PRIMARY KEY, so
 * claiming one is an insert the database either accepts or refuses — the same
 * "never decide in JavaScript" shape the caps use (caps.ts).
 *
 * A record of a CALL, not of a group, so it deliberately outlives the group: a create
 * retried after the tenancy was deleted must not quietly resurrect it under the same
 * key. `deleteGroupCascade` leaves these rows alone for that reason.
 */
export interface ProvisioningIdempotencyTable {
  /** The `Idempotency-Key` header, cleaned to printable ASCII and bounded in length. */
  key: string
  /** The group that key created. May name a group that has since been deleted. */
  group_id: string
  created_at: string
}

export interface Database {
  groups: GroupsTable
  endpoints: EndpointsTable
  messages: MessagesTable
  group_keys: GroupKeysTable
  pairing_codes: PairingCodesTable
  removed_endpoints: RemovedEndpointsTable
  meta: MetaTable
  quota_counters: QuotaCountersTable
  provisioning_idempotency: ProvisioningIdempotencyTable
}

export type GroupRow = Selectable<GroupsTable>
export type EndpointRow = Selectable<EndpointsTable>
export type MessageRow = Selectable<MessagesTable>
export type PairingCodeRow = Selectable<PairingCodesTable>
