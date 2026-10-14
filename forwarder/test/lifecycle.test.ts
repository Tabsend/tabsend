import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { hashWakeToken } from '../src/tokens'
import { fakeApnsToken, post, register, startRig, type TestRig } from './helpers'

/**
 * The registration → replacement → revocation lifecycle, which is the whole reason this
 * service keeps a store at all (PROTOCOL.md §3.1, §3.3, §5).
 */
describe('wake token lifecycle', () => {
  let rig: TestRig

  beforeEach(async () => {
    rig = await startRig()
  })
  afterEach(async () => {
    await rig.close()
  })

  it('mints an opaque wake token and remembers only its hash', async () => {
    const { wakeToken, apnsToken } = await register(rig)

    expect(wakeToken).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const stored = rig.store.find(hashWakeToken(wakeToken))
    expect(stored).toBeDefined()
    expect(stored?.deviceToken).toBe(apnsToken)
    expect(stored?.wakeCount).toBe(0)
    expect(stored?.lastWakeAt).toBeNull()
    // The token itself is nowhere in the row.
    expect(JSON.stringify(stored)).not.toContain(wakeToken)
  })

  it('re-registering the same device REPLACES the wake token, and the old one stops working', async () => {
    const apnsToken = fakeApnsToken()
    const first = await register(rig, apnsToken)
    const second = await register(rig, apnsToken)

    expect(second.wakeToken).not.toBe(first.wakeToken)
    expect(rig.store.find(hashWakeToken(first.wakeToken))).toBeUndefined()
    expect(rig.store.find(hashWakeToken(second.wakeToken))).toBeDefined()
    expect(rig.store.count()).toBe(1)

    // The old token rings nothing; the new one rings the phone.
    await post(rig, '/v1/wake', {}, first.wakeToken)
    expect(rig.apns.calls).toHaveLength(0)
    await post(rig, '/v1/wake', {}, second.wakeToken)
    expect(rig.apns.calls).toHaveLength(1)
  })

  it('keeps two different devices independent', async () => {
    const a = await register(rig)
    const b = await register(rig)

    expect(rig.store.count()).toBe(2)
    // Ringing one leaves the other untouched, and revoking one does not revoke both.
    await post(rig, '/v1/wake', {}, a.wakeToken)
    expect(rig.apns.calls.map((c) => c.apnsToken)).toEqual([a.apnsToken])

    await post(rig, '/v1/revoke', {}, a.wakeToken)
    expect(rig.store.find(hashWakeToken(b.wakeToken))?.deviceToken).toBe(b.apnsToken)
    await post(rig, '/v1/wake', {}, b.wakeToken)
    expect(rig.apns.calls.map((c) => c.apnsToken)).toEqual([a.apnsToken, b.apnsToken])
  })

  it('revokes a token, after which it rings nothing', async () => {
    const { wakeToken } = await register(rig)

    const revoked = await post(rig, '/v1/revoke', {}, wakeToken)
    expect(revoked.status).toBe(200)
    expect(revoked.body).toEqual({ status: 'ok' })
    expect(rig.store.count()).toBe(0)

    const woken = await post(rig, '/v1/wake', {}, wakeToken)
    expect(woken.status).toBe(202)
    expect(rig.apns.calls).toHaveLength(0)
  })

  it('carries the registration environment through to Apple', async () => {
    const { wakeToken } = await register(rig, fakeApnsToken(), 'sandbox')
    await post(rig, '/v1/wake', {}, wakeToken)
    expect(rig.apns.calls[0]?.environment).toBe('sandbox')
  })

  it('refuses a registration without a usable APNs token, and says what to send', async () => {
    const missing = await post(rig, '/v1/register', {})
    expect(missing.status).toBe(400)
    expect(missing.body.error.code).toBe('invalid_request')
    expect(missing.body.error.message).toContain('apnsToken')

    const notHex = await post(rig, '/v1/register', { apnsToken: 'not-a-hex-token' })
    expect(notHex.status).toBe(400)
    expect(notHex.body.error.message).toContain('hexadecimal')

    const badEnv = await post(rig, '/v1/register', {
      apnsToken: fakeApnsToken(),
      environment: 'staging',
    })
    expect(badEnv.status).toBe(400)
    expect(badEnv.body.error.message).toContain('sandbox')
  })

  it('survives a restart: a second process reopens the same file and old tokens still work', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tabsend-forwarder-restart-'))
    const databasePath = join(dir, 'forwarder.db')
    try {
      const first = await startRig({ databasePath })
      const { wakeToken, apnsToken } = await register(first)
      await first.close()

      // A whole new process would do exactly this: open the file and carry on.
      const second = await startRig({ databasePath })
      try {
        expect(second.store.find(hashWakeToken(wakeToken))?.deviceToken).toBe(apnsToken)
        expect(second.store.count()).toBe(1)
        // And the token minted before the restart still rings the phone.
        const woken = await post(second, '/v1/wake', {}, wakeToken)
        expect(woken.status).toBe(202)
        expect(second.apns.calls).toHaveLength(1)
      } finally {
        await second.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
