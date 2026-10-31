import type { GroupResetState, IsoTimestamp } from '@tabsend/shared'
import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { leftoverEndpoints } from './bootstrap'
import {
  CAP_COLUMNS,
  capOverridesFromRow,
  capsFromRow,
  type GroupCapOverrides,
  type GroupCaps,
  historyCutoff,
  liveQueuedMessages,
  lockGroup,
  storedHistoryBlobs,
} from './caps'
import type { GroupCapDefaults } from './config'
import type { Database } from './db/schema'
import { quotaHits } from './quota'
import { iso } from './time'

/**
 * A group as a TENANCY [0031] (HOSTED_PLAN §4.2, §5): the three things somebody who
 * provisioned a group needs to do to it afterwards, kept out of the routes so the
 * client-facing paths can read the same state without importing a route module.
 *
 *  - **suspension** — the group stops accepting work, and keeps everything it has;
 *  - **usage** — aggregates, and ONLY aggregates (see {@link GroupUsage});
 *  - **deletion** — an idempotent cascade, safe to re-run until everything is gone;
 *  - **a reset that waits** [P-18 item 12] — held and shown here, stoppable by any
 *    device in the group, and never carried out by the relay (see the schema).
 *
 * SUSPENSION SEMANTICS, stated here because they are the part that could be got
 * quietly wrong. HOSTED_PLAN §5 names the failure mode to avoid: somebody's card
 * expires on holiday and their devices silently unpair themselves. So suspension is
 * an ACCEPTANCE gate, never a delivery or an authentication one:
 *
 *  - refused: sending (`POST /v1/messages`), joining (`POST /v1/endpoints/register`),
 *    and minting a pairing link (`POST /v1/pairing`) — everything that would add work
 *    or devices to a tenancy that is not currently paid for;
 *  - untouched: device tokens (nobody is unpaired), collection of already-queued tabs,
 *    acks, group history, the endpoint list, heartbeats and live WebSockets.
 *
 * Letting queued tabs drain is not generosity, it is the only coherent answer: those
 * tabs were accepted while the group was running, ack is what ERASES their ciphertext
 * (ADR-0011), and a suspension that blocked acks would make the relay hold somebody's
 * encrypted data longer for not paying. Group-key distribution (`POST /v1/group-keys`)
 * stays open for the same reason: with joins refused it can only serve devices that are
 * already members, and refusing it would break history reading (ADR-0028) for devices
 * that are still paired and still allowed to read what they have.
 */

/** How long a group has been suspended, or null while it is running. */
export type SuspendedAt = string | null

/**
 * The group-row state every write path has to consult: is this tenancy accepting work,
 * and under what caps. ONE read, because both questions are answered by one row and
 * are asked at the same moment (routes/messages.ts, routes/endpoints.ts).
 */
export interface GroupGate {
  /** False when there is no such group. Its `caps` are then meaningless. */
  exists: boolean
  suspendedAt: SuspendedAt
  caps: GroupCaps
}

/**
 * @param forUpdate hold the row for the rest of the caller's transaction, the way
 * {@link lockGroup} does. Postgres only, and only meaningful inside a transaction:
 * it is what makes a group-scoped write ordered with respect to a concurrent
 * {@link deleteGroupCascade}, so one read answers all three questions a write path
 * has — does this tenancy still exist, is it accepting work, and under what caps.
 */
export async function readGroupGate(
  db: Kysely<Database>,
  defaults: GroupCapDefaults,
  groupId: string,
  forUpdate = false,
): Promise<GroupGate> {
  let query = db
    .selectFrom('groups')
    .select([...CAP_COLUMNS, 'suspended_at'])
    .where('id', '=', groupId)
  if (forUpdate) query = query.forUpdate()
  const row = await query.executeTakeFirst()
  return {
    exists: row !== undefined,
    suspendedAt: row?.suspended_at ?? null,
    caps: capsFromRow(row, defaults),
  }
}

/**
 * What a write path says when the group it belongs to went away underneath it.
 *
 * Reachable only in the race {@link deleteGroupCascade} now orders: the caller
 * authenticated against an endpoint row that a deletion has since removed, so by the
 * time it reads this its own credential is gone too. Says what happened rather than
 * 500-ing on it, and points at the only thing left to do.
 */
export const GROUP_GONE_MESSAGE =
  'This group no longer exists on this relay. It was deleted while this request was in flight, so nothing was stored. Pair this device again if you still have access to the relay.'

/** Suspension alone, for a path that has no reason to read the caps (pairing mint). */
export async function groupSuspendedAt(
  db: Kysely<Database>,
  groupId: string,
): Promise<SuspendedAt> {
  const row = await db
    .selectFrom('groups')
    .select('suspended_at')
    .where('id', '=', groupId)
    .executeTakeFirst()
  return row?.suspended_at ?? null
}

/** What one suspend/resume call did. `exists: false` means there was no such group. */
export interface SuspensionOutcome {
  exists: boolean
  /** The state the group is in AFTER the call; null when it is running (or absent). */
  suspendedAt: SuspendedAt
}

/**
 * Suspend or resume a group. Reports `exists: false` when there is no such group, so a
 * caller cannot mistake a typo'd id for a successful write.
 *
 * Suspending an already-suspended group KEEPS the original timestamp: "suspended since"
 * is what a grace period is counted from, and re-stamping it on every retry of an
 * idempotent control-plane call would silently restart the clock. That is why the
 * resulting timestamp is RETURNED rather than left for the caller to read back: the
 * value it wants is the one this function just decided, and a second select could only
 * ever tell it something different (a concurrent call) or the same thing twice.
 */
export async function setGroupSuspended(
  db: Kysely<Database>,
  groupId: string,
  suspended: boolean,
  now: Date,
): Promise<SuspensionOutcome> {
  const row = await db
    .selectFrom('groups')
    .select('suspended_at')
    .where('id', '=', groupId)
    .executeTakeFirst()
  if (!row) return { exists: false, suspendedAt: null }
  const alreadyRight = suspended === (row.suspended_at !== null)
  if (alreadyRight) return { exists: true, suspendedAt: row.suspended_at }
  const suspendedAt = suspended ? iso(now) : null
  await db
    .updateTable('groups')
    .set({ suspended_at: suspendedAt })
    .where('id', '=', groupId)
    .execute()
  return { exists: true, suspendedAt }
}

/**
 * A pending reset, as the wire carries it [P-18 item 12]: when it was asked for and
 * when it will happen. Null while none is pending. The shared contract's own type, so
 * the device route and the usage report cannot drift apart from it.
 */
export type GroupReset = GroupResetState

/** The reset columns of one group row. */
type ResetRow = Pick<Database['groups'], 'reset_requested_at' | 'reset_at' | 'reset_stopped_at'>

const RESET_COLUMNS = ['reset_requested_at', 'reset_at', 'reset_stopped_at'] as const

/**
 * The pending reset on a row, or null. Pending means BOTH timestamps are set: every
 * write sets or clears them together, so one without the other is not a state any code
 * path makes, and reading it as "pending" would show devices a reset with no time.
 */
function resetFromRow(row: ResetRow): GroupReset | null {
  if (row.reset_requested_at === null || row.reset_at === null) return null
  return {
    requestedAt: row.reset_requested_at as IsoTimestamp,
    resetsAt: row.reset_at as IsoTimestamp,
  }
}

/** A group's reset state. `exists: false` means there is no such group. */
export interface GroupResetOutcome {
  exists: boolean
  reset: GroupReset | null
  /** When a device last stopped a reset, or null if none ever has. */
  stoppedAt: string | null
}

/**
 * Schedule a reset that waits [P-18 item 12], or report the one already pending.
 *
 * A pending reset is KEPT as it is, time and all: a control-plane call retried after a
 * timeout must not move the clock the devices are counting down against, the same rule
 * `setGroupSuspended` keeps for "suspended since". `scheduled` says which happened, so
 * the caller tells the group and rings its phones only for a reset that is new.
 *
 * Under the group row ({@link lockGroup}), so a device's Stop and this are ordered:
 * whichever lands second sees what the first one left.
 */
export async function scheduleGroupReset(
  db: Kysely<Database>,
  postgres: boolean,
  groupId: string,
  resetsAt: string,
  now: Date,
): Promise<GroupResetOutcome & { scheduled: boolean }> {
  return db.transaction().execute(async (trx) => {
    if (!(await lockGroup(trx, postgres, groupId))) {
      return { exists: false, reset: null, stoppedAt: null, scheduled: false }
    }
    const row = await trx
      .selectFrom('groups')
      .select(RESET_COLUMNS)
      .where('id', '=', groupId)
      .executeTakeFirstOrThrow()
    const pending = resetFromRow(row)
    if (pending) {
      return { exists: true, reset: pending, stoppedAt: row.reset_stopped_at, scheduled: false }
    }
    const requestedAt = iso(now)
    await trx
      .updateTable('groups')
      .set({ reset_requested_at: requestedAt, reset_at: resetsAt, reset_stopped_at: null })
      .where('id', '=', groupId)
      .execute()
    return {
      exists: true,
      reset: { requestedAt, resetsAt: resetsAt as IsoTimestamp },
      stoppedAt: null,
      scheduled: true,
    }
  })
}

/**
 * Clear a pending reset because the ACCOUNT OWNER cancelled it (the control plane).
 * Leaves `reset_stopped_at` alone: that records what a device did, and the owner
 * cancelling does not change it. `cleared` is false when nothing was pending.
 */
export async function cancelGroupReset(
  db: Kysely<Database>,
  postgres: boolean,
  groupId: string,
): Promise<GroupResetOutcome & { cleared: boolean }> {
  return db.transaction().execute(async (trx) => {
    if (!(await lockGroup(trx, postgres, groupId))) {
      return { exists: false, reset: null, stoppedAt: null, cleared: false }
    }
    const row = await trx
      .selectFrom('groups')
      .select(RESET_COLUMNS)
      .where('id', '=', groupId)
      .executeTakeFirstOrThrow()
    const cleared = row.reset_requested_at !== null || row.reset_at !== null
    if (cleared) {
      await trx
        .updateTable('groups')
        .set({ reset_requested_at: null, reset_at: null })
        .where('id', '=', groupId)
        .execute()
    }
    return { exists: true, reset: null, stoppedAt: row.reset_stopped_at, cleared }
  })
}

/** What a device's Stop did. */
export type StopResetOutcome = 'stopped' | 'none' | 'gone' | 'caller_gone'

/**
 * A DEVICE stops a pending reset [P-18 item 12]: any device in the group may, and that
 * is the whole safeguard. Records when, and clears the pending pair.
 *
 * Under the group row, and the caller is re-read under it, the same way a removal
 * checks it (routes/endpoints.ts): a device removed a moment ago must not get one last
 * Stop in. `none` when nothing was pending, which the route answers exactly like a
 * stop, so a retry or two devices pressing Stop at once both read as done.
 */
export async function stopGroupReset(
  db: Kysely<Database>,
  postgres: boolean,
  groupId: string,
  callerEndpointId: string,
  now: Date,
): Promise<StopResetOutcome> {
  return db.transaction().execute(async (trx) => {
    if (!(await lockGroup(trx, postgres, groupId))) return 'gone'
    const stillHere = await trx
      .selectFrom('endpoints')
      .select('id')
      .where('id', '=', callerEndpointId)
      .where('group_id', '=', groupId)
      .executeTakeFirst()
    if (!stillHere) return 'caller_gone'
    const row = await trx
      .selectFrom('groups')
      .select(RESET_COLUMNS)
      .where('id', '=', groupId)
      .executeTakeFirstOrThrow()
    if (!resetFromRow(row)) return 'none'
    await trx
      .updateTable('groups')
      .set({ reset_requested_at: null, reset_at: null, reset_stopped_at: iso(now) })
      .where('id', '=', groupId)
      .execute()
    return 'stopped'
  })
}

/** The pending reset of a group a device belongs to; null when none (or no group). */
export async function readGroupReset(
  db: Kysely<Database>,
  groupId: string,
): Promise<GroupReset | null> {
  const row = await db
    .selectFrom('groups')
    .select(RESET_COLUMNS)
    .where('id', '=', groupId)
    .executeTakeFirst()
  return row ? resetFromRow(row) : null
}

/**
 * Everything the provisioning API may say about one group's usage — AGGREGATES ONLY.
 *
 * This shape is a boundary, not a convenience. HOSTED_PLAN §2.2 promises the control
 * plane sees "aggregate usage only", and §4.2 names the exact thing that would falsify
 * it: `/admin/status`'s device listing (labels, device names, push transport, per-row
 * activity). Per-endpoint diagnostics stay operator-local, reached on the relay's own
 * host. NOTHING here may ever carry an endpoint id, a label, a device name, a push
 * detail or a message id — `provisioning.test.ts` asserts that over the live response,
 * not over this comment.
 */
export interface GroupUsage {
  groupId: string
  createdAt: string
  suspended: boolean
  suspendedAt: SuspendedAt
  /**
   * The pending reset [P-18 item 12], or null. Group-level timestamps, set by the
   * control plane itself, so they name no device and break nothing above.
   */
  reset: GroupReset | null
  /**
   * When a device last stopped a reset, or null. Says THAT a device did, never which
   * one: the control plane needs "somebody still holds a paired device", not who.
   */
  resetStoppedAt: string | null
  /** Devices in the group. A count, never a list. */
  endpoints: number
  /**
   * How many of them are leftovers of a failed first setup (PLANS P-21, `leftoverEndpoints`
   * in bootstrap.ts). Either 0 or all of `endpoints`: when it is all of them, the account
   * page may make a new first link, and doing so removes them.
   */
  leftoverEndpoints: number
  queue: {
    /** Live queued tabs: unacked, envelope still present, unexpired — the set the
     *  queue caps count, so this number and `caps.remaining` agree by construction. */
    messages: number
    /**
     * Stored bytes the byte cap counts (`octet_length`, as [0030] counts): the
     * envelopes of the live rows above PLUS the history blobs the relay still holds
     * for this group ([0028], inside HISTORY_RETENTION_DAYS).
     *
     * Wider than `messages`, deliberately: a blob survives its envelope's ack, so a
     * group can hold stored bytes with an empty queue. The alternative — report only
     * envelope bytes — is the number that made `caps.remaining.queuedBytes` disagree
     * with the guard that actually refuses.
     */
    bytes: number
    /** Age of the oldest of them, or null when the queue is empty. */
    oldestPendingSeconds: number | null
  }
  /**
   * Sealed copies of the group history key the relay is still holding [0028], as a
   * count and their bytes.
   *
   * ITS OWN FIGURE, not folded into `queue.bytes`, and that is the point of adding it
   * [0031 amended]. These rows were invisible to every number this report carried, so
   * an operator looking at a tenant sitting on a relay's disk was told it was inside
   * its quota — the queue caps do not govern this table and were never meant to
   * (routes/group-keys.ts). What bounds it is a per-item size limit and the group's
   * send window; what this does is stop the report being silent about it.
   */
  groupKeys: {
    copies: number
    bytes: number
  }
  caps: {
    /** In force after overrides. `0` means unlimited, as everywhere else. */
    effective: {
      endpoints: number
      queuedMessages: number
      queuedBytes: number
      sendsPerWindow: number
      sendWindowSeconds: number
    }
    /** As SET on the group row. `null` is "no override, follow the relay" [0030]. */
    overrides: GroupCapOverrides
    /** Headroom left under each cap; `null` where that cap is unlimited. */
    remaining: {
      endpoints: number | null
      queuedMessages: number | null
      queuedBytes: number | null
      sendsPerWindow: number | null
    }
  }
  generatedAt: string
}

/** COUNT/SUM coerced to a number: SQLite hands back a number, Postgres a bigint string. */
function toNumber(value: unknown): number {
  return Number(value ?? 0)
}

/** Headroom under a cap, or null when the cap is off. Never negative. */
function headroom(cap: number, used: number): number | null {
  return cap > 0 ? Math.max(0, cap - used) : null
}

/**
 * Assemble one group's usage. Returns null when there is no such group.
 *
 * Every predicate here comes FROM caps.ts rather than being written to match it
 * ({@link liveQueuedMessages}, {@link storedHistoryBlobs}). That is the point: a control
 * plane reading "3 of 5 queued" and a relay refusing the sixth must be counting the same
 * rows, or the number an operator acts on is not the number that refused them — and two
 * hand-copied WHERE clauses is precisely how that stops being true.
 */
export async function groupUsage(
  db: Kysely<Database>,
  defaults: GroupCapDefaults,
  historyRetentionMs: number,
  groupId: string,
  now: Date,
): Promise<GroupUsage | null> {
  const group = await db
    .selectFrom('groups')
    .select([...CAP_COLUMNS, ...RESET_COLUMNS, 'id', 'created_at', 'suspended_at'])
    .where('id', '=', groupId)
    .executeTakeFirst()
  if (!group) return null

  const nowIso = iso(now)
  const caps = capsFromRow(group, defaults)

  const endpoints = await db
    .selectFrom('endpoints')
    .select((eb) => eb.fn.countAll().as('n'))
    .where('group_id', '=', groupId)
    .executeTakeFirst()

  // One pass over the group's rows for every message number: separate queries would
  // each take their own snapshot, and a send landing between them would produce a
  // report that never described any single moment. The two sets overlap but are not
  // the same set, so each aggregate carries its own predicate as a CASE rather than
  // sitting in the WHERE (`sum(case …)` rather than `count(*) filter`, because the two
  // dialects do not agree about FILTER).
  const live = liveQueuedMessages(groupId, nowIso)
  const blobs = storedHistoryBlobs(groupId, historyCutoff(now, historyRetentionMs))
  const queue = await sql<{
    n: unknown
    envelope_bytes: unknown
    blob_bytes: unknown
    oldest: string | null
  }>`
    select
      coalesce(sum(case when ${live} then 1 else 0 end), 0) as n,
      coalesce(sum(case when ${live} then octet_length(envelope) else 0 end), 0)
        as envelope_bytes,
      coalesce(sum(case when ${blobs} then octet_length(history_blob) else 0 end), 0)
        as blob_bytes,
      min(case when ${live} then created_at end) as oldest
    from messages
    where group_id = ${groupId}
  `.execute(db)
  const row = queue.rows[0]

  const oldestIso = row?.oldest ?? null
  const oldestParsed = oldestIso === null ? Number.NaN : Date.parse(oldestIso)
  const oldestPendingSeconds = Number.isNaN(oldestParsed)
    ? null
    : Math.max(0, Math.round((now.getTime() - oldestParsed) / 1000))

  const queuedMessages = toNumber(row?.n)
  const queuedBytes = toNumber(row?.envelope_bytes) + toNumber(row?.blob_bytes)

  // Group-key copies, counted and measured the same way (`octet_length`, as the relay
  // actually holds them). A separate statement rather than a join: it is a different
  // table with a different lifetime, and nothing about it feeds a cap.
  const keys = await sql<{ n: unknown; bytes: unknown }>`
    select count(*) as n, coalesce(sum(octet_length(envelope)), 0) as bytes
    from group_keys where group_id = ${groupId}
  `.execute(db)
  // The live window's count, read without touching it (quota.ts): headroom under a
  // WINDOWED cap is only meaningful against the window the relay is currently in.
  const sendsThisWindow =
    caps.sendsPerWindow > 0
      ? await quotaHits(db, 'group_sends', groupId, caps.sendWindowMs, now)
      : 0

  return {
    groupId: group.id,
    createdAt: group.created_at,
    suspended: group.suspended_at !== null,
    suspendedAt: group.suspended_at,
    reset: resetFromRow(group),
    resetStoppedAt: group.reset_stopped_at,
    endpoints: toNumber(endpoints?.n),
    leftoverEndpoints: (await leftoverEndpoints(db, groupId, now)).length,
    queue: { messages: queuedMessages, bytes: queuedBytes, oldestPendingSeconds },
    groupKeys: {
      copies: toNumber(keys.rows[0]?.n),
      bytes: toNumber(keys.rows[0]?.bytes),
    },
    caps: {
      effective: {
        endpoints: caps.endpoints,
        queuedMessages: caps.queuedMessages,
        queuedBytes: caps.queuedBytes,
        sendsPerWindow: caps.sendsPerWindow,
        sendWindowSeconds: Math.round(caps.sendWindowMs / 1000),
      },
      overrides: capOverridesFromRow(group),
      remaining: {
        endpoints: headroom(caps.endpoints, toNumber(endpoints?.n)),
        queuedMessages: headroom(caps.queuedMessages, queuedMessages),
        queuedBytes: headroom(caps.queuedBytes, queuedBytes),
        sendsPerWindow: headroom(caps.sendsPerWindow, sendsThisWindow),
      },
    },
    generatedAt: nowIso,
  }
}

/** Rows removed by one deletion pass. All zeroes when the group was already gone. */
export interface GroupDeletion {
  /** False when the group row was not there — the idempotent re-run (HOSTED_PLAN §5). */
  existed: boolean
  deleted: {
    endpoints: number
    messages: number
    groupKeys: number
    pairingCodes: number
    removedEndpoints: number
    quotaCounters: number
  }
  /**
   * The deleted devices' stored push subscriptions, for the caller to retire their wake
   * tokens after the commit. Server-side only: it holds wake tokens, so it must never
   * reach a response body or a log line.
   */
  deletedEndpoints: { endpointId: string; pushSubscription: string }[]
}

function deletedRows(result: { numDeletedRows?: bigint } | undefined): number {
  return Number(result?.numDeletedRows ?? 0n)
}

/**
 * Tear a group down, everything it owns with it. Idempotent by construction: every
 * statement is a DELETE with a group-scoped WHERE, so re-running it on a group that is
 * already gone deletes nothing and succeeds. HOSTED_PLAN §5 asks for exactly that,
 * "because a half-deleted tenant is worse than either state".
 *
 * What goes, and why each one has to be named rather than assumed:
 *  - `messages` — queued ciphertext AND the history blobs riding those rows [0028];
 *  - `group_keys` — the sealed copies of the group history key;
 *  - `pairing_codes` — including unconsumed ones, so a link handed out earlier cannot
 *    resurrect a tenancy that no longer exists;
 *  - `removed_endpoints` — the tombstones. Deleting them means a device that was kicked
 *    out before the tenancy was, and comes back afterwards, hears `unauthorized`
 *    ("hold on to your pairing") rather than `endpoint_removed` ("unpair yourself").
 *    That is the safe direction and the one the relay already takes for an unknown
 *    token, because a relay restored from a backup is indistinguishable from this;
 *  - `endpoints` — the devices, and with them `device_token_hash`, which IS the device
 *    token as far as the relay ever holds it (ADR-0024: the hash is stored, never the
 *    token). Nothing else has to be deleted to revoke a token;
 *  - `quota_counters` for `group_sends` — the group's send-window buckets. Keyed by
 *    group id, so a recycled id would otherwise inherit somebody else's spent window;
 *  - the `groups` row itself, which carries the cap overrides, `suspended_at` and the
 *    pending reset as columns, so those need no statement of their own.
 *
 * What deliberately STAYS: `provisioning_idempotency` rows naming this group [0031].
 * They record a CALL the control plane made, not state the group owns, and deleting
 * them would mean a create retried with the same key after a deletion silently
 * resurrects the tenancy. It answers `not_found` instead, which is the honest one.
 *
 * ORDER IS LOAD-BEARING. `endpoints.group_id` and `pairing_codes.group_id` are real
 * foreign keys and SQLite runs with `foreign_keys = ON` (db/index.ts), so the group row
 * must go last. One transaction, so a failure half way leaves nothing behind.
 *
 * SERIALISED AGAINST WRITERS [0031 amended], which is the part a transaction alone did
 * NOT give it. The statements below are atomic, but atomic is not the same as ordered:
 * a send or a group-key upload that had already read its way past the group row could
 * commit its own row AFTER this transaction had swept that table and BEFORE it removed
 * the group, leaving ciphertext or sealed key material behind in a tenancy the caller
 * had just been told was gone. `messages` and `group_keys` are the two tables where
 * that is possible at all, because they are the two whose `group_id` is not a real
 * foreign key — an `endpoints` or `pairing_codes` insert already blocks on the group
 * row for as long as this holds it, because the foreign key makes it.
 *
 * So the group row is HELD first ({@link lockGroup}), and every route that writes a
 * group-scoped row holds it too. The two orders that remain are both correct: a writer
 * that gets there first commits, and its row is swept by the deletion behind it; a
 * writer that arrives second blocks until this commits, then finds no group and writes
 * nothing. On SQLite the hold is a plain read and the ordering comes from the single
 * connection Kysely serialises every statement through.
 *
 * NOT done here: closing the live WebSockets of the deleted endpoints. That is the
 * caller's job (routes/provisioning.ts) because it is in-process state, not database
 * state, and it must happen AFTER the commit.
 */
export async function deleteGroupCascade(
  db: Kysely<Database>,
  postgres: boolean,
  groupId: string,
): Promise<GroupDeletion> {
  return db.transaction().execute(async (trx) => {
    // Held for the rest of the transaction, before anything is deleted: see above.
    // Its answer is also the `existed` this reports, so the read is not an extra one.
    const existed = await lockGroup(trx, postgres, groupId)
    return cascadeUnderHold(trx, groupId, existed)
  })
}

/** What carrying out a reset did [P-18 item 12]. */
export type ResetRunOutcome =
  | { status: 'gone' }
  | { status: 'not_due' }
  | { status: 'deleted'; deletion: GroupDeletion }

/**
 * Carry out a reset that waited, IF it still should be [P-18 item 12]: the group is
 * deleted only when a reset is pending AND its time has come, and that is decided in
 * the same transaction, under the same hold on the group row, as the deletion itself.
 *
 * That is the point of doing it here rather than in the control plane. A control plane
 * that read usage and then called the plain DELETE left a window between the two in
 * which a device's Stop was accepted, reported as done, and then deleted anyway. A
 * device's Stop takes the same hold ({@link stopGroupReset}), so the two are ordered:
 * a Stop that lands first clears the reset and this answers `not_due`; a Stop that
 * lands second finds no group, or no token.
 *
 * `gone` when there is no such group, which a caller re-running after a crash part way
 * through should read as already done.
 */
export async function runDueGroupReset(
  db: Kysely<Database>,
  postgres: boolean,
  groupId: string,
  now: Date,
): Promise<ResetRunOutcome> {
  return db.transaction().execute(async (trx) => {
    if (!(await lockGroup(trx, postgres, groupId))) return { status: 'gone' as const }
    const row = await trx
      .selectFrom('groups')
      .select(RESET_COLUMNS)
      .where('id', '=', groupId)
      .executeTakeFirstOrThrow()
    const pending = resetFromRow(row)
    if (!pending || Date.parse(pending.resetsAt) > now.getTime()) {
      return { status: 'not_due' as const }
    }
    return { status: 'deleted' as const, deletion: await cascadeUnderHold(trx, groupId, true) }
  })
}

/**
 * The statements of {@link deleteGroupCascade}, for a caller that already holds the
 * group row inside its own transaction. Order and reasons are documented there.
 */
async function cascadeUnderHold(
  trx: Kysely<Database>,
  groupId: string,
  existed: boolean,
): Promise<GroupDeletion> {
  const messages = await trx
    .deleteFrom('messages')
    .where('group_id', '=', groupId)
    .executeTakeFirst()
  const groupKeys = await trx
    .deleteFrom('group_keys')
    .where('group_id', '=', groupId)
    .executeTakeFirst()
  const pairingCodes = await trx
    .deleteFrom('pairing_codes')
    .where('group_id', '=', groupId)
    .executeTakeFirst()
  const removedEndpoints = await trx
    .deleteFrom('removed_endpoints')
    .where('group_id', '=', groupId)
    .executeTakeFirst()
  // Read before they go, so the caller can retire their wake tokens at the forwarder
  // once this has committed [2026-10-20, PLANS P-17].
  const wakeTargets = await trx
    .selectFrom('endpoints')
    .select(['id', 'push_subscription'])
    .where('group_id', '=', groupId)
    .execute()
  const endpoints = await trx
    .deleteFrom('endpoints')
    .where('group_id', '=', groupId)
    .executeTakeFirst()
  const quotaCounters = await trx
    .deleteFrom('quota_counters')
    .where('scope', '=', 'group_sends')
    .where('key', '=', groupId)
    .executeTakeFirst()
  await trx.deleteFrom('groups').where('id', '=', groupId).execute()

  return {
    existed,
    deleted: {
      endpoints: deletedRows(endpoints),
      messages: deletedRows(messages),
      groupKeys: deletedRows(groupKeys),
      pairingCodes: deletedRows(pairingCodes),
      removedEndpoints: deletedRows(removedEndpoints),
      quotaCounters: deletedRows(quotaCounters),
    },
    deletedEndpoints: wakeTargets.map((row) => ({
      endpointId: row.id,
      pushSubscription: row.push_subscription,
    })),
  }
}

/**
 * What a suspended relay says, to a technical reader.
 *
 * Written for whoever is looking at the relay's answer — a developer, an agent reading
 * a log, the operator's own control plane — not for an end user: HOSTED_PLAN §2.2 puts
 * accounts and billing in the control plane, so it is the control plane that translates
 * "suspended" into whatever the person actually needs to do about it. The relay's job
 * is to say what is true and what would change it, without inventing an address it
 * cannot know or a reason it was never told.
 */
export const SUSPENDED_SEND_MESSAGE =
  'This group is suspended on this relay, so it is not accepting tabs. Tabs already queued still arrive and paired devices stay paired. Whoever runs this relay can lift the suspension.'

export const SUSPENDED_JOIN_MESSAGE =
  'This group is suspended on this relay, so it is not taking new devices. Devices already paired keep working. Ask whoever runs this relay to lift the suspension, then join again with a new pairing link.'

export const SUSPENDED_PAIRING_MESSAGE =
  'This group is suspended on this relay, so it cannot invite new devices. Devices already paired keep working. Ask whoever runs this relay to lift the suspension, then make a new pairing link.'
