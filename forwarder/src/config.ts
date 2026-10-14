import { DEVICE_TOKEN_KEY_HINT, parseDeviceTokenKey } from './token-box'

/**
 * Runtime configuration for the wake-up forwarder, resolved from env vars.
 *
 * Invariant: `loadConfig` is PURE. It reads an env bag, validates it, and returns a
 * Config or throws. No files are opened, no sockets, no clock — so boot ordering never
 * hides a validation failure and tests can drive it with a plain object. The one place
 * that looks like I/O (`APNS_KEY_PATH`) stores the path; reading it is boot's job.
 *
 * Reference: PROTOCOL.md §10.
 */

/** Apple runs two disjoint environments; a device token is valid in exactly one. */
export type ApnsEnvironment = 'production' | 'sandbox'

/**
 * Which provider rings a registered device. The wire contract between a relay and this
 * service names no platform at all — a relay holds a wake token and nothing else — so
 * this never leaves the forwarder. It exists because Apple and Google are rung
 * differently, not because anyone outside needs to know which phone is which.
 */
export type DevicePlatform = 'ios' | 'android'

export interface RateLimitConfig {
  /** Max requests per window per key. <= 0 disables this limiter entirely. */
  max: number
  /** Window length in ms. */
  windowMs: number
}

export interface ApnsConfig {
  /** PKCS#8 PEM of the .p8 signing key, or the path to read it from at boot. */
  keyPem?: string
  keyPath?: string
  /** The 10-character key id Apple shows next to the .p8. */
  keyId: string
  /** The 10-character Apple team id. */
  teamId: string
  /** The app bundle id; APNs calls it the topic. */
  topic: string
  /** Environment used when a registration does not name one. */
  defaultEnvironment: ApnsEnvironment
  /** Ceiling on one Apple call, in ms. A doorbell nobody answers must not hang. */
  timeoutMs: number
}

/**
 * Google credentials. Unlike Apple's .p8 — which is a bare key and needs the key id and
 * team id supplied beside it — a Google service-account JSON already carries the project
 * id, the client email and the private key, so there is one secret to configure and
 * nothing to keep in sync with it. Parsed by the sender at boot, for the same reason
 * `ApnsConfig` keeps a path: `loadConfig` stays pure.
 */
export interface FcmConfig {
  /** The service-account JSON itself, or the path to read it from at boot. */
  serviceAccountJson?: string
  serviceAccountPath?: string
  /** Ceiling on one Google call, in ms. A doorbell nobody answers must not hang. */
  timeoutMs: number
}

export interface Config {
  host: string
  port: number
  /** SQLite file holding the token → doorbell-address table. `:memory:` is accepted. */
  databasePath: string
  /**
   * The key the store encrypts device tokens under [2026-10-02, SECURITY_REVIEW G15],
   * held outside the database file so a copy of the file rings nobody. Exactly one of the
   * two: the key itself (already checked to be 32 bytes of base64), or a path to read it
   * from at boot, which is boot's job for the same reason as `APNS_KEY_PATH`.
   */
  deviceTokenKey?: string
  deviceTokenKeyPath?: string
  /**
   * Apple credentials, or undefined when this forwarder rings no iPhones: an explicit
   * APNS_DRY_RUN, or a forwarder configured for Google only [0034]. A forwarder whose
   * whole job is ringing must not start able to ring nobody by accident (PROTOCOL.md §10).
   */
  apns?: ApnsConfig
  /** True when APNS_DRY_RUN selected the no-op sender. */
  apnsDryRun: boolean
  /**
   * Google credentials, or undefined when this forwarder serves no Android devices.
   * Undefined is normal here, unlike `apns`: a forwarder can legitimately ring only one
   * of the two platforms, and `/v1/register` refuses the one it cannot reach rather than
   * accepting a registration it would never ring.
   */
  fcm?: FcmConfig
  /** True when FCM_DRY_RUN selected the no-op sender. */
  fcmDryRun: boolean
  /** Trust `X-Forwarded-For` so the per-caller rate limit keys on the real client IP. */
  trustProxy: boolean
  /** Max JSON body in bytes. Bodies here are one short string; the cap is a guard. */
  bodyLimitBytes: number
  /** Wakes allowed per wake token (PROTOCOL.md §6). */
  wakeRateLimit: RateLimitConfig
  /** Wakes allowed per calling relay, keyed by client IP. */
  callerRateLimit: RateLimitConfig
  /** Registrations allowed per client IP. */
  registerRateLimit: RateLimitConfig
  logLevel: string
}

function num(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === '') return fallback
  const n = Number(value)
  if (!Number.isFinite(n)) {
    throw new Error(`${name} must be a number, got: ${value}`)
  }
  return n
}

function positiveNum(value: string | undefined, fallback: number, name: string): number {
  const n = num(value, fallback, name)
  if (n <= 0) throw new Error(`${name} must be greater than zero, got: ${n}`)
  return n
}

function flag(value: string | undefined): boolean {
  return value === '1' || value === 'true'
}

function trimmed(value: string | undefined): string | undefined {
  const v = value?.trim()
  return v === undefined || v === '' ? undefined : v
}

function readEnvironment(value: string | undefined, name: string): ApnsEnvironment {
  const v = trimmed(value) ?? 'production'
  if (v !== 'production' && v !== 'sandbox') {
    throw new Error(`${name} must be "production" or "sandbox", got: ${v}`)
  }
  return v
}

/** True when the operator set any Apple variable at all, complete or not. Partial
 *  credentials must fail loudly rather than fall through to "Apple not configured". */
function mentionsApns(env: NodeJS.ProcessEnv): boolean {
  return [
    env.APNS_KEY_PEM,
    env.APNS_KEY_PATH,
    env.APNS_KEY_ID,
    env.APNS_TEAM_ID,
    env.APNS_TOPIC,
    env.APNS_DEFAULT_ENVIRONMENT,
  ].some((v) => trimmed(v) !== undefined)
}

/**
 * Google credentials. One secret, so there is no partial-credential case to police: it
 * is present or it is not. The sender parses it at boot and throws with the fix if the
 * JSON is not a service account.
 */
function readFcmConfig(env: NodeJS.ProcessEnv): FcmConfig | undefined {
  const serviceAccountJson = trimmed(env.FCM_SERVICE_ACCOUNT_JSON)
  const serviceAccountPath = trimmed(env.FCM_SERVICE_ACCOUNT_PATH)
  if (serviceAccountJson && serviceAccountPath) {
    throw new Error(
      'Set FCM_SERVICE_ACCOUNT_JSON or FCM_SERVICE_ACCOUNT_PATH, not both. Two service accounts cannot both be the credential, and guessing which one you meant would be worse than stopping here.',
    )
  }
  if (!serviceAccountJson && !serviceAccountPath) return undefined
  return {
    ...(serviceAccountJson ? { serviceAccountJson } : {}),
    ...(serviceAccountPath ? { serviceAccountPath } : {}),
    timeoutMs: positiveNum(env.FCM_TIMEOUT_MS, 5_000, 'FCM_TIMEOUT_MS'),
  }
}

/**
 * Apple credentials, validated as a set. Partial credentials are rejected rather than
 * ignored: a forwarder that boots with a key id and no key would answer every wake with
 * a cheerful 202 and ring nothing, which is the one failure mode this service cannot
 * afford to hide.
 */
function readApnsConfig(env: NodeJS.ProcessEnv): ApnsConfig {
  const keyPem = trimmed(env.APNS_KEY_PEM)
  const keyPath = trimmed(env.APNS_KEY_PATH)
  if (keyPem && keyPath) {
    throw new Error(
      'Set APNS_KEY_PEM or APNS_KEY_PATH, not both. Two keys cannot both be the signing key, and guessing which one you meant would be worse than stopping here.',
    )
  }
  if (!keyPem && !keyPath) {
    throw new Error(
      'No Apple signing key, but other APNS_ variables are set. Set APNS_KEY_PATH to your .p8 file, or APNS_KEY_PEM to its contents. For local development without an Apple account, set APNS_DRY_RUN=1 and every wake is accepted and dropped. To run an Android-only forwarder, unset every APNS_ variable and configure FCM_SERVICE_ACCOUNT_PATH instead.',
    )
  }
  const keyId = trimmed(env.APNS_KEY_ID)
  if (!keyId) {
    throw new Error(
      'APNS_KEY_ID is required. Apple shows it beside the .p8 in the developer portal, and it names which key signed each request, so Apple cannot verify a signature without it.',
    )
  }
  const teamId = trimmed(env.APNS_TEAM_ID)
  if (!teamId) {
    throw new Error(
      'APNS_TEAM_ID is required. It is your 10-character Apple team id, and it is the issuer of the token Apple checks, so a request without it is rejected before it reaches any device.',
    )
  }
  return {
    ...(keyPem ? { keyPem } : {}),
    ...(keyPath ? { keyPath } : {}),
    keyId,
    teamId,
    topic: trimmed(env.APNS_TOPIC) ?? 'io.tabsend.app',
    defaultEnvironment: readEnvironment(env.APNS_DEFAULT_ENVIRONMENT, 'APNS_DEFAULT_ENVIRONMENT'),
    timeoutMs: positiveNum(env.APNS_TIMEOUT_MS, 5_000, 'APNS_TIMEOUT_MS'),
  }
}

/**
 * The device-token key, required on every forwarder, dry run included: it decides what a
 * copy of the database is worth, which does not depend on whether this process can ring.
 * The inline form is validated here; a path is only recorded, and read at boot.
 */
function readDeviceTokenKey(
  env: NodeJS.ProcessEnv,
): Pick<Config, 'deviceTokenKey' | 'deviceTokenKeyPath'> {
  const inline = trimmed(env.DEVICE_TOKEN_KEY)
  const path = trimmed(env.DEVICE_TOKEN_KEY_PATH)
  if (inline && path) {
    throw new Error(
      'Set DEVICE_TOKEN_KEY or DEVICE_TOKEN_KEY_PATH, not both. Two keys cannot both be the one the database was written with, and guessing which one you meant would be worse than stopping here.',
    )
  }
  if (path) return { deviceTokenKeyPath: path }
  if (!inline) {
    throw new Error(
      `DEVICE_TOKEN_KEY is required. It encrypts each phone's push address in the database, so that a copy of the database file, or of a backup, cannot be used to cut phones off and ring them. ${DEVICE_TOKEN_KEY_HINT} Set DEVICE_TOKEN_KEY to it, or DEVICE_TOKEN_KEY_PATH to a file holding it.`,
    )
  }
  parseDeviceTokenKey(inline, 'DEVICE_TOKEN_KEY')
  return { deviceTokenKey: inline }
}

/** Build a Config from an env bag (defaults to process.env). Pure — no side effects. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const apnsDryRun = flag(env.APNS_DRY_RUN)
  const fcmDryRun = flag(env.FCM_DRY_RUN)
  const fcm = fcmDryRun ? undefined : readFcmConfig(env)
  // Apple is read when the operator mentioned Apple at all, and also when they mentioned
  // neither provider — in which case readApnsConfig throws, which is the right answer: a
  // forwarder able to ring nobody must not start (PROTOCOL.md §10). Configuring only
  // Google is the one way to legitimately have no Apple credentials.
  const wantsApns = apnsDryRun ? false : mentionsApns(env) || !(fcm || fcmDryRun)
  // Providers first: an operator who configured nothing at all should hear about that
  // before hearing about the key that protects the store.
  const apns = wantsApns ? readApnsConfig(env) : undefined
  const deviceTokenKey = readDeviceTokenKey(env)

  return {
    host: env.HOST ?? '127.0.0.1',
    // Not 8787: the relay owns that one, and both run on a developer's box at once.
    port: num(env.PORT, 8788, 'PORT'),
    databasePath: trimmed(env.DATABASE_PATH) ?? './.data/forwarder.db',
    ...deviceTokenKey,
    ...(apns ? { apns } : {}),
    apnsDryRun,
    ...(fcm ? { fcm } : {}),
    fcmDryRun,
    trustProxy: flag(env.TRUST_PROXY),
    bodyLimitBytes: positiveNum(env.MAX_BODY_BYTES, 4096, 'MAX_BODY_BYTES'),
    // A phone cannot need more than a few rings a minute; see PROTOCOL.md §6.
    wakeRateLimit: {
      max: num(env.WAKE_RATE_LIMIT_MAX, 6, 'WAKE_RATE_LIMIT_MAX'),
      windowMs:
        positiveNum(env.WAKE_RATE_LIMIT_WINDOW_SECONDS, 60, 'WAKE_RATE_LIMIT_WINDOW_SECONDS') *
        1000,
    },
    callerRateLimit: {
      max: num(env.CALLER_RATE_LIMIT_MAX, 120, 'CALLER_RATE_LIMIT_MAX'),
      windowMs:
        positiveNum(env.CALLER_RATE_LIMIT_WINDOW_SECONDS, 60, 'CALLER_RATE_LIMIT_WINDOW_SECONDS') *
        1000,
    },
    registerRateLimit: {
      max: num(env.REGISTER_RATE_LIMIT_MAX, 10, 'REGISTER_RATE_LIMIT_MAX'),
      windowMs:
        positiveNum(
          env.REGISTER_RATE_LIMIT_WINDOW_SECONDS,
          600,
          'REGISTER_RATE_LIMIT_WINDOW_SECONDS',
        ) * 1000,
    },
    logLevel: trimmed(env.LOG_LEVEL) ?? 'info',
  }
}
