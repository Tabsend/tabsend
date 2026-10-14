import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { createPgPool } from '../src/db'
import { PG_URL, USE_POSTGRES } from './helpers'

/**
 * A pooled Postgres connection that fails while idle must not end the relay
 * (`PLANS.md` P-13). Found on the hosted machine on 2026-10-13: stopping Postgres made
 * pg emit an `'error'` event on the pool with no listener, which Node turns into an
 * uncaught exception, so the relay died instead of answering 5xx until the database
 * came back (HOSTED_PLAN §10.1).
 */
describe('Postgres pool: a connection failing while idle', () => {
  it('is reported, not thrown', async () => {
    const seen: string[] = []
    // Never connects: the pool opens connections lazily, and nothing here queries.
    const pool = createPgPool('postgres://nobody@/nowhere?host=/nonexistent', {
      onPoolError: (error) => seen.push(error.message),
    })
    // Without a listener, EventEmitter#emit('error') throws, which is the crash.
    expect(() =>
      pool.emit('error', new Error('terminating connection due to administrator command')),
    ).not.toThrow()
    expect(seen).toEqual(['terminating connection due to administrator command'])
    await pool.end()
  })

  it.skipIf(!USE_POSTGRES)('is dropped, and the next query gets a fresh connection', async () => {
    const seen: string[] = []
    const pool = createPgPool(PG_URL, { onPoolError: (error) => seen.push(error.message) })
    const admin = new Pool({ connectionString: PG_URL, max: 1 })
    try {
      const { rows } = await pool.query<{ pid: number }>('select pg_backend_pid() as pid')
      const pid = rows[0]?.pid
      // The connection is idle in the pool now. End it from outside, the way a
      // Postgres restart or an administrator would.
      await admin.query('select pg_terminate_backend($1)', [pid])
      await expect.poll(() => seen.length, { timeout: 5000 }).toBeGreaterThan(0)
      const again = await pool.query<{ pid: number }>('select pg_backend_pid() as pid')
      expect(again.rows[0]?.pid).not.toBe(pid)
    } finally {
      await admin.end()
      await pool.end()
    }
  })
})
