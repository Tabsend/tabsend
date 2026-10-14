import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import type { Database } from './db/schema'
import { iso } from './time'

/**
 * The shared fixed-window counter store [0030] (HOSTED_PLAN §4.4).
 *
 * Every windowed limit the relay enforces counts here: the register rate limiter's
 * per-IP buckets and the per-group sends-per-window cap. It exists to make one
 * promise the in-process `Map` it replaces could not: **the budget is the same budget
 * for every relay process reading this database.** Two instances behind a load
 * balancer used to hand out `RATE_LIMIT_MAX` each, silently, and nothing anywhere
 * reported a doubled limit — the failure mode a limit exists to prevent.
 *
 * INVARIANT — the count is incremented by the DATABASE, never by this process.
 * {@link hitQuota} is one statement: an insert that, on conflict, increments the
 * existing row only while it is still under the maximum. Postgres re-reads the live
 * row under `ON CONFLICT DO UPDATE` (not the statement's snapshot) and SQLite
 * serialises writers, so two callers racing the last unit of budget produce exactly
 * one winner on both dialects. A read-then-write would produce two, and would go
 * quietly approximate precisely under the load §10.1 measures.
 *
 * FAILURE SEMANTICS, restated because they changed. ADR-0012 recorded the old
 * limiter as failing SAFE: a shared bucket over-limits rather than under-limits.
 * That still holds (the key is still the client IP, so a proxy without TRUST_PROXY
 * still collapses clients into one bucket). What is new is that the store can be
 * unreachable. A database error propagates and the call it guards fails with a 500
 * — fail CLOSED, which is right for both callers: register cannot do its job without
 * the database anyway, and a send that cannot be counted must not be counted as free.
 */

/** Outcome of one counted hit. `retryAfterMs` is 0 whenever `ok`. */
export interface QuotaHit {
  ok: boolean
  /** Milliseconds until this window rolls over; a `Retry-After`-style hint. */
  retryAfterMs: number
}

/** One counted request against one window. See {@link hitQuota}. */
export interface QuotaRequest {
  /** Which limit is counting: `register_ip`, `group_sends`. Namespaces `key`. */
  scope: string
  /** The subject: a client IP, a group id. Opaque here. */
  key: string
  /** Maximum hits per window. `<= 0` means unlimited: nothing is written at all. */
  max: number
  /** Window length in ms. `<= 0` also means unlimited — see {@link hitQuota}. */
  windowMs: number
  /** Now, from the caller's injected clock (tests advance it). */
  now: Date
}

/**
 * Window boundaries, ALIGNED to a multiple of `windowMs` since the epoch rather than
 * started at the first hit.
 *
 * Alignment is what lets two relay processes agree on which window they are in
 * without talking to each other: both compute the same `window_start` from the same
 * wall clock, so both land on the same row. A first-hit-starts-the-window scheme (the
 * old in-memory one) gives each process its own phase and therefore its own bucket,
 * which is the bug this store exists to remove.
 *
 * THROWS on a window that is not positive, rather than producing one. Dividing by 0
 * gives Infinity and by a negative gives a window that runs backwards; both reach
 * `iso()` as NaN, which throws something unreadable from three frames down. A limit
 * that is switched off never gets here at all — {@link hitQuota} answers first.
 */
export function windowBounds(now: Date, windowMs: number): { start: Date; end: Date } {
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new Error(
      `A fixed window must be a positive number of milliseconds, got ${windowMs}. Switching a limit off is spelled with a non-positive max or window, which is handled before this is called.`,
    )
  }
  const startMs = Math.floor(now.getTime() / windowMs) * windowMs
  return { start: new Date(startMs), end: new Date(startMs + windowMs) }
}

/**
 * Count one hit against `scope`/`key` in the current window, atomically.
 *
 * Returns `ok: false` without incrementing once the window's budget is spent. The
 * single statement is:
 *
 *   INSERT INTO quota_counters (scope, key, window_start, window_end, hits)
 *   VALUES (?, ?, ?, ?, 1)
 *   ON CONFLICT (scope, key, window_start)
 *     DO UPDATE SET hits = quota_counters.hits + 1
 *     WHERE quota_counters.hits < ?
 *
 * Zero rows affected means the WHERE refused it, i.e. the budget is spent. There is
 * no branch in JavaScript that could disagree with the database about the count.
 *
 * SWITCHED OFF HAS TWO SPELLINGS, and both mean the same thing: nothing is written and
 * everything is allowed. `max <= 0` is the documented one (`RATE_LIMIT_MAX=0`, and the
 * `0 = unlimited` convention every cap uses). `windowMs <= 0` is the other half of the
 * same knob — `RATE_LIMIT_WINDOW_SECONDS=0` used to reach {@link windowBounds}, produce
 * NaN boundaries, and fail every register with a 500. A limiter with no window is not a
 * limiter, so it is off, which is also what the in-process limiter it replaced did.
 */
export async function hitQuota(db: Kysely<Database>, req: QuotaRequest): Promise<QuotaHit> {
  if (req.max <= 0 || req.windowMs <= 0) return { ok: true, retryAfterMs: 0 }
  const { start, end } = windowBounds(req.now, req.windowMs)
  const result = await db
    .insertInto('quota_counters')
    .values({
      scope: req.scope,
      key: req.key,
      window_start: iso(start),
      window_end: iso(end),
      hits: 1,
    })
    .onConflict((oc) =>
      oc
        .columns(['scope', 'key', 'window_start'])
        .doUpdateSet({ hits: sql<number>`${sql.ref('quota_counters.hits')} + 1` })
        .where('quota_counters.hits', '<', req.max),
    )
    .executeTakeFirst()

  if (Number(result?.numInsertedOrUpdatedRows ?? 0n) > 0) return { ok: true, retryAfterMs: 0 }
  // Never 0: a client told to retry in "0 seconds" retries immediately and is
  // refused again, which reads as a broken relay rather than a spent budget.
  return { ok: false, retryAfterMs: Math.max(1, end.getTime() - req.now.getTime()) }
}

/**
 * Read the current window's count without touching it. Diagnostics and tests only —
 * nothing that enforces a limit may read first and decide second.
 */
export async function quotaHits(
  db: Kysely<Database>,
  scope: string,
  key: string,
  windowMs: number,
  now: Date,
): Promise<number> {
  const { start } = windowBounds(now, windowMs)
  const row = await db
    .selectFrom('quota_counters')
    .select('hits')
    .where('scope', '=', scope)
    .where('key', '=', key)
    .where('window_start', '=', iso(start))
    .executeTakeFirst()
  return Number(row?.hits ?? 0)
}

/**
 * Drop every window that has already ended. Idempotent, and cheap because the row a
 * live window is using never matches (`window_end` is in the future).
 *
 * Dates the rows by their own stored `window_end` rather than by the caller's idea of
 * a window length, so changing `RATE_LIMIT_WINDOW_SECONDS` between boots cannot leave
 * rows nobody can age out. Run from the TTL sweeper (sweep.ts), which is the relay's
 * one housekeeping clock.
 */
export async function sweepQuotaCounters(db: Kysely<Database>, now: Date): Promise<number> {
  const result = await db
    .deleteFrom('quota_counters')
    .where('window_end', '<=', iso(now))
    .executeTakeFirst()
  return Number(result?.numDeletedRows ?? 0n)
}
