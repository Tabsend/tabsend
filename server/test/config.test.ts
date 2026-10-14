import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CLIENT_PROTOCOL, MIN_RELAY_PROTOCOL, type ServerConfigResponse } from '@tabsend/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app'
import { acceptsNewGroups, loadConfig, readProvisioningTokenFile } from '../src/config'
import { createDatabase, ensureRelayId, migrate } from '../src/db'
import { http, startTestServer, type TestServer } from './helpers'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

const rootVersion = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
  .version as string

let server: TestServer | undefined

afterEach(async () => {
  await server?.close()
  // Clearing matters: the relayId describe below starts no server, so without
  // this its afterEach would close the previous one a second time — a no-op on
  // SQLite, but fatal on Postgres, where close drops the test schema.
  server = undefined
})

describe('GET /v1/config', () => {
  it('returns an empty vapidPublicKey when push is disabled (no auth needed)', async () => {
    server = await startTestServer()
    const res = await http.get<ServerConfigResponse>(server.baseUrl, '/v1/config')
    expect(res.status).toBe(200)
    expect(res.body.vapidPublicKey).toBe('')
  })

  it('surfaces the configured VAPID public key', async () => {
    server = await startTestServer({ vapidPublicKey: 'BPublicKeyBase64Url' })
    const res = await http.get<ServerConfigResponse>(server.baseUrl, '/v1/config')
    expect(res.status).toBe(200)
    expect(res.body.vapidPublicKey).toBe('BPublicKeyBase64Url')
  })

  it('advertises bootstrap-pairing protocol support', async () => {
    server = await startTestServer()
    const res = await http.get<ServerConfigResponse>(server.baseUrl, '/v1/config')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      protocol: CLIENT_PROTOCOL,
      minClientProtocol: MIN_RELAY_PROTOCOL,
    })
  })

  it('returns a UUID-shaped relayId (P-4 stable identity)', async () => {
    server = await startTestServer()
    const res = await http.get<ServerConfigResponse>(server.baseUrl, '/v1/config')
    expect(res.status).toBe(200)
    expect(res.body.relayId).toMatch(UUID_RE)
  })

  // A self-hoster upgrades the relay by hand, so "which build is running?" has to be
  // answerable from the outside. Asserted against the root manifest rather than a
  // literal, so a version bump never has to touch this file.
  it('reports its own build id, matching the monorepo root version', async () => {
    server = await startTestServer()
    const res = await http.get<ServerConfigResponse>(server.baseUrl, '/v1/config')
    expect(res.status).toBe(200)
    expect(res.body.relayVersion).toBe(rootVersion)
  })
})

describe('relayId stability (P-4)', () => {
  // The id must survive every restart: minted on the FIRST boot only, then read
  // forever — a re-run of migrate() + ensureRelayId() on the same database is
  // exactly what a restart does.
  it('is minted once and never overwritten across repeated migrates', async () => {
    const db = createDatabase('sqlite::memory:')
    try {
      await migrate(db)
      const first = await ensureRelayId(db)
      expect(first).toMatch(UUID_RE)

      await migrate(db) // "restart" on the same database
      const second = await ensureRelayId(db)
      expect(second).toBe(first)
    } finally {
      await db.destroy()
    }
  })
})

/**
 * Env parsing for the single-group policy (ADR-0022). Worth its own coverage because
 * every other test sets the policy on the config object directly and so never exercises
 * the env path — and the DEFAULT is the whole point: a deployment that omits the
 * variable (i.e. every existing docker-compose out there) must come up single-group.
 */
describe('ALLOW_MULTIPLE_GROUPS', () => {
  const base = { DATABASE_URL: 'sqlite::memory:', PUBLIC_RELAY_URL: 'https://relay.test' }

  it('defaults to single-group when unset', () => {
    expect(loadConfig(base).groupCreation).toBe('single')
  })

  it('accepts 1 and true, and still means exactly `open` [0029]', () => {
    // Back-compat is the point: an existing deployment keeps the behaviour it had.
    expect(loadConfig({ ...base, ALLOW_MULTIPLE_GROUPS: '1' }).groupCreation).toBe('open')
    expect(loadConfig({ ...base, ALLOW_MULTIPLE_GROUPS: 'true' }).groupCreation).toBe('open')
  })

  it('treats anything else as off, rather than as truthy-non-empty', () => {
    // '0' and 'false' are the dangerous ones: a permissive parse would read either as
    // "enabled" and silently hand back multi-group to someone switching it off.
    for (const value of ['0', 'false', 'no', '']) {
      expect(loadConfig({ ...base, ALLOW_MULTIPLE_GROUPS: value }).groupCreation).toBe('single')
    }
  })
})

/**
 * The three-way group-creation policy [0029] (HOSTED_PLAN §4.1). Two things need
 * proving here and nowhere else: that the default is unchanged for everyone who has
 * never heard of this variable, and that a pair of variables which disagree stops the
 * relay instead of picking a winner. Guessing there is how a relay ends up multi-tenant
 * while its operator believes it is not.
 */
describe('GROUP_CREATION', () => {
  const base = { DATABASE_URL: 'sqlite::memory:', PUBLIC_RELAY_URL: 'https://relay.test' }

  it('defaults to single, and answers the create question per policy', () => {
    expect(loadConfig(base).groupCreation).toBe('single')
    // The ladder every reader shares [0029]: `open` always, `single` until it holds
    // one, `provisioned` never — including on an empty relay, which is the whole
    // difference between it and `single`.
    expect(acceptsNewGroups('open', true)).toBe(true)
    expect(acceptsNewGroups('single', false)).toBe(true)
    expect(acceptsNewGroups('single', true)).toBe(false)
    expect(acceptsNewGroups('provisioned', false)).toBe(false)
  })

  it('is case- and whitespace-insensitive, but refuses a value it does not know', () => {
    expect(loadConfig({ ...base, GROUP_CREATION: ' Provisioned ' }).groupCreation).toBe(
      'provisioned',
    )
    // A typo must not fall back to a default: the operator asked for something.
    expect(() => loadConfig({ ...base, GROUP_CREATION: 'provisionned' })).toThrow(
      /single, open, provisioned/,
    )
  })

  it('wins over ALLOW_MULTIPLE_GROUPS, so an open relay can be tightened in place', () => {
    // The hosted upgrade path: keep the old variable, add the new one, get the lock.
    const config = loadConfig({
      ...base,
      ALLOW_MULTIPLE_GROUPS: '1',
      GROUP_CREATION: 'provisioned',
    })
    expect(config.groupCreation).toBe('provisioned')
  })

  it('refuses to boot when the two variables contradict each other', () => {
    expect(() =>
      loadConfig({ ...base, ALLOW_MULTIPLE_GROUPS: '1', GROUP_CREATION: 'single' }),
    ).toThrow(/GROUP_CREATION/)
    expect(() =>
      loadConfig({ ...base, ALLOW_MULTIPLE_GROUPS: '0', GROUP_CREATION: 'open' }),
    ).toThrow(/GROUP_CREATION/)
    // An UNSET (or empty) legacy variable is not a contradiction — it is silence.
    expect(
      loadConfig({ ...base, ALLOW_MULTIPLE_GROUPS: '', GROUP_CREATION: 'open' }).groupCreation,
    ).toBe('open')
  })
})

describe('explicit VAPID configuration', () => {
  const base = { DATABASE_URL: 'sqlite::memory:', PUBLIC_RELAY_URL: 'https://relay.test' }

  it('preserves a complete operator-supplied keypair as the override', () => {
    expect(
      loadConfig({
        ...base,
        VAPID_PUBLIC_KEY: 'operator-public',
        VAPID_PRIVATE_KEY: 'operator-private',
        VAPID_SUBJECT: 'mailto:operator@example.com',
      }).vapid,
    ).toEqual({
      publicKey: 'operator-public',
      privateKey: 'operator-private',
      subject: 'mailto:operator@example.com',
    })
  })

  it('treats two blank compose variables as omitted so boot can auto-provision', () => {
    expect(
      loadConfig({ ...base, VAPID_PUBLIC_KEY: '  ', VAPID_PRIVATE_KEY: '' }).vapid,
    ).toBeUndefined()
  })

  it('rejects either half of a partial explicit pair', () => {
    expect(() => loadConfig({ ...base, VAPID_PUBLIC_KEY: 'operator-public' })).toThrow(
      'must either both be set or both be omitted',
    )
    expect(() => loadConfig({ ...base, VAPID_PRIVATE_KEY: 'operator-private' })).toThrow(
      'must either both be set or both be omitted',
    )
  })
})

describe('WebSocket resource limits', () => {
  const base = { DATABASE_URL: 'sqlite::memory:', PUBLIC_RELAY_URL: 'https://relay.test' }

  it('uses conservative defaults', () => {
    const config = loadConfig(base)
    expect(config.streamMaxFrameBytes).toBe(16 * 1024)
    expect(config.streamHelloTimeoutMs).toBe(10_000)
    expect(config.streamIdleTimeoutMs).toBe(90_000)
    expect(config.streamMaxConnections).toBe(1_000)
    expect(config.streamMaxConnectionsPerEndpoint).toBe(5)
    expect(config.streamMaxConnectionsPerGroup).toBe(100)
  })

  it('reads operator overrides', () => {
    const config = loadConfig({
      ...base,
      STREAM_MAX_FRAME_BYTES: '4096',
      STREAM_HELLO_TIMEOUT_SECONDS: '7',
      STREAM_IDLE_TIMEOUT_SECONDS: '45',
      STREAM_MAX_CONNECTIONS: '200',
      STREAM_MAX_CONNECTIONS_PER_ENDPOINT: '3',
      STREAM_MAX_CONNECTIONS_PER_GROUP: '12',
    })
    expect(config.streamMaxFrameBytes).toBe(4096)
    expect(config.streamHelloTimeoutMs).toBe(7_000)
    expect(config.streamIdleTimeoutMs).toBe(45_000)
    expect(config.streamMaxConnections).toBe(200)
    expect(config.streamMaxConnectionsPerEndpoint).toBe(3)
    expect(config.streamMaxConnectionsPerGroup).toBe(12)
  })

  it('rejects zero because ws treats a zero payload limit as unlimited', () => {
    expect(() => loadConfig({ ...base, STREAM_MAX_FRAME_BYTES: '0' })).toThrow(
      'STREAM_MAX_FRAME_BYTES must be greater than zero',
    )
  })
})

/**
 * The register rate limiter's two knobs, and the ONE thing about them that was a live
 * defect: a window of zero. `RATE_LIMIT_WINDOW_SECONDS=0` reads as "switch this off"
 * to anyone who has met `RATE_LIMIT_MAX=0` or any of the `CAP_*` variables — and it
 * used to reach `windowBounds`, divide by zero, and make every register 500, because
 * the limiter fails closed. Both spellings of "off" are pinned here.
 */
describe('rate-limit window', () => {
  const base = { DATABASE_URL: 'sqlite::memory:', PUBLIC_RELAY_URL: 'https://relay.test' }

  it('defaults to 30 requests per 10 minutes', () => {
    expect(loadConfig(base).rateLimit).toEqual({ max: 30, windowMs: 600_000 })
  })

  it('reads an operator window in seconds', () => {
    expect(loadConfig({ ...base, RATE_LIMIT_WINDOW_SECONDS: '90' }).rateLimit.windowMs).toBe(90_000)
  })

  it('normalises a zero or negative window to off, rather than to a zero-length one', () => {
    for (const value of ['0', '-1', '-600']) {
      expect(loadConfig({ ...base, RATE_LIMIT_WINDOW_SECONDS: value }).rateLimit.windowMs).toBe(0)
    }
    // With the window off, `max` is left exactly as the operator set it: it is the
    // window that switches the limiter off, and neither knob rewrites the other.
    const config = loadConfig({ ...base, RATE_LIMIT_WINDOW_SECONDS: '0', RATE_LIMIT_MAX: '5' })
    expect(config.rateLimit).toEqual({ max: 5, windowMs: 0 })
  })
})

describe('Web Push egress policy', () => {
  const base = { DATABASE_URL: 'sqlite::memory:', PUBLIC_RELAY_URL: 'https://relay.test' }

  it('blocks private endpoints by default', () => {
    expect(loadConfig(base).pushAllowPrivateEndpoints).toBe(false)
  })

  it('requires an explicit self-hosting opt-in', () => {
    expect(
      loadConfig({ ...base, PUSH_ALLOW_PRIVATE_ENDPOINTS: '1' }).pushAllowPrivateEndpoints,
    ).toBe(true)
    expect(
      loadConfig({ ...base, PUSH_ALLOW_PRIVATE_ENDPOINTS: 'true' }).pushAllowPrivateEndpoints,
    ).toBe(true)
    expect(
      loadConfig({ ...base, PUSH_ALLOW_PRIVATE_ENDPOINTS: 'yes' }).pushAllowPrivateEndpoints,
    ).toBe(false)
  })
})

/**
 * `WAKE_FORWARDER_URL` [0032] (HOSTED_PLAN §6).
 *
 * Unset is the default and means today's behaviour, exactly: no wake, drain on open.
 * Set-but-wrong is a boot error rather than a shrug, because the quiet version of that
 * failure is phones that pair happily and then never ring.
 */
describe('wake-up forwarder URL', () => {
  const base = { DATABASE_URL: 'sqlite::memory:', PUBLIC_RELAY_URL: 'https://relay.test' }

  it('defaults to absent, which is the relay every self-hoster runs today', () => {
    expect(loadConfig(base).wakeForwarderUrl).toBeUndefined()
    expect(loadConfig({ ...base, WAKE_FORWARDER_URL: '  ' }).wakeForwarderUrl).toBeUndefined()
  })

  it('normalises away a trailing slash so the wake route cannot come out doubled', () => {
    expect(loadConfig({ ...base, WAKE_FORWARDER_URL: 'https://wake.test/' }).wakeForwarderUrl).toBe(
      'https://wake.test',
    )
    expect(
      loadConfig({ ...base, WAKE_FORWARDER_URL: 'https://wake.test/forwarder/' }).wakeForwarderUrl,
    ).toBe('https://wake.test/forwarder')
  })

  it('refuses anything that is not a plain absolute base URL', () => {
    expect(() => loadConfig({ ...base, WAKE_FORWARDER_URL: 'wake.test' })).toThrow(
      'WAKE_FORWARDER_URL must be an absolute URL',
    )
    expect(() => loadConfig({ ...base, WAKE_FORWARDER_URL: 'ftp://wake.test' })).toThrow(
      'WAKE_FORWARDER_URL must be http or https',
    )
    // A wake token rides a header, never a URL (forwarder PROTOCOL §6): a query string
    // here is either a typo or somebody attaching a secret to every wake.
    expect(() => loadConfig({ ...base, WAKE_FORWARDER_URL: 'https://wake.test?t=abc' })).toThrow(
      'no query string or fragment',
    )
  })
})

/**
 * The provisioning credential [0031] (HOSTED_PLAN §4.2).
 *
 * `loadConfig` validates it even though the FILE form is only read at boot, because
 * every failure here has the same shape: a provisioning API the operator believes is
 * protected, or believes is reachable, and is not. Unset is not a failure — it is the
 * default, and it means the routes do not exist.
 */
describe('provisioning credential', () => {
  const base = { DATABASE_URL: 'sqlite::memory:', PUBLIC_RELAY_URL: 'https://relay.test' }

  it('defaults to absent, which is what keeps a self-hosted relay unchanged', () => {
    const config = loadConfig(base)
    expect(config.provisioningToken).toBeUndefined()
    expect(config.provisioningTokenFile).toBeUndefined()
  })

  it('takes a credential from the environment, trimmed', () => {
    const config = loadConfig({ ...base, PROVISIONING_TOKEN: '  a-long-enough-credential  ' })
    expect(config.provisioningToken).toBe('a-long-enough-credential')
  })

  it('refuses two answers to one question', () => {
    expect(() =>
      loadConfig({
        ...base,
        PROVISIONING_TOKEN: 'a-long-enough-credential',
        PROVISIONING_TOKEN_FILE: '/run/secrets/provisioning',
      }),
    ).toThrow('are both set')
  })

  it('refuses a credential that is set but empty, rather than serving the routes unguarded', () => {
    expect(() => loadConfig({ ...base, PROVISIONING_TOKEN: '' })).toThrow('set but empty')
    expect(() => loadConfig({ ...base, PROVISIONING_TOKEN: '   ' })).toThrow('set but empty')
    expect(() => loadConfig({ ...base, PROVISIONING_TOKEN_FILE: '' })).toThrow('set but empty')
  })

  it('refuses a credential short enough to guess, and says how to make one', () => {
    let message = ''
    try {
      loadConfig({ ...base, PROVISIONING_TOKEN: 'changeme' })
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toContain('at least 16 characters')
    // The fix is a command that runs as written, not a placeholder.
    expect(message).toContain('openssl rand -base64 32')
  })

  it('reads the file form at boot, newline and all, and names the path when it cannot', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tabsend-provisioning-'))
    const path = join(dir, 'credential')
    writeFileSync(path, 'a-long-enough-credential\n')
    try {
      expect(readProvisioningTokenFile(path)).toBe('a-long-enough-credential')
      const missing = join(dir, 'nope')
      expect(() => readProvisioningTokenFile(missing)).toThrow(missing)
      writeFileSync(path, '\n')
      expect(() => readProvisioningTokenFile(path)).toThrow('set but empty')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('registers no provisioning routes without one, and refuses to build an app that lost the file', async () => {
    server = await startTestServer()
    const res = await http.post(server.baseUrl, '/admin/provisioning/groups')
    expect(res.status).toBe(404)

    // The wiring assertion: a configured file path that boot never read must not fall
    // through to "no routes, no explanation".
    const db = createDatabase('sqlite::memory:')
    await migrate(db)
    const config = loadConfig({ ...base, PROVISIONING_TOKEN_FILE: '/run/secrets/provisioning' })
    await expect(buildApp({ db, config, relayId: await ensureRelayId(db) })).rejects.toThrow(
      'never loaded',
    )
    await db.destroy()
  })
})

/**
 * PAIRING_CODES_MAX_LIVE [0031 amended]. A count, so a whole number of 0 or more, and
 * refused at boot otherwise [2026-10-01]: a limit reaches SQL as a parameter compared
 * against `count(*)`, and Postgres refused a fraction there on every mint, so `2.5`
 * turned every pairing link into a 500.
 */
describe('PAIRING_CODES_MAX_LIVE', () => {
  const base = { DATABASE_URL: 'sqlite::memory:', PUBLIC_RELAY_URL: 'https://relay.test' }

  it('defaults to 20, and 0 switches it off', () => {
    expect(loadConfig(base).pairingCodesMaxLive).toBe(20)
    expect(loadConfig({ ...base, PAIRING_CODES_MAX_LIVE: '' }).pairingCodesMaxLive).toBe(20)
    expect(loadConfig({ ...base, PAIRING_CODES_MAX_LIVE: '0' }).pairingCodesMaxLive).toBe(0)
    expect(loadConfig({ ...base, PAIRING_CODES_MAX_LIVE: '5' }).pairingCodesMaxLive).toBe(5)
  })

  it.each(['2.5', '-1', '1e20', 'lots'])(
    'refuses %s at boot rather than at every mint',
    (value) => {
      expect(() => loadConfig({ ...base, PAIRING_CODES_MAX_LIVE: value })).toThrow(
        /PAIRING_CODES_MAX_LIVE|Expected a number/,
      )
    },
  )
})

/**
 * HISTORY_RETENTION_DAYS [0028]. A whole number of days, 0 (history off) to ten
 * years, refused at boot otherwise (review 2026-10-13): a negative read as "off"
 * without saying so, and a value past about 10^8 days turned every send into a 500.
 */
describe('HISTORY_RETENTION_DAYS', () => {
  const base = { DATABASE_URL: 'sqlite::memory:', PUBLIC_RELAY_URL: 'https://relay.test' }
  const DAY_MS = 24 * 60 * 60 * 1000

  it('defaults to 30 days, and 0 switches history off', () => {
    expect(loadConfig(base).historyRetentionMs).toBe(30 * DAY_MS)
    expect(loadConfig({ ...base, HISTORY_RETENTION_DAYS: '0' }).historyRetentionMs).toBe(0)
    expect(loadConfig({ ...base, HISTORY_RETENTION_DAYS: '3650' }).historyRetentionMs).toBe(
      3650 * DAY_MS,
    )
  })

  it.each(['-1', '1.5', '3651', '200000000', 'lots'])('refuses %s at boot', (value) => {
    expect(() => loadConfig({ ...base, HISTORY_RETENTION_DAYS: value })).toThrow(
      /HISTORY_RETENTION_DAYS|Expected a number/,
    )
  })
})

/**
 * Every count reaches SQL compared against a `count(*)` or a counter, where Postgres
 * refuses a fraction on every request; and a link lifetime of zero makes links dead on
 * arrival [2026-10-01]. Both are refused at boot instead.
 */
describe('limits that must be whole numbers, and lifetimes that must be positive', () => {
  const base = { DATABASE_URL: 'sqlite::memory:', PUBLIC_RELAY_URL: 'https://relay.test' }

  it.each([
    'CAP_ENDPOINTS',
    'CAP_QUEUED_MESSAGES',
    'CAP_QUEUED_BYTES',
    'CAP_SENDS_PER_WINDOW',
    'RATE_LIMIT_MAX',
  ])('refuses a fraction or a negative for %s', (name) => {
    expect(() => loadConfig({ ...base, [name]: '2.5' })).toThrow(name)
    expect(() => loadConfig({ ...base, [name]: '-1' })).toThrow(name)
    expect(() => loadConfig({ ...base, [name]: '0' })).not.toThrow()
  })

  it.each(['PAIRING_CODE_TTL_MINUTES', 'BOOTSTRAP_PAIRING_TTL_MINUTES'])(
    'refuses a %s of zero',
    (name) => {
      expect(() => loadConfig({ ...base, [name]: '0' })).toThrow(name)
    },
  )
})
