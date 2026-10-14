import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  BrowserFamily,
  EncryptedEnvelope,
  EndpointKind,
  Platform,
  PushSubscription,
  RegisterResponse,
} from '@tabsend/shared'
import type { FastifyInstance } from 'fastify'
import type { Kysely } from 'kysely'
import { buildApp } from '../src/app'
import { ensureBootstrapGroup, type FirstRunPairing, mintFirstRunPairing } from '../src/bootstrap'
import { type Config, type GroupCreation, loadConfig } from '../src/config'
import {
  createDatabase,
  type Database,
  dropPgSchema,
  ensurePgSchema,
  ensureRelayId,
  migrate,
} from '../src/db'
import { GroupWriteQueue } from '../src/group-queue'
import { Hub } from '../src/hub'
import { keyIdFor, newPairingCode } from '../src/ids'
import { FakePushSender, ForwarderWakeSender } from '../src/push'
import { RateLimiter } from '../src/ratelimit'
import { RelayStats } from '../src/stats'
import { addMs, iso } from '../src/time'

/**
 * Dialect matrix. The default is SQLite (fast, no external service). Set
 * `TABSEND_TEST_PG=1` to run the SAME suite against Postgres (CI does both).
 * Each server gets its own throwaway schema so suites stay isolated and can run
 * in parallel against one shared `tabsend_test` database.
 */
export const USE_POSTGRES = process.env.TABSEND_TEST_PG === '1'
export const PG_URL =
  process.env.TABSEND_TEST_PG_URL ?? 'postgres://postgres@127.0.0.1:55432/tabsend_test'

/** Extract the relay-internal register secret carried by a pairing link. */
export function pairingCodeFromLink(link: string): string {
  const code = new URLSearchParams(new URL(link).hash.slice(1)).get('c')
  if (!code) throw new Error('Pairing link did not contain a secret.')
  return code
}

export interface TestClock {
  now(): Date
  advance(ms: number): void
  set(date: Date): void
}

function makeClock(start = new Date('2026-07-16T12:00:00.000Z')): TestClock {
  let current = start
  return {
    now: () => current,
    advance(ms: number) {
      current = new Date(current.getTime() + ms)
    },
    set(date: Date) {
      current = date
    },
  }
}

export interface TestServer {
  baseUrl: string
  wsUrl: string
  push: FakePushSender
  clock: TestClock
  app: FastifyInstance
  /** The live store — lets tests drive the sweeper / inspect rows directly. */
  db: Kysely<Database>
  /** The live config, so tests can re-run boot-time steps against this relay. */
  config: Config
  /** The relay's per-group write queue, so race tests can see a write join it. */
  groupWrites: GroupWriteQueue
  /** What boot would print for a first device (ADR-0023); null once someone has joined. */
  firstRunPairing: FirstRunPairing | null
  /** Present only with `secondListener` — the companion listener's addresses. */
  second?: { baseUrl: string; wsUrl: string }
  close(): Promise<void>
}

/** Relay-wide cap defaults for a focused test [0030]. Omitted caps stay unlimited. */
export interface CapOptions {
  endpoints?: number
  queuedMessages?: number
  queuedBytes?: number
  sendsPerWindow?: number
  sendWindowMs?: number
}

export interface StartOptions {
  messageTtlMs?: number
  /** How long group history stays readable [0028]; 0 disables serving it. */
  historyRetentionMs?: number
  pairingCodeTtlMs?: number
  /** Live pairing codes one group may hold [0031 amended]. Production default is 20. */
  pairingCodesMaxLive?: number
  /** Set a VAPID public key for GET /v1/config tests (push stays faked). */
  vapidPublicKey?: string
  /** Enable rate limiting for a focused test (default: OFF so multi-register suites
   *  sharing 127.0.0.1 never trip the limit). */
  rateLimit?: { max: number; windowMs: number }
  /** Override the dead-subscription threshold for a focused pruning test. */
  pushDeadThreshold?: number
  /** Sweeper cadence in ms. The background sweeper is never started here; this only
   *  changes what the relay REPORTS about it, which `0` (switched off) makes visible. */
  sweepIntervalMs?: number
  /** Override the request body cap for a focused size-limit test. */
  bodyLimitBytes?: number
  streamMaxFrameBytes?: number
  streamHelloTimeoutMs?: number
  streamIdleTimeoutMs?: number
  streamMaxConnections?: number
  streamMaxConnectionsPerEndpoint?: number
  streamMaxConnectionsPerGroup?: number
  /**
   * Who may create a group here [0029]. Defaults to the PRODUCTION default, `single`,
   * so suites exercise what a real relay does; a suite that genuinely needs
   * independent groups (cross-group isolation) opts into `open`, and the hosted lock
   * is `provisioned`.
   */
  groupCreation?: GroupCreation
  /**
   * The pre-[0029] spelling, kept working: `true` means `groupCreation: 'open'`.
   * Prefer `groupCreation`; this exists so the suites that opted into multi-group
   * before the policy existed did not all have to change to say the same thing.
   */
  allowMultipleGroups?: boolean
  /** Set a served-cert SPKI pin so pairing payloads carry it (P-3 self-signed mode;
   *  the test server itself stays plain HTTP). */
  certFingerprint?: string
  /** Boot a SECOND listener sharing this relay's db, hub and rate limiter — the
   *  dual-listen shape (https + cleartext http on one relay). Exposed as
   *  `server.second`. Both listeners are plain HTTP here: what's under test is the
   *  shared state, not TLS. */
  secondListener?: boolean
  /**
   * Make that second listener a second relay INSTANCE rather than a second door:
   * its own Hub, RateLimiter and RelayStats, sharing only the database [0030].
   *
   * This is the shape §4.4 exists for. `secondListener` alone proves the opposite
   * thing — that one relay's two doors share in-process state — and would pass a
   * shared-store test for the wrong reason, because both doors hold the same
   * limiter object. Implies `secondListener`.
   */
  secondInstance?: boolean
  /** Relay-wide per-group cap defaults [0030]. Default: every cap unlimited. */
  caps?: CapOptions
  /**
   * Turn the provisioning API on with this credential [0031]. Unset (the default) is a
   * relay WITHOUT the routes at all, which is what every other suite must exercise —
   * that is what a self-hosted relay runs.
   */
  provisioningToken?: string
  /**
   * Capture the relay's structured log lines. Each entry is one parsed pino record.
   * Used by the audit-mirror test; leaving it unset keeps the suites silent.
   */
  captureLogs?: unknown[]
  /**
   * Give this relay a wake-up forwarder [0032]. Unset (the default) is a relay that
   * has none, which is what every other suite must exercise: the `forwarder` transport
   * is refused there, and nothing else changes.
   */
  wakeForwarderUrl?: string
  /**
   * Stand in for `fetch` on the forwarder call. Supplying it wraps the FakePushSender
   * in a REAL {@link ForwarderWakeSender}, so what the suite exercises is the actual
   * request the relay would send — method, URL and `Authorization` header — with
   * nothing leaving the process. Requires `wakeForwarderUrl`.
   */
  wakeFetch?: typeof fetch
}

interface DialectHandle {
  db: Kysely<Database>
  databaseUrl: string
  cleanup(): Promise<void>
}

/**
 * Live relays by base URL, so {@link register} can put an endpoint into the relay's own
 * group without every call site having to thread the server through.
 *
 * Needed because the relay now OWNS its group (ADR-0023): "register me" is no longer
 * "create a group", it is "join the one that already exists" — which needs a pairing
 * code, which needs the database. Entries are removed on close.
 */
const liveRelays = new Map<string, { db: Kysely<Database>; config: Config; now: () => Date }>()

/** Provision an isolated store for one test server (SQLite file OR PG schema). */
async function provisionStore(): Promise<DialectHandle> {
  if (USE_POSTGRES) {
    const schema = `ts_${randomBytes(8).toString('hex')}`
    const db = createDatabase(PG_URL, { pgSchema: schema })
    await ensurePgSchema(db, schema)
    await migrate(db)
    return {
      db,
      databaseUrl: PG_URL,
      async cleanup() {
        await dropPgSchema(db, schema)
        await db.destroy()
      },
    }
  }

  const dir = mkdtempSync(join(tmpdir(), 'tabsend-test-'))
  const dbPath = join(dir, 'test.db')
  const databaseUrl = `sqlite:${dbPath}`
  const db = createDatabase(databaseUrl)
  await migrate(db)
  return {
    db,
    databaseUrl,
    async cleanup() {
      await db.destroy()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/**
 * Boot a real in-process relay on an ephemeral port. Backed by SQLite by default,
 * or Postgres (isolated schema) when `TABSEND_TEST_PG=1`. The background sweeper
 * is left OFF — the injected clock drives TTL tests, and `server.db` lets a test
 * call `sweepExpired` deterministically.
 */
export async function startTestServer(options: StartOptions = {}): Promise<TestServer> {
  const store = await provisionStore()

  const push = new FakePushSender()
  const clock = makeClock()

  const config = loadConfig({
    DATABASE_URL: store.databaseUrl,
    PUBLIC_RELAY_URL: 'https://relay.test',
  })
  if (options.messageTtlMs !== undefined) config.messageTtlMs = options.messageTtlMs
  if (options.historyRetentionMs !== undefined)
    config.historyRetentionMs = options.historyRetentionMs
  if (options.pairingCodeTtlMs !== undefined) config.pairingCodeTtlMs = options.pairingCodeTtlMs
  if (options.pairingCodesMaxLive !== undefined)
    config.pairingCodesMaxLive = options.pairingCodesMaxLive
  // Rate limiting OFF by default in tests (all requests come from 127.0.0.1).
  config.rateLimit = options.rateLimit ?? { max: 0, windowMs: 600_000 }
  // Caps OFF by default [0030], matching a real relay: a suite that does not ask for
  // one must exercise the unguarded path, which is the path every deployment runs.
  config.caps = {
    endpoints: options.caps?.endpoints ?? 0,
    queuedMessages: options.caps?.queuedMessages ?? 0,
    queuedBytes: options.caps?.queuedBytes ?? 0,
    sendsPerWindow: options.caps?.sendsPerWindow ?? 0,
    sendWindowMs: options.caps?.sendWindowMs ?? 60_000,
  }
  if (options.pushDeadThreshold !== undefined) config.pushDeadThreshold = options.pushDeadThreshold
  if (options.sweepIntervalMs !== undefined) config.sweepIntervalMs = options.sweepIntervalMs
  if (options.bodyLimitBytes !== undefined) config.bodyLimitBytes = options.bodyLimitBytes
  if (options.streamMaxFrameBytes !== undefined)
    config.streamMaxFrameBytes = options.streamMaxFrameBytes
  if (options.streamHelloTimeoutMs !== undefined)
    config.streamHelloTimeoutMs = options.streamHelloTimeoutMs
  if (options.streamIdleTimeoutMs !== undefined)
    config.streamIdleTimeoutMs = options.streamIdleTimeoutMs
  if (options.streamMaxConnections !== undefined)
    config.streamMaxConnections = options.streamMaxConnections
  if (options.streamMaxConnectionsPerEndpoint !== undefined)
    config.streamMaxConnectionsPerEndpoint = options.streamMaxConnectionsPerEndpoint
  if (options.streamMaxConnectionsPerGroup !== undefined)
    config.streamMaxConnectionsPerGroup = options.streamMaxConnectionsPerGroup
  let groupCreation = options.groupCreation
  if (groupCreation === undefined && options.allowMultipleGroups !== undefined) {
    groupCreation = options.allowMultipleGroups ? 'open' : 'single'
  }
  if (groupCreation !== undefined) config.groupCreation = groupCreation
  if (options.vapidPublicKey !== undefined) {
    // Push stays faked (injected below); this only surfaces via GET /v1/config.
    config.vapid = {
      publicKey: options.vapidPublicKey,
      privateKey: 'test-private-key',
      subject: 'mailto:test@tabsend.local',
    }
  }

  if (options.provisioningToken !== undefined) {
    config.provisioningToken = options.provisioningToken
  }

  if (options.wakeForwarderUrl !== undefined) {
    config.wakeForwarderUrl = options.wakeForwarderUrl
  }
  if (options.wakeFetch && options.wakeForwarderUrl === undefined) {
    throw new Error('wakeFetch needs a wakeForwarderUrl — there is nothing to ring without one.')
  }

  // Fastify hands pino a `stream`, so this captures the real log lines the relay
  // writes rather than a stand-in for them — which is the point when what is under
  // test IS a log line (the [0031] audit mirror).
  const logger = options.captureLogs
    ? {
        level: 'info',
        stream: {
          write(line: string) {
            options.captureLogs?.push(JSON.parse(line))
          },
        },
      }
    : undefined

  const relayId = await ensureRelayId(store.db)
  // Mirror the real boot sequence (server.ts): the relay owns its group and hands out
  // the first pairing code. Tests that skipped this would exercise a relay no operator
  // ever runs.
  await ensureBootstrapGroup(store.db, config, clock.now())
  const firstRunPairing = await mintFirstRunPairing(
    store.db,
    config,
    options.certFingerprint,
    clock.now(),
  )
  // Built explicitly so a second listener can SHARE them (see StartOptions.secondListener).
  const hub = new Hub()
  const groupWrites = new GroupWriteQueue()
  const rateLimiter = new RateLimiter(store.db, config.rateLimit, () => clock.now())
  // Started on the injected clock, so an uptime-sensitive assertion (the sweeper-idle
  // warning) can be driven by advancing it rather than by waiting.
  const stats = new RelayStats(clock.now())
  // With a fake fetch the relay gets the REAL forwarder sender over the fake one, so
  // the suite asserts the request the relay would actually make [0032]. Without one it
  // keeps the plain FakePushSender, whose `calls` already record a forwarder
  // subscription like any other.
  const pushSender = options.wakeFetch
    ? new ForwarderWakeSender(options.wakeForwarderUrl as string, push, options.wakeFetch)
    : push
  const app = await buildApp({
    db: store.db,
    config,
    relayId,
    certFingerprint: options.certFingerprint,
    push: pushSender,
    hub,
    rateLimiter,
    stats,
    groupWrites,
    now: () => clock.now(),
    ...(logger ? { logger } : {}),
  })
  await app.listen({ host: '127.0.0.1', port: 0 })
  const { port } = app.server.address() as AddressInfo
  const baseUrl = `http://127.0.0.1:${port}`
  liveRelays.set(baseUrl, { db: store.db, config, now: () => clock.now() })

  let secondApp: FastifyInstance | undefined
  let second: TestServer['second']
  if (options.secondListener || options.secondInstance) {
    // A second INSTANCE shares nothing but the database, so it gets fresh in-process
    // state; a second LISTENER is one relay's other door and shares all of it [0030].
    const separate = options.secondInstance === true
    secondApp = await buildApp({
      db: store.db,
      config,
      relayId,
      certFingerprint: options.certFingerprint,
      push,
      hub: separate ? new Hub() : hub,
      rateLimiter: separate
        ? new RateLimiter(store.db, config.rateLimit, () => clock.now())
        : rateLimiter,
      stats: separate ? new RelayStats(clock.now()) : stats,
      groupWrites: separate ? new GroupWriteQueue() : groupWrites,
      now: () => clock.now(),
    })
    await secondApp.listen({ host: '127.0.0.1', port: 0 })
    const addr = secondApp.server.address() as AddressInfo
    second = {
      baseUrl: `http://127.0.0.1:${addr.port}`,
      wsUrl: `ws://127.0.0.1:${addr.port}/v1/stream`,
    }
    // Same relay, second door: registering through it must be able to join the same
    // group, so it needs the same entry.
    liveRelays.set(second.baseUrl, { db: store.db, config, now: () => clock.now() })
  }

  let closed = false
  return {
    baseUrl,
    wsUrl: `ws://127.0.0.1:${port}/v1/stream`,
    push,
    clock,
    app,
    config,
    groupWrites,
    firstRunPairing,
    db: store.db,
    second,
    async close() {
      // Idempotent: when a `beforeEach` boot fails, the test file's `afterEach`
      // still closes the PREVIOUS server, and a second close would bury the real
      // failure under "driver has already been destroyed".
      if (closed) return
      liveRelays.delete(baseUrl)
      if (second) liveRelays.delete(second.baseUrl)
      closed = true
      await app.close()
      await secondApp?.close()
      await store.cleanup()
    },
  }
}

// --- HTTP helpers ---------------------------------------------------------

export interface HttpResult<T = unknown> {
  status: number
  body: T
}

async function request<T>(
  method: string,
  baseUrl: string,
  path: string,
  body?: unknown,
  token?: string,
): Promise<HttpResult<T>> {
  const headers: Record<string, string> = {}
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (token) headers.authorization = `Bearer ${token}`
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  const parsed = text.length > 0 ? JSON.parse(text) : undefined
  return { status: res.status, body: parsed as T }
}

export const http = {
  post: <T>(baseUrl: string, path: string, body?: unknown, token?: string) =>
    request<T>('POST', baseUrl, path, body, token),
  get: <T>(baseUrl: string, path: string, token?: string) =>
    request<T>('GET', baseUrl, path, undefined, token),
  patch: <T>(baseUrl: string, path: string, body?: unknown, token?: string) =>
    request<T>('PATCH', baseUrl, path, body, token),
  del: <T>(baseUrl: string, path: string, token?: string) =>
    request<T>('DELETE', baseUrl, path, undefined, token),
}

// --- domain helpers -------------------------------------------------------

let pubkeyCounter = 0

export interface RegisterOverrides {
  label?: string
  kind?: EndpointKind
  browser?: BrowserFamily | null
  platform?: Platform
  pushSubscription?: PushSubscription
  e2ePubkey?: string
  deviceName?: string
  pairingCode?: string
}

export interface RegisteredEndpoint extends RegisterResponse {
  token: string
  e2ePubkey: string
}

/** Register (create group if no pairingCode, else join). Returns response + token. */
/**
 * Mint a pairing code for this relay's group, straight into the database.
 *
 * The shortcut a test needs now that the relay owns its group (ADR-0023): joining takes
 * a code, and the first one normally comes from the boot log. Returns undefined on an
 * `open` relay, where a bare register still creates a group and needs no code, and on
 * any relay with no group yet.
 *
 * Deliberately keyed on `groupCreation === 'open'` rather than on multiplicity [0029]:
 * a `provisioned` relay hosts many groups but refuses every bare register, so a test
 * there needs a code exactly as a single-group one does.
 */
export async function autoPairingCode(baseUrl: string): Promise<string | undefined> {
  const relay = liveRelays.get(baseUrl)
  if (!relay || relay.config.groupCreation === 'open') return undefined
  const group = await relay.db.selectFrom('groups').select('id').limit(1).executeTakeFirst()
  if (!group) return undefined
  const code = newPairingCode()
  const now = relay.now()
  await relay.db
    .insertInto('pairing_codes')
    .values({
      code,
      group_id: group.id,
      created_at: iso(now),
      expires_at: iso(addMs(now, relay.config.pairingCodeTtlMs)),
      consumed_at: null,
    })
    .execute()
  return code
}

export async function register(
  baseUrl: string,
  overrides: RegisterOverrides = {},
): Promise<RegisteredEndpoint> {
  const e2ePubkey = overrides.e2ePubkey ?? `pubkey-${++pubkeyCounter}`
  // On a single-group relay a bare register is refused (ADR-0022), because the relay
  // already made the group (ADR-0023). Tests asking for "an endpoint" mean one IN that
  // group, so mint them a code — the same thing a paired device does for a newcomer.
  // A test that passes its own code, or that opted into `groupCreation: 'open'` to
  // create groups deliberately, is left alone.
  const pairingCode = overrides.pairingCode ?? (await autoPairingCode(baseUrl))
  const body = {
    label: overrides.label ?? 'Test Endpoint',
    kind: overrides.kind ?? 'extension',
    browser: overrides.browser ?? 'chrome',
    platform: overrides.platform ?? 'macos',
    pushSubscription:
      overrides.pushSubscription ??
      ({
        transport: 'webpush',
        endpoint: 'https://push.test/endpoint',
        keys: { p256dh: 'p256dh-key', auth: 'auth-key' },
      } satisfies PushSubscription),
    e2ePubkey,
    ...(overrides.deviceName ? { deviceName: overrides.deviceName } : {}),
    ...(pairingCode ? { pairingCode } : {}),
  }
  const res = await http.post<RegisterResponse>(baseUrl, '/v1/endpoints/register', body)
  if (res.status !== 201) {
    throw new Error(`register failed (${res.status}): ${JSON.stringify(res.body)}`)
  }
  return { ...res.body, token: res.body.deviceToken as unknown as string, e2ePubkey }
}

/** Build a well-formed envelope sealed (as far as the relay knows) to a pubkey. */
export function envelopeFor(
  targetPubkey: string,
  opts: { targetKeyId?: string; senderKeyId?: string } = {},
): EncryptedEnvelope {
  return {
    alg: 'x25519-xsalsa20-poly1305/box',
    senderKeyId: opts.senderKeyId ?? 'sender-key-id',
    targetKeyId: opts.targetKeyId ?? keyIdFor(targetPubkey),
    nonce: Buffer.from('nonce-24-bytes-padding!!').toString('base64'),
    ciphertext: Buffer.from(JSON.stringify({ url: 'https://example.com' })).toString('base64'),
  }
}

// --- WebSocket client -----------------------------------------------------

export interface TestWs {
  send(obj: unknown): void
  sendRaw(value: string): void
  /** Resolve with the next message matching `pred` (checks already-buffered first). */
  next(pred?: (msg: any) => boolean, timeoutMs?: number): Promise<any>
  messages: any[]
  close(): void
  closed: Promise<{ code: number }>
}

export function connectWs(wsUrl: string): Promise<TestWs> {
  const ws = new WebSocket(wsUrl)
  const messages: any[] = []
  const buffer: any[] = []
  const waiters: Array<{ pred: (m: any) => boolean; resolve: (m: any) => void }> = []

  ws.addEventListener('message', (ev: MessageEvent) => {
    const raw = typeof ev.data === 'string' ? ev.data : String(ev.data)
    const msg = JSON.parse(raw)
    messages.push(msg)
    const idx = waiters.findIndex((w) => w.pred(msg))
    if (idx >= 0) {
      const [w] = waiters.splice(idx, 1)
      w!.resolve(msg)
    } else {
      buffer.push(msg)
    }
  })

  let resolveClosed: (v: { code: number }) => void
  const closed = new Promise<{ code: number }>((r) => {
    resolveClosed = r
  })
  ws.addEventListener('close', (ev: CloseEvent) => resolveClosed({ code: ev.code }))

  const api: TestWs = {
    send(obj: unknown) {
      ws.send(JSON.stringify(obj))
    },
    sendRaw(value: string) {
      ws.send(value)
    },
    next(pred: (m: any) => boolean = () => true, timeoutMs = 5000) {
      const idx = buffer.findIndex(pred)
      if (idx >= 0) {
        const [m] = buffer.splice(idx, 1)
        return Promise.resolve(m)
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('ws next() timeout')), timeoutMs)
        waiters.push({
          pred,
          resolve: (m) => {
            clearTimeout(timer)
            resolve(m)
          },
        })
      })
    },
    messages,
    close() {
      ws.close()
    },
    closed,
  }

  return new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve(api))
    ws.addEventListener('error', () => reject(new Error('ws connection error')))
  })
}

/** Small delay helper for the rare case a test must let async fan-out settle. */
export function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
