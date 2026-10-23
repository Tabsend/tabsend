import { readFileSync } from 'node:fs'
import { constants, type SecureClientSessionOptions } from 'node:http2'
import { ApnsTokenSource, loadApnsPrivateKey } from './apns-jwt'
import type { ApnsConfig, ApnsEnvironment, Config } from './config'
import { KeptSession } from './h2-session'
import type { WakeOutcome } from './outcome'

/**
 * The Apple side, behind a one-method interface so tests inject a fake and never reach
 * the network — the same shape `server/src/push.ts` uses for Web Push.
 *
 * Invariant: the wake is a CONTENT-FREE background push. The payload is
 * `{"aps":{"content-available":1}}` and there is no code path that adds a field to it.
 * The phone wakes and fetches from its own relay; nothing about what is waiting passes
 * through this file (PROTOCOL.md §1, §3.2).
 */

export interface ApnsWakeRequest {
  /** Apple's device token. Goes in Apple's URL path, which is Apple's protocol, not
   *  ours — and is never logged (PROTOCOL.md §6). */
  apnsToken: string
  environment: ApnsEnvironment
}

/**
 * Apple is authoritative about which of its device tokens still exist. `deviceGone` means
 * this doorbell address rings nothing any more, and the caller drops the row. It is set
 * only for answers that prove that much; see `isDeviceGone` for what does not count and
 * why. The shape is shared with the Google sender so `ring` need not know which provider
 * answered.
 */
export type ApnsResult = WakeOutcome

export interface ApnsSender {
  wake(request: ApnsWakeRequest): Promise<ApnsResult>
  close(): Promise<void>
}

const APNS_HOSTS: Record<ApnsEnvironment, string> = {
  production: 'https://api.push.apple.com',
  sandbox: 'https://api.sandbox.push.apple.com',
}

/** The whole payload. Deliberately the only string in this file that reaches a device. */
const WAKE_PAYLOAD = JSON.stringify({ aps: { 'content-available': 1 } })

/**
 * A doorbell that stops ringing after five minutes. Beyond that the phone finds the
 * message when it opens, which is the honest fallback anyway (PROTOCOL.md §3.2).
 */
const WAKE_EXPIRATION_SECONDS = 300

/**
 * Apple collapses rings that share this id, so a replayed or duplicated wake becomes one
 * ring at Apple's end as well as at ours.
 */
const WAKE_COLLAPSE_ID = 'wake'

/**
 * True only for the APNs answer that PROVES a device token is dead: `410 Unregistered`.
 * Apple returns that when the app has been deleted from the device, and it means nothing
 * else.
 *
 * `400 BadDeviceToken` is deliberately NOT here, though it reads like it belongs. Apple
 * sends it both for a token that is genuinely wrong AND for a perfectly live token
 * presented to the other environment, and the response does not say which. A Release
 * build signed locally gets a sandbox token; point it at a forwarder configured for
 * production and every wake looks like a dead device. Deleting on that answer would
 * unregister a working phone, silently, on its first ring. The asymmetry decides it: a
 * row kept in error is one stale doorbell address, while a row deleted in error costs the
 * user every wake until they re-pair and gives them no way to notice.
 */
export function isDeviceGone(status: number): boolean {
  return status === 410
}

/** Apple's "I will not accept this token here". Not evidence the device is gone; see
 *  `isDeviceGone`. The caller logs it with the fix rather than acting on it. */
export function isBadDeviceToken(result: ApnsResult): boolean {
  return !result.ok && result.status === 400 && result.reason === 'BadDeviceToken'
}

/** Dry-run sender: accepts every wake and rings nobody. Local development only. */
export class NoopApnsSender implements ApnsSender {
  async wake(): Promise<ApnsResult> {
    return { ok: true }
  }
  async close(): Promise<void> {}
}

/** Records wake calls for assertions. Never touches the network. */
export class FakeApnsSender implements ApnsSender {
  readonly calls: ApnsWakeRequest[] = []
  /** When set, the NEXT wake returns this result instead of success. */
  failNext: ApnsResult | null = null
  /**
   * When set, every wake blocks on this promise before answering. The call is still
   * RECORDED immediately, which is what lets a test prove the route replied while Apple
   * was still thinking: hold the gate shut, and any 202 that arrives cannot have waited.
   */
  gate: Promise<void> | null = null
  closed = false

  async wake(request: ApnsWakeRequest): Promise<ApnsResult> {
    this.calls.push(request)
    if (this.gate) await this.gate
    if (this.failNext) {
      const result = this.failNext
      this.failNext = null
      return result
    }
    return { ok: true }
  }

  async close(): Promise<void> {
    this.closed = true
  }
}

export interface Http2ApnsSenderOptions {
  /**
   * Test seam: a local fake of Apple for both environments, with the TLS options it needs.
   * Production always connects to Apple's two fixed hosts with default verification; there
   * is no setting that changes either.
   */
  origin?: string
  connectOptions?: SecureClientSessionOptions
  /** Test seam: how often a connection is checked. Production: `KEEPALIVE_MS`. */
  keepAliveMs?: number
  /** Test seam: the pause before a background reconnect. Production picks at random. */
  reconnectDelayMs?: () => number
  /**
   * Given, the sender checks its Apple credential once at start-up and reports the one log
   * line it comes to (`checkCredential`). Production passes the operator's log.
   */
  onCredentialCheck?: (check: ApnsCredentialCheck) => void
}

/** What the start-up credential check came to, and the line that says so. */
export interface ApnsCredentialCheck {
  outcome: 'ok' | 'refused' | 'inconclusive'
  /** The whole log line. Begins `apns credential check: `, and carries no token. */
  line: string
}

/**
 * The device token the credential check rings: 64 zeros, the shape of a token and nobody's.
 * Apple can only answer that it is not a device; what matters is what it says first.
 */
export const CREDENTIAL_CHECK_DEVICE_TOKEN = '0'.repeat(64)

/**
 * What each Apple refusal of the credential means, and the fix. Reasons from Apple's
 * "Handling notification responses from APNs".
 */
const CREDENTIAL_FIXES: Record<string, string> = {
  InvalidProviderToken:
    'Apple does not accept the signed token. Check that APNS_KEY_ID is the key id shown beside this .p8, that APNS_TEAM_ID is the team that made the key, and that the key has not been revoked.',
  ExpiredProviderToken:
    "Apple says the signed token is too old. The usual cause is this machine's clock: check that it is set by NTP.",
  MissingProviderToken: 'No signed token reached Apple. This is a bug in the forwarder.',
  Forbidden:
    'Apple refused the key for this request. Check that the key has the Apple Push Notifications service enabled and has not been revoked.',
  TopicDisallowed:
    'Apple will not send to APNS_TOPIC with this key. Check that APNS_TOPIC is the bundle id of an app on the team in APNS_TEAM_ID.',
  BadTopic: 'APNS_TOPIC is not a valid bundle id. Set it to the app bundle id.',
}

/**
 * The real client. HTTP/2 via `node:http2` because APNs speaks nothing else, and one kept
 * connection per environment (`h2-session.ts`) because Apple expects a connection to be
 * reused rather than re-established per push.
 *
 * [2026-10-20, SECURITY_REVIEW G25] The connection used to be opened on a ring and its
 * streams sent at once. On a new connection that lost every ring past the few Apple takes
 * before its settings arrive (fifty at once against a limit of two delivered two), and the
 * ring that opened it paid for the connection after its reply, work a dead token never
 * caused (§4). Now both environments' connections are opened at start-up and kept, and
 * rings wait for a new connection's settings, as the Google sender's do.
 */
export class Http2ApnsSender implements ApnsSender {
  private readonly sessions = new Map<ApnsEnvironment, KeptSession>()
  private readonly tokens: ApnsTokenSource
  /** Rings between their start and their outcome. */
  private inFlight = 0

  constructor(
    private readonly config: ApnsConfig,
    private readonly options: Http2ApnsSenderOptions = {},
  ) {
    const pem = config.keyPem ?? readFileSync(config.keyPath as string, 'utf8')
    this.tokens = new ApnsTokenSource(loadApnsPrivateKey(pem), config.keyId, config.teamId)
    // Both environments at start-up [2026-10-20 review of G25], so no ring ever opens one
    // after its reply, the first ring for a development build's sandbox token included.
    // The cost is one idle connection to Apple's sandbox, checked every two minutes.
    this.connection(config.defaultEnvironment)
    this.connection(config.defaultEnvironment === 'production' ? 'sandbox' : 'production')
    const report = options.onCredentialCheck
    if (report) void this.checkCredential().then(report)
  }

  /**
   * Ring an invented device token once, to learn whether Apple takes this forwarder's
   * credential [2026-10-20, the Apple counterpart of SECURITY_REVIEW G13]. Before this, a
   * wrong key id, team id or a revoked key showed only as a warning on each real ring.
   *
   * What it can and cannot prove: Apple refuses a credential it does not accept with
   * `403` and a reason naming it (`InvalidProviderToken`, `ExpiredProviderToken`, …), and a
   * device token that is not one with `400 BadDeviceToken`. Apple does not document the
   * order it checks a request in. In practice the credential is checked first, so
   * `BadDeviceToken` for an invented token is read as "the credential was accepted"; that
   * is observed, not promised, and a real ring is still the proof. Anything else (no
   * answer, a 5xx, a reason not listed) is reported as inconclusive rather than guessed at.
   * Once, at start-up: the answer does not change while the key does not, and a key
   * revoked later shows on the real rings.
   */
  async checkCredential(): Promise<ApnsCredentialCheck> {
    const result = await this.send({
      apnsToken: CREDENTIAL_CHECK_DEVICE_TOKEN,
      environment: this.config.defaultEnvironment,
    })
    const prefix = 'apns credential check: '
    if (!result.ok && result.status === 400 && result.reason === 'BadDeviceToken') {
      return { outcome: 'ok', line: `${prefix}ok` }
    }
    if (!result.ok && (result.status === 403 || CREDENTIAL_FIXES[result.reason] !== undefined)) {
      const fix =
        CREDENTIAL_FIXES[result.reason] ??
        'Check APNS_KEY_ID, APNS_TEAM_ID and the .p8, and that the key has not been revoked.'
      return { outcome: 'refused', line: `${prefix}refused (${result.reason}). ${fix}` }
    }
    const what = result.ok
      ? 'Apple accepted a ring for an invented device'
      : `${result.status} ${result.reason}`
    return {
      outcome: 'inconclusive',
      line: `${prefix}inconclusive (${what}). Real rings will show whether Apple takes the credential.`,
    }
  }

  /** The kept connection for this environment, opened the first time it is needed. */
  private connection(environment: ApnsEnvironment): KeptSession {
    const existing = this.sessions.get(environment)
    if (existing) return existing
    const kept = new KeptSession({
      origin: this.options.origin ?? APNS_HOSTS[environment],
      ...(this.options.connectOptions ? { connectOptions: this.options.connectOptions } : {}),
      timeoutMs: this.config.timeoutMs,
      ...(this.options.keepAliveMs ? { keepAliveMs: this.options.keepAliveMs } : {}),
      ...(this.options.reconnectDelayMs ? { reconnectDelayMs: this.options.reconnectDelayMs } : {}),
    })
    this.sessions.set(environment, kept)
    return kept
  }

  async wake(request: ApnsWakeRequest): Promise<ApnsResult> {
    // [2026-10-20 review of G25] A ceiling on rings in flight, as the Google sender has
    // (SECURITY_REVIEW G17): with Apple stalled, rings would otherwise pile up without
    // limit on a 1 GB machine. Past it a ring is dropped at once, and the phone collects
    // when it next opens.
    if (this.inFlight >= this.config.maxInFlight) {
      return {
        ok: false,
        deviceGone: false,
        status: 0,
        reason: `Busy: ${this.config.maxInFlight} rings already waiting on Apple`,
      }
    }
    this.inFlight += 1
    try {
      return await this.send(request)
    } finally {
      this.inFlight -= 1
    }
  }

  private async send(request: ApnsWakeRequest): Promise<ApnsResult> {
    const expiration = Math.floor(Date.now() / 1000) + WAKE_EXPIRATION_SECONDS
    const reply = await this.connection(request.environment).request(
      {
        [constants.HTTP2_HEADER_METHOD]: 'POST',
        [constants.HTTP2_HEADER_PATH]: `/3/device/${request.apnsToken}`,
        [constants.HTTP2_HEADER_AUTHORIZATION]: `bearer ${this.tokens.current()}`,
        'apns-topic': this.config.topic,
        // Background push, priority 5, content-available: the three fields that make this
        // a silent wake rather than a notification (PROTOCOL.md §3.2).
        'apns-push-type': 'background',
        'apns-priority': '5',
        'apns-expiration': String(expiration),
        'apns-collapse-id': WAKE_COLLAPSE_ID,
        [constants.HTTP2_HEADER_CONTENT_TYPE]: 'application/json',
        [constants.HTTP2_HEADER_CONTENT_LENGTH]: Buffer.byteLength(WAKE_PAYLOAD),
      },
      WAKE_PAYLOAD,
    )
    if (!reply.answered) {
      return { ok: false, deviceGone: false, status: 0, reason: reply.reason }
    }
    if (reply.status === 200) return { ok: true }
    // APNs error bodies are `{"reason":"..."}`. A malformed one is still an error.
    let reason = 'Unknown'
    try {
      const parsed: unknown = JSON.parse(reply.body.toString('utf8'))
      if (parsed && typeof parsed === 'object' && 'reason' in parsed) {
        reason = String((parsed as { reason: unknown }).reason)
      }
    } catch {
      // Leave the placeholder; the status alone is enough to act on.
    }
    return { ok: false, deviceGone: isDeviceGone(reply.status), status: reply.status, reason }
  }

  async close(): Promise<void> {
    for (const kept of this.sessions.values()) kept.close()
    this.sessions.clear()
  }
}

/** Pick a sender from config: the real one when Apple credentials are present. */
export function createApnsSender(config: Config, options: Http2ApnsSenderOptions = {}): ApnsSender {
  return config.apns ? new Http2ApnsSender(config.apns, options) : new NoopApnsSender()
}
