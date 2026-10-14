import { randomUUID } from 'node:crypto'
import type { SendResponse } from '@tabsend/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { hitQuota, quotaHits, sweepQuotaCounters, windowBounds } from '../src/quota'
import { sweepExpired } from '../src/sweep'
import {
  envelopeFor,
  http,
  pairingCodeFromLink,
  register,
  startTestServer,
  type TestServer,
} from './helpers'

/**
 * The shared counter store [0030] (HOSTED_PLAN §4.4).
 *
 * The point of the move is one claim that the in-process `Map` could not make: two
 * relay processes over one database enforce ONE budget. `secondInstance` is what
 * makes that testable — a second listener sharing the first's limiter object would
 * pass this suite for entirely the wrong reason.
 */

let server: TestServer
afterEach(async () => {
  await server?.close()
})

const REGISTER_BODY = {
  label: 'X',
  kind: 'extension',
  browser: 'chrome',
  platform: 'macos',
  pushSubscription: {
    transport: 'webpush',
    endpoint: 'https://p.test/e',
    keys: { p256dh: 'p', auth: 'a' },
  },
  e2ePubkey: 'k',
}

describe('windows are aligned, not started by the first hit', () => {
  it('puts two clocks inside one window on the same row', () => {
    const a = windowBounds(new Date('2026-07-16T12:00:17.000Z'), 60_000)
    const b = windowBounds(new Date('2026-07-16T12:00:59.999Z'), 60_000)
    expect(a.start.toISOString()).toBe('2026-07-16T12:00:00.000Z')
    expect(b.start.toISOString()).toBe(a.start.toISOString())
    expect(a.end.toISOString()).toBe('2026-07-16T12:01:00.000Z')
    // The next tick is a different window, so the budget rolls without a sweep.
    expect(windowBounds(new Date('2026-07-16T12:01:00.000Z'), 60_000).start.toISOString()).toBe(
      '2026-07-16T12:01:00.000Z',
    )
  })

  it('refuses a window that is not positive, instead of producing NaN boundaries', () => {
    // 0 divides to Infinity and a negative runs the window backwards; both reach
    // `iso()` as an Invalid Date and throw something unreadable from three frames
    // down. Switching a limit off is `hitQuota`'s job, and it never gets here.
    for (const windowMs of [0, -1, Number.NaN]) {
      expect(() => windowBounds(new Date('2026-07-16T12:00:00.000Z'), windowMs)).toThrow(
        /positive number of milliseconds/,
      )
    }
  })
})

describe('hitQuota', () => {
  it('counts in the database and refuses past the maximum', async () => {
    server = await startTestServer()
    const now = new Date('2026-07-16T12:00:30.000Z')
    const req = { scope: 'test', key: 'k', max: 2, windowMs: 60_000, now }
    expect((await hitQuota(server.db, req)).ok).toBe(true)
    expect((await hitQuota(server.db, req)).ok).toBe(true)
    const third = await hitQuota(server.db, req)
    expect(third.ok).toBe(false)
    // 30 s left in this window, and never 0 — "retry in 0 seconds" reads as a broken
    // relay rather than a spent budget.
    expect(third.retryAfterMs).toBe(30_000)
    expect(await quotaHits(server.db, 'test', 'k', 60_000, now)).toBe(2)

    // The next window is a different row, so the budget is whole again.
    const later = { ...req, now: new Date('2026-07-16T12:01:00.000Z') }
    expect((await hitQuota(server.db, later)).ok).toBe(true)
  })

  it('writes nothing at all when the limit is off', async () => {
    server = await startTestServer()
    const now = new Date('2026-07-16T12:00:00.000Z')
    expect(
      (await hitQuota(server.db, { scope: 'off', key: 'k', max: 0, windowMs: 1000, now })).ok,
    ).toBe(true)
    const rows = await server.db.selectFrom('quota_counters').select('scope').execute()
    expect(rows).toHaveLength(0)
  })

  it('keeps scopes and keys apart', async () => {
    server = await startTestServer()
    const now = new Date('2026-07-16T12:00:00.000Z')
    await hitQuota(server.db, { scope: 'a', key: 'k', max: 1, windowMs: 60_000, now })
    // Same key, different limit: its own budget, untouched by the one above.
    expect(
      (await hitQuota(server.db, { scope: 'b', key: 'k', max: 1, windowMs: 60_000, now })).ok,
    ).toBe(true)
    // Same limit, different subject: likewise.
    expect(
      (await hitQuota(server.db, { scope: 'a', key: 'j', max: 1, windowMs: 60_000, now })).ok,
    ).toBe(true)
    expect(
      (await hitQuota(server.db, { scope: 'a', key: 'k', max: 1, windowMs: 60_000, now })).ok,
    ).toBe(false)
  })

  it('holds exactly when many callers race the last unit', async () => {
    server = await startTestServer()
    const now = new Date('2026-07-16T12:00:00.000Z')
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        hitQuota(server.db, { scope: 'race', key: 'k', max: 6, windowMs: 60_000, now }),
      ),
    )
    expect(results.filter((r) => r.ok)).toHaveLength(6)
    expect(await quotaHits(server.db, 'race', 'k', 60_000, now)).toBe(6)
  })
})

describe('the register limiter is honest across two relay instances', () => {
  it('spends ONE budget however the two instances are addressed', async () => {
    // Two apps, own Hub / RateLimiter / RelayStats each, one database — the shape
    // §4.4 exists for. Before [0030] each instance held its own Map and handed out
    // the full RATE_LIMIT_MAX, so the effective limit was silently double.
    server = await startTestServer({
      rateLimit: { max: 3, windowMs: 60_000 },
      secondInstance: true,
      allowMultipleGroups: true,
    })
    const second = server.second
    if (!second) throw new Error('secondInstance did not produce a companion listener')

    const doors = [server.baseUrl, second.baseUrl, server.baseUrl, second.baseUrl]
    const statuses: number[] = []
    for (const baseUrl of doors) {
      const res = await http.post(baseUrl, '/v1/endpoints/register', REGISTER_BODY)
      statuses.push(res.status)
    }
    expect(statuses).toEqual([201, 201, 201, 429])

    // The refusal is the contract's, whichever door answered it.
    const res = await fetch(`${second.baseUrl}/v1/endpoints/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(REGISTER_BODY),
    })
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBeTruthy()
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('rate_limited')
  })

  it('holds exactly when both instances are hit at once', async () => {
    server = await startTestServer({
      rateLimit: { max: 4, windowMs: 60_000 },
      secondInstance: true,
      allowMultipleGroups: true,
    })
    const second = server.second
    if (!second) throw new Error('secondInstance did not produce a companion listener')
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        http.post(i % 2 === 0 ? server.baseUrl : second.baseUrl, '/v1/endpoints/register', {
          ...REGISTER_BODY,
          e2ePubkey: `k${i}`,
        }),
      ),
    )
    expect(results.filter((r) => r.status === 201)).toHaveLength(4)
    expect(results.filter((r) => r.status === 429)).toHaveLength(8)
  })

  it('shares a per-group send cap across instances too', async () => {
    server = await startTestServer({
      caps: { sendsPerWindow: 2, sendWindowMs: 60_000 },
      secondInstance: true,
    })
    const second = server.second
    if (!second) throw new Error('secondInstance did not produce a companion listener')
    const source = await register(server.baseUrl, { e2ePubkey: 'source-key' })
    const link = await http.post<{ link: string }>(
      server.baseUrl,
      '/v1/pairing',
      undefined,
      source.token,
    )
    const target = await register(server.baseUrl, {
      pairingCode: pairingCodeFromLink(link.body.link),
      e2ePubkey: 'target-key',
    })

    const sendOne = (baseUrl: string) =>
      http.post<SendResponse>(
        baseUrl,
        '/v1/messages',
        {
          items: [
            {
              id: randomUUID(),
              targetEndpointId: target.endpointId,
              envelope: envelopeFor('target-key'),
            },
          ],
        },
        source.token,
      )

    expect((await sendOne(server.baseUrl)).body.accepted).toHaveLength(1)
    expect((await sendOne(second.baseUrl)).body.accepted).toHaveLength(1)
    // The third is refused whichever door it arrives at: one group, one window.
    const third = await sendOne(second.baseUrl)
    expect(third.body.rejected[0]).toMatchObject({
      reason: 'limit_reached',
      limit: 'sends_per_window',
    })
  })
})

describe('the sweeper drops finished windows', () => {
  it('deletes ended windows and leaves the live one alone', async () => {
    server = await startTestServer()
    const now = new Date('2026-07-16T12:00:30.000Z')
    await hitQuota(server.db, { scope: 'old', key: 'k', max: 5, windowMs: 60_000, now })
    await hitQuota(server.db, {
      scope: 'live',
      key: 'k',
      max: 5,
      windowMs: 60_000,
      now: new Date('2026-07-16T12:05:30.000Z'),
    })

    // 12:03 is past the first window's end (12:01) and inside the second's.
    const dropped = await sweepQuotaCounters(server.db, new Date('2026-07-16T12:05:40.000Z'))
    expect(dropped).toBe(1)
    const left = await server.db.selectFrom('quota_counters').select('scope').execute()
    expect(left.map((r) => r.scope)).toEqual(['live'])
  })

  it('rides the ordinary TTL sweep, so nothing needs its own timer', async () => {
    server = await startTestServer()
    await hitQuota(server.db, {
      scope: 'old',
      key: 'k',
      max: 5,
      windowMs: 60_000,
      now: new Date('2026-07-16T12:00:00.000Z'),
    })
    const result = await sweepExpired(server.db, new Date('2026-07-16T13:00:00.000Z'), 0, 0)
    expect(result.quotaWindowsDropped).toBe(1)
  })
})
