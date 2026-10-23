import { afterEach, describe, expect, it } from 'vitest'
import { addressKey } from '../src/ratelimit'
import {
  fakeApnsToken,
  fakeFcmToken,
  post,
  register,
  registerAndroid,
  startRig,
  type TestRig,
} from './helpers'

/**
 * What keeps sign-ups from filling the disk the forwarder shares with a relay
 * [2026-10-20, SECURITY_REVIEW G16], and from letting Android phones in while the
 * forwarder cannot reach Google [G13].
 */
describe('POST /v1/register limits', () => {
  let rig: TestRig | undefined

  afterEach(async () => {
    await rig?.close()
    rig = undefined
  })

  it('caps a Google token at 512 characters', async () => {
    rig = await startRig()
    const at = (length: number) => `x:${'A'.repeat(length - 2)}`

    expect((await post(rig, '/v1/register', { fcmToken: at(512) })).status).toBe(200)
    expect((await post(rig, '/v1/register', { fcmToken: at(513) })).status).toBe(400)
  })

  it('takes no new phones past MAX_DEVICES, and still lets a known phone sign up again', async () => {
    rig = await startRig({ env: { MAX_DEVICES: '2', REGISTER_RATE_LIMIT_MAX: '0' } })
    const first = await register(rig)
    await registerAndroid(rig)

    const third = await post(rig, '/v1/register', { apnsToken: fakeApnsToken() })
    expect(third.status).toBe(503)
    expect(third.body.error.code).toBe('unavailable')
    expect(rig.store.count()).toBe(2)

    // The first phone re-registering replaces its own row, full table or not.
    const again = await post(rig, '/v1/register', { apnsToken: first.apnsToken })
    expect(again.status).toBe(200)
    expect(rig.store.count()).toBe(2)

    // A revoke frees a place.
    await post(rig, '/v1/revoke', {}, again.body.wakeToken)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect((await post(rig, '/v1/register', { apnsToken: fakeApnsToken() })).status).toBe(200)
  })

  it('counts an IPv6 /64 as one address for sign-ups', async () => {
    rig = await startRig({ env: { TRUST_PROXY: '1', REGISTER_RATE_LIMIT_MAX: '2' } })
    const from = async (ip: string) => {
      const response = await fetch(`${(rig as TestRig).baseUrl}/v1/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
        body: JSON.stringify({ apnsToken: fakeApnsToken() }),
      })
      return response.status
    }

    expect(await from('2001:db8:1:2::1')).toBe(200)
    expect(await from('2001:db8:1:2:ffff::9')).toBe(200)
    // A third address in the same /64 is the same caller.
    expect(await from('2001:db8:1:2:abcd:1234:5678:9')).toBe(429)
    // A neighbouring /64 is not.
    expect(await from('2001:db8:1:3::1')).toBe(200)
    // Nor is an address the parser cannot read: refused or keyed, never a 500.
    expect(await from('1:2:3:4:5:6:7:8::9')).not.toBe(500)
  })

  it('refuses Android sign-ups while the forwarder cannot sign in to Google, and takes them again after', async () => {
    rig = await startRig()
    const fcm = rig.fcm as NonNullable<TestRig['fcm']>
    fcm.refusingRegistrations = true

    const refused = await post(rig, '/v1/register', { fcmToken: fakeFcmToken() })
    expect(refused.status).toBe(501)
    expect(refused.body.error.code).toBe('unsupported')
    // iPhones are not Google's business.
    expect((await post(rig, '/v1/register', { apnsToken: fakeApnsToken() })).status).toBe(200)

    fcm.refusingRegistrations = false
    expect((await post(rig, '/v1/register', { fcmToken: fakeFcmToken() })).status).toBe(200)
  })
})

describe('addressKey', () => {
  it('keys IPv6 by its /64 and everything else by itself', () => {
    expect(addressKey('192.0.2.7')).toBe('192.0.2.7')
    expect(addressKey('::ffff:192.0.2.7')).toBe('192.0.2.7')
    expect(addressKey('2001:db8:1:2::1')).toBe('2001:db8:1:2::/64')
    expect(addressKey('2001:0db8:0001:0002:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:1:2::/64')
    expect(addressKey('2001:db8::5')).toBe('2001:db8:0:0::/64')
    expect(addressKey('::1')).toBe('0:0:0:0::/64')
    expect(addressKey('fe80::1%eth0')).toBe('fe80:0:0:0::/64')
  })

  /**
   * The 2026-10-20 review of the G16 fix: the hand-rolled parser put every IPv4 caller
   * spelled in hex or in full into one /64 bucket, and threw on nine groups, which reached
   * the register route as a 500 through `X-Forwarded-For`.
   */
  it('unmaps IPv4 in any spelling, and keys what it cannot read as written', () => {
    for (const mapped of [
      '::ffff:192.0.2.1',
      '::ffff:c000:201',
      '0:0:0:0:0:ffff:192.0.2.1',
      '0000:0000:0000:0000:0000:FFFF:C000:0201',
    ]) {
      expect(addressKey(mapped)).toBe('192.0.2.1')
    }
    expect(addressKey('::ffff:c000:202')).toBe('192.0.2.2')
    expect(addressKey('1:2:3:4:5:6:7:8:9')).toBe('1:2:3:4:5:6:7:8:9')
    expect(addressKey('1:2:3:4:5:6:7:8::9')).toBe('1:2:3:4:5:6:7:8::9')
    expect(addressKey('not:an:address')).toBe('not:an:address')
  })
})
