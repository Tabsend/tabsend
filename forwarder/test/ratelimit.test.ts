import { afterEach, describe, expect, it, vi } from 'vitest'
import { RateLimiter, SWEEP_EVERY_HITS } from '../src/ratelimit'
import { newWakeToken } from '../src/tokens'
import { fakeApnsToken, post, register, startRig, type TestRig } from './helpers'

/**
 * The abuse contract: a wake is a doorbell, and more than a few rings a minute is abuse
 * (PROTOCOL.md §6). Both limits are asserted separately, because they defend against
 * different things — one leaked token, and one hostile caller.
 */
describe('rate limiting', () => {
  const rigs: TestRig[] = []

  afterEach(async () => {
    await Promise.all(rigs.splice(0).map((rig) => rig.close()))
  })

  async function rigWith(env: NodeJS.ProcessEnv): Promise<TestRig> {
    const rig = await startRig({ env })
    rigs.push(rig)
    return rig
  }

  it('limits wakes per token SILENTLY: still 202, but the phone is not rung', async () => {
    // A generous caller limit, so this test can only trip the per-token one.
    const rig = await rigWith({
      WAKE_RATE_LIMIT_MAX: '3',
      WAKE_RATE_LIMIT_WINDOW_SECONDS: '60',
      CALLER_RATE_LIMIT_MAX: '1000',
    })
    const { wakeToken } = await register(rig)

    for (let i = 0; i < 3; i++) {
      expect((await post(rig, '/v1/wake', {}, wakeToken)).status).toBe(202)
    }
    const past = await post(rig, '/v1/wake', {}, wakeToken)

    // PROTOCOL.md §4 [2026-10-01]. This bucket is shared with the relay that really
    // rings the phone, so a 429 with a Retry-After told whoever held a leaked token
    // that it was live and roughly when its relay last rang it. Over the limit now
    // reads exactly like any other wake, and the phone is simply not rung.
    expect(past.status).toBe(202)
    expect(past.body).toEqual({ status: 'accepted' })
    expect(past.headers.get('retry-after')).toBeNull()
    await vi.waitFor(() =>
      expect(rig.log.all()).toContain('Wake dropped: this token is over its per-device limit'),
    )
    expect(rig.apns.calls).toHaveLength(3)

    // A second device on the same caller is unaffected: the bucket is per token.
    const other = await register(rig, fakeApnsToken())
    expect((await post(rig, '/v1/wake', {}, other.wakeToken)).status).toBe(202)
    await vi.waitFor(() => expect(rig.apns.calls).toHaveLength(4))

    // The window is fixed, so it reopens when it rolls over.
    rig.clock.advance(60_000)
    expect((await post(rig, '/v1/wake', {}, wakeToken)).status).toBe(202)
    await vi.waitFor(() => expect(rig.apns.calls).toHaveLength(5))
  })

  it('limits wakes per caller across different tokens', async () => {
    const rig = await rigWith({
      CALLER_RATE_LIMIT_MAX: '2',
      CALLER_RATE_LIMIT_WINDOW_SECONDS: '60',
      WAKE_RATE_LIMIT_MAX: '1000',
    })
    const a = await register(rig, fakeApnsToken())
    const b = await register(rig, fakeApnsToken())
    const c = await register(rig, fakeApnsToken())

    expect((await post(rig, '/v1/wake', {}, a.wakeToken)).status).toBe(202)
    expect((await post(rig, '/v1/wake', {}, b.wakeToken)).status).toBe(202)
    const refused = await post(rig, '/v1/wake', {}, c.wakeToken)

    expect(refused.status).toBe(429)
    expect(rig.apns.calls).toHaveLength(2)
  })

  it('spends the same budget on unknown tokens as on live ones, so the limit is not an oracle', async () => {
    const rig = await rigWith({ CALLER_RATE_LIMIT_MAX: '2', WAKE_RATE_LIMIT_MAX: '1000' })
    const { wakeToken } = await register(rig)

    // Two wakes for tokens that do not exist consume the caller budget in full.
    expect((await post(rig, '/v1/wake', {}, newWakeToken())).status).toBe(202)
    expect((await post(rig, '/v1/wake', {}, newWakeToken())).status).toBe(202)
    const live = await post(rig, '/v1/wake', {}, wakeToken)

    expect(live.status).toBe(429)
  })

  it('limits registrations per caller', async () => {
    const rig = await rigWith({
      REGISTER_RATE_LIMIT_MAX: '2',
      REGISTER_RATE_LIMIT_WINDOW_SECONDS: '600',
    })

    await register(rig, fakeApnsToken())
    await register(rig, fakeApnsToken())
    const refused = await post(rig, '/v1/register', { apnsToken: fakeApnsToken() })

    expect(refused.status).toBe(429)
    expect(refused.headers.get('retry-after')).toBe('600')
    expect(rig.store.count()).toBe(2)
  })

  /**
   * The wake bucket is keyed by the hash of whatever token was presented, and it is
   * charged before the store is consulted (PROTOCOL.md §4), so a prober can mint a fresh
   * key on every request. Nothing but a sweep gets those buckets back.
   */
  it('drops closed windows for keys nobody presents again', () => {
    let clock = 0
    const limiter = new RateLimiter({ max: SWEEP_EVERY_HITS, windowMs: 60_000 }, () => clock)

    for (let i = 0; i < SWEEP_EVERY_HITS; i++) limiter.hit(`probe-${i}`)
    expect(limiter.size).toBe(SWEEP_EVERY_HITS)

    // Every probe window has now closed, and not one of those keys will ever be seen
    // again. Ordinary traffic on one live key is enough to clear them out.
    clock += 60_001
    for (let i = 0; i < SWEEP_EVERY_HITS; i++) limiter.hit('a-real-caller')

    expect(limiter.size).toBe(1)
    // The surviving bucket kept its count, so a sweep is bookkeeping and not an amnesty.
    expect(limiter.hit('a-real-caller')).toEqual({ ok: false, retryAfterMs: 60_000 })
  })

  /** Found by the 2026-10-02 verification pass: with nobody else calling, nothing swept. */
  it('drops a closed window on its own timer, with no further calls', async () => {
    const limiter = new RateLimiter({ max: 5, windowMs: 30 })
    try {
      limiter.hit('203.0.113.77')
      expect(limiter.size).toBe(1)
      await vi.waitFor(() => expect(limiter.size).toBe(0), { timeout: 1000, interval: 10 })
    } finally {
      limiter.close()
    }
  })

  it('can be turned off entirely with a max of zero', async () => {
    const rig = await rigWith({ WAKE_RATE_LIMIT_MAX: '0', CALLER_RATE_LIMIT_MAX: '0' })
    const { wakeToken } = await register(rig)

    for (let i = 0; i < 20; i++) {
      expect((await post(rig, '/v1/wake', {}, wakeToken)).status).toBe(202)
    }
    expect(rig.apns.calls).toHaveLength(20)
  })
})
