import { performance } from 'node:perf_hooks'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RING_DELAY_MAX_MS, randomRingDelayMs } from '../src/app'
import { hashWakeToken, newWakeToken } from '../src/tokens'
import { deferred, fakeApnsToken, post, register, startRig, type TestRig } from './helpers'

/**
 * The wake path: the happy ring, and the uniform answer that keeps this route from
 * becoming a token-validity oracle (PROTOCOL.md §3.2, §4).
 */
describe('POST /v1/wake', () => {
  let rig: TestRig

  beforeEach(async () => {
    rig = await startRig()
  })
  afterEach(async () => {
    await rig.close()
  })

  it('rings the registered device and records the wake', async () => {
    const { wakeToken, apnsToken } = await register(rig)

    const response = await post(rig, '/v1/wake', {}, wakeToken)

    expect(response.status).toBe(202)
    expect(response.body).toEqual({ status: 'accepted' })
    expect(rig.apns.calls).toEqual([{ apnsToken, environment: 'production' }])
    const stored = rig.store.find(hashWakeToken(wakeToken))
    expect(stored?.wakeCount).toBe(1)
    expect(stored?.lastWakeAt).toBe(rig.clock.now())
  })

  it('is idempotent: replayed rings are just more rings, and leave one row', async () => {
    const { wakeToken } = await register(rig)

    for (let i = 0; i < 3; i++) await post(rig, '/v1/wake', {}, wakeToken)

    expect(rig.apns.calls).toHaveLength(3)
    expect(rig.store.count()).toBe(1)
    expect(rig.store.find(hashWakeToken(wakeToken))?.wakeCount).toBe(3)
  })

  it('answers an unknown token exactly as it answers a live one', async () => {
    const { wakeToken } = await register(rig)
    const live = await post(rig, '/v1/wake', {}, wakeToken)
    const unknown = await post(rig, '/v1/wake', {}, newWakeToken())

    expect(unknown.status).toBe(live.status)
    expect(unknown.body).toEqual(live.body)
    // Nothing was rung for the unknown one, and nothing was stored for it either.
    expect(rig.apns.calls).toHaveLength(1)
    expect(rig.store.count()).toBe(1)
  })

  it('answers a REVOKED token exactly as it answers a live one', async () => {
    const revoked = await register(rig)
    const alive = await register(rig)
    await post(rig, '/v1/revoke', {}, revoked.wakeToken)

    const afterRevoke = await post(rig, '/v1/wake', {}, revoked.wakeToken)
    const live = await post(rig, '/v1/wake', {}, alive.wakeToken)

    expect(afterRevoke.status).toBe(live.status)
    expect(afterRevoke.body).toEqual(live.body)
  })

  it('answers before Apple does, so a live token is no slower than an unknown one', async () => {
    const { wakeToken } = await register(rig)
    // Apple will not answer until this test says so. A route that awaited the ring could
    // not reply at all, so the 202 below is the assertion.
    const apple = deferred()
    rig.apns.gate = apple.promise

    const response = await post(rig, '/v1/wake', {}, wakeToken)

    expect(response.status).toBe(202)
    expect(response.body).toEqual({ status: 'accepted' })
    // The ring was started and the wake recorded — AFTER the reply, not before it (the
    // ordering is asserted at the bottom of this file), and either way without ever
    // waiting for Apple.
    await vi.waitFor(() => expect(rig.apns.calls).toHaveLength(1))
    expect(rig.store.find(hashWakeToken(wakeToken))?.wakeCount).toBe(1)

    apple.open()
    // And the outcome still reaches the operator, on the detached path.
    await vi.waitFor(() => expect(rig.log.all()).toContain('Rang a device'))
  })

  it('answers 202 even when Apple refuses, so an outage is not a validity signal', async () => {
    const { wakeToken } = await register(rig)
    rig.apns.failNext = { ok: false, deviceGone: false, status: 503, reason: 'ServiceUnavailable' }

    const response = await post(rig, '/v1/wake', {}, wakeToken)

    expect(response.status).toBe(202)
    expect(response.body).toEqual({ status: 'accepted' })
    // The device is kept: a transient Apple failure is not evidence the phone is gone.
    expect(rig.store.count()).toBe(1)
    // The caller learns nothing, but the operator does.
    await vi.waitFor(() => expect(rig.log.all()).toContain('APNs refused a wake'))
  })

  it('drops a device Apple reports as gone, after the response has gone out', async () => {
    const { wakeToken } = await register(rig)
    rig.apns.failNext = { ok: false, deviceGone: true, status: 410, reason: 'Unregistered' }
    const apple = deferred()
    rig.apns.gate = apple.promise

    const response = await post(rig, '/v1/wake', {}, wakeToken)

    expect(response.status).toBe(202)
    // Still registered: Apple has not answered yet, and the reply did not wait for it.
    expect(rig.store.count()).toBe(1)

    apple.open()
    await vi.waitFor(() => {
      expect(rig.store.find(hashWakeToken(wakeToken))).toBeUndefined()
      expect(rig.store.count()).toBe(0)
    })
  })

  it('keeps the registration when Apple says BadDeviceToken, and names the likely cause', async () => {
    const { wakeToken } = await register(rig)
    // A locally signed Release build gets a sandbox token; a production forwarder is told
    // BadDeviceToken for it, every time. Deleting on that would unregister a live phone.
    rig.apns.failNext = { ok: false, deviceGone: false, status: 400, reason: 'BadDeviceToken' }

    const response = await post(rig, '/v1/wake', {}, wakeToken)

    expect(response.status).toBe(202)
    await vi.waitFor(() => expect(rig.log.all()).toContain('environment mismatch'))
    expect(rig.store.find(hashWakeToken(wakeToken))).toBeDefined()
    expect(rig.store.count()).toBe(1)
  })

  it('refuses a malformed or missing token with an actionable message', async () => {
    const missing = await post(rig, '/v1/wake', {})
    expect(missing.status).toBe(400)
    expect(missing.body.error.code).toBe('invalid_request')
    expect(missing.body.error.message).toContain('Authorization')

    const wrongShape = await post(rig, '/v1/wake', {}, 'too-short')
    expect(wrongShape.status).toBe(400)
    expect(wrongShape.body.error.message).toContain('43-character')

    expect(rig.apns.calls).toHaveLength(0)
  })

  it('never accepts a wake token in the URL', async () => {
    const { wakeToken } = await register(rig)

    const inPath = await fetch(`${rig.baseUrl}/v1/wake/${wakeToken}`, { method: 'POST' })
    expect(inPath.status).toBe(404)

    const inQuery = await fetch(`${rig.baseUrl}/v1/wake?token=${wakeToken}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    // The route exists, but the query string is not a credential: it is refused for a
    // missing header, exactly as a bare call would be (PROTOCOL.md §6).
    expect(inQuery.status).toBe(400)
    expect(rig.apns.calls).toHaveLength(0)
  })
})

describe('POST /v1/revoke', () => {
  let rig: TestRig

  beforeEach(async () => {
    rig = await startRig()
  })
  afterEach(async () => {
    await rig.close()
  })

  it('answers an unknown token exactly as it answers a live one', async () => {
    const { wakeToken } = await register(rig, fakeApnsToken())
    const known = await post(rig, '/v1/revoke', {}, wakeToken)
    const unknown = await post(rig, '/v1/revoke', {}, newWakeToken())

    expect(unknown.status).toBe(known.status)
    expect(unknown.body).toEqual(known.body)
  })

  it('is idempotent', async () => {
    const { wakeToken } = await register(rig)
    const first = await post(rig, '/v1/revoke', {}, wakeToken)
    const second = await post(rig, '/v1/revoke', {}, wakeToken)

    expect(second.status).toBe(first.status)
    expect(second.body).toEqual(first.body)
  })
})

describe('GET /healthz', () => {
  it('reports liveness and nothing about the user base', async () => {
    const rig = await startRig()
    try {
      await register(rig)
      const response = await fetch(`${rig.baseUrl}/healthz`)
      const body = (await response.json()) as Record<string, unknown>

      expect(response.status).toBe(200)
      expect(body.status).toBe('ok')
      expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0)
      // No device count, no wake tallies (PROTOCOL.md §3.4).
      expect(Object.keys(body).sort()).toEqual(['status', 'uptimeSeconds', 'version'])
    } finally {
      await rig.close()
    }
  })
})

/**
 * §4's clock corollary, asserted rather than commented.
 *
 * "The same work done before the reply" is the whole of §4, and detaching the APNs call
 * was only half of it. A live token still paid, before its 202, for a `recordWake` write
 * and for whatever `apns.wake` does synchronously before its first await — opening an
 * HTTP/2 session, signing an ES256 JWT, building the request — while an unknown token
 * returned from the store lookup having done none of it. That is a difference a prober
 * with a stopwatch can read, and it is the same distinction the rest of §4 spends its
 * length denying.
 *
 * The reply is observed where its bytes go to the socket (`res.end`), with an async
 * `onSend` hook in the chain so the write is itself a few microtasks late, as it would be
 * behind any plugin (see `onReplyWritten` in helpers.ts). Everything the route defers
 * runs on `setImmediate`, a macrotask, so the whole reply chain drains first. A deferral
 * weakened to a microtask runs ahead of that write, and these tests fail on it.
 */
describe('POST /v1/wake does the same work before the reply, whatever the token', () => {
  let order: string[]
  let rig: TestRig
  /** Whether the unknown-token log line already existed when the reply went out. */
  let loggedBeforeReply = false

  beforeEach(async () => {
    order = []
    loggedBeforeReply = false
    rig = await startRig({
      onReplyWritten: () => {
        order.push('reply')
        if (rig?.log.all().includes('Wake for an unknown or revoked token')) {
          loggedBeforeReply = true
        }
      },
    })
    const realRecordWake = rig.store.recordWake.bind(rig.store)
    rig.store.recordWake = (hash: string, at: number) => {
      order.push('recordWake')
      realRecordWake(hash, at)
    }
    const realWake = rig.apns.wake.bind(rig.apns)
    rig.apns.wake = async (request) => {
      order.push('apns')
      return realWake(request)
    }
    // Since 2026-10-02 the lookup itself waits for the reply too: reading a live row
    // decrypts its address, which an unknown token never pays for (SECURITY_REVIEW G14).
    const realFind = rig.store.find.bind(rig.store)
    rig.store.find = (hash: string) => {
      order.push('find')
      return realFind(hash)
    }
  })
  afterEach(async () => {
    await rig.close()
  })

  it('records the wake and rings Apple only after the 202 is on its way', async () => {
    const { wakeToken } = await register(rig)
    order.length = 0 // the register reply is not what is under test

    const response = await post(rig, '/v1/wake', {}, wakeToken)
    expect(response.status).toBe(202)

    await vi.waitFor(() => expect(order).toContain('apns'))
    // Nothing that depends on the token existing happens before the reply.
    expect(order).toEqual(['reply', 'find', 'recordWake', 'apns'])
  })

  it('leaves an unknown token nothing extra to pay for either', async () => {
    order.length = 0

    const response = await post(rig, '/v1/wake', {}, newWakeToken())
    expect(response.status).toBe(202)

    // One reply, then the lookup, and nothing else. The log line an operator gets is
    // written after the reply for the same reason.
    await vi.waitFor(() => expect(rig.log.all()).toContain('Wake for an unknown or revoked token'))
    expect(order).toEqual(['reply', 'find'])
    expect(loggedBeforeReply).toBe(false)
  })

  it('revokes only after the reply, so a live token is not slower to retire', async () => {
    const { wakeToken } = await register(rig)
    const realDelete = rig.store.delete.bind(rig.store)
    rig.store.delete = (hash: string) => {
      order.push('delete')
      return realDelete(hash)
    }
    order.length = 0

    const response = await post(rig, '/v1/revoke', {}, wakeToken)
    expect(response.status).toBe(200)

    await vi.waitFor(() => expect(order).toContain('delete'))
    expect(order).toEqual(['reply', 'delete'])
    // And it did retire it: the next ring for it is the unknown-token case.
    await vi.waitFor(() => expect(rig.store.find(hashWakeToken(wakeToken))).toBeUndefined())
  })
})

/**
 * The pause between a reply and its work [2026-10-02, SECURITY_REVIEW G14].
 *
 * Replying first kept a live token from being slower to answer, but its work still ran
 * straight after the reply, so a prober who asked the forwarder anything at that moment
 * found it busy after a live token and idle after a dead one. Measured from outside, that
 * told the two apart in a handful of samples. The work now starts at a random point in
 * the next `RING_DELAY_MAX_MS`.
 */
describe('POST /v1/wake starts its work at a random point after the reply', () => {
  it('draws delays across the whole window, never past it', () => {
    const draws = Array.from({ length: 2000 }, () => randomRingDelayMs())
    for (const delay of draws) {
      expect(Number.isInteger(delay)).toBe(true)
      expect(delay).toBeGreaterThanOrEqual(0)
      expect(delay).toBeLessThanOrEqual(RING_DELAY_MAX_MS)
    }
    expect(Math.min(...draws)).toBeLessThan(RING_DELAY_MAX_MS * 0.1)
    expect(Math.max(...draws)).toBeGreaterThan(RING_DELAY_MAX_MS * 0.9)
    const mean = draws.reduce((sum, delay) => sum + delay, 0) / draws.length
    expect(mean).toBeGreaterThan(RING_DELAY_MAX_MS * 0.4)
    expect(mean).toBeLessThan(RING_DELAY_MAX_MS * 0.6)
  })

  it('waits the delay after the reply before ringing or revoking, and the reply does not wait', async () => {
    const marks: { what: string; at: number }[] = []
    const rig = await startRig({
      ringDelayMs: () => 150,
      onReplyWritten: () => marks.push({ what: 'reply', at: performance.now() }),
    })
    try {
      const realWake = rig.apns.wake.bind(rig.apns)
      rig.apns.wake = async (request) => {
        marks.push({ what: 'apns', at: performance.now() })
        return realWake(request)
      }
      const realDelete = rig.store.delete.bind(rig.store)
      rig.store.delete = (hash: string) => {
        marks.push({ what: 'delete', at: performance.now() })
        return realDelete(hash)
      }
      const { wakeToken } = await register(rig)
      marks.length = 0

      expect((await post(rig, '/v1/wake', {}, wakeToken)).status).toBe(202)
      await vi.waitFor(() => expect(marks.map((m) => m.what)).toContain('apns'))
      expect((await post(rig, '/v1/revoke', {}, wakeToken)).status).toBe(200)
      await vi.waitFor(() => expect(marks.map((m) => m.what)).toContain('delete'))

      expect(marks.map((m) => m.what)).toEqual(['reply', 'apns', 'reply', 'delete'])
      const [wakeReply, ring, revokeReply, removal] = marks.map((mark) => mark.at) as [
        number,
        number,
        number,
        number,
      ]
      expect(ring - wakeReply).toBeGreaterThanOrEqual(145)
      expect(removal - revokeReply).toBeGreaterThanOrEqual(145)
    } finally {
      await rig.close()
    }
  })

  it('uses the random delay when nothing overrides it', async () => {
    const replies: number[] = []
    const rings: number[] = []
    const rig = await startRig({
      ringDelayMs: 'production',
      env: { WAKE_RATE_LIMIT_MAX: '0', CALLER_RATE_LIMIT_MAX: '0' },
      onReplyWritten: () => replies.push(performance.now()),
    })
    try {
      const { wakeToken } = await register(rig)
      replies.length = 0
      const realWake = rig.apns.wake.bind(rig.apns)
      rig.apns.wake = async (request) => {
        rings.push(performance.now())
        return realWake(request)
      }
      for (let i = 0; i < 10; i++) {
        await post(rig, '/v1/wake', {}, wakeToken)
        await vi.waitFor(() => expect(rings).toHaveLength(i + 1), { timeout: 3000 })
      }
      const delays = rings.map((at, i) => at - (replies[i] as number))
      // Ten draws from [0, 500]: all ten under 150 ms would happen about six times in a
      // million runs. A delay of zero puts every ring within a few ms of its reply.
      expect(Math.max(...delays)).toBeGreaterThanOrEqual(150)
      for (const delay of delays) expect(delay).toBeLessThan(RING_DELAY_MAX_MS + 250)
      // And not one fixed delay, which a prober would simply line up with: ten draws all
      // within 100 ms of each other happen about four times in a million runs.
      expect(Math.max(...delays) - Math.min(...delays)).toBeGreaterThanOrEqual(100)
    } finally {
      await rig.close()
    }
  })
})
