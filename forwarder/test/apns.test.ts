import { describe, expect, it } from 'vitest'
import {
  type ApnsResult,
  createApnsSender,
  FakeApnsSender,
  isBadDeviceToken,
  isDeviceGone,
  NoopApnsSender,
} from '../src/apns'
import { loadConfig } from '../src/config'
import { TEST_DEVICE_TOKEN_KEY_B64 } from './helpers'

/**
 * Sender selection, and the two stand-ins. The real HTTP/2 client is not exercised here:
 * it needs a real Apple key and a real Apple endpoint, which PROTOCOL.md §11 records as
 * the one thing in this package that no test can prove.
 */
describe('APNs sender selection', () => {
  it('uses the no-op sender in dry-run mode, so a keyless forwarder rings nobody quietly', async () => {
    const sender = createApnsSender(
      loadConfig({ APNS_DRY_RUN: '1', DEVICE_TOKEN_KEY: TEST_DEVICE_TOKEN_KEY_B64 }),
    )

    expect(sender).toBeInstanceOf(NoopApnsSender)
    await expect(
      sender.wake({ apnsToken: 'a'.repeat(64), environment: 'production' }),
    ).resolves.toEqual({ ok: true })
  })
})

/**
 * Which Apple answers are allowed to delete a registration. This is the whole of the
 * cleanup rule in PROTOCOL.md §9, and it is deliberately narrow.
 */
describe('what counts as a dead device token', () => {
  it('treats a 410 as proof, and no other status', () => {
    // Apple returns 410 Unregistered when the app is gone from the device, and means
    // nothing else by it.
    expect(isDeviceGone(410)).toBe(true)
    expect(isDeviceGone(400)).toBe(false)
    expect(isDeviceGone(403)).toBe(false)
    expect(isDeviceGone(503)).toBe(false)
    // A timeout or a socket error, which report no status at all.
    expect(isDeviceGone(0)).toBe(false)
  })

  it('keeps a BadDeviceToken registration, because an environment mismatch says it too', () => {
    const badToken: ApnsResult = {
      ok: false,
      deviceGone: isDeviceGone(400),
      status: 400,
      reason: 'BadDeviceToken',
    }

    expect(badToken.ok === false && badToken.deviceGone).toBe(false)
    expect(isBadDeviceToken(badToken)).toBe(true)
    // Other 400s are ordinary refusals and get no special handling.
    expect(
      isBadDeviceToken({ ok: false, deviceGone: false, status: 400, reason: 'BadCollapseId' }),
    ).toBe(false)
    expect(isBadDeviceToken({ ok: true })).toBe(false)
  })
})

describe('FakeApnsSender', () => {
  it('records every ring and can be told to fail exactly once', async () => {
    const sender = new FakeApnsSender()
    const request = { apnsToken: 'b'.repeat(64), environment: 'sandbox' } as const

    sender.failNext = { ok: false, deviceGone: true, status: 410, reason: 'Unregistered' }
    expect(await sender.wake(request)).toEqual({
      ok: false,
      deviceGone: true,
      status: 410,
      reason: 'Unregistered',
    })
    expect(await sender.wake(request)).toEqual({ ok: true })
    expect(sender.calls).toHaveLength(2)

    await sender.close()
    expect(sender.closed).toBe(true)
  })
})
