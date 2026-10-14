import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config'
import { TEST_DEVICE_TOKEN_KEY_B64 } from './helpers'

/**
 * `loadConfig` is pure and validates early (PROTOCOL.md §10). The cases that matter are
 * the ones where a lenient config would produce a forwarder that starts, answers every
 * wake cheerfully, and rings nobody.
 */

/** Every forwarder needs the key that encrypts device tokens at rest (§5, §10). */

const KEY = { DEVICE_TOKEN_KEY: TEST_DEVICE_TOKEN_KEY_B64 }

const APPLE_ENV = {
  APNS_KEY_PEM: '-----BEGIN PRIVATE KEY-----\nnot-parsed-here\n-----END PRIVATE KEY-----',
  APNS_KEY_ID: 'ABCD123456',
  APNS_TEAM_ID: 'TEAM123456',
  ...KEY,
}

describe('loadConfig', () => {
  it('fills in defaults around a complete Apple credential set', () => {
    const config = loadConfig({ ...APPLE_ENV })

    expect(config.host).toBe('127.0.0.1')
    // Not the relay's 8787, so both run on one dev box.
    expect(config.port).toBe(8788)
    expect(config.databasePath).toBe('./.data/forwarder.db')
    expect(config.apns?.topic).toBe('io.tabsend.app')
    expect(config.apns?.defaultEnvironment).toBe('production')
    expect(config.apnsDryRun).toBe(false)
    expect(config.wakeRateLimit).toEqual({ max: 6, windowMs: 60_000 })
    expect(config.callerRateLimit).toEqual({ max: 120, windowMs: 60_000 })
    expect(config.registerRateLimit).toEqual({ max: 10, windowMs: 600_000 })
  })

  it('refuses to start with no Apple key, and names the dry-run escape', () => {
    expect(() => loadConfig({ APNS_KEY_ID: 'ABCD123456', APNS_TEAM_ID: 'TEAM123456' })).toThrow(
      /APNS_DRY_RUN/,
    )
  })

  it('refuses two keys rather than guessing which one is meant', () => {
    expect(() => loadConfig({ ...APPLE_ENV, APNS_KEY_PATH: '/tmp/AuthKey.p8' })).toThrow(/not both/)
  })

  it('refuses a key with no key id or no team id', () => {
    const { APNS_KEY_ID, ...noKeyId } = APPLE_ENV
    expect(() => loadConfig(noKeyId)).toThrow(/APNS_KEY_ID/)
    const { APNS_TEAM_ID, ...noTeamId } = APPLE_ENV
    expect(() => loadConfig(noTeamId)).toThrow(/APNS_TEAM_ID/)
  })

  it('allows a key-less config only when dry run is explicit', () => {
    const config = loadConfig({ APNS_DRY_RUN: '1', ...KEY })
    expect(config.apnsDryRun).toBe(true)
    expect(config.apns).toBeUndefined()
  })

  it('rejects an unknown default environment', () => {
    expect(() => loadConfig({ ...APPLE_ENV, APNS_DEFAULT_ENVIRONMENT: 'staging' })).toThrow(
      /production/,
    )
  })

  it('rejects nonsense numbers instead of silently using a default', () => {
    expect(() => loadConfig({ ...APPLE_ENV, PORT: 'eight' })).toThrow(/PORT/)
    expect(() => loadConfig({ ...APPLE_ENV, MAX_BODY_BYTES: '0' })).toThrow(/greater than zero/)
    expect(() => loadConfig({ ...APPLE_ENV, WAKE_RATE_LIMIT_WINDOW_SECONDS: '-1' })).toThrow(
      /greater than zero/,
    )
  })

  it('reads the knobs an operator actually turns', () => {
    const config = loadConfig({
      ...APPLE_ENV,
      HOST: '0.0.0.0',
      PORT: '9000',
      DATABASE_PATH: '/var/lib/tabsend/forwarder.db',
      APNS_TOPIC: 'io.example.app',
      APNS_DEFAULT_ENVIRONMENT: 'sandbox',
      APNS_TIMEOUT_MS: '2500',
      TRUST_PROXY: '1',
      WAKE_RATE_LIMIT_MAX: '3',
      LOG_LEVEL: 'debug',
    })

    expect(config.host).toBe('0.0.0.0')
    expect(config.port).toBe(9000)
    expect(config.databasePath).toBe('/var/lib/tabsend/forwarder.db')
    expect(config.apns?.topic).toBe('io.example.app')
    expect(config.apns?.defaultEnvironment).toBe('sandbox')
    expect(config.apns?.timeoutMs).toBe(2500)
    expect(config.trustProxy).toBe(true)
    expect(config.wakeRateLimit.max).toBe(3)
    expect(config.logLevel).toBe('debug')
  })

  /**
   * The key that keeps a copy of the database from being a list of every phone's push
   * address [2026-10-02, SECURITY_REVIEW G15]. Required everywhere, dry run included.
   */
  describe('DEVICE_TOKEN_KEY', () => {
    it('is required, and the refusal says how to make one', () => {
      expect(() => loadConfig({ APNS_DRY_RUN: '1' })).toThrow(/DEVICE_TOKEN_KEY is required/)
      expect(() => loadConfig({ APNS_DRY_RUN: '1' })).toThrow(/openssl rand -base64 32/)
    })

    it('accepts the inline key, or a path that boot reads later', () => {
      expect(loadConfig({ APNS_DRY_RUN: '1', ...KEY }).deviceTokenKey).toBe(KEY.DEVICE_TOKEN_KEY)
      const fromPath = loadConfig({
        APNS_DRY_RUN: '1',
        DEVICE_TOKEN_KEY_PATH: '/etc/tabsend/device-token.key',
      })
      expect(fromPath.deviceTokenKeyPath).toBe('/etc/tabsend/device-token.key')
      expect(fromPath.deviceTokenKey).toBeUndefined()
    })

    it('refuses both forms at once rather than guessing', () => {
      expect(() =>
        loadConfig({ APNS_DRY_RUN: '1', ...KEY, DEVICE_TOKEN_KEY_PATH: '/tmp/k' }),
      ).toThrow(/not both/)
    })

    it('refuses a key of the wrong size or shape, without echoing it', () => {
      const short = Buffer.alloc(16, 9).toString('base64')
      let message = ''
      try {
        loadConfig({ APNS_DRY_RUN: '1', DEVICE_TOKEN_KEY: short })
      } catch (err) {
        message = (err as Error).message
      }
      expect(message).toMatch(/exactly 32 bytes/)
      expect(message).not.toContain(short)
      expect(() =>
        loadConfig({ APNS_DRY_RUN: '1', DEVICE_TOKEN_KEY: 'not base64 at all!' }),
      ).toThrow(/base64/)
    })

    it('names the providers first when nothing at all is configured', () => {
      expect(() => loadConfig({})).toThrow(/Apple signing key/)
    })
  })
})
