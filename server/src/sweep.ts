import type { Kysely } from 'kysely'
import type { Database } from './db/schema'
import { sweepQuotaCounters } from './quota'
import { addMs, iso } from './time'

/**
 * TTL sweeper — the durable-queue's privacy + housekeeping job (PRD §6.6).
 *
 * Delivery of expired messages is ALREADY impossible without the sweeper: the
 * `?pending=1` / `?outbox=1` reads filter `expires_at > now`, so an expired row
 * never reaches a target. The sweeper closes the *privacy* gap Chunk 2 flagged —
 * an unacked message's ciphertext must not linger past its TTL — and reclaims
 * dead rows.
 *
 * What remains of a row (mirrors the ack model):
 *  - PURGE: an expired row that still holds ciphertext has its `envelope` set to
 *    NULL immediately — exactly what ack does. The routing row is retained as a
 *    tombstone, so an idempotent replay of the same client id can't resurrect the
 *    payload (INSERT … ON CONFLICT DO NOTHING preserves the expired tombstone,
 *    and the reads already exclude it by expiry).
 *  - PRUNE: once a row has been expired for longer than `graceMs`, no legitimate
 *    client replay can still occur (the client's own retention is bounded by the
 *    TTL), so the tombstone is hard-deleted to reclaim space. Default grace =
 *    one message TTL, i.e. total server retention ≈ 2× TTL, matching the
 *    extension's seen-set retention.
 *
 * Group history [0028] adds a SECOND clock to the prune step. A row carrying a
 * `history_blob` is still serving the history screens long after its delivery
 * job is done, so it survives until BOTH windows have passed: expiry + grace
 * (replay protection) AND creation + history retention (the product promise).
 * `envelope` is still purged on schedule — the history blob is a different thing
 * with a different lifetime, sealed to a different key, and the relay can read
 * neither.
 *
 * The shared quota store [0030] rides along as a third, unrelated job: finished
 * rate-limit and cap windows are dropped here because this is the relay's one
 * housekeeping clock, not because they share any retention rule with messages. Dead
 * pairing codes [0031 amended] ride along for the same reason, and they are the one
 * table that had nothing removing it at all: a relay kept a row per link ever minted.
 */
export interface SweepResult {
  /** Rows whose ciphertext was nulled this pass (expired, still-held payloads). */
  purged: number
  /** Tombstone rows hard-deleted this pass (past every retention window). */
  deleted: number
  /** History blobs dropped this pass: past `HISTORY_RETENTION_DAYS` [0028]. */
  blobsDropped: number
  /** Group-key copies aged out this pass [0028]. */
  keysDropped: number
  /** Pairing codes dropped this pass: past expiry by the grace window [0031 amended]. */
  pairingCodesDropped: number
  /** Finished rate-limit / cap windows dropped this pass [0030]. */
  quotaWindowsDropped: number
}

/** Run one sweep pass. Pure over (db, now) — unit-tested with an injected clock. */
export async function sweepExpired(
  db: Kysely<Database>,
  now: Date,
  graceMs: number,
  historyRetentionMs: number,
): Promise<SweepResult> {
  const nowIso = iso(now)

  const purge = await db
    .updateTable('messages')
    .set({ envelope: null })
    .where('expires_at', '<=', nowIso)
    .where('envelope', 'is not', null)
    .executeTakeFirst()

  const cutoffIso = iso(addMs(now, -Math.max(0, graceMs)))
  const historyCutoffIso = iso(addMs(now, -Math.max(0, historyRetentionMs)))

  // A history blob past its window is dropped on time, whatever the row's other
  // clock says. The row itself may have to stay (expiry + grace is replay
  // protection), and before 2026-10-13 the blob stayed with it: with a window
  // shorter than TTL + grace, including 0, blobs outlived the window by up to
  // 14 days by default, neither served nor counted against any cap.
  const blobs = await db
    .updateTable('messages')
    .set({ history_blob: null })
    .where('history_blob', 'is not', null)
    .where('created_at', '<=', historyCutoffIso)
    .executeTakeFirst()
  const del = await db
    .deleteFrom('messages')
    .where('expires_at', '<=', cutoffIso)
    // A row with history still to serve stays, however long expired it is. With
    // history disabled (retention 0) the cutoff is `now`, so every row created in
    // the past qualifies and this collapses to the original behaviour.
    .where((eb) =>
      eb.or([eb('history_blob', 'is', null), eb('created_at', '<=', historyCutoffIso)]),
    )
    .executeTakeFirst()

  // Group-key copies [0028] are not consumed on read (a device that fetches and
  // then dies before persisting must be able to fetch again), so age is the only
  // thing that removes them. They share the history window: a key older than the
  // history it can open has nothing left to unlock.
  //
  // With history disabled the cutoff is `now`, which drops them on the next pass —
  // correct, because a relay serving no history has no use for the keys to it.
  const keys = await db
    .deleteFrom('group_keys')
    .where('created_at', '<=', historyCutoffIso)
    .executeTakeFirst()

  // Pairing codes past their own expiry by the tombstone grace [0031 amended].
  //
  // Nothing removed these before, so a relay accumulated one row per link ever minted,
  // for as long as it ran. Dated by `expires_at` rather than by consumption, because a
  // consumed code and an expired one are the same kind of dead — but the register route
  // reads the row to tell somebody "this link was already used" rather than "unknown
  // link", which is the better answer and is worth keeping for a while. The grace is the
  // tombstone one for exactly that reason: it is the same question (how long after a
  // thing is finished can a client still ask about it), and giving it a second knob
  // would mean two answers to it.
  const codes = await db
    .deleteFrom('pairing_codes')
    .where('expires_at', '<=', cutoffIso)
    .executeTakeFirst()

  // Finished rate-limit and cap windows [0030]. Unrelated to message retention —
  // they hold no ciphertext and no routing facts, only a count — but they are the
  // one other table that grows with traffic rather than with devices, and this is
  // the relay's only housekeeping clock. Dated by their own stored `window_end`, so
  // an operator changing a window length between boots cannot strand rows.
  const quota = await sweepQuotaCounters(db, now)

  return {
    purged: Number(purge?.numUpdatedRows ?? 0n),
    deleted: Number(del?.numDeletedRows ?? 0n),
    blobsDropped: Number(blobs?.numUpdatedRows ?? 0n),
    keysDropped: Number(keys?.numDeletedRows ?? 0n),
    pairingCodesDropped: Number(codes?.numDeletedRows ?? 0n),
    quotaWindowsDropped: quota,
  }
}

export interface Sweeper {
  stop(): void
}

export interface StartSweeperOptions {
  intervalMs: number
  graceMs: number
  /**
   * How long a history blob is kept [0028]. Required, not defaulted: a default of 0
   * meant a caller that forgot it ran the production sweeper with history off,
   * dropping every key copy on each pass, and no test noticed (review 2026-10-13).
   */
  historyRetentionMs: number
  /** Clock (defaults to wall clock); tests can inject. */
  now?: () => Date
  onError?: (err: unknown) => void
  onResult?: (result: SweepResult) => void
}

/**
 * Start a periodic sweeper. Returns a handle whose `stop()` clears the timer.
 * The timer is `unref`'d so it never keeps the process alive on its own.
 * `intervalMs <= 0` disables it (tests that drive `sweepExpired` directly).
 */
export function startSweeper(db: Kysely<Database>, opts: StartSweeperOptions): Sweeper {
  if (opts.intervalMs <= 0) return { stop() {} }
  const now = opts.now ?? (() => new Date())
  const timer: ReturnType<typeof setInterval> = setInterval(() => {
    sweepExpired(db, now(), opts.graceMs, opts.historyRetentionMs)
      .then((result) => opts.onResult?.(result))
      .catch((err) => opts.onError?.(err))
  }, opts.intervalMs)
  timer.unref?.()
  return {
    stop() {
      clearInterval(timer)
    },
  }
}
