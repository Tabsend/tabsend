import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hashWakeToken, newWakeToken } from '../src/tokens'
import {
  deferred,
  fakeApnsToken,
  fakeFcmToken,
  post,
  register,
  registerAndroid,
  startRig,
  type TestRig,
} from './helpers'

/**
 * The Android half of the forwarder: the same wake token, the same 202, the same silence
 * about whether a token exists — rung through Google instead of Apple.
 *
 * The property these tests exist to protect is that adding a provider changed nothing a
 * relay can see. A relay holds a wake token and posts to /v1/wake; which provider answers
 * is the forwarder's business and appears nowhere on the wire.
 */
describe('Android devices', () => {
  let rig: TestRig

  beforeEach(async () => {
    rig = await startRig()
  })
  afterEach(async () => {
    await rig.close()
  })

  it('registers with an fcmToken and rings through Google, not Apple', async () => {
    const { wakeToken, fcmToken } = await registerAndroid(rig)

    expect(wakeToken).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const stored = rig.store.find(hashWakeToken(wakeToken))
    expect(stored?.platform).toBe('android')
    expect(stored?.deviceToken).toBe(fcmToken)

    const woken = await post(rig, '/v1/wake', {}, wakeToken)
    expect(woken.status).toBe(202)
    expect(rig.fcm?.calls).toEqual([{ fcmToken }])
    expect(rig.apns.calls).toHaveLength(0)
  })

  it('answers a wake without waiting for Google', async () => {
    const { wakeToken } = await registerAndroid(rig)
    // Hold Google shut. A route that awaited the ring would hang here instead of replying,
    // which is the §4 property for the Apple path restated for this one.
    const gate = deferred()
    if (rig.fcm) rig.fcm.gate = gate.promise

    const woken = await post(rig, '/v1/wake', {}, wakeToken)
    expect(woken.status).toBe(202)
    expect(rig.fcm?.calls).toHaveLength(1)
    gate.open()
  })

  it('drops a row Google reports UNREGISTERED, and keeps one it merely refuses', async () => {
    const gone = await registerAndroid(rig)
    if (rig.fcm) {
      rig.fcm.failNext = { ok: false, deviceGone: true, status: 404, reason: 'UNREGISTERED' }
    }
    await post(rig, '/v1/wake', {}, gone.wakeToken)
    await rig.app.close()
    expect(rig.store.find(hashWakeToken(gone.wakeToken))).toBeUndefined()

    // A fresh rig, because the one above is closed. INVALID_ARGUMENT is the answer Google
    // gives for a live token shown to the wrong Firebase project, so the row must survive.
    const second = await startRig()
    try {
      const kept = await registerAndroid(second)
      if (second.fcm) {
        second.fcm.failNext = {
          ok: false,
          deviceGone: false,
          status: 400,
          reason: 'INVALID_ARGUMENT',
        }
      }
      await post(second, '/v1/wake', {}, kept.wakeToken)
      await second.app.close()
      expect(second.store.find(hashWakeToken(kept.wakeToken))).toBeDefined()
      expect(second.log.all()).toContain('project mismatch')
    } finally {
      await second.close()
    }
  })

  it('replaces the wake token when the same phone re-registers', async () => {
    const fcmToken = fakeFcmToken()
    const first = await registerAndroid(rig, fcmToken)
    const second = await registerAndroid(rig, fcmToken)

    expect(second.wakeToken).not.toBe(first.wakeToken)
    expect(rig.store.count()).toBe(1)
    await post(rig, '/v1/wake', {}, first.wakeToken)
    expect(rig.fcm?.calls).toHaveLength(0)
  })

  it('keeps an iPhone and an Android phone independent', async () => {
    const phone = await register(rig)
    const droid = await registerAndroid(rig)

    await post(rig, '/v1/wake', {}, phone.wakeToken)
    await post(rig, '/v1/wake', {}, droid.wakeToken)

    expect(rig.apns.calls.map((c) => c.apnsToken)).toEqual([phone.apnsToken])
    expect(rig.fcm?.calls.map((c) => c.fcmToken)).toEqual([droid.fcmToken])
  })

  it('refuses both addresses at once, and neither', async () => {
    const both = await post(rig, '/v1/register', {
      apnsToken: fakeApnsToken(),
      fcmToken: fakeFcmToken(),
    })
    expect(both.status).toBe(400)
    expect(both.body.error.code).toBe('invalid_request')

    const neither = await post(rig, '/v1/register', {})
    expect(neither.status).toBe(400)
    expect(neither.body.error.message).toContain('fcmToken')
  })

  it('refuses an fcmToken that is not the shape Google issues', async () => {
    const bad = await post(rig, '/v1/register', { fcmToken: 'nope' })
    expect(bad.status).toBe(400)
    expect(rig.store.count()).toBe(0)
  })

  it('refuses Android outright when it has no Google credentials', async () => {
    const iosOnly = await startRig({ withoutFcm: true })
    try {
      const refused = await post(iosOnly, '/v1/register', { fcmToken: fakeFcmToken() })
      // 501, and nothing stored: a registration accepted here would be a phone that
      // believes it is set up and never rings.
      expect(refused.status).toBe(501)
      expect(refused.body.error.code).toBe('unsupported')
      expect(iosOnly.store.count()).toBe(0)
      // An iPhone on the same forwarder is unaffected.
      await register(iosOnly)
      expect(iosOnly.store.count()).toBe(1)
    } finally {
      await iosOnly.close()
    }
  })

  it('never writes an FCM token to a log line', async () => {
    const { wakeToken, fcmToken } = await registerAndroid(rig)
    await post(rig, '/v1/wake', {}, wakeToken)
    expect(rig.log.all()).not.toContain(fcmToken)
    expect(rig.log.all()).not.toContain(wakeToken)
  })
})

/**
 * PROTOCOL.md §4 for Android rows [2026-10-02, SECURITY_REVIEW G22].
 *
 * Ordering after the reply, identical replies (including the branch where the Google
 * credentials were removed) and the silent per-device limit were proven for iPhones
 * only, and four mutations survived on the Android side because of it.
 */
describe('Android devices get the same §4 treatment as iPhones', () => {
  const sameHeaders = (headers: Headers) => [...headers].filter(([name]) => name !== 'date')

  it('records and rings Google only after the 202 is on its way', async () => {
    const order: string[] = []
    const rig = await startRig({ onReplyWritten: () => order.push('reply') })
    try {
      const realRecord = rig.store.recordWake.bind(rig.store)
      rig.store.recordWake = (hash: string, at: number) => {
        order.push('recordWake')
        realRecord(hash, at)
      }
      const fcm = rig.fcm!
      const realWake = fcm.wake.bind(fcm)
      fcm.wake = async (request) => {
        order.push('fcm')
        return realWake(request)
      }
      const { wakeToken } = await registerAndroid(rig)
      order.length = 0

      expect((await post(rig, '/v1/wake', {}, wakeToken)).status).toBe(202)
      await vi.waitFor(() => expect(order).toContain('fcm'))
      expect(order).toEqual(['reply', 'recordWake', 'fcm'])
    } finally {
      await rig.close()
    }
  })

  it('answers a live Android token and an unknown one with the same status, body and headers', async () => {
    const rig = await startRig()
    try {
      const { wakeToken } = await registerAndroid(rig)
      const live = await post(rig, '/v1/wake', {}, wakeToken)
      const unknown = await post(rig, '/v1/wake', {}, newWakeToken())
      expect(unknown.status).toBe(live.status)
      expect(unknown.body).toEqual(live.body)
      expect(sameHeaders(unknown.headers)).toEqual(sameHeaders(live.headers))
    } finally {
      await rig.close()
    }
  })

  it('answers the same when the Google credentials were removed after a phone registered', async () => {
    const rig = await startRig({ withoutFcm: true })
    try {
      const wakeToken = newWakeToken()
      rig.store.register({
        wakeTokenHash: hashWakeToken(wakeToken),
        platform: 'android',
        deviceToken: fakeFcmToken(),
        environment: 'production',
        now: 0,
      })
      const live = await post(rig, '/v1/wake', {}, wakeToken)
      const unknown = await post(rig, '/v1/wake', {}, newWakeToken())
      expect(live.status).toBe(202)
      expect(unknown.status).toBe(live.status)
      expect(unknown.body).toEqual(live.body)
      expect(sameHeaders(unknown.headers)).toEqual(sameHeaders(live.headers))
      await rig.app.close()
      // The operator is told, after the reply, in the log.
      expect(rig.log.all()).toContain('no Google credentials')
    } finally {
      await rig.close()
    }
  })

  it('keeps the per-device limit silent for Android: 202, no Retry-After, not rung', async () => {
    const rig = await startRig({
      env: { WAKE_RATE_LIMIT_MAX: '3', CALLER_RATE_LIMIT_MAX: '1000' },
    })
    try {
      const { wakeToken } = await registerAndroid(rig)
      for (let i = 0; i < 3; i++) {
        expect((await post(rig, '/v1/wake', {}, wakeToken)).status).toBe(202)
      }
      const past = await post(rig, '/v1/wake', {}, wakeToken)
      expect(past.status).toBe(202)
      expect(past.body).toEqual({ status: 'accepted' })
      expect(past.headers.get('retry-after')).toBeNull()
      await rig.app.close()
      expect(rig.fcm?.calls).toHaveLength(3)
    } finally {
      await rig.close()
    }
  })

  /** SECURITY_REVIEW G24: log hygiene on the failure paths, not only the happy one. */
  it('keeps the FCM token out of every outcome line, refusals and removals included', async () => {
    const rig = await startRig()
    try {
      const fcm = rig.fcm!
      const secrets: string[] = []
      for (const outcome of [
        { ok: false as const, deviceGone: false, status: 400, reason: 'INVALID_ARGUMENT' },
        { ok: false as const, deviceGone: false, status: 503, reason: 'UNAVAILABLE' },
        { ok: false as const, deviceGone: true, status: 404, reason: 'UNREGISTERED' },
      ]) {
        const { wakeToken, fcmToken } = await registerAndroid(rig)
        secrets.push(wakeToken, fcmToken)
        fcm.failNext = outcome
        await post(rig, '/v1/wake', {}, wakeToken)
        await vi.waitFor(() => expect(fcm.failNext).toBeNull())
      }
      await rig.app.close()
      const logged = rig.log.all()
      expect(logged).toContain('project mismatch')
      expect(logged).toContain('FCM refused a wake')
      expect(logged).toContain('reports as gone')
      for (const secret of secrets) expect(logged).not.toContain(secret)
    } finally {
      await rig.close()
    }
  })

  /** SECURITY_REVIEW G24: the iPhone half of "refuse the provider it cannot reach". */
  it('refuses an iPhone at a forwarder with Google credentials only', async () => {
    const rig = await startRig({ env: { APNS_DRY_RUN: '', FCM_DRY_RUN: '1' } })
    try {
      expect(rig.config.apns).toBeUndefined()
      const refused = await post(rig, '/v1/register', { apnsToken: fakeApnsToken() })
      expect(refused.status).toBe(501)
      expect(refused.body.error.code).toBe('unsupported')
      expect(rig.store.count()).toBe(0)
    } finally {
      await rig.close()
    }
  })
})
