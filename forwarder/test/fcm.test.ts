import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto'
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import type { AddressInfo } from 'node:net'
import { inspect } from 'node:util'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config'
import { isDeviceGone, isWrongProject } from '../src/fcm'
import {
  FcmTokenSource,
  httpTokenExchange,
  loadServiceAccount,
  type Scheduler,
  signServiceAccountAssertion,
  type TokenExchange,
} from '../src/fcm-auth'
import { TEST_DEVICE_TOKEN_KEY_B64 } from './helpers'

/**
 * The Google credential path. Everything here is about the two ways a forwarder can be
 * wrong in a way that looks fine: credentials it cannot use, and an access token it keeps
 * past its life.
 */

const KEY = { DEVICE_TOKEN_KEY: TEST_DEVICE_TOKEN_KEY_B64 }

const APPLE_ENV = {
  APNS_KEY_PEM: '-----BEGIN PRIVATE KEY-----\nnot-parsed-here\n-----END PRIVATE KEY-----',
  APNS_KEY_ID: 'ABCD123456',
  APNS_TEAM_ID: 'TEAM123456',
  ...KEY,
}

function serviceAccountJson(): string {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  return JSON.stringify({
    type: 'service_account',
    project_id: 'tabsend-test',
    client_email: 'wake@tabsend-test.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  })
}

describe('Google credentials in loadConfig', () => {
  it('reads a service account beside Apple credentials', () => {
    const config = loadConfig({ ...APPLE_ENV, FCM_SERVICE_ACCOUNT_PATH: '/tmp/sa.json' })
    expect(config.fcm?.serviceAccountPath).toBe('/tmp/sa.json')
    expect(config.fcm?.timeoutMs).toBe(5_000)
    expect(config.apns).toBeDefined()
  })

  it('allows an Android-only forwarder: Google configured, no Apple variables at all', () => {
    const config = loadConfig({ FCM_SERVICE_ACCOUNT_PATH: '/tmp/sa.json', ...KEY })
    expect(config.fcm).toBeDefined()
    expect(config.apns).toBeUndefined()
    expect(config.apnsDryRun).toBe(false)
  })

  it('still rejects PARTIAL Apple credentials when Google is configured', () => {
    // The Android-only escape must not become a way for an Apple typo to pass silently.
    expect(() =>
      loadConfig({
        FCM_SERVICE_ACCOUNT_PATH: '/tmp/sa.json',
        ...KEY,
        APNS_KEY_ID: 'ABCD123456',
        APNS_TEAM_ID: 'TEAM123456',
      }),
    ).toThrow(/No Apple signing key/)
  })

  it('refuses to start with neither provider configured', () => {
    expect(() => loadConfig({})).toThrow(/Apple signing key/)
  })

  it('refuses two service accounts rather than guessing', () => {
    expect(() =>
      loadConfig({
        ...APPLE_ENV,
        FCM_SERVICE_ACCOUNT_JSON: '{}',
        FCM_SERVICE_ACCOUNT_PATH: '/tmp/sa.json',
      }),
    ).toThrow(/not both/)
  })

  /**
   * SECURITY_REVIEW G13: fractions and out-of-range numbers were accepted, and made every
   * Google call fail (past about 24.8 days Node fires a timer at once).
   */
  it('accepts only a whole-number timeout in a sane range', () => {
    const base = { ...APPLE_ENV, FCM_SERVICE_ACCOUNT_PATH: '/tmp/sa.json' }
    for (const bad of ['1.5', '0', '99', '60001', '3000000000', '-5']) {
      expect(() => loadConfig({ ...base, FCM_TIMEOUT_MS: bad })).toThrow(/FCM_TIMEOUT_MS/)
    }
    expect(loadConfig({ ...base, FCM_TIMEOUT_MS: '2500' }).fcm?.timeoutMs).toBe(2500)
  })

  it('reads the ceiling on rings in flight', () => {
    const base = { ...APPLE_ENV, FCM_SERVICE_ACCOUNT_PATH: '/tmp/sa.json' }
    expect(loadConfig(base).fcm?.maxInFlight).toBe(64)
    expect(loadConfig({ ...base, FCM_MAX_IN_FLIGHT: '8' }).fcm?.maxInFlight).toBe(8)
    expect(() => loadConfig({ ...base, FCM_MAX_IN_FLIGHT: '0' })).toThrow(/FCM_MAX_IN_FLIGHT/)
  })

  it('treats FCM_DRY_RUN as a configured Google side', () => {
    const config = loadConfig({ FCM_DRY_RUN: '1', ...KEY })
    expect(config.fcmDryRun).toBe(true)
    expect(config.fcm).toBeUndefined()
    // And it satisfies "this forwarder can ring someone", so Apple is not demanded.
    expect(config.apns).toBeUndefined()
  })
})

describe('loadServiceAccount', () => {
  it('reads project id, client email and key out of a real service account', () => {
    const account = loadServiceAccount(serviceAccountJson())
    expect(account.projectId).toBe('tabsend-test')
    expect(account.clientEmail).toBe('wake@tabsend-test.iam.gserviceaccount.com')
  })

  it('names the likely mistake when handed google-services.json instead', () => {
    // The Android client config is JSON, is called something similar, and contains no
    // credential. An operator who confuses the two gets told which file to go and get.
    const clientConfig = JSON.stringify({
      project_info: { project_id: 'tabsend-test' },
      client: [{ api_key: [{ current_key: 'AIzaSy-not-a-credential' }] }],
    })
    expect(() => loadServiceAccount(clientConfig)).toThrow(/google-services\.json/)
  })

  it('rejects JSON that is not JSON, and a key that is not a key', () => {
    expect(() => loadServiceAccount('not json at all')).toThrow(/as JSON/)
    expect(() =>
      loadServiceAccount(
        JSON.stringify({
          project_id: 'p',
          client_email: 'e@example.com',
          private_key: 'definitely not a pem',
        }),
      ),
    ).toThrow(/newlines/)
  })

  /**
   * SECURITY_REVIEW G13: an EC key started and signed assertions Google refuses, so every
   * Android ring failed on a forwarder that had looked fine at boot.
   */
  it('refuses a key that is not RSA', () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    expect(() =>
      loadServiceAccount(
        JSON.stringify({
          project_id: 'p',
          client_email: 'e@example.com',
          private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
        }),
      ),
    ).toThrow(/ec key.*only RSA/)
  })

  /** SECURITY_REVIEW G24: a key that will not parse must not land in a log with the error. */
  it('never repeats the private key it could not read', () => {
    const secret = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ-not-really-a-key'
    let printed = ''
    try {
      loadServiceAccount(
        JSON.stringify({ project_id: 'p', client_email: 'e@x', private_key: secret }),
      )
    } catch (err) {
      printed = inspect(err, { depth: 5 })
    }
    expect(printed).toContain('newlines')
    expect(printed).not.toContain(secret)
  })
})

describe('signServiceAccountAssertion', () => {
  it('signs an RS256 JWT scoped to firebase.messaging and addressed to the token endpoint', () => {
    const account = loadServiceAccount(serviceAccountJson())
    const jwt = signServiceAccountAssertion({ account, issuedAtSeconds: 1_700_000_000 })
    const parts = jwt.split('.')
    expect(parts).toHaveLength(3)
    const [header, payload, signature] = parts as [string, string, string]

    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({
      alg: 'RS256',
      typ: 'JWT',
    })
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString())
    expect(claims.iss).toBe(account.clientEmail)
    expect(claims.scope).toBe('https://www.googleapis.com/auth/firebase.messaging')
    expect(claims.aud).toBe('https://oauth2.googleapis.com/token')
    // Google rejects an assertion claiming more than an hour.
    expect(claims.exp - claims.iat).toBe(3600)
    expect(signature.length).toBeGreaterThan(0)
  })

  /** SECURITY_REVIEW G24: the header says RS256, so the signature has to be one. */
  it('signs with RSA over SHA-256, verifiable with the account’s public key', () => {
    const account = loadServiceAccount(serviceAccountJson())
    const [header, payload, signature] = signServiceAccountAssertion({
      account,
      issuedAtSeconds: 1_700_000_000,
    }).split('.') as [string, string, string]
    const publicKey = createPublicKey(account.privateKey.export({ type: 'pkcs8', format: 'pem' }))
    expect(
      verify(
        'sha256',
        Buffer.from(`${header}.${payload}`),
        publicKey,
        Buffer.from(signature, 'base64url'),
      ),
    ).toBe(true)
  })
})

describe('FcmTokenSource', () => {
  it('caches an access token and re-exchanges it only once it nears expiry', async () => {
    const account = loadServiceAccount(serviceAccountJson())
    let exchanges = 0
    const exchange: TokenExchange = async () => {
      exchanges += 1
      return { accessToken: `token-${exchanges}`, expiresInSeconds: 3600 }
    }
    let clock = Date.UTC(2026, 9, 1, 12, 0, 0)
    const source = new FcmTokenSource(account, 5_000, exchange, () => clock)

    expect(await source.current()).toBe('token-1')
    expect(await source.current()).toBe('token-1')
    expect(exchanges).toBe(1)

    // 59 minutes in: still inside the hour, but within the refresh margin.
    clock += 59 * 60 * 1000 + 30 * 1000
    expect(await source.current()).toBe('token-2')
    expect(exchanges).toBe(2)
  })

  it('shares one in-flight exchange across concurrent wakes', async () => {
    const account = loadServiceAccount(serviceAccountJson())
    let exchanges = 0
    const exchange: TokenExchange = async () => {
      exchanges += 1
      await new Promise((resolve) => setTimeout(resolve, 5))
      return { accessToken: 'shared', expiresInSeconds: 3600 }
    }
    const source = new FcmTokenSource(account, 5_000, exchange)

    const tokens = await Promise.all([source.current(), source.current(), source.current()])
    expect(tokens).toEqual(['shared', 'shared', 'shared'])
    // A burst on a cold cache must not hammer Google's token endpoint.
    expect(exchanges).toBe(1)
  })

  /**
   * SECURITY_REVIEW G17: a failing exchange used to be retried by every ring, each signing
   * and posting an assertion of its own, for as long as Google refused. Now a ring inside
   * the back-off fails at once; the failure is still not cached past it.
   */
  it('backs off after a failed exchange, for rings too, and recovers after it', async () => {
    const account = loadServiceAccount(serviceAccountJson())
    let attempts = 0
    const exchange: TokenExchange = async () => {
      attempts += 1
      if (attempts === 1) throw new Error('Google refused the service-account assertion: nope')
      return { accessToken: 'recovered', expiresInSeconds: 3600 }
    }
    let clock = Date.UTC(2026, 9, 20, 12, 0, 0)
    const source = new FcmTokenSource(account, 5_000, exchange, () => clock)

    await expect(source.current()).rejects.toThrow(/refused/)
    for (let i = 0; i < 10; i++) {
      await expect(source.current()).rejects.toThrow(/last exchange failed.*nope/)
    }
    expect(attempts).toBe(1)

    // Past the back-off, the next caller exchanges again: the failure is not cached.
    clock += 30_000
    expect(await source.current()).toBe('recovered')
    expect(attempts).toBe(2)
  })

  /** SECURITY_REVIEW G17: an empty access token used to be cached and sent for an hour. */
  it('never caches an empty access token, or one with no lifetime', async () => {
    const account = loadServiceAccount(serviceAccountJson())
    for (const answer of [
      { accessToken: '', expiresInSeconds: 3600 },
      { accessToken: 'ya29.x', expiresInSeconds: 0 },
      { accessToken: 'ya29.x', expiresInSeconds: 20 },
      { accessToken: 'ya29.x', expiresInSeconds: Number.NaN },
    ]) {
      const source = new FcmTokenSource(account, 5_000, async () => answer)
      await expect(source.current()).rejects.toThrow(/refused/)
      expect(source.healthy).toBe(false)
    }
  })

  /** SECURITY_REVIEW G17: a 401 on a send did not drop the token Google had stopped taking. */
  it('drops a token Google refused, fetches a new one at once, and not more than twice a minute', async () => {
    const account = loadServiceAccount(serviceAccountJson())
    let exchanges = 0
    const exchange: TokenExchange = async () => {
      exchanges += 1
      return { accessToken: `token-${exchanges}`, expiresInSeconds: 3600 }
    }
    let clock = Date.UTC(2026, 9, 20, 12, 0, 0)
    const source = new FcmTokenSource(
      account,
      5_000,
      exchange,
      () => clock,
      () => () => undefined,
    )
    source.start()
    await new Promise((resolve) => setImmediate(resolve))
    expect(await source.current()).toBe('token-1')

    source.invalidate('token-1')
    await new Promise((resolve) => setImmediate(resolve))
    expect(exchanges).toBe(2)
    expect(await source.current()).toBe('token-2')

    // A late 401 for the token already replaced changes nothing.
    source.invalidate('token-1')
    // Nor does a second 401 inside thirty seconds: a 401 on every ring must not become an
    // exchange on every ring.
    clock += 10_000
    source.invalidate('token-2')
    await new Promise((resolve) => setImmediate(resolve))
    expect(exchanges).toBe(2)
    expect(await source.current()).toBe('token-2')

    clock += 30_000
    source.invalidate('token-2')
    await new Promise((resolve) => setImmediate(resolve))
    expect(exchanges).toBe(3)
    source.stop()
  })

  /** SECURITY_REVIEW G13: whether Android sign-ups are let in follows the last exchange. */
  it('reports itself unhealthy while the last exchange failed, and healthy once one works', async () => {
    const account = loadServiceAccount(serviceAccountJson())
    let refuse = true
    const exchange: TokenExchange = async () => {
      if (refuse) throw new Error('Google refused the service-account assertion: invalid_grant')
      return { accessToken: 'ok', expiresInSeconds: 3600 }
    }
    let clock = Date.UTC(2026, 9, 20, 12, 0, 0)
    const source = new FcmTokenSource(account, 5_000, exchange, () => clock)

    expect(source.healthy).toBe(true)
    await expect(source.current()).rejects.toThrow()
    expect(source.healthy).toBe(false)

    refuse = false
    clock += 30_000
    expect(await source.current()).toBe('ok')
    expect(source.healthy).toBe(true)
  })
})

/**
 * The real exchange against a local token endpoint [2026-10-20, SECURITY_REVIEW G17]: it
 * followed redirects and read a reply of any size.
 */
describe('httpTokenExchange', () => {
  async function endpoint(
    handler: (req: IncomingMessage, res: ServerResponse) => void,
  ): Promise<{ url: string; hits: string[]; close: () => Promise<void> }> {
    const hits: string[] = []
    const server = createHttpServer((req, res) => {
      hits.push(req.url ?? '')
      handler(req, res)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const { port } = server.address() as AddressInfo
    return {
      url: `http://127.0.0.1:${port}/token`,
      hits,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    }
  }

  it('reads a token answer', async () => {
    const google = await endpoint((_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ access_token: 'ya29.ok', expires_in: 3599 }))
    })
    try {
      expect(await httpTokenExchange(google.url)('assertion', 2_000)).toEqual({
        accessToken: 'ya29.ok',
        expiresInSeconds: 3599,
      })
    } finally {
      await google.close()
    }
  })

  it('follows no redirect', async () => {
    const google = await endpoint((req, res) => {
      if (req.url === '/token') {
        res.statusCode = 307
        res.setHeader('location', '/elsewhere')
        res.end()
        return
      }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ access_token: 'ya29.redirected', expires_in: 3600 }))
    })
    try {
      await expect(httpTokenExchange(google.url)('assertion', 2_000)).rejects.toThrow()
      expect(google.hits).toEqual(['/token'])
    } finally {
      await google.close()
    }
  })

  it('reads only the start of an oversized answer', async () => {
    const google = await endpoint((_req, res) => {
      res.setHeader('content-type', 'application/json')
      // A usable token, but only past the first 64 KiB.
      res.end(
        JSON.stringify({
          pad: 'x'.repeat(2 * 1024 * 1024),
          access_token: 'ya29.big',
          expires_in: 3600,
        }),
      )
    })
    try {
      await expect(httpTokenExchange(google.url)('assertion', 2_000)).rejects.toThrow(/refused/)
    } finally {
      await google.close()
    }
  })

  /**
   * The 2026-10-20 review of G17: a missing lifetime became an hour on this path, and one
   * under the 30 s margin was cached and never used, so every ring exchanged again.
   */
  it('refuses an answer with no lifetime, or one too short to use', async () => {
    for (const lifetime of [undefined, 20, 59]) {
      const google = await endpoint((_req, res) => {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ access_token: 'ya29.short', expires_in: lifetime }))
      })
      try {
        const account = loadServiceAccount(serviceAccountJson())
        const source = new FcmTokenSource(account, 2_000, httpTokenExchange(google.url))
        await expect(source.current()).rejects.toThrow(/lifetime/)
        expect(source.healthy).toBe(false)
      } finally {
        await google.close()
      }
    }
  })

  it('refuses an answer with an empty token', async () => {
    const google = await endpoint((_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ access_token: '', expires_in: 3600 }))
    })
    try {
      await expect(httpTokenExchange(google.url)('assertion', 2_000)).rejects.toThrow(
        /no access token/,
      )
    } finally {
      await google.close()
    }
  })
})

/**
 * The refresh timer [2026-10-02, SECURITY_REVIEW G14]. A ring used to pay for the
 * exchange whenever it found the token stale: signing an assertion and a round trip to
 * Google after its reply, busy time an unknown token never caused. Now the timer pays.
 */
describe('FcmTokenSource on its timer', () => {
  /** A scheduler a test fires by hand, recording what was asked of it. */
  function manualScheduler(): {
    schedule: Scheduler
    pending: { delayMs: number; run: () => void; cancelled: boolean }[]
    fireNext(): void
  } {
    const pending: { delayMs: number; run: () => void; cancelled: boolean }[] = []
    return {
      schedule: (task, delayMs) => {
        const entry = { delayMs, run: task, cancelled: false }
        pending.push(entry)
        return () => {
          entry.cancelled = true
        }
      },
      pending,
      fireNext() {
        const next = pending.find((entry) => !entry.cancelled)
        if (!next) throw new Error('nothing scheduled')
        next.cancelled = true
        next.run()
      },
    }
  }
  const settle = () => new Promise((resolve) => setImmediate(resolve))

  it('exchanges at start and again ahead of expiry, with no ring involved', async () => {
    const account = loadServiceAccount(serviceAccountJson())
    let exchanges = 0
    const exchange: TokenExchange = async () => {
      exchanges += 1
      return { accessToken: `token-${exchanges}`, expiresInSeconds: 3600 }
    }
    let clock = Date.UTC(2026, 9, 2, 12, 0, 0)
    const timer = manualScheduler()
    const source = new FcmTokenSource(account, 5_000, exchange, () => clock, timer.schedule)

    source.start()
    await settle()
    expect(exchanges).toBe(1)
    // Next refresh five minutes before the hour is up.
    expect(timer.pending.at(-1)?.delayMs).toBe(55 * 60 * 1000)

    clock += 55 * 60 * 1000
    timer.fireNext()
    await settle()
    expect(exchanges).toBe(2)
    expect(await source.current()).toBe('token-2')
    expect(exchanges).toBe(2)
    source.stop()
  })

  it('hands a ring the token it holds, never one still being fetched', async () => {
    const account = loadServiceAccount(serviceAccountJson())
    let exchanges = 0
    let release: (() => void) | undefined
    const exchange: TokenExchange = async () => {
      exchanges += 1
      if (exchanges > 1) {
        // Google is slow to answer the refresh.
        await new Promise<void>((resolve) => {
          release = resolve
        })
      }
      return { accessToken: `token-${exchanges}`, expiresInSeconds: 3600 }
    }
    let clock = Date.UTC(2026, 9, 2, 12, 0, 0)
    const timer = manualScheduler()
    const source = new FcmTokenSource(account, 5_000, exchange, () => clock, timer.schedule)
    source.start()
    await settle()

    // Fifty-nine minutes in: the refresh is under way and has not come back.
    clock += 59 * 60 * 1000
    timer.fireNext()
    await settle()
    expect(exchanges).toBe(2)

    // The old token is still good for a minute, so a ring takes it and does not wait.
    const answer = await Promise.race([
      source.current(),
      new Promise((resolve) => setTimeout(() => resolve('waited'), 200)),
    ])
    expect(answer).toBe('token-1')

    release?.()
    await settle()
    expect(await source.current()).toBe('token-2')
    source.stop()
  })

  /** Found by the 2026-10-02 verification pass: a stop during a refresh did not hold. */
  it('stays stopped when stopped while a refresh is under way', async () => {
    const account = loadServiceAccount(serviceAccountJson())
    let release: (() => void) | undefined
    const exchange: TokenExchange = async () => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return { accessToken: 'late', expiresInSeconds: 3600 }
    }
    const timer = manualScheduler()
    const source = new FcmTokenSource(account, 5_000, exchange, () => Date.now(), timer.schedule)
    source.start()
    await settle()

    source.stop()
    release?.()
    await settle()

    expect(timer.pending.filter((entry) => !entry.cancelled)).toHaveLength(0)
  })

  /** Found by the 2026-10-02 verification pass: past 24.8 days Node fires a timer at once. */
  it('refreshes at least hourly, whatever lifetime the token endpoint claims', async () => {
    const account = loadServiceAccount(serviceAccountJson())
    const exchange: TokenExchange = async () => ({
      accessToken: 'long',
      expiresInSeconds: 30 * 24 * 3600,
    })
    const timer = manualScheduler()
    const source = new FcmTokenSource(account, 5_000, exchange, () => Date.now(), timer.schedule)
    source.start()
    await settle()

    expect(timer.pending.at(-1)?.delayMs).toBe(60 * 60 * 1000)
    source.stop()
  })

  it('backs off after a failed refresh, tells the operator, and recovers', async () => {
    const account = loadServiceAccount(serviceAccountJson())
    let attempts = 0
    const exchange: TokenExchange = async () => {
      attempts += 1
      if (attempts <= 2) throw new Error('Google refused the service-account assertion: nope')
      return { accessToken: 'recovered', expiresInSeconds: 3600 }
    }
    const errors: string[] = []
    const timer = manualScheduler()
    const source = new FcmTokenSource(
      account,
      5_000,
      exchange,
      () => Date.now(),
      timer.schedule,
      (err) => errors.push(err.message),
    )

    source.start()
    await settle()
    expect(timer.pending.at(-1)?.delayMs).toBe(30_000)
    timer.fireNext()
    await settle()
    expect(timer.pending.at(-1)?.delayMs).toBe(60_000)
    timer.fireNext()
    await settle()

    expect(errors).toHaveLength(2)
    expect(await source.current()).toBe('recovered')
    source.stop()
  })

  it('stops refreshing when stopped', async () => {
    const account = loadServiceAccount(serviceAccountJson())
    const timer = manualScheduler()
    const source = new FcmTokenSource(
      account,
      5_000,
      async () => ({ accessToken: 't', expiresInSeconds: 3600 }),
      () => Date.now(),
      timer.schedule,
    )
    source.start()
    await settle()
    source.stop()
    expect(timer.pending.every((entry) => entry.cancelled)).toBe(true)
  })
})

describe('reading Google error answers', () => {
  it('counts only 404 UNREGISTERED as proof a device is gone', () => {
    expect(isDeviceGone(404, 'UNREGISTERED')).toBe(true)
    expect(isDeviceGone(404, 'NOT_FOUND')).toBe(false)
    // The one that looks like it belongs and does not: Google says this for a live token
    // shown to the wrong Firebase project.
    expect(isDeviceGone(400, 'INVALID_ARGUMENT')).toBe(false)
    expect(isDeviceGone(503, 'UNAVAILABLE')).toBe(false)
  })

  it('recognises the wrong-project answer so the row is kept and the operator told', () => {
    expect(
      isWrongProject({ ok: false, deviceGone: false, status: 400, reason: 'INVALID_ARGUMENT' }),
    ).toBe(true)
    expect(isWrongProject({ ok: true })).toBe(false)
  })
})
