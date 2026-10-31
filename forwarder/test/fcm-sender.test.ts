import {
  type AddressInfo,
  connect as connectNet,
  createServer as createNetServer,
  type Socket,
} from 'node:net'
import { createServer as createTlsServer } from 'node:tls'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../src/config'
import { createFcmSender, HttpFcmSender, NoopFcmSender } from '../src/fcm'
import type { WakeOutcome } from '../src/outcome'
import {
  certificate,
  FAKE_ACCESS_TOKEN,
  FAKE_GOOGLE_TLS,
  type FakeGoogle,
  fcmError,
  senderFor,
  serviceAccountJson,
  startFakeGoogle,
} from './fake-google'
import { fakeFcmToken, TEST_DEVICE_TOKEN_KEY_B64 } from './helpers'

/**
 * The real Google sender, end to end against a local fake of FCM over TLS and HTTP/2
 * [2026-10-02, SECURITY_REVIEW G23, G24, G14].
 *
 * Until these, every test replaced the whole sender with a fake, so the request body, the
 * error parsing that alone decides whether a row is deleted, and the token exchange never
 * ran. The same gap V8 closed for Web Push.
 */
describe('HttpFcmSender', () => {
  let google: FakeGoogle
  const senders: HttpFcmSender[] = []

  beforeEach(async () => {
    google = await startFakeGoogle()
  })
  afterEach(async () => {
    await Promise.all(senders.splice(0).map((sender) => sender.close()))
    await google.close()
  })

  function sender(...args: Parameters<typeof senderFor>[1][]): HttpFcmSender {
    const made = senderFor(google, args[0])
    senders.push(made)
    return made
  }

  it('sends exactly the content-free, high-priority wake, and nothing else', async () => {
    const fcmToken = fakeFcmToken()

    expect(await sender().wake({ fcmToken })).toEqual({ ok: true })

    expect(google.sends).toHaveLength(1)
    const send = google.sends[0]!
    expect(send.path).toBe('/v1/projects/tabsend-test/messages:send')
    expect(send.headers.authorization).toBe(`Bearer ${FAKE_ACCESS_TOKEN}`)
    expect(send.headers['content-type']).toBe('application/json')
    // The whole message. No `notification` block, which is what keeps Android from
    // drawing anything, and high priority, the only one that reaches a dozing phone.
    expect(JSON.parse(send.body)).toEqual({
      message: {
        token: fcmToken,
        data: { wake: '1' },
        android: { priority: 'high', ttl: '300s', collapse_key: 'wake' },
      },
    })
  })

  it('counts only 404 UNREGISTERED as a device gone, read from the details', async () => {
    const send = sender()
    // Google puts the generic status first and the specific reason in the details; the
    // details are the only place an uninstalled app is told apart from other 404s.
    google.answer = () => ({ status: 404, body: fcmError(404, 'NOT_FOUND', 'UNREGISTERED') })
    expect(await send.wake({ fcmToken: fakeFcmToken() })).toEqual({
      ok: false,
      deviceGone: true,
      status: 404,
      reason: 'UNREGISTERED',
    })

    // The answer for a live token shown to the wrong Firebase project. Deleting on it
    // would unregister every working phone on its first ring.
    google.answer = () => ({
      status: 400,
      body: fcmError(400, 'INVALID_ARGUMENT', 'INVALID_ARGUMENT'),
    })
    expect(await send.wake({ fcmToken: fakeFcmToken() })).toEqual({
      ok: false,
      deviceGone: false,
      status: 400,
      reason: 'INVALID_ARGUMENT',
    })

    google.answer = () => ({ status: 404, body: fcmError(404, 'NOT_FOUND') })
    expect(await send.wake({ fcmToken: fakeFcmToken() })).toMatchObject({
      deviceGone: false,
      reason: 'NOT_FOUND',
    })

    google.answer = () => ({ status: 401, body: fcmError(401, 'UNAUTHENTICATED') })
    expect(await send.wake({ fcmToken: fakeFcmToken() })).toMatchObject({ deviceGone: false })
  })

  it('never puts the access token in an outcome, which is what reaches the log', async () => {
    const send = sender({ config: { timeoutMs: 300 } })
    const outcomes: WakeOutcome[] = []
    for (const answer of [
      { status: 400, body: fcmError(400, 'INVALID_ARGUMENT', 'INVALID_ARGUMENT') },
      { status: 401, body: fcmError(401, 'UNAUTHENTICATED', 'THIRD_PARTY_AUTH_ERROR') },
      { status: 404, body: fcmError(404, 'NOT_FOUND', 'UNREGISTERED') },
      { status: 503, body: 'not json' },
      // The paths that end in an exception rather than an answer.
      { status: 200, hang: true },
      { status: 200, reset: true },
    ]) {
      google.answer = () => answer
      outcomes.push(await send.wake({ fcmToken: fakeFcmToken() }))
    }
    for (const outcome of outcomes) {
      expect(outcome.ok).toBe(false)
      expect(JSON.stringify(outcome)).not.toContain(FAKE_ACCESS_TOKEN)
    }
  })

  it('treats a failed token exchange as the forwarder’s problem, never a device gone', async () => {
    const send = sender({
      exchange: async () => {
        throw new Error('Google refused the service-account assertion: invalid_grant')
      },
    })
    const outcome = await send.wake({ fcmToken: fakeFcmToken() })
    expect(outcome).toMatchObject({ ok: false, deviceGone: false })
    expect(google.sends).toHaveLength(0)
  })

  it('gives up on a stalled Google at its deadline', async () => {
    const send = sender({ config: { timeoutMs: 300 } })
    google.answer = () => ({ status: 200, hang: true })
    const started = Date.now()
    expect(await send.wake({ fcmToken: fakeFcmToken() })).toMatchObject({
      ok: false,
      deviceGone: false,
      reason: 'Timeout',
    })
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('reads only the start of an oversized answer', async () => {
    const send = sender()
    google.answer = () => ({
      status: 500,
      body: { error: { status: 'INTERNAL', pad: 'x'.repeat(2 * 1024 * 1024) } },
    })
    // Cut off at 64 KiB, the answer no longer parses, so its code is not read. Had the
    // whole two megabytes been read, it would say INTERNAL.
    expect(await send.wake({ fcmToken: fakeFcmToken() })).toEqual({
      ok: false,
      deviceGone: false,
      status: 500,
      reason: 'Unknown',
    })
  })

  /**
   * SECURITY_REVIEW G14. `fetch` dropped the connection after four seconds idle, so most
   * Android rings opened a new TLS connection after their reply: about 3 ms of work an
   * unknown token never caused, readable from outside. Closing after four idle minutes
   * still let a prober who spaced its rings out get a new connection on each (verification
   * pass), so the connection is opened at start-up and never closed for being idle.
   */
  it('connects at start-up, so no ring pays for a connection, and keeps it while idle', async () => {
    const send = sender()
    await vi.waitFor(() => expect(google.connections).toBe(1))
    expect(google.sends).toHaveLength(0)

    expect(await send.wake({ fcmToken: fakeFcmToken() })).toEqual({ ok: true })
    await new Promise((resolve) => setTimeout(resolve, 4_500))
    expect(await send.wake({ fcmToken: fakeFcmToken() })).toEqual({ ok: true })

    expect(google.sends).toHaveLength(2)
    expect(google.connections).toBe(1)
  }, 15_000)

  it('opens the next connection in the background when Google closes one', async () => {
    sender({ reconnectDelayMs: () => 20 })
    await vi.waitFor(() => expect(google.connections).toBe(1))

    google.goAway()

    // No ring in between: the new connection is the sender's own doing.
    await vi.waitFor(() => expect(google.connections).toBe(2))
    expect(google.sends).toHaveLength(0)
  })

  it('checks the connection on a schedule, and replaces one that went silent before a ring needs it', async () => {
    const path = await silenceable(google)
    const send = senderFor(google, {
      origin: path.origin,
      config: { timeoutMs: 300 },
      keepAliveMs: 100,
      reconnectDelayMs: () => 20,
    })
    senders.push(send)
    try {
      await vi.waitFor(() => expect(google.connections).toBe(1))
      path.silence()
      // The next PING goes unanswered, the connection is dropped and another opened.
      await vi.waitFor(() => expect(google.connections).toBe(2), { timeout: 3000 })
      expect(await send.wake({ fcmToken: fakeFcmToken() })).toEqual({ ok: true })
      expect(google.sends).toHaveLength(1)
    } finally {
      await path.close()
    }
  })

  it('replaces a connection that answers PINGs but loses every ring', async () => {
    const send = sender({ config: { timeoutMs: 200 }, reconnectDelayMs: () => 20 })
    google.answer = () => ({ status: 200, hang: true })
    for (let i = 0; i < 3; i++) {
      expect(await send.wake({ fcmToken: fakeFcmToken() })).toMatchObject({ reason: 'Timeout' })
    }
    await vi.waitFor(() => expect(google.connections).toBe(2), { timeout: 3000 })

    google.answer = () => ({ status: 200, body: { name: 'projects/p/messages/1' } })
    expect(await send.wake({ fcmToken: fakeFcmToken() })).toEqual({ ok: true })
    expect(google.connections).toBe(2)
  })

  it('moves to a new connection when Google sends the old one away', async () => {
    const send = sender({ config: { timeoutMs: 1000 } })
    // One ring still in flight keeps the old connection draining rather than gone.
    google.answer = () => ({ status: 200, hang: true })
    const stuck = send.wake({ fcmToken: fakeFcmToken() })
    await vi.waitFor(() => expect(google.sends).toHaveLength(1))
    google.goAway()
    await new Promise((resolve) => setTimeout(resolve, 100))

    // A session told to go away refuses new streams while it drains, so reusing it
    // would fail this ring, and every one after it until the old ring finished.
    google.answer = () => ({ status: 200, body: { name: 'projects/p/messages/1' } })
    expect(await send.wake({ fcmToken: fakeFcmToken() })).toEqual({ ok: true })
    expect(google.connections).toBe(2)
    expect(await stuck).toMatchObject({ ok: false, deviceGone: false })
  })

  /**
   * Found verifying the G14 fix: on a new connection Node sends streams before the server
   * has said how many it takes, assuming a hundred, and the server refuses whatever is past
   * its real limit; fifty rings at once against a limit of two lost forty-eight. `fetch`
   * waited for the server's settings; this sender has to.
   */
  it('sends a burst on a new connection only once Google has said how many it takes', async () => {
    await google.close()
    google = await startFakeGoogle({ maxConcurrentStreams: 2 })
    google.answer = () => ({ status: 200, body: { name: 'projects/p/messages/1' }, delayMs: 20 })
    const send = sender()

    const outcomes = await Promise.all(
      Array.from({ length: 30 }, () => send.wake({ fcmToken: fakeFcmToken() })),
    )

    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(30)
    expect(google.sends).toHaveLength(30)
    expect(google.connections).toBe(1)
  })

  it('waits for the settings inside the ring deadline, and never sends a ring late', async () => {
    // A server that completes TLS and then says nothing at all: no settings, ever.
    const { key, cert } = await certificate()
    const received: Buffer[] = []
    const mute = createTlsServer({ key, cert, ALPNProtocols: ['h2'] }, (socket) => {
      socket.on('data', (chunk: Buffer) => received.push(chunk))
      socket.on('error', () => undefined)
    })
    await new Promise<void>((resolve) => mute.listen(0, '127.0.0.1', () => resolve()))
    const port = (mute.address() as AddressInfo).port
    const send = senderFor(google, {
      origin: `https://localhost:${port}`,
      config: { timeoutMs: 200 },
    })
    senders.push(send)
    try {
      expect(await send.wake({ fcmToken: fakeFcmToken() })).toMatchObject({
        ok: false,
        reason: 'Timeout',
      })
      await new Promise((resolve) => setTimeout(resolve, 300))
      // The client's own preface and settings may be there; a request must not be.
      expect(frameTypes(Buffer.concat(received))).not.toContain(HEADERS_FRAME)
    } finally {
      mute.close()
    }
  })

  /**
   * Found by the 2026-10-02 verification pass: a connection is only closed by its idle
   * timer, and rings keep it from going idle, so one that stalled while being set up
   * failed every ring that came after it.
   */
  it('drops a connection that never finished setting up, so the next ring opens another', async () => {
    const { key, cert } = await certificate()
    let connections = 0
    const mute = createTlsServer({ key, cert, ALPNProtocols: ['h2'] }, (socket) => {
      connections += 1
      socket.on('error', () => undefined)
    })
    await new Promise<void>((resolve) => mute.listen(0, '127.0.0.1', () => resolve()))
    const port = (mute.address() as AddressInfo).port
    const send = senderFor(google, {
      origin: `https://localhost:${port}`,
      config: { timeoutMs: 200 },
    })
    senders.push(send)
    try {
      expect(await send.wake({ fcmToken: fakeFcmToken() })).toMatchObject({ reason: 'Timeout' })
      expect(await send.wake({ fcmToken: fakeFcmToken() })).toMatchObject({ reason: 'Timeout' })
      expect(connections).toBe(2)
    } finally {
      mute.close()
    }
  })

  /** The same, for a connection that went silent after it was set up: a dropped route. */
  it('checks a connection that went silent, and moves to a new one', async () => {
    const path = await silenceable(google)
    const send = senderFor(google, { origin: path.origin, config: { timeoutMs: 300 } })
    senders.push(send)
    try {
      expect(await send.wake({ fcmToken: fakeFcmToken() })).toEqual({ ok: true })
      path.silence()
      expect(await send.wake({ fcmToken: fakeFcmToken() })).toMatchObject({ reason: 'Timeout' })
      // The PING that follows goes unanswered too, and the connection is dropped.
      await new Promise((resolve) => setTimeout(resolve, 500))
      expect(await send.wake({ fcmToken: fakeFcmToken() })).toEqual({ ok: true })
      expect(google.connections).toBe(2)
    } finally {
      await path.close()
    }
  })

  /** A connection that fails before Google's settings must not hold its rings to the deadline. */
  it('fails a ring at once when the connection to Google cannot be made', async () => {
    const closed = createTlsServer()
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', () => resolve()))
    const port = (closed.address() as AddressInfo).port
    await new Promise<void>((resolve) => closed.close(() => resolve()))
    const send = senderFor(google, {
      origin: `https://localhost:${port}`,
      config: { timeoutMs: 3000 },
    })
    senders.push(send)

    const started = Date.now()
    const outcome = await send.wake({ fcmToken: fakeFcmToken() })

    expect(outcome).toMatchObject({ ok: false, deviceGone: false })
    expect(outcome).not.toMatchObject({ reason: 'Timeout' })
    expect(Date.now() - started).toBeLessThan(1500)
  })

  /**
   * SECURITY_REVIEW G17: with Google stalled, rings piled up without limit (600 of them
   * added 145 MB on a 1 GB machine). Past the ceiling a ring is dropped at once.
   */
  it('drops rings past the ceiling on rings in flight, at once', async () => {
    const send = sender({ config: { timeoutMs: 1000, maxInFlight: 5 } })
    google.answer = () => ({ status: 200, hang: true })

    const started = Date.now()
    const pending = Array.from({ length: 8 }, () => send.wake({ fcmToken: fakeFcmToken() }))
    const dropped = await Promise.race([
      Promise.all(pending.slice(5)),
      new Promise<'waited'>((resolve) => setTimeout(() => resolve('waited'), 500)),
    ])
    expect(dropped).not.toBe('waited')
    for (const outcome of dropped as WakeOutcome[]) {
      expect(outcome).toMatchObject({
        ok: false,
        deviceGone: false,
        reason: expect.stringMatching(/^Busy/),
      })
    }
    expect(Date.now() - started).toBeLessThan(500)
    await Promise.all(pending)
    expect(google.sends.length).toBeLessThanOrEqual(5)

    // Room again once those are over.
    google.answer = () => ({ status: 200, body: { name: 'projects/p/messages/1' } })
    expect(await send.wake({ fcmToken: fakeFcmToken() })).toEqual({ ok: true })
  })

  /** SECURITY_REVIEW G17: a 401 kept the cached access token in use for the rest of its hour. */
  it('drops the access token after a 401 and uses a fresh one', async () => {
    let exchanges = 0
    const send = sender({
      exchange: async () => {
        exchanges += 1
        return { accessToken: `ya29.token-${exchanges}`, expiresInSeconds: 3600 }
      },
    })
    google.answer = () => ({ status: 401, body: fcmError(401, 'UNAUTHENTICATED') })
    expect(await send.wake({ fcmToken: fakeFcmToken() })).toMatchObject({ ok: false, status: 401 })

    google.answer = () => ({ status: 200, body: { name: 'projects/p/messages/1' } })
    await vi.waitFor(() => expect(exchanges).toBe(2))
    expect(await send.wake({ fcmToken: fakeFcmToken() })).toEqual({ ok: true })
    expect(google.sends.at(-1)?.headers.authorization).toBe('Bearer ya29.token-2')
  })

  /** SECURITY_REVIEW G17: `Retry-After` was ignored, so a rate-limited sender kept sending. */
  it('sends nothing for as long as Google asked after a 429 or 503', async () => {
    let clock = Date.UTC(2026, 9, 20, 12, 0, 0)
    const send = sender({ now: () => clock })

    google.answer = () => ({
      status: 429,
      body: fcmError(429, 'RESOURCE_EXHAUSTED'),
      headers: { 'retry-after': '120' },
    })
    expect(await send.wake({ fcmToken: fakeFcmToken() })).toMatchObject({ ok: false, status: 429 })
    google.answer = () => ({ status: 200, body: { name: 'projects/p/messages/1' } })

    clock += 119_000
    expect(await send.wake({ fcmToken: fakeFcmToken() })).toMatchObject({
      ok: false,
      deviceGone: false,
      reason: expect.stringMatching(/^Paused/),
    })
    expect(google.sends).toHaveLength(1)

    clock += 1_000
    expect(await send.wake({ fcmToken: fakeFcmToken() })).toEqual({ ok: true })

    // A 503 with no Retry-After pauses for ten seconds.
    google.answer = () => ({ status: 503, body: fcmError(503, 'UNAVAILABLE') })
    expect(await send.wake({ fcmToken: fakeFcmToken() })).toMatchObject({ status: 503 })
    google.answer = () => ({ status: 200, body: { name: 'projects/p/messages/1' } })
    clock += 9_000
    expect(await send.wake({ fcmToken: fakeFcmToken() })).toMatchObject({
      reason: expect.stringMatching(/^Paused/),
    })
    clock += 1_000
    expect(await send.wake({ fcmToken: fakeFcmToken() })).toEqual({ ok: true })
  })

  /** SECURITY_REVIEW G13: the register route asks this before letting an Android phone in. */
  it('accepts registrations only while it can get an access token', async () => {
    const refused = sender({
      exchange: async () => {
        throw new Error('Google refused the service-account assertion: invalid_grant')
      },
      schedule: () => () => undefined,
    })
    const working = sender()
    // The start-up exchange decides it; recovery is `FcmTokenSource`'s own test.
    await vi.waitFor(() => expect(refused.acceptsRegistrations()).toBe(false))
    expect(working.acceptsRegistrations()).toBe(true)
  })

  /** SECURITY_REVIEW G14: the first exchange is at boot, not on somebody's ring. */
  it('exchanges for an access token when it starts, not on the first ring', async () => {
    let exchanges = 0
    const send = sender({
      exchange: async () => {
        exchanges += 1
        return { accessToken: FAKE_ACCESS_TOKEN, expiresInSeconds: 3600 }
      },
    })
    await new Promise((resolve) => setImmediate(resolve))
    expect(exchanges).toBe(1)

    expect(await send.wake({ fcmToken: fakeFcmToken() })).toEqual({ ok: true })
    expect(await send.wake({ fcmToken: fakeFcmToken() })).toEqual({ ok: true })
    expect(exchanges).toBe(1)
  })
})

describe('createFcmSender', () => {
  const KEY = { DEVICE_TOKEN_KEY: TEST_DEVICE_TOKEN_KEY_B64 }

  it('builds the real sender when Google credentials are configured', async () => {
    const config = loadConfig({ FCM_SERVICE_ACCOUNT_JSON: serviceAccountJson(), ...KEY })
    // It connects as it starts, so it is pointed at a local fake, never at Google.
    const google = await startFakeGoogle()
    const sender = createFcmSender(config, {
      exchange: async () => ({ accessToken: FAKE_ACCESS_TOKEN, expiresInSeconds: 3600 }),
      origin: google.origin,
      connectOptions: FAKE_GOOGLE_TLS,
    })
    try {
      expect(sender).toBeInstanceOf(HttpFcmSender)
      expect(await sender?.wake({ fcmToken: fakeFcmToken() })).toEqual({ ok: true })
    } finally {
      await sender?.close()
      await google.close()
    }
  })

  it('builds the no-op sender for a dry run, and none at all without Google', () => {
    expect(createFcmSender(loadConfig({ FCM_DRY_RUN: '1', ...KEY }))).toBeInstanceOf(NoopFcmSender)
    expect(createFcmSender(loadConfig({ APNS_DRY_RUN: '1', ...KEY }))).toBeUndefined()
  })
})

/** The HTTP/2 frame type of a request's headers. */
const HEADERS_FRAME = 0x1

/** The frame types in what an HTTP/2 client sent, after its 24-byte preface. */
function frameTypes(bytes: Buffer): number[] {
  const types: number[] = []
  let at = 24
  while (at + 9 <= bytes.length) {
    const length = bytes.readUIntBE(at, 3)
    types.push(bytes[at + 3] as number)
    at += 9 + length
  }
  return types
}

/**
 * A TCP path to the fake that can go silent: every connection open when `silence` is
 * called stops carrying bytes either way, as a dropped route does, with no reset. New
 * connections still get through.
 */
async function silenceable(target: FakeGoogle): Promise<{
  origin: string
  silence(): void
  close(): Promise<void>
}> {
  const upstreamPort = Number(new URL(target.origin).port)
  const open = new Set<{ silent: boolean; sockets: Socket[] }>()
  const server = createNetServer((client) => {
    const link = { silent: false, sockets: [client] as Socket[] }
    const upstream = connectNet(upstreamPort, '127.0.0.1')
    link.sockets.push(upstream)
    open.add(link)
    client.on('data', (chunk) => {
      if (!link.silent) upstream.write(chunk)
    })
    upstream.on('data', (chunk) => {
      if (!link.silent) client.write(chunk)
    })
    for (const socket of link.sockets) {
      socket.on('error', () => undefined)
      socket.on('close', () => {
        for (const other of link.sockets) other.destroy()
        open.delete(link)
      })
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const { port } = server.address() as AddressInfo
  return {
    origin: `https://localhost:${port}`,
    silence() {
      for (const link of open) link.silent = true
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const link of open) for (const socket of link.sockets) socket.destroy()
        server.close(() => resolve())
      }),
  }
}
