import { mkdtempSync, rmSync } from 'node:fs'
import { connect as connectNet } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import SQLite from 'better-sqlite3'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { withSafeSerializers } from '../src/app'
import { hashWakeToken, newWakeToken, tokenRef } from '../src/tokens'
import {
  captureLog,
  fakeApnsToken,
  fakeFcmToken,
  post,
  register,
  startRig,
  type TestRig,
} from './helpers'

/**
 * PROTOCOL.md §8: a wake token never appears in a log line, in any form. Neither does an
 * APNs device token. This suite drives a full lifecycle with the logger captured and
 * reads every line back.
 */
describe('logging', () => {
  let rig: TestRig

  beforeEach(async () => {
    rig = await startRig()
  })
  afterEach(async () => {
    await rig.close()
  })

  it('never writes a wake token or an APNs token to any log line', async () => {
    const apnsToken = fakeApnsToken()
    const first = await register(rig, apnsToken)
    // Re-register (replacement), ring, ring an unknown token, revoke, ring again.
    const second = await register(rig, apnsToken)
    await post(rig, '/v1/wake', {}, first.wakeToken)
    await post(rig, '/v1/wake', {}, second.wakeToken)
    await post(rig, '/v1/revoke', {}, second.wakeToken)
    await post(rig, '/v1/wake', {}, second.wakeToken)
    await post(rig, '/v1/wake', {}, 'not-a-token')

    const logged = rig.log.all()
    expect(logged.length).toBeGreaterThan(0)
    expect(logged).not.toContain(first.wakeToken)
    expect(logged).not.toContain(second.wakeToken)
    expect(logged).not.toContain(apnsToken)
    // Not even the full hash, which would be a stable per-device identifier.
    expect(logged).not.toContain(hashWakeToken(second.wakeToken))
  })

  it('logs a short hash prefix, so two lines about one device can still be correlated', async () => {
    const { wakeToken } = await register(rig)
    await post(rig, '/v1/wake', {}, wakeToken)

    const ref = tokenRef(hashWakeToken(wakeToken))
    expect(ref).toHaveLength(8)
    const matching = rig.log.lines.filter((line) => line.includes(`"tokenRef":"${ref}"`))
    // One line from the registration, one from the ring.
    expect(matching.length).toBeGreaterThanOrEqual(2)
  })

  it('logs an unknown-token wake for the operator, without telling the caller', async () => {
    const probe = await post(rig, '/v1/wake', {}, 'A'.repeat(43))

    expect(probe.status).toBe(202)
    expect(rig.log.all()).toContain('Wake for an unknown or revoked token')
  })
})

/**
 * No log line carries a network address [2026-10-02, SECURITY_REVIEW G7].
 *
 * Fastify's default request log wrote each caller's address and port under the same
 * request id as the `tokenRef` lines, so the log linked a phone's sign-up address to the
 * time and relay address of every ring: the history PROTOCOL.md §5 says this service
 * does not keep. Callers here arrive through a trusted proxy with documentation-range
 * addresses, so an address that leaks is unmistakable.
 */
/**
 * Found by the 2026-10-02 verification pass: at trace level Fastify logs a request it
 * cannot parse with the error's raw bytes attached, which carry the wake token and any
 * forwarded address. Only the error serializer keeps them out, and nothing tested it.
 */
describe('a request that cannot be parsed', () => {
  it('is logged without its raw bytes, even at trace level', async () => {
    const rig = await startRig({ logLevel: 'trace' })
    try {
      const wakeToken = newWakeToken()
      const port = Number(new URL(rig.baseUrl).port)
      const raw = [
        'POST /v1/wake HTTP/1.1',
        'Host: forwarder.example',
        `Authorization: Bearer ${wakeToken}`,
        'X-Forwarded-For: 203.0.113.77',
        'Not a header',
        '',
        '',
      ].join('\r\n')
      await new Promise<void>((resolve) => {
        const socket = connectNet(port, '127.0.0.1', () => socket.end(raw))
        socket.on('error', () => resolve())
        socket.on('close', () => resolve())
        socket.resume()
      })
      await vi.waitFor(() => expect(rig.log.all()).toContain('client error'))

      const logged = rig.log.all()
      expect(logged).not.toContain(wakeToken)
      expect(logged).not.toContain('203.0.113.77')
      expect(logged).not.toContain('rawPacket')
    } finally {
      await rig.close()
    }
  })
})

/**
 * Found by the 2026-10-02 verification pass: a stored address that no longer decrypts
 * was skipped with OpenSSL's words and nothing else, so the operator could not tell which
 * phone had stopped ringing, or why.
 */
describe('a stored address that cannot be decrypted', () => {
  it('is logged with its token reference, and the caller hears the same 202', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tabsend-forwarder-damaged-'))
    const rig = await startRig({ databasePath: join(dir, 'forwarder.db') })
    try {
      const { wakeToken } = await register(rig)
      const hash = hashWakeToken(wakeToken)
      const db = new SQLite(rig.databasePath)
      db.pragma('busy_timeout = 2000')
      db.prepare('UPDATE devices SET device_token_enc = ? WHERE wake_token_hash = ?').run(
        Buffer.alloc(64, 7).toString('base64url'),
        hash,
      )
      db.close()

      const response = await post(rig, '/v1/wake', {}, wakeToken)
      expect(response.status).toBe(202)
      await vi.waitFor(() => expect(rig.log.all()).toContain('cannot be decrypted'))

      const line = rig.log.lines.find((entry) => entry.includes('cannot be decrypted'))
      expect(line).toContain(`"tokenRef":"${tokenRef(hash)}"`)
      expect(line).not.toContain(wakeToken)
      expect(rig.apns.calls).toHaveLength(0)
    } finally {
      await rig.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('logging carries no network address', () => {
  it('writes no caller address in any line, through a full cycle and its refusals', async () => {
    const rig = await startRig({
      env: { TRUST_PROXY: '1', CALLER_RATE_LIMIT_MAX: '8', REGISTER_RATE_LIMIT_MAX: '3' },
    })
    try {
      // The start-up line names the forwarder's own listening address, which is not a
      // caller's. Everything after this point is about callers.
      rig.log.lines.length = 0
      const send = async (
        path: string,
        body: string,
        from: string,
        token?: string,
      ): Promise<number> => {
        const response = await fetch(`${rig.baseUrl}${path}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-forwarded-for': from,
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
          body,
        })
        await response.text()
        return response.status
      }
      const phoneAt = '198.51.100.23'
      const droidAt = '2001:db8::23'
      const relayAt = '203.0.113.77'

      const phone = (await (
        await fetch(`${rig.baseUrl}/v1/register`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-forwarded-for': phoneAt },
          body: JSON.stringify({ apnsToken: fakeApnsToken() }),
        })
      ).json()) as { wakeToken: string }
      const droid = (await (
        await fetch(`${rig.baseUrl}/v1/register`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-forwarded-for': droidAt },
          body: JSON.stringify({ fcmToken: fakeFcmToken() }),
        })
      ).json()) as { wakeToken: string }
      rig.apns.failNext = { ok: false, deviceGone: false, status: 400, reason: 'BadDeviceToken' }
      expect(await send('/v1/wake', '{}', relayAt, phone.wakeToken)).toBe(202)
      expect(await send('/v1/wake', '{}', relayAt, droid.wakeToken)).toBe(202)
      expect(await send('/v1/wake', '{}', relayAt, newWakeToken())).toBe(202)
      expect(await send('/v1/revoke', '{}', droidAt, droid.wakeToken)).toBe(200)
      // Refusals of every kind: bad JSON, a body too large, no token, a route that does
      // not exist, and a caller over its limit.
      expect(await send('/v1/wake', '{not json', relayAt, phone.wakeToken)).toBe(400)
      expect(await send('/v1/wake', JSON.stringify({ pad: 'x'.repeat(10_000) }), relayAt)).toBe(413)
      expect(await send('/v1/wake', '{}', relayAt)).toBe(400)
      expect(await send('/v1/nothing', '{}', relayAt)).toBe(404)
      expect(await send('/v1/register', '{}', phoneAt)).toBe(400)
      for (let i = 0; i < 4; i++) await send('/v1/wake', '{}', relayAt, newWakeToken())
      expect(await send('/v1/wake', '{}', relayAt, newWakeToken())).toBe(429)

      // Detached work (rings, the unknown-token line, the revoke) writes after the reply.
      await rig.app.close()
      const logged = rig.log.all()
      expect(logged).toContain('Rang a device')
      expect(logged).toContain('environment mismatch')
      expect(logged).toContain('Wake for an unknown or revoked token')
      for (const address of [phoneAt, droidAt, relayAt, '127.0.0.1', '::ffff:']) {
        expect(logged).not.toContain(address)
      }
      expect(logged).not.toMatch(/\b\d{1,3}(?:\.\d{1,3}){3}\b/)
      expect(logged).not.toMatch(/remoteAddress|remotePort/)
      // The first lock: Fastify's per-request lines are off altogether.
      expect(logged).not.toContain('incoming request')
      expect(logged).not.toContain('request completed')
    } finally {
      await rig.close()
    }
  })

  /** The second lock: anything that logs a request object gets no address from it. */
  it('drops the address and the query string from any request object a line includes', async () => {
    const { log, stream } = captureLog()
    const app = Fastify({
      logger: withSafeSerializers({ level: 'info', stream }),
      trustProxy: true,
    })
    app.get('/probe', async (request) => {
      request.log.info({ req: request }, 'a plugin logging the request')
      return { ok: true }
    })
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/probe?token=AAAA',
        headers: { 'x-forwarded-for': '203.0.113.77' },
        remoteAddress: '198.51.100.23',
      })
      expect(response.statusCode).toBe(200)
      const line = log.lines.find((entry) => entry.includes('a plugin logging the request'))
      expect(line).toBeDefined()
      expect(line).toContain('"url":"/probe"')
      for (const leak of ['203.0.113.77', '198.51.100.23', 'remoteAddress', 'token=AAAA']) {
        expect(line).not.toContain(leak)
      }
    } finally {
      await app.close()
    }
  })
})
