import { describe, expect, it } from 'vitest'
import { type Config, loadConfig } from '../src/config'
import { assertProfile, hostedProfileViolations } from '../src/profile'

/**
 * The hosted deployment posture, asserted at boot [0033] (HOSTED_PLAN §4.5).
 *
 * Every case here goes through `loadConfig` with a real env bag rather than through a
 * hand-built Config literal. That is deliberate: the rules are written against variable
 * NAMES an operator sets, so a test that bypassed the reader would keep passing after
 * somebody renamed the variable the error message tells them to change.
 */

/** An env bag that satisfies every hosted rule. Each test breaks exactly one thing. */
const HOSTED_ENV: NodeJS.ProcessEnv = {
  TABSEND_PROFILE: 'hosted',
  DATABASE_URL: 'postgres://tabsend@127.0.0.1:5432/tabsend_relay',
  PUBLIC_RELAY_URL: 'https://app.tabsend.org',
  GROUP_CREATION: 'provisioned',
  PROVISIONING_TOKEN_FILE: '/run/secrets/tabsend-provisioning',
  TRUST_PROXY: '1',
  RATE_LIMIT_MAX: '30',
  SWEEP_INTERVAL_SECONDS: '60',
}

/** The settings a violation list names, so an assertion reads as the fix an operator gets. */
function settings(config: Config): string[] {
  return hostedProfileViolations(config).map((v) => v.setting)
}

describe('TABSEND_PROFILE', () => {
  it('changes nothing at all when it is unset', () => {
    const config = loadConfig({})
    expect(config.profile).toBeUndefined()
    // The default relay breaks nearly every hosted rule (SQLite, single group, no
    // proxy), and none of that matters: with no claim there is nothing to check.
    expect(hostedProfileViolations(config).length).toBeGreaterThan(0)
    expect(() => assertProfile(config)).not.toThrow()
  })

  it('treats an empty value as unset rather than as a claim', () => {
    expect(loadConfig({ TABSEND_PROFILE: '' }).profile).toBeUndefined()
    expect(loadConfig({ TABSEND_PROFILE: '   ' }).profile).toBeUndefined()
  })

  it('accepts the value in any case, because env files are typed by hand', () => {
    expect(loadConfig({ ...HOSTED_ENV, TABSEND_PROFILE: 'HOSTED' }).profile).toBe('hosted')
  })

  it('refuses an unrecognised value instead of falling through to no profile', () => {
    let message = ''
    try {
      loadConfig({ TABSEND_PROFILE: 'hostd' })
    } catch (err) {
      message = (err as Error).message
    }
    // A typo must not buy a relay that boots happily and checks nothing.
    expect(message).toContain('TABSEND_PROFILE must be one of hosted')
    expect(message).toContain('hostd')
  })
})

describe('the hosted posture, one rule at a time', () => {
  it('boots a compliant hosted relay without complaint', () => {
    const config = loadConfig(HOSTED_ENV)
    expect(config.profile).toBe('hosted')
    expect(hostedProfileViolations(config)).toEqual([])
    expect(() => assertProfile(config)).not.toThrow()
  })

  it('refuses PUSH_ALLOW_PRIVATE_ENDPOINTS, which HOSTED_SECURITY_PLAN forbids outright', () => {
    const config = loadConfig({ ...HOSTED_ENV, PUSH_ALLOW_PRIVATE_ENDPOINTS: '1' })
    expect(settings(config)).toEqual(['PUSH_ALLOW_PRIVATE_ENDPOINTS'])
    expect(() => assertProfile(config)).toThrow('cloud metadata address')
  })

  it('refuses any GROUP_CREATION but provisioned, and says which one it found', () => {
    for (const policy of ['single', 'open']) {
      const config = loadConfig({ ...HOSTED_ENV, GROUP_CREATION: policy })
      expect(settings(config)).toEqual(['GROUP_CREATION'])
      expect(() => assertProfile(config)).toThrow(`is "${policy}"`)
    }
  })

  it('refuses a provisioned relay with no credential, because no tenancy could ever exist', () => {
    const { PROVISIONING_TOKEN_FILE: _dropped, ...noCredential } = HOSTED_ENV
    const config = loadConfig(noCredential)
    expect(settings(config)).toEqual(['PROVISIONING_TOKEN_FILE'])
    // The fix is a command that runs as written.
    expect(() => assertProfile(config)).toThrow('openssl rand -base64 32')
  })

  it('accepts either form of the credential', () => {
    const { PROVISIONING_TOKEN_FILE: _dropped, ...env } = HOSTED_ENV
    const config = loadConfig({ ...env, PROVISIONING_TOKEN: 'a-long-enough-credential' })
    expect(hostedProfileViolations(config)).toEqual([])
  })

  it('refuses SQLite, which cannot express the two-database boundary §7 requires', () => {
    const config = loadConfig({ ...HOSTED_ENV, DATABASE_URL: 'sqlite:./.data/tabsend.db' })
    expect(settings(config)).toEqual(['DATABASE_URL'])
    expect(() => assertProfile(config)).toThrow('postgres://')
  })

  it('accepts the postgresql:// spelling of the same URL', () => {
    const config = loadConfig({
      ...HOSTED_ENV,
      DATABASE_URL: 'postgresql://tabsend@127.0.0.1:5432/tabsend_relay',
    })
    expect(hostedProfileViolations(config)).toEqual([])
  })

  it('refuses self-signed TLS, which is the no-domain self-host path (ADR-0019)', () => {
    const config = loadConfig({ ...HOSTED_ENV, TLS_SELF_SIGNED: '1' })
    expect(settings(config)).toEqual(['TLS_SELF_SIGNED'])
    expect(() => assertProfile(config)).toThrow('ADR-0019')
  })

  it('refuses TRUST_PROXY=0, because the relay sits behind a TLS-terminating proxy', () => {
    const config = loadConfig({ ...HOSTED_ENV, TRUST_PROXY: '0' })
    expect(settings(config)).toEqual(['TRUST_PROXY'])
    expect(() => assertProfile(config)).toThrow('one bucket shared by the whole internet')
  })

  it('refuses a switched-off rate limit on the one auth-free write route', () => {
    const config = loadConfig({ ...HOSTED_ENV, RATE_LIMIT_MAX: '0' })
    expect(settings(config)).toEqual(['RATE_LIMIT_MAX'])
    expect(() => assertProfile(config)).toThrow('RATE_LIMIT_MAX=30')
  })

  it('refuses a stopped sweeper, which would hold expired ciphertext past its promise', () => {
    const config = loadConfig({ ...HOSTED_ENV, SWEEP_INTERVAL_SECONDS: '0' })
    expect(settings(config)).toEqual(['SWEEP_INTERVAL_SECONDS'])
    expect(() => assertProfile(config)).toThrow('SWEEP_INTERVAL_SECONDS=60')
  })

  it('refuses a PUBLIC_RELAY_URL devices cannot reach, left at the default or plain http', () => {
    const { PUBLIC_RELAY_URL: _dropped, ...noUrl } = HOSTED_ENV
    expect(settings(loadConfig(noUrl))).toEqual(['PUBLIC_RELAY_URL'])
    const plain = loadConfig({ ...HOSTED_ENV, PUBLIC_RELAY_URL: 'http://app.tabsend.org' })
    expect(settings(plain)).toEqual(['PUBLIC_RELAY_URL'])
    expect(() => assertProfile(plain)).toThrow('public https origin')
  })
})

/**
 * The wake forwarder's scheme [0031 amended].
 *
 * The wake token is a bearer credential for the whole forwarder, sent on every ring
 * (forwarder PROTOCOL.md §4, §6). Over plain http to another host that is the
 * credential in the clear, on a relay whose traffic leaves its own machine. ADR-0032
 * deliberately leaves this URL unguarded because it is operator config and a
 * self-hoster ringing their own forwarder over http on their own LAN is supported;
 * hosted is the deployment where that reasoning stops holding.
 */
describe('the wake forwarder must not carry its token in the clear', () => {
  const hosted = (url?: string) =>
    loadConfig({ ...HOSTED_ENV, ...(url === undefined ? {} : { WAKE_FORWARDER_URL: url }) })

  it('says nothing when there is no forwarder at all', () => {
    // Unset stays unasserted: a hosted relay with no iPhone customers is a hosted
    // relay, and drain-on-open is a complete delivery mode [0032].
    expect(settings(hosted())).toEqual([])
  })

  it('accepts https, wherever it points', () => {
    expect(settings(hosted('https://wake.tabsend.io'))).toEqual([])
  })

  it.each(['http://127.0.0.1:8788', 'http://localhost:8788', 'http://[::1]:8788'])(
    'accepts %s, where there is no wire to read',
    (url) => {
      expect(settings(hosted(url))).toEqual([])
    },
  )

  it.each(['http://wake.tabsend.io', 'http://10.0.0.7:8788', 'http://wake.internal'])(
    'refuses %s, which puts the wake token on the wire',
    (url) => {
      const config = hosted(url)
      expect(settings(config)).toEqual(['WAKE_FORWARDER_URL'])
      expect(() => assertProfile(config)).toThrow('in the clear')
    },
  )
})

describe('what the refusal tells an operator', () => {
  it('reports every violation at once, so one restart fixes the lot', () => {
    // A relay whose operator set the profile and nothing else: the default self-hosted
    // shape, which breaks most of the posture.
    const config = loadConfig({ TABSEND_PROFILE: 'hosted' })
    const broken = settings(config)
    expect(broken).toContain('GROUP_CREATION')
    expect(broken).toContain('DATABASE_URL')
    expect(broken).toContain('TRUST_PROXY')
    expect(broken).toContain('PUBLIC_RELAY_URL')
    expect(broken).toContain('PROVISIONING_TOKEN_FILE')

    let message = ''
    try {
      assertProfile(config)
    } catch (err) {
      message = (err as Error).message
    }
    // Numbered, one per line, so the list is a to-do rather than a paragraph.
    for (const [index, setting] of broken.entries()) {
      expect(message).toContain(`${index + 1}. ${setting}`)
    }
    expect(message).toContain('Refusing to start.')
    // Points at the half of the posture no boot check can reach.
    expect(message).toContain('docs/HOSTED_PROFILE.md')
    // And at the way out for somebody who set the variable by mistake.
    expect(message).toContain('Unset TABSEND_PROFILE')
  })

  it('names a variable and a fix in every rule, and never an em dash or a placeholder', () => {
    // Every rule, not a sample: a config that breaks the lot, so a message added later
    // cannot slip past this by being in the one rule the test did not trip.
    const config = loadConfig({
      TABSEND_PROFILE: 'hosted',
      PUSH_ALLOW_PRIVATE_ENDPOINTS: '1',
      WAKE_FORWARDER_URL: 'http://wake.example.com',
      TLS_SELF_SIGNED: '1',
    })
    for (const violation of hostedProfileViolations(config)) {
      expect(violation.setting).toMatch(/^[A-Z][A-Z0-9_]+$/)
      expect(violation.problem.length).toBeGreaterThan(40)
      // House rules for shipped copy: no em dashes, and nothing an operator has to
      // fill in before the instruction means anything.
      expect(violation.problem).not.toContain('—')
      expect(violation.problem).not.toMatch(/<[a-zA-Z_-]+>/)
      // Nor a capitalised stand-in inside an address, which is how
      // `http://127.0.0.1:PORT` once slipped past the line above.
      expect(violation.problem).not.toMatch(/https?:\/\/\S*[A-Z]{2,}/)
    }
  })
})
