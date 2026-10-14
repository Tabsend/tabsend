import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { lockGroup } from '../src/caps'
import type { Database } from '../src/db/schema'
import { delay } from './helpers'

/**
 * Postgres row-lock choreography for the race tests (tenancy-races.test.ts, caps.test.ts).
 *
 * A concurrency test that merely races passes for the wrong reason on a fast machine, so
 * these make the interleaving a CHOICE. The test takes a group's row itself and holds it;
 * the operations under test are then started one at a time, and each is confirmed to be
 * WAITING behind the test's hold, by asking Postgres who blocks whom, before the next
 * one starts. Waiters are granted the row in the order they queued for it, so the order
 * the test started them in is the order they run in once it lets go.
 *
 * "Waiting behind the hold" is the assertion that matters. A version of the relay that
 * stopped taking the group row on some path would not wait at all, and the wait below
 * fails loudly instead of the test passing quietly. That replaced a fixed sleep, which
 * both slowed the suite and decided nothing: it passed whether or not anything waited.
 */

export interface GroupRowHold {
  /** Resolves with the holding backend's pid once the row is actually held. */
  ready: Promise<number>
  /** Let go of the row. Safe to call more than once; tests call it in `finally`. */
  release: () => void
  /** Settles when the holding transaction has finished. Never rejects. */
  done: Promise<void>
}

/** Take `groupId`'s row with the same `SELECT … FOR UPDATE` the relay takes, and hold it. */
export function holdGroupRow(db: Kysely<Database>, groupId: string): GroupRowHold {
  let release!: () => void
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  let markReady!: (pid: number) => void
  let refuse!: (err: unknown) => void
  const ready = new Promise<number>((resolve, reject) => {
    markReady = resolve
    refuse = reject
  })
  const done = db
    .transaction()
    .execute(async (trx) => {
      if (!(await lockGroup(trx, true, groupId))) {
        throw new Error(`There is no group ${groupId} to hold.`)
      }
      const { rows } = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(trx)
      markReady(Number(rows[0]?.pid))
      await released
    })
    .catch((err: unknown) => {
      refuse(err)
    })
  return { ready, release, done }
}

/**
 * Wait until `count` sessions are waiting, directly or behind one another, on locks the
 * session `holderPid` holds. Throws if that does not happen within `timeoutMs`, which is
 * what a path that stopped taking the lock looks like from here.
 */
export async function waitForBlockedBehind(
  db: Kysely<Database>,
  holderPid: number,
  count: number,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let seen = 0
  for (;;) {
    const { rows } = await sql<{ pid: number; blockers: number[] | null }>`
      select pid, pg_blocking_pids(pid) as blockers
      from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock'
    `.execute(db)
    const behind = new Set<number>([holderPid])
    let grew = true
    while (grew) {
      grew = false
      for (const row of rows) {
        const pid = Number(row.pid)
        if (behind.has(pid)) continue
        if ((row.blockers ?? []).some((b) => behind.has(Number(b)))) {
          behind.add(pid)
          grew = true
        }
      }
    }
    seen = behind.size - 1
    if (seen >= count) return
    if (Date.now() > deadline) {
      throw new Error(
        `Expected ${count} waiting behind the held group row, but saw ${seen}. A path that should take the group row did not wait for it.`,
      )
    }
    await delay(10)
  }
}

/** A promise whose settling can be checked without awaiting it. */
export interface Watched<T> {
  settled: () => boolean
  value: Promise<T>
}

/** Settled-or-not, without awaiting: what "is it still blocked?" needs. */
export function watch<T>(promise: Promise<T>): Watched<T> {
  let settled = false
  const value = promise.then(
    (v) => {
      settled = true
      return v
    },
    (err) => {
      settled = true
      throw err
    },
  )
  return { settled: () => settled, value }
}
