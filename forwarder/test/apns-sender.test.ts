import { generateKeyPairSync } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type ApnsCredentialCheck,
  CREDENTIAL_CHECK_DEVICE_TOKEN,
  Http2ApnsSender,
  type Http2ApnsSenderOptions,
} from '../src/apns'
import type { ApnsConfig } from '../src/config'
import { FAKE_GOOGLE_TLS, type FakeGoogle, startFakeGoogle } from './fake-google'
import { fakeApnsToken } from './helpers'

/**
 * The real Apple sender, end to end against a local HTTP/2 server over TLS [2026-10-20,
 * SECURITY_REVIEW G25]. The fake is the Google one answering as Apple does: an empty 200,
 * or `{"reason": …}`. Until these, the real Apple client ran in no test at all.
 */
describe('Http2ApnsSender', () => {
  let apple: FakeGoogle
  const senders: Http2ApnsSender[] = []

  beforeEach(async () => {
    apple = await startFakeGoogle()
    apple.answer = () => ({ status: 200 })
  })
  afterEach(async () => {
    await Promise.all(senders.splice(0).map((sender) => sender.close()))
    await apple.close()
  })

  function sender(
    options: Http2ApnsSenderOptions = {},
    config: Partial<ApnsConfig> = {},
  ): Http2ApnsSender {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const made = new Http2ApnsSender(
      {
        keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
        keyId: 'ABCD123456',
        teamId: 'TEAM123456',
        topic: 'io.tabsend.app',
        defaultEnvironment: 'production',
        timeoutMs: 2000,
        maxInFlight: 64,
        ...config,
      },
      { origin: apple.origin, connectOptions: FAKE_GOOGLE_TLS, ...options },
    )
    senders.push(made)
    return made
  }

  it('sends the silent, content-free wake and reads Apple’s answers', async () => {
    const send = sender()
    const apnsToken = fakeApnsToken()

    expect(await send.wake({ apnsToken, environment: 'production' })).toEqual({ ok: true })
    const sent = apple.sends[0]
    expect(sent?.path).toBe(`/3/device/${apnsToken}`)
    expect(sent?.headers['apns-push-type']).toBe('background')
    expect(sent?.headers['apns-priority']).toBe('5')
    expect(sent?.headers['apns-topic']).toBe('io.tabsend.app')
    expect(sent?.headers.authorization).toMatch(/^bearer [\w-]+\.[\w-]+\.[\w-]+$/)
    expect(JSON.parse(sent?.body ?? '')).toEqual({ aps: { 'content-available': 1 } })

    apple.answer = () => ({ status: 410, body: { reason: 'Unregistered' } })
    expect(await send.wake({ apnsToken, environment: 'production' })).toEqual({
      ok: false,
      deviceGone: true,
      status: 410,
      reason: 'Unregistered',
    })
  })

  /**
   * G25 itself: on a new connection Node sent streams before Apple had said how many it
   * takes, assuming a hundred, and the server refused the rest. Fifty rings at once
   * against a limit of two delivered two.
   */
  it('delivers a burst on a new connection only once Apple has said how many it takes', async () => {
    await apple.close()
    apple = await startFakeGoogle({ maxConcurrentStreams: 2 })
    apple.answer = () => ({ status: 200, delayMs: 10 })
    const send = sender()

    const outcomes = await Promise.all(
      Array.from({ length: 50 }, () =>
        send.wake({ apnsToken: fakeApnsToken(), environment: 'production' }),
      ),
    )

    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(50)
    expect(apple.sends).toHaveLength(50)
    // One per environment, both opened at start-up: none was opened by the burst.
    expect(apple.connections).toBe(2)
  })

  /**
   * G25's second half: the ring that found no connection opened one after its reply, about
   * 3 ms of work an unknown token never caused (PROTOCOL.md §4).
   */
  it('connects at start-up, so no ring pays for a connection', async () => {
    sender()
    await vi.waitFor(() => expect(apple.connections).toBe(2))
    expect(apple.sends).toHaveLength(0)
  })

  it('opens the next connection in the background when Apple closes one', async () => {
    sender({ reconnectDelayMs: () => 20 })
    await vi.waitFor(() => expect(apple.connections).toBe(2))

    apple.goAway()

    await vi.waitFor(() => expect(apple.connections).toBe(4))
    expect(apple.sends).toHaveLength(0)
  })

  /**
   * The 2026-10-20 review of G25: the sandbox connection was opened by its first ring,
   * after that ring's reply.
   */
  it('opens both environments at start-up, so not even a sandbox ring opens one', async () => {
    const send = sender()
    await vi.waitFor(() => expect(apple.connections).toBe(2))

    for (let i = 0; i < 3; i++) {
      expect(await send.wake({ apnsToken: fakeApnsToken(), environment: 'sandbox' })).toEqual({
        ok: true,
      })
    }
    expect(apple.connections).toBe(2)
  })

  /** The 2026-10-20 review: the Google sender had a ceiling on rings in flight, Apple's not. */
  it('drops rings past the ceiling on rings in flight, at once', async () => {
    const send = sender({}, { timeoutMs: 1000, maxInFlight: 5 })
    apple.answer = () => ({ status: 200, hang: true })

    const pending = Array.from({ length: 8 }, () =>
      send.wake({ apnsToken: fakeApnsToken(), environment: 'production' }),
    )
    const dropped = await Promise.race([
      Promise.all(pending.slice(5)),
      new Promise<'waited'>((resolve) => setTimeout(() => resolve('waited'), 500)),
    ])
    expect(dropped).not.toBe('waited')
    for (const outcome of dropped as Awaited<(typeof pending)[number]>[]) {
      expect(outcome).toMatchObject({ ok: false, reason: expect.stringMatching(/^Busy/) })
    }
    await Promise.all(pending)
    expect(apple.sends.length).toBeLessThanOrEqual(5)
  })

  it('gives up on a stalled Apple at its deadline', async () => {
    const send = sender({}, { timeoutMs: 300 })
    apple.answer = () => ({ status: 200, hang: true })
    expect(await send.wake({ apnsToken: fakeApnsToken(), environment: 'production' })).toEqual({
      ok: false,
      deviceGone: false,
      status: 0,
      reason: 'Timeout',
    })
  })

  /**
   * The Apple counterpart of G13 [2026-10-20]: ring an invented device once at start-up
   * and say in one line whether Apple took the credential.
   */
  describe('credential check at start-up', () => {
    async function check(answer: { status: number; body?: unknown }): Promise<ApnsCredentialCheck> {
      apple.answer = () => answer
      const checks: ApnsCredentialCheck[] = []
      sender({ onCredentialCheck: (result) => checks.push(result) })
      await vi.waitFor(() => expect(checks).toHaveLength(1))
      expect(apple.sends).toHaveLength(1)
      expect(apple.sends[0]?.path).toBe(`/3/device/${CREDENTIAL_CHECK_DEVICE_TOKEN}`)
      return checks[0] as ApnsCredentialCheck
    }

    it('reads BadDeviceToken for the invented device as a credential Apple took', async () => {
      expect(await check({ status: 400, body: { reason: 'BadDeviceToken' } })).toEqual({
        outcome: 'ok',
        line: 'apns credential check: ok',
      })
    })

    it('reads a 403 as a refused credential, and names the fix', async () => {
      const result = await check({ status: 403, body: { reason: 'InvalidProviderToken' } })
      expect(result.outcome).toBe('refused')
      expect(result.line).toMatch(/^apns credential check: refused \(InvalidProviderToken\)\. /)
      expect(result.line).toContain('APNS_KEY_ID')
      // The signed token is never in the line.
      expect(result.line).not.toMatch(/bearer|ey[A-Za-z0-9_-]{10,}/)
    })

    it('says inconclusive rather than guess at anything else', async () => {
      const result = await check({ status: 500, body: { reason: 'InternalServerError' } })
      expect(result.outcome).toBe('inconclusive')
      expect(result.line).toMatch(
        /^apns credential check: inconclusive \(500 InternalServerError\)/,
      )
    })
  })
})
