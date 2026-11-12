import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GONE_RETENTION_MS } from '../src/store'
import { hashWakeToken, newWakeToken } from '../src/tokens'
import { post, register, registerAndroid, startRig, type TestRig } from './helpers'

/**
 * POST /v1/status (PROTOCOL.md §3.5, PLANS P-31 item 3): the relay asks whether the phone
 * behind a wake token was proved uninstalled. Only Apple's 410 and Google's UNREGISTERED
 * prove that; every other token, live, unknown or revoked, answers the same `gone: false`.
 */
describe('POST /v1/status', () => {
  let rig: TestRig

  beforeEach(async () => {
    rig = await startRig()
  })
  afterEach(async () => {
    await rig.close()
  })

  it('says gone after Apple answers 410 Unregistered', async () => {
    const { wakeToken } = await register(rig)
    expect((await post(rig, '/v1/status', {}, wakeToken)).body).toEqual({ gone: false })

    rig.apns.failNext = { ok: false, deviceGone: true, status: 410, reason: 'Unregistered' }
    await post(rig, '/v1/wake', {}, wakeToken)
    await vi.waitFor(() => expect(rig.store.isGone(hashWakeToken(wakeToken))).toBe(true))

    const response = await post(rig, '/v1/status', {}, wakeToken)
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ gone: true })
    // The row itself is gone, as before: a gone token rings nothing.
    expect(rig.store.find(hashWakeToken(wakeToken))).toBeUndefined()
  })

  it('says gone after Google answers UNREGISTERED', async () => {
    const { wakeToken } = await registerAndroid(rig)
    if (rig.fcm) {
      rig.fcm.failNext = { ok: false, deviceGone: true, status: 404, reason: 'UNREGISTERED' }
    }
    await post(rig, '/v1/wake', {}, wakeToken)
    await vi.waitFor(() => expect(rig.store.isGone(hashWakeToken(wakeToken))).toBe(true))
    expect((await post(rig, '/v1/status', {}, wakeToken)).body).toEqual({ gone: true })
  })

  it('answers a live, an unknown and a revoked token alike', async () => {
    const live = await register(rig)
    const revoked = await register(rig)
    await post(rig, '/v1/revoke', {}, revoked.wakeToken)
    await vi.waitFor(() => expect(rig.store.find(hashWakeToken(revoked.wakeToken))).toBeUndefined())

    const answers = await Promise.all(
      [live.wakeToken, newWakeToken(), revoked.wakeToken].map((t) =>
        post(rig, '/v1/status', {}, t),
      ),
    )
    for (const a of answers) {
      expect(a.status).toBe(200)
      expect(a.body).toEqual({ gone: false })
    }
  })

  it('does not count an answer that is not proof (BadDeviceToken)', async () => {
    const { wakeToken } = await register(rig)
    rig.apns.failNext = { ok: false, deviceGone: false, status: 400, reason: 'BadDeviceToken' }
    await post(rig, '/v1/wake', {}, wakeToken)
    await vi.waitFor(() => expect(rig.log.all()).toContain('environment mismatch'))
    expect((await post(rig, '/v1/status', {}, wakeToken)).body).toEqual({ gone: false })
  })

  it('never rings', async () => {
    const { wakeToken } = await register(rig)
    await post(rig, '/v1/status', {}, wakeToken)
    expect(rig.apns.calls).toHaveLength(0)
  })

  it('refuses a malformed token', async () => {
    const response = await post(rig, '/v1/status', {}, 'too-short')
    expect(response.status).toBe(400)
  })

  it('forgets a gone token after the retention window', () => {
    const hash = hashWakeToken(newWakeToken())
    rig.store.markGone(hash, 1_000)
    expect(rig.store.isGone(hash)).toBe(true)
    expect(rig.store.pruneGone(1_000 + GONE_RETENTION_MS - 1)).toBe(0)
    expect(rig.store.pruneGone(1_000 + GONE_RETENTION_MS + 1)).toBe(1)
    expect(rig.store.isGone(hash)).toBe(false)
  })
})
