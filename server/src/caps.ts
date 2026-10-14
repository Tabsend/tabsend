import type { GroupLimit } from '@tabsend/shared'
import type { Kysely, RawBuilder } from 'kysely'
import { sql } from 'kysely'
import type { GroupCapDefaults } from './config'
import type { Database } from './db/schema'
import { hitQuota } from './quota'
import { addMs, iso } from './time'

/**
 * Per-group caps [0030] (HOSTED_PLAN §4.3) — endpoint count, queued messages,
 * queued bytes, and sends per window.
 *
 * The byte cap bounds STORED bytes, which is not the same as queued ones. Amended
 * 2026-08-20 (ADR-0030's amendment): it used to sum `octet_length(envelope)` over live
 * rows alone, and `history_blob` survives ack for HISTORY_RETENTION_DAYS ([0028]), so a
 * capped group could ack its way to an empty queue and go on storing blobs forever with
 * nothing measuring them. Both halves are counted now — see {@link storedBytesOf}.
 *
 * INVARIANT — no cap is ever decided in JavaScript. Every count and every sum lives
 * inside the WHERE clause of the statement that would exceed it, so the database
 * either performs the write or performs nothing; this module never reads a total and
 * then decides. That is what §10.1 asks for ("every cap still enforced *exactly* at a
 * further 10× overload — the limiter must not go approximate under pressure"), and it
 * is the one property a check-then-insert cannot have at any load.
 *
 * On SQLite that guard is sufficient on its own: better-sqlite3 is synchronous and
 * SQLite serialises writers, so no second writer can slip between the WHERE and the
 * INSERT. On Postgres it is NOT sufficient by itself — READ COMMITTED gives each
 * statement a snapshot taken at its start, so two concurrent senders both see the
 * pre-insert count and both write, overshooting by one per racer. {@link lockGroup}
 * closes that: the group row is held FOR UPDATE first, the loser blocks, and the
 * guarded insert it then runs takes a FRESH snapshot that includes the winner's row.
 *
 * That hold is now taken on EVERY group-scoped write, capped or not [0031 amended],
 * and the reason is no longer about caps at all: `deleteGroupCascade` holds the same
 * row, so a send landing while a tenancy is being torn down either finishes before the
 * deletion sees it or finds the group gone and writes nothing. It used to be taken only
 * where a cap could refuse ({@link capsActive}), which left the uncapped relay running
 * unserialised inserts — cheaper, and the exact shape that let an in-flight send strand
 * ciphertext in a group that had just been deleted. What `capsActive` still decides is
 * whether the inserts are the GUARDED ones; an uncapped relay runs the plain insert it
 * always ran, inside a transaction that costs it one indexed read.
 *
 * Not here: suspension. It landed in [0031] as its own group-row state
 * (`groups.suspended_at`, tenancy.ts) rather than as "caps to zero", because the two
 * answer different questions — a cap says how much, suspension says whether — and a
 * kill switch spelled as a cap would have destroyed whatever numbers the operator had
 * set the moment it was lifted. Still not here: per-ACCOUNT limits, because the relay
 * knows no accounts (§3, [0029]).
 */

/** The four caps in force for one group, after overrides. `<= 0` means unlimited. */
export interface GroupCaps {
  endpoints: number
  queuedMessages: number
  queuedBytes: number
  sendsPerWindow: number
  /** Window for `sendsPerWindow`, in ms. Relay-wide; not overridable per group. */
  sendWindowMs: number
}

/**
 * Per-group overrides as stored. `undefined` leaves a cap untouched by a write and
 * means "no override" on a read; `null` clears one back to the relay-wide default.
 */
export interface GroupCapOverrides {
  endpoints?: number | null
  queuedMessages?: number | null
  queuedBytes?: number | null
  sendsPerWindow?: number | null
}

/**
 * Could any cap refuse a SEND? False ⇒ the send path takes the unguarded, pre-[0030]
 * route: no transaction, no group lock, the same insert it always ran.
 *
 * Deliberately not "is any cap set at all". The endpoint cap can only refuse a join,
 * so a relay that caps devices and nothing else must not have every send serialised
 * behind a group lock for a limit that cannot apply to it.
 */
export function capsActive(caps: GroupCaps): boolean {
  return caps.queuedMessages > 0 || caps.queuedBytes > 0 || caps.sendsPerWindow > 0
}

/**
 * The rows a QUEUE cap counts: handed to the relay, not yet collected, not expired.
 *
 * One definition, used by the guard that refuses a send (below) and by the usage report
 * the provisioning API answers with (`tenancy.groupUsage`). They have to be the same set
 * of rows or the number an operator acts on is not the number that refused their
 * customer — and they were two hand-copied WHERE clauses before this, which is exactly
 * how that drifts. Mirrors `?pending=1` (routes/messages.ts): acked and expired rows are
 * no longer queued, so a group at its cap drains itself as its devices read their tabs.
 */
export function liveQueuedMessages(groupId: string, nowIso: string): RawBuilder<boolean> {
  return sql<boolean>`group_id = ${groupId} and acked_at is null
    and envelope is not null and expires_at > ${nowIso}`
}

/**
 * The rows whose history blob the relay still promises to serve [0028]: a blob is
 * present and the row is inside HISTORY_RETENTION_DAYS.
 *
 * Same reason for existing as {@link liveQueuedMessages}, and the same two readers. The
 * window is the one `?history=1` serves and the one the sweeper prunes by, so bytes stop
 * counting against a group at the moment the relay stops owing it anything for them —
 * not at the moment the sweeper next happens to run. With history switched off
 * (`HISTORY_RETENTION_DAYS=0`) the cutoff is `now`, nothing matches, and blobs count for
 * nothing: they are still accepted, but not stored (since 2026-10-13), so there is
 * nothing to count.
 */
export function storedHistoryBlobs(groupId: string, historyCutoffIso: string): RawBuilder<boolean> {
  return sql<boolean>`group_id = ${groupId} and history_blob is not null
    and created_at > ${historyCutoffIso}`
}

/**
 * The instant a stored history blob leaves its retention window: `now - retention`.
 * Named once so the guard, the usage report and the history read cannot disagree about
 * where the window starts.
 */
export function historyCutoff(now: Date, historyRetentionMs: number): string {
  return iso(addMs(now, -Math.max(0, historyRetentionMs)))
}

/**
 * Bytes this group has the relay storing, as one SQL scalar: queued envelopes plus
 * retained history blobs, each over its own predicate above.
 *
 * A SUB-EXPRESSION, never a query this module runs and then decides on — it goes inside
 * the WHERE of the insert it would refuse, which is the module invariant. `octet_length`
 * is the column as the relay actually holds it, not a client's claim about it and not
 * the plaintext it cannot read.
 */
export function storedBytesOf(groupId: string, nowIso: string, historyCutoffIso: string) {
  return sql`
    (select coalesce(sum(octet_length(envelope)), 0) from messages
      where ${liveQueuedMessages(groupId, nowIso)})
    + (select coalesce(sum(octet_length(history_blob)), 0) from messages
      where ${storedHistoryBlobs(groupId, historyCutoffIso)})
  `
}

/**
 * The caps in force for `groupId`: the group's own override where it has one, the
 * relay-wide default otherwise.
 *
 * NULL and 0 are different answers and stay different. NULL is "nobody set one here",
 * so the group follows the relay; 0 is "somebody set unlimited here", which must keep
 * meaning unlimited even after an operator raises the relay-wide default. Collapsing
 * them would make every deliberate exemption evaporate on the next config change.
 */
export async function effectiveCaps(
  db: Kysely<Database>,
  defaults: GroupCapDefaults,
  groupId: string,
): Promise<GroupCaps> {
  const row = await db
    .selectFrom('groups')
    .select(CAP_COLUMNS)
    .where('id', '=', groupId)
    .executeTakeFirst()
  return capsFromRow(row, defaults)
}

/** The override columns, named once so every reader of the group row selects the same set. */
export const CAP_COLUMNS = [
  'cap_endpoints',
  'cap_queued_messages',
  'cap_queued_bytes',
  'cap_sends_per_window',
] as const

/** Just the override columns of a `groups` row — what {@link capsFromRow} needs. */
export type GroupCapRow = Pick<Database['groups'], (typeof CAP_COLUMNS)[number]>

/**
 * Resolve one group row's overrides against the relay-wide defaults.
 *
 * Split out of {@link effectiveCaps} so a caller that is ALREADY reading the group row
 * for another reason does not read it twice. `readGroupGate` (tenancy.ts) is that
 * caller: suspension [0031] and the caps live in the same row, are needed at the same
 * moment on the send and register paths, and asking for them separately would have
 * added a round trip per send on every relay, capped or not.
 *
 * A missing row falls back to the relay-wide defaults rather than throwing: the caller
 * that cares whether the group exists checks that itself, and the caps of a group that
 * is not there decide nothing.
 */
export function capsFromRow(row: GroupCapRow | undefined, defaults: GroupCapDefaults): GroupCaps {
  return {
    endpoints: pick(row?.cap_endpoints, defaults.endpoints),
    queuedMessages: pick(row?.cap_queued_messages, defaults.queuedMessages),
    queuedBytes: pick(row?.cap_queued_bytes, defaults.queuedBytes),
    sendsPerWindow: pick(row?.cap_sends_per_window, defaults.sendsPerWindow),
    sendWindowMs: defaults.sendWindowMs,
  }
}

function pick(override: number | null | undefined, fallback: number): number {
  return override === null || override === undefined ? fallback : Number(override)
}

/**
 * Read a group's overrides as set (NOT the effective caps). The read half of the
 * small surface the §4.2 provisioning API will call; plain functions rather than
 * routes, because the route that exposes them is authenticated and audited in a way
 * that is not this chunk's decision to make.
 */
export async function getGroupCapOverrides(
  db: Kysely<Database>,
  groupId: string,
): Promise<GroupCapOverrides> {
  const row = await db
    .selectFrom('groups')
    .select(CAP_COLUMNS)
    .where('id', '=', groupId)
    .executeTakeFirst()
  return row ? capOverridesFromRow(row) : {}
}

/**
 * One group row's overrides as SET, without a read of its own.
 *
 * The same split {@link capsFromRow} is, for the same caller: the provisioning API
 * answers with the overrides AND what they resolve to, and reading the one row twice
 * to say two things about it is a round trip nobody needs.
 */
export function capOverridesFromRow(row: GroupCapRow): GroupCapOverrides {
  return {
    endpoints: nullable(row.cap_endpoints),
    queuedMessages: nullable(row.cap_queued_messages),
    queuedBytes: nullable(row.cap_queued_bytes),
    sendsPerWindow: nullable(row.cap_sends_per_window),
  }
}

function nullable(value: number | null): number | null {
  return value === null ? null : Number(value)
}

/**
 * Set (or clear) a group's cap overrides. The write half of the provisioning surface.
 *
 * PATCH semantics: an omitted field is left alone, an explicit `null` clears the
 * override back to the relay-wide default. Anything else is stored as given, including
 * 0 for "unlimited for this group whatever the relay says". Returns false when there
 * is no such group, so a caller cannot mistake a typo'd id for a successful write.
 */
export async function setGroupCapOverrides(
  db: Kysely<Database>,
  groupId: string,
  overrides: GroupCapOverrides,
): Promise<boolean> {
  const patch: Record<string, number | null> = {}
  if ('endpoints' in overrides) patch.cap_endpoints = overrides.endpoints ?? null
  if ('queuedMessages' in overrides) patch.cap_queued_messages = overrides.queuedMessages ?? null
  if ('queuedBytes' in overrides) patch.cap_queued_bytes = overrides.queuedBytes ?? null
  if ('sendsPerWindow' in overrides) patch.cap_sends_per_window = overrides.sendsPerWindow ?? null
  if (Object.keys(patch).length === 0) {
    const exists = await db
      .selectFrom('groups')
      .select('id')
      .where('id', '=', groupId)
      .executeTakeFirst()
    return exists !== undefined
  }
  const result = await db
    .updateTable('groups')
    .set(patch)
    .where('id', '=', groupId)
    .executeTakeFirst()
  return Number(result?.numUpdatedRows ?? 0n) > 0
}

/**
 * Take this group's row and hold it for the rest of the transaction. Answers whether
 * the group is still there.
 *
 * TWO JOBS, and it grew the second one on purpose. The first is cap accounting: a
 * count-guarded insert cannot be trusted on Postgres until the row is held, because
 * READ COMMITTED gives each statement a snapshot taken at its start and two senders
 * would both see the pre-insert count (see the module note). The second is TENANCY
 * LIFETIME [0031 amended]: `deleteGroupCascade` holds the same row, so a write and a
 * deletion of the group it belongs to can no longer interleave — whichever gets the
 * row first finishes, and the other one sees the finished state rather than half of it.
 *
 * `FOR UPDATE` is Postgres-only and stays that way. SQLite needs no lock because
 * Kysely serves it through ONE connection behind a mutex, so a transaction there is
 * already exclusive of every other statement in the process; what SQLite does need is
 * the existence answer, which is why the SELECT runs on both dialects.
 *
 * Returns FALSE when the group row is gone. On Postgres that is the interesting
 * answer: a caller that blocked on a concurrent deletion is released once it commits,
 * re-reads under a fresh snapshot, and finds nothing — which is precisely the moment
 * it must not write a row naming a tenancy that no longer exists.
 *
 * TAKE IT FIRST, before any other row lock in the transaction [0031 amended
 * 2026-10-01]. Every path that holds the group row also touches other rows under it
 * (a deletion and a first-link mint delete pairing codes, a join consumes one), and two
 * transactions that take the same two locks in opposite orders deadlock: Postgres
 * breaks the cycle after a second by failing one of them with a 500. The join once
 * consumed its pairing code and only then reached the group row, through its endpoint
 * insert's foreign key, which is exactly that cycle against a deletion or a re-mint.
 * One order everywhere, group row first, is what rules it out.
 *
 * Must be called INSIDE a transaction, or the lock is released immediately and buys
 * nothing.
 */
export async function lockGroup(
  trx: Kysely<Database>,
  postgres: boolean,
  groupId: string,
): Promise<boolean> {
  let query = trx.selectFrom('groups').select('id').where('id', '=', groupId)
  if (postgres) query = query.forUpdate()
  return (await query.executeTakeFirst()) !== undefined
}

/** What a guarded insert did. `capped` names which limit refused it, when one did. */
export interface GuardOutcome {
  inserted: boolean
  /** True when the row was already there — an idempotent replay, not a refusal. */
  duplicate: boolean
  capped?: GroupLimit
}

/** The endpoint columns a join writes. Mirrors `enrollEndpoint` in routes/endpoints.ts. */
export interface EndpointInsert {
  id: string
  group_id: string
  kind: string
  browser: string | null
  platform: string
  label: string
  device_name: string | null
  e2e_pubkey: string
  push_subscription: string
  push_failures: number
  device_token_hash: string
  last_seen_at: string
  created_at: string
}

/**
 * Insert an endpoint only while its group is under the endpoint cap.
 *
 * One statement: `INSERT INTO endpoints (…) SELECT ?,?,… WHERE (SELECT count(*) FROM
 * endpoints WHERE group_id = ?) < ?`. Zero rows affected means the count check failed,
 * which is the only way this insert can do nothing — the id is freshly minted, so
 * there is no conflict to confuse it with.
 */
export async function insertEndpointWithinCap(
  trx: Kysely<Database>,
  row: EndpointInsert,
  cap: number,
): Promise<GuardOutcome> {
  const result = await sql`
    insert into endpoints (
      id, group_id, kind, browser, platform, label, device_name,
      e2e_pubkey, push_subscription, push_failures, device_token_hash,
      last_seen_at, created_at
    )
    select
      ${row.id}, ${row.group_id}, ${row.kind}, ${row.browser}, ${row.platform},
      ${row.label}, ${row.device_name}, ${row.e2e_pubkey}, ${row.push_subscription},
      ${row.push_failures}, ${row.device_token_hash}, ${row.last_seen_at}, ${row.created_at}
    where (select count(*) from endpoints where group_id = ${row.group_id}) < ${cap}
  `.execute(trx)
  if (Number(result.numAffectedRows ?? 0n) > 0) return { inserted: true, duplicate: false }
  return { inserted: false, duplicate: false, capped: 'endpoints' }
}

/** The message columns a send writes. Mirrors the insert in routes/messages.ts. */
export interface MessageInsert {
  id: string
  group_id: string
  source_endpoint_id: string
  target_endpoint_id: string
  envelope: string
  history_blob: string | null
  created_at: string
  expires_at: string
}

/**
 * Insert one queued message only while its group is under BOTH queue caps.
 *
 * One statement again, with both checks in the same WHERE:
 *
 *   INSERT INTO messages (…)
 *   SELECT ?,?,…
 *   WHERE (SELECT count(*)      FROM messages WHERE <live for group>) < ?
 *     AND (<stored bytes for group>) + ? <= ?
 *   ON CONFLICT (id) DO NOTHING
 *
 * Three things the plan pins, and where each lands:
 *
 *  - **Bytes measure what the relay STORES for the group** ({@link storedBytesOf}):
 *    queued envelopes plus the history blobs still inside HISTORY_RETENTION_DAYS. The
 *    row being inserted is charged for both of its own halves (`+ ?`), so the cap bounds
 *    what the group holds after the write rather than before it. ADR-0030 originally
 *    read `HOSTED_PLAN` §4.3's "byte caps measure the stored envelope" as excluding
 *    `history_blob`, on the grounds that a delivery-queue cap should not drift with a
 *    retention setting. The consequence was worse than the drift: a blob survives ack
 *    ([0028]) and nothing else measures it, so a capped group could send, ack, repeat,
 *    and store unbounded bytes while every cap reported healthy. A cap on bytes now
 *    bounds bytes.
 *  - **A replay never counts twice.** `ON CONFLICT (id) DO NOTHING` is still the
 *    dedupe point, and it sits AFTER the cap check for a reason: a replay whose row is
 *    already stored must be accepted, not refused, even by a group that has since
 *    filled up. So zero rows affected is disambiguated by one cheap re-read — the row
 *    is either there (replay: accepted, nothing counted) or it is not (capped).
 *  - **Only live rows count toward the QUEUE cap.** Acked and expired messages are no
 *    longer queued, so they are excluded exactly as `?pending=1` excludes them. A group
 *    at its message cap drains itself simply by its devices reading their tabs; a group
 *    at its BYTE cap drains as those rows leave the history window too.
 */
export async function insertMessageWithinCaps(
  trx: Kysely<Database>,
  row: MessageInsert,
  caps: GroupCaps,
  nowIso: string,
  historyCutoffIso: string,
): Promise<GuardOutcome> {
  const bytes =
    Buffer.byteLength(row.envelope, 'utf8') +
    (row.history_blob === null ? 0 : Buffer.byteLength(row.history_blob, 'utf8'))
  const messageCap = caps.queuedMessages > 0 ? caps.queuedMessages : null
  const byteCap = caps.queuedBytes > 0 ? caps.queuedBytes : null

  // Named rather than indexed out of an array: an `undefined` reaching a `sql`
  // interpolation would become a NULL parameter, the WHERE would never be true, and
  // every send would silently read as capped.
  const countGuard =
    messageCap === null
      ? sql`1 = 1`
      : sql`(select count(*) from messages
              where ${liveQueuedMessages(row.group_id, nowIso)}) < ${messageCap}`
  const byteGuard =
    byteCap === null
      ? sql`1 = 1`
      : sql`(${storedBytesOf(row.group_id, nowIso, historyCutoffIso)}) + ${bytes} <= ${byteCap}`

  const result = await sql`
    insert into messages (
      id, group_id, source_endpoint_id, target_endpoint_id,
      envelope, history_blob, created_at, expires_at, delivered_at, acked_at
    )
    select
      ${row.id}, ${row.group_id}, ${row.source_endpoint_id}, ${row.target_endpoint_id},
      ${row.envelope}, ${row.history_blob}, ${row.created_at}, ${row.expires_at}, null, null
    where ${countGuard} and ${byteGuard}
    on conflict (id) do nothing
  `.execute(trx)
  if (Number(result.numAffectedRows ?? 0n) > 0) return { inserted: true, duplicate: false }

  // Zero rows: either the dedupe swallowed it or a cap refused it. Ask.
  const existing = await trx
    .selectFrom('messages')
    .select('id')
    .where('id', '=', row.id)
    .executeTakeFirst()
  if (existing) return { inserted: false, duplicate: true }

  // Which cap refused it. Re-counted only on the refusal path, so the common path
  // pays nothing for the diagnosis — and the answer is only ever used to name a
  // limit in the response, never to decide whether to write. Same predicate as the
  // guard above, for the same reason it is shared everywhere else.
  if (messageCap !== null) {
    const count = await sql<{ n: unknown }>`
      select count(*) as n from messages where ${liveQueuedMessages(row.group_id, nowIso)}
    `.execute(trx)
    if (Number(count.rows[0]?.n ?? 0) >= messageCap)
      return { inserted: false, duplicate: false, capped: 'queued_messages' }
  }
  return { inserted: false, duplicate: false, capped: 'queued_bytes' }
}

/**
 * What one device mint did. `gone` is the group deleted underneath the caller;
 * `caller_gone` is the minting device removed from its group while the request was in
 * flight.
 */
export type PairingMintOutcome = 'minted' | 'capped' | 'gone' | 'caller_gone'

/** The pairing-code columns a mint writes. Mirrors the insert in routes/pairing.ts. */
export interface PairingCodeInsert {
  code: string
  group_id: string
  created_at: string
  expires_at: string
}

/**
 * The pairing codes a group is currently HOLDING: minted, not yet used, not yet
 * expired.
 *
 * Named here beside the other cap predicates and for the same reason they are: the
 * guard that refuses a mint and anything that later reports how many a group has must
 * count the same rows. Consumed and expired codes are not held — a consumed one is
 * spent and an expired one opens nothing — so a group at its limit clears itself
 * simply by time passing, exactly as a full queue clears as tabs are read.
 */
export function livePairingCodes(groupId: string, nowIso: string): RawBuilder<boolean> {
  return sql<boolean>`group_id = ${groupId} and consumed_at is null
    and expires_at > ${nowIso}`
}

/**
 * Insert a device-minted pairing code [0031 amended]: only while the group is under the
 * live-code limit, and only while the device asking is still in the group. Reports
 * which of the four things happened.
 *
 * ONE TRANSACTION HOLDING THE GROUP ROW, with the limit on or off, because two of the
 * three things it decides have nothing to do with the limit:
 *
 *  - **The group is still there.** A mint racing a deletion finds no group and writes
 *    nothing. Reported apart from `capped` because the two need different words: "this
 *    group already has 20 links waiting" is exactly the wrong thing to tell somebody
 *    whose group is gone. With the limit off this used to be a bare insert, which met
 *    the deletion on the foreign key instead and answered 500.
 *  - **The caller is still in it.** A device removed while its mint was in flight must
 *    not walk away with a credential into the group it was just removed from. The
 *    removal holds the same row (routes/endpoints.ts), so the two cannot interleave:
 *    either the mint lands while the device was still a member, or the removal lands
 *    first and this finds no caller. It also closes the one way a populated group
 *    could still end up holding an unclaimed first-run link: a last device's in-flight
 *    mint landing after it removed itself.
 *  - **The live-code limit.** The same two-part shape every other cap here uses: the
 *    count lives inside the WHERE of the insert, so the database decides, and the hold
 *    makes Postgres decide it against a snapshot that already includes the other
 *    racer's row. Without the hold, mints arriving together each count the same
 *    pre-insert total and a limit of three admits six (`caps.test.ts` pins this by
 *    holding the row itself and queueing the mints behind it). A limit that goes
 *    approximate exactly when something is hammering it is not a limit, which is
 *    §10.1's whole point.
 */
export async function insertPairingCodeWithinCap(
  db: Kysely<Database>,
  postgres: boolean,
  row: PairingCodeInsert,
  callerEndpointId: string,
  cap: number,
  nowIso: string,
): Promise<PairingMintOutcome> {
  return db.transaction().execute(async (trx) => {
    if (!(await lockGroup(trx, postgres, row.group_id))) return 'gone'

    // Not a cap, so not subject to the module invariant: a membership fact, read under
    // the hold that every write to it also takes, which is what makes the read exact.
    const caller = await trx
      .selectFrom('endpoints')
      .select('id')
      .where('id', '=', callerEndpointId)
      .where('group_id', '=', row.group_id)
      .executeTakeFirst()
    if (!caller) return 'caller_gone'

    // Named rather than inlined for the reason insertMessageWithinCaps gives: an
    // undefined reaching a `sql` interpolation would read every mint as capped.
    const countGuard =
      cap > 0
        ? sql`(select count(*) from pairing_codes
                where ${livePairingCodes(row.group_id, nowIso)}) < ${cap}`
        : sql`1 = 1`
    const result = await sql`
      insert into pairing_codes (code, group_id, created_at, expires_at, consumed_at)
      select ${row.code}, ${row.group_id}, ${row.created_at}, ${row.expires_at}, null
      where ${countGuard}
    `.execute(trx)
    return Number(result.numAffectedRows ?? 0n) > 0 ? 'minted' : 'capped'
  })
}

/** The group-key columns an upload writes. Mirrors the insert in routes/group-keys.ts. */
export interface GroupKeyInsert {
  id: string
  group_id: string
  source_endpoint_id: string
  target_endpoint_id: string
  envelope: string
  created_at: string
}

/**
 * Insert one sealed copy of the group history key only while its TARGET holds fewer
 * than `maxPerTarget` copies [0030 amended 2026-10-01].
 *
 * A structural bound, not a cap in [0030]'s sense, and that is why it is always on.
 * What legitimately lands here is one copy per key generation per recipient: a device
 * is handed the current key once, and again only when the group rotates. So a target
 * holding dozens of copies is not a busy group, it is somebody storing bytes. Before
 * this, the only count on this table was the send window, which is off by default and
 * optional per group, so a tenant (a suspended one included) could store copies without
 * end while every number an operator reads said it was inside its quota.
 *
 * Counted per target over every copy it holds, not over a time window: copies leave by
 * the sweeper at the history cutoff, with their endpoint, or with their group, and a
 * window would stop bounding anything the moment history is switched off.
 *
 * Zero rows affected means either the dedupe swallowed it or the bound refused it, so,
 * exactly as {@link insertMessageWithinCaps} does, one re-read tells them apart.
 */
export async function insertGroupKeyWithinBound(
  trx: Kysely<Database>,
  row: GroupKeyInsert,
  maxPerTarget: number,
): Promise<{ inserted: boolean; duplicate: boolean }> {
  const result = await sql`
    insert into group_keys (
      id, group_id, source_endpoint_id, target_endpoint_id, envelope, created_at
    )
    select
      ${row.id}, ${row.group_id}, ${row.source_endpoint_id}, ${row.target_endpoint_id},
      ${row.envelope}, ${row.created_at}
    where (select count(*) from group_keys
            where target_endpoint_id = ${row.target_endpoint_id}) < ${maxPerTarget}
    on conflict (id) do nothing
  `.execute(trx)
  if (Number(result.numAffectedRows ?? 0n) > 0) return { inserted: true, duplicate: false }
  const existing = await trx
    .selectFrom('group_keys')
    .select('id')
    .where('id', '=', row.id)
    .executeTakeFirst()
  return { inserted: false, duplicate: existing !== undefined }
}

/**
 * Count one accepted send against the group's sends-per-window cap, in the shared
 * store (§4.4) rather than in this process. Unlimited caps write nothing.
 */
export async function hitSendWindow(
  db: Kysely<Database>,
  caps: GroupCaps,
  groupId: string,
  now: Date,
): Promise<boolean> {
  const { ok } = await hitQuota(db, {
    scope: 'group_sends',
    key: groupId,
    max: caps.sendsPerWindow,
    windowMs: caps.sendWindowMs,
    now,
  })
  return ok
}
