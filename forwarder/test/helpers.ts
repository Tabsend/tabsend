import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { FakeApnsSender } from '../src/apns'
import { buildApp } from '../src/app'
import { type Config, loadConfig } from '../src/config'
import { FakeFcmSender } from '../src/fcm'
import { DeviceStore } from '../src/store'

/**
 * Shared test rig: a real Fastify instance on a real SQLite file, driven over real HTTP,
 * with a fake sender per provider and a captured logger.
 *
 * The logger is captured rather than silenced on purpose — PROTOCOL.md §8 forbids a wake
 * token from ever reaching a log line, and an assertion needs the lines to look at.
 */

export interface CapturedLog {
  lines: string[]
  /** Every captured line as one string, for a simple "does this appear anywhere" check. */
  all(): string
}

/**
 * A pino-compatible sink that keeps every serialized line. Fastify accepts a `stream`
 * in its logger options, which is the least intrusive way in.
 */
export function captureLog(): { log: CapturedLog; stream: { write(line: string): void } } {
  const lines: string[] = []
  return {
    log: { lines, all: () => lines.join('\n') },
    stream: {
      write(line: string) {
        lines.push(line)
      },
    },
  }
}

export interface TestClock {
  now(): number
  advance(ms: number): void
}

export function makeClock(start = Date.UTC(2026, 7, 19, 12, 0, 0)): TestClock {
  let current = start
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms
    },
  }
}

/**
 * A promise a test opens by hand. Used to hold `FakeApnsSender` shut while the wake route
 * is expected to answer anyway: if the route awaited Apple, the request would hang.
 */
export function deferred(): { promise: Promise<void>; open: () => void } {
  let open: () => void = () => undefined
  const promise = new Promise<void>((resolve) => {
    open = resolve
  })
  return { promise, open }
}

/**
 * The device-token key every rig uses unless a test says otherwise. Fixed rather than
 * random so a restart test can reopen a file with the key it was written under.
 */
export const TEST_DEVICE_TOKEN_KEY = Buffer.from(
  '22844d3704dd0354f389c3553dfaf3aabde3a36c9763002f96592a1832e18ad2',
  'hex',
)
export const TEST_DEVICE_TOKEN_KEY_B64 = TEST_DEVICE_TOKEN_KEY.toString('base64')

/** A plausible APNs device token: 32 bytes of hex, the shape Apple issues. */
export function fakeApnsToken(): string {
  return randomBytes(32).toString('hex')
}

/**
 * A plausible FCM registration token. Google's real ones are an instance id, a colon, then
 * a long base64url body — the shape matters here only because `/v1/register` validates the
 * alphabet.
 */
export function fakeFcmToken(): string {
  return `${randomBytes(8).toString('base64url')}:APA91b${randomBytes(96).toString('base64url')}`
}

export interface TestRig {
  app: FastifyInstance
  store: DeviceStore
  apns: FakeApnsSender
  /** Undefined when the rig was started with `withoutFcm`, matching a forwarder that has
   *  no Google credentials. */
  fcm: FakeFcmSender | undefined
  log: CapturedLog
  clock: TestClock
  config: Config
  baseUrl: string
  /** The SQLite file, so a test can reopen it and prove the store survives a restart. */
  databasePath: string
  close(): Promise<void>
}

export interface StartRigOptions {
  /** Overrides merged over the default env bag before `loadConfig` sees it. */
  env?: NodeJS.ProcessEnv
  /** Reuse an existing database file (restart tests). */
  databasePath?: string
  /**
   * Start with NO Google sender, which is what a forwarder serving only iPhones looks
   * like. The register route must refuse Android there rather than accept a row it could
   * never ring.
   */
  withoutFcm?: boolean
  /**
   * Called at the moment each reply's bytes are handed to the socket: `res.end`, wrapped
   * per request.
   *
   * The only way a test can see the MOMENT a reply goes out, which is what PROTOCOL.md
   * §4's clock corollary is about: everything that depends on whether the token exists
   * has to happen after this, or a prober with a stopwatch can tell a live token from
   * an invented one. It was once an `onSend` hook, which runs BEFORE the write, so the
   * ordering tests passed even with the deferral regressed to a microtask that ran
   * ahead of the bytes [2026-10-01].
   *
   * Setting it also registers an async `onSend` hook that waits fifty microtask turns,
   * so the write lands well after the handler returns rather than inside it, and any
   * deferral weaker than a macrotask shows up as work recorded before the write.
   * Production registers no `onSend` hook today. A plugin that did real async I/O there
   * (compression, say) would delay the write past even a macrotask, which these tests
   * cannot model and PROTOCOL.md §4 says out loud.
   * Registered before `listen`, because Fastify takes no hooks after that.
   */
  onReplyWritten?: () => void
  /**
   * The pause between a reply and its token-dependent work. Rigs default to 0, which is
   * the `setImmediate` path every ordering test below was written against; the tests of
   * the random delay itself pass their own, or `'production'` for the real default.
   */
  ringDelayMs?: (() => number) | 'production'
  /** The device-token key the store opens with. Defaults to TEST_DEVICE_TOKEN_KEY. */
  deviceTokenKey?: Buffer
  /** The captured logger's level. Defaults to `info`, as production does. */
  logLevel?: string
}

/** Boot a forwarder for one test. Every rig gets its own temp directory. */
export async function startRig(options: StartRigOptions = {}): Promise<TestRig> {
  const dir = mkdtempSync(join(tmpdir(), 'tabsend-forwarder-'))
  const databasePath = options.databasePath ?? join(dir, 'forwarder.db')
  const config = loadConfig({
    // Dry run keeps `loadConfig` from demanding Apple credentials; the sender is
    // injected anyway, so nothing in the tests depends on that choice.
    APNS_DRY_RUN: '1',
    DATABASE_PATH: databasePath,
    DEVICE_TOKEN_KEY: TEST_DEVICE_TOKEN_KEY_B64,
    PORT: '0',
    ...options.env,
  })
  const store = new DeviceStore(databasePath, options.deviceTokenKey ?? TEST_DEVICE_TOKEN_KEY)
  const apns = new FakeApnsSender()
  const fcm = options.withoutFcm ? undefined : new FakeFcmSender()
  const clock = makeClock()
  const { log, stream } = captureLog()
  const app = buildApp({
    config,
    store,
    apns,
    ...(fcm ? { fcm } : {}),
    now: () => clock.now(),
    ...(options.ringDelayMs === 'production'
      ? {}
      : { ringDelayMs: options.ringDelayMs ?? (() => 0) }),
    logger: { level: options.logLevel ?? 'info', stream },
  })
  if (options.onReplyWritten) {
    const mark = options.onReplyWritten
    app.addHook('onRequest', async (_request, reply) => {
      const raw = reply.raw
      const end = raw.end as (...args: unknown[]) => typeof raw
      raw.end = function (this: typeof raw, ...args: unknown[]) {
        mark()
        return end.apply(this, args)
      } as typeof raw.end
    })
    // Fifty microtask turns before the write, so any deferral built from promises or
    // `queueMicrotask` (each a turn or two) runs ahead of it and the ordering tests fail.
    // Only a macrotask such as the route's `setImmediate` still waits for the bytes.
    app.addHook('onSend', async (_request, _reply, payload) => {
      for (let i = 0; i < 50; i++) await null
      return payload
    })
  }
  await app.listen({ host: '127.0.0.1', port: 0 })
  const { port } = app.server.address() as AddressInfo

  return {
    app,
    store,
    apns,
    fcm,
    log,
    clock,
    config,
    databasePath,
    baseUrl: `http://127.0.0.1:${port}`,
    async close() {
      await app.close()
      store.close()
      if (!options.databasePath) rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** POST JSON, optionally with a bearer token. Returns status and parsed body. */
export async function post(
  rig: TestRig,
  path: string,
  body: unknown,
  token?: string,
): Promise<{ status: number; body: any; headers: Headers }> {
  const response = await fetch(`${rig.baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body ?? {}),
  })
  const text = await response.text()
  return {
    status: response.status,
    body: text === '' ? undefined : JSON.parse(text),
    headers: response.headers,
  }
}

/** Register an iPhone and return its wake token plus the APNs token used. */
export async function register(
  rig: TestRig,
  apnsToken = fakeApnsToken(),
  environment?: string,
): Promise<{ wakeToken: string; apnsToken: string }> {
  const result = await post(rig, '/v1/register', {
    apnsToken,
    ...(environment ? { environment } : {}),
  })
  if (result.status !== 200) {
    throw new Error(`register failed: ${result.status} ${JSON.stringify(result.body)}`)
  }
  return { wakeToken: result.body.wakeToken, apnsToken }
}

/** Register an Android phone and return its wake token plus the FCM token used. */
export async function registerAndroid(
  rig: TestRig,
  fcmToken = fakeFcmToken(),
): Promise<{ wakeToken: string; fcmToken: string }> {
  const result = await post(rig, '/v1/register', { fcmToken })
  if (result.status !== 200) {
    throw new Error(`register failed: ${result.status} ${JSON.stringify(result.body)}`)
  }
  return { wakeToken: result.body.wakeToken, fcmToken }
}
