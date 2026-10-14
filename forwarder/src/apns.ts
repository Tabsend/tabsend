import { readFileSync } from 'node:fs'
import { type ClientHttp2Session, connect, constants } from 'node:http2'
import { ApnsTokenSource, loadApnsPrivateKey } from './apns-jwt'
import type { ApnsConfig, ApnsEnvironment, Config } from './config'
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

/**
 * The real client. HTTP/2 via `node:http2` because APNs speaks nothing else, and one
 * long-lived session per environment because Apple expects a connection to be reused
 * rather than re-established per push.
 */
export class Http2ApnsSender implements ApnsSender {
  private readonly sessions = new Map<ApnsEnvironment, ClientHttp2Session>()
  private readonly tokens: ApnsTokenSource

  constructor(private readonly config: ApnsConfig) {
    const pem = config.keyPem ?? readFileSync(config.keyPath as string, 'utf8')
    this.tokens = new ApnsTokenSource(loadApnsPrivateKey(pem), config.keyId, config.teamId)
  }

  /** Reuse the live session for this environment, or open one. */
  private session(environment: ApnsEnvironment): ClientHttp2Session {
    const existing = this.sessions.get(environment)
    if (existing && !existing.closed && !existing.destroyed) return existing
    const session = connect(APNS_HOSTS[environment])
    // A dead session must not poison every later wake: forget it and reconnect next
    // time. An unhandled 'error' on an http2 session would otherwise take the process
    // down, and this service exists to be reachable.
    session.on('error', () => this.sessions.delete(environment))
    session.on('close', () => this.sessions.delete(environment))
    this.sessions.set(environment, session)
    return session
  }

  async wake(request: ApnsWakeRequest): Promise<ApnsResult> {
    const session = this.session(request.environment)
    const expiration = Math.floor(Date.now() / 1000) + WAKE_EXPIRATION_SECONDS
    const stream = session.request({
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
    })
    stream.setTimeout(this.config.timeoutMs, () => stream.close(constants.NGHTTP2_CANCEL))

    return await new Promise<ApnsResult>((resolve) => {
      let status = 0
      let body = ''
      stream.on('response', (headers) => {
        status = Number(headers[constants.HTTP2_HEADER_STATUS] ?? 0)
      })
      stream.setEncoding('utf8')
      stream.on('data', (chunk: string) => {
        body += chunk
      })
      stream.on('end', () => {
        if (status === 200) {
          resolve({ ok: true })
          return
        }
        // APNs error bodies are `{"reason":"..."}`. A malformed one is still an error.
        let reason = 'Unknown'
        try {
          const parsed: unknown = JSON.parse(body)
          if (parsed && typeof parsed === 'object' && 'reason' in parsed) {
            reason = String((parsed as { reason: unknown }).reason)
          }
        } catch {
          // Leave the placeholder; the status alone is enough to act on.
        }
        resolve({ ok: false, deviceGone: isDeviceGone(status), status, reason })
      })
      stream.on('timeout', () => {
        resolve({ ok: false, deviceGone: false, status: 0, reason: 'Timeout' })
      })
      stream.on('error', (err: Error) => {
        resolve({ ok: false, deviceGone: false, status: 0, reason: err.message })
      })
      stream.end(WAKE_PAYLOAD)
    })
  }

  async close(): Promise<void> {
    for (const session of this.sessions.values()) session.close()
    this.sessions.clear()
  }
}

/** Pick a sender from config: the real one when Apple credentials are present. */
export function createApnsSender(config: Config): ApnsSender {
  return config.apns ? new Http2ApnsSender(config.apns) : new NoopApnsSender()
}
