import { randomUUID } from 'node:crypto'
import type { PushSubscription } from '@tabsend/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  envelopeFor,
  http,
  pairingCodeFromLink,
  register,
  startTestServer,
  type TestServer,
} from './helpers'

describe('rate limiting (auth-free write routes)', () => {
  let server: TestServer
  beforeEach(async () => {
    // Multi-group so repeated bare registers stay 201s: this suite is about the
    // limiter's counting, not about ADR-0022's one-group-per-relay policy.
    server = await startTestServer({
      rateLimit: { max: 2, windowMs: 60_000 },
      allowMultipleGroups: true,
    })
  })
  afterEach(async () => {
    await server.close()
  })

  const body = {
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

  it('emits rate_limited (429) + Retry-After once the window budget is spent', async () => {
    // max = 2 → first two register attempts pass, third is throttled.
    const r1 = await http.post(server.baseUrl, '/v1/endpoints/register', body)
    const r2 = await http.post(server.baseUrl, '/v1/endpoints/register', body)
    expect(r1.status).toBe(201)
    expect(r2.status).toBe(201)

    const res = await fetch(`${server.baseUrl}/v1/endpoints/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBeTruthy()
    const parsed = (await res.json()) as { error: { code: string } }
    expect(parsed.error.code).toBe('rate_limited')
  })

  it('is switched OFF by a zero window, and register still works', async () => {
    // `RATE_LIMIT_WINDOW_SECONDS=0` used to be fatal rather than permissive: the
    // window reached `windowBounds`, produced NaN boundaries, and the limiter — which
    // fails CLOSED — turned every register into a 500. An operator switching a limit
    // off must never take the one unauthenticated write route down with it.
    const off = await startTestServer({
      rateLimit: { max: 5, windowMs: 0 },
      allowMultipleGroups: true,
    })
    try {
      for (let i = 0; i < 7; i++) {
        const res = await http.post(off.baseUrl, '/v1/endpoints/register', body)
        expect(res.status).toBe(201)
      }
      // Nothing was counted either: a limiter with no window writes no rows.
      const rows = await off.db.selectFrom('quota_counters').select('scope').execute()
      expect(rows).toEqual([])
    } finally {
      await off.close()
    }
  })

  it('exposes no recovery route at all (ADR-0021)', async () => {
    // There is deliberately no phrase-authorised back door into a group. Asserted here
    // rather than merely deleted, so re-adding one is a visible, failing decision.
    const res = await http.post(server.baseUrl, '/v1/endpoints/recover', {
      ...body,
      recoveryPhrase: 'anything at all here',
    })
    expect(res.status).toBe(404)
  })
})

describe('request size cap', () => {
  let server: TestServer
  beforeEach(async () => {
    // Small cap so the whole (rejected) body still fits the TCP send buffer in one
    // write — the client then reads a clean 413 instead of an ECONNRESET mid-stream.
    server = await startTestServer({ bodyLimitBytes: 1024 })
  })
  afterEach(async () => {
    await server.close()
  })

  it('rejects an over-limit body with 413 (mapped to the error envelope)', async () => {
    const overLimit = 'x'.repeat(4096) // 4 KiB > the 1 KiB cap
    const res = await fetch(`${server.baseUrl}/v1/endpoints/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: overLimit, kind: 'extension' }),
    })
    expect(res.status).toBe(413)
    const parsed = (await res.json()) as { error: { code: string } }
    expect(parsed.error.code).toBe('invalid_request')
  })
})

/**
 * Client-chosen ids are short handles [2026-10-01 follow-up review, R7]. Unbounded, an
 * id was the one part of a stored row nothing measured: it rode past the byte caps and
 * the usage report, a single one could be most of a request, and on Postgres a long
 * one failed the primary-key index with a 500 instead of a 400.
 */
describe('id length', () => {
  let server: TestServer
  beforeEach(async () => {
    server = await startTestServer()
  })
  afterEach(async () => {
    await server.close()
  })

  async function sendWithId(id: string) {
    const a = await register(server.baseUrl)
    const code = pairingCodeFromLink(
      (await http.post<{ link: string }>(server.baseUrl, '/v1/pairing', undefined, a.token)).body
        .link,
    )
    const b = await register(server.baseUrl, { pairingCode: code })
    return http.post<{ accepted?: string[]; error?: { code: string; message: string } }>(
      server.baseUrl,
      '/v1/messages',
      { items: [{ id, targetEndpointId: b.endpointId, envelope: envelopeFor(b.e2ePubkey) }] },
      a.token,
    )
  }

  it('accepts an id up to 128 characters', async () => {
    const id = 'm'.repeat(128)
    expect((await sendWithId(id)).body.accepted).toEqual([id])
  })

  it('refuses an id carrying a NUL character, which Postgres cannot store', async () => {
    const res = await sendWithId('m\u0000x')
    expect(res.status).toBe(400)
    expect(res.body.error?.code).toBe('invalid_request')
  })

  it('refuses a longer one as malformed, on both dialects alike', async () => {
    const res = await sendWithId('m'.repeat(4_000))
    expect(res.status).toBe(400)
    expect(res.body.error?.code).toBe('invalid_request')
    expect(res.body.error?.message).toContain('at most 128 characters')
  })
})

describe('dead push-subscription pruning', () => {
  let server: TestServer
  beforeEach(async () => {
    server = await startTestServer({ pushDeadThreshold: 2 })
  })
  afterEach(async () => {
    await server.close()
  })

  const sub: PushSubscription = {
    transport: 'webpush',
    endpoint: 'https://push.test/dead',
    keys: { p256dh: 'p', auth: 'a' },
  }

  async function sendTo(sourceToken: string, targetId: string, targetPubkey: string) {
    return http.post<{ accepted: string[] }>(
      server.baseUrl,
      '/v1/messages',
      {
        items: [
          { id: randomUUID(), targetEndpointId: targetId, envelope: envelopeFor(targetPubkey) },
        ],
      },
      sourceToken,
    )
  }

  it('marks a subscription dead after N consecutive 404/410s and skips further wakes', async () => {
    const source = await register(server.baseUrl, { e2ePubkey: 'source-key' })
    const target = await register(server.baseUrl, {
      pairingCode: await mintCode(server, source.token),
      e2ePubkey: 'target-key',
      pushSubscription: sub,
    })

    // First two sends: the push service returns 410 → failures 1, then 2 (== threshold).
    server.push.failDeadNextStatus = 410
    await sendTo(source.token, target.endpointId, 'target-key')
    server.push.failDeadNextStatus = 410
    await sendTo(source.token, target.endpointId, 'target-key')

    const afterTwo = await failuresOf(server, target.endpointId)
    expect(afterTwo).toBe(2)

    // Third send: subscription is dead → the relay SKIPS the network wake entirely
    // (push.calls does not grow), but the message is still queued + WS-delivered.
    const callsBefore = server.push.calls.length
    const third = await sendTo(source.token, target.endpointId, 'target-key')
    expect(third.body.accepted).toHaveLength(1) // send still succeeds
    expect(server.push.calls.length).toBe(callsBefore) // no wake attempted

    // The target can still pull the queued messages (correctness never depended on push).
    const pending = await http.get<unknown[]>(
      server.baseUrl,
      '/v1/messages?pending=1',
      target.token,
    )
    expect(pending.body.length).toBeGreaterThanOrEqual(1)
  })

  it('a good wake resets the transient failure count', async () => {
    const source = await register(server.baseUrl, { e2ePubkey: 'source-key' })
    const target = await register(server.baseUrl, {
      pairingCode: await mintCode(server, source.token),
      e2ePubkey: 'target-key',
      pushSubscription: sub,
    })

    server.push.failDeadNextStatus = 404
    await sendTo(source.token, target.endpointId, 'target-key')
    expect(await failuresOf(server, target.endpointId)).toBe(1)

    // Next wake succeeds → counter clears.
    await sendTo(source.token, target.endpointId, 'target-key')
    expect(await failuresOf(server, target.endpointId)).toBe(0)
  })

  it('heartbeat with a fresh subscription clears a dead marking (client self-heal)', async () => {
    const source = await register(server.baseUrl, { e2ePubkey: 'source-key' })
    const target = await register(server.baseUrl, {
      pairingCode: await mintCode(server, source.token),
      e2ePubkey: 'target-key',
      pushSubscription: sub,
    })

    server.push.failDeadNextStatus = 410
    await sendTo(source.token, target.endpointId, 'target-key')
    server.push.failDeadNextStatus = 410
    await sendTo(source.token, target.endpointId, 'target-key')
    expect(await failuresOf(server, target.endpointId)).toBe(2)

    // The client re-registers a fresh subscription via heartbeat → counter resets.
    const hb = await http.post(
      server.baseUrl,
      `/v1/endpoints/${target.endpointId}/heartbeat`,
      {
        pushSubscription: {
          transport: 'webpush',
          endpoint: 'https://push.test/fresh',
          keys: { p256dh: 'p2', auth: 'a2' },
        },
      },
      target.token,
    )
    expect(hb.status).toBe(200)
    expect(await failuresOf(server, target.endpointId)).toBe(0)

    // Wakes resume.
    const callsBefore = server.push.calls.length
    await sendTo(source.token, target.endpointId, 'target-key')
    expect(server.push.calls.length).toBe(callsBefore + 1)
  })
})

// --- test helpers ----------------------------------------------------------

async function mintCode(server: TestServer, token: string): Promise<string> {
  const res = await http.post<{ link: string }>(server.baseUrl, '/v1/pairing', undefined, token)
  return pairingCodeFromLink(res.body.link)
}

async function failuresOf(server: TestServer, endpointId: string): Promise<number> {
  const row = await server.db
    .selectFrom('endpoints')
    .select('push_failures')
    .where('id', '=', endpointId)
    .executeTakeFirstOrThrow()
  return Number(row.push_failures)
}
