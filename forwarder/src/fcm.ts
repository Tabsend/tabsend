import { readFileSync } from 'node:fs'
import { constants, type SecureClientSessionOptions } from 'node:http2'
import type { Config, FcmConfig } from './config'
import {
  FcmTokenSource,
  fetchAccessToken,
  loadServiceAccount,
  type Scheduler,
  type TokenExchange,
  unrefScheduler,
} from './fcm-auth'
import { KEEPALIVE_MS, KeptSession } from './h2-session'
import type { WakeOutcome } from './outcome'

/**
 * The Google side, behind the same one-method interface as the Apple side so tests inject
 * a fake and never reach the network.
 *
 * Invariant, identical to APNs and for the same reason: the wake is a CONTENT-FREE data
 * message. The payload is one fixed marker, there is no `notification` block — which is
 * what keeps Android from drawing anything on screen — and no code path adds a field to
 * it. The phone wakes and fetches from its own relay; nothing about what is waiting passes
 * through this file (PROTOCOL.md §1, §3.2).
 */

export interface FcmWakeRequest {
  /** Google's registration token. Goes in the JSON body, never a URL, and is never
   *  logged (PROTOCOL.md §6). */
  fcmToken: string
}

export interface FcmSender {
  wake(request: FcmWakeRequest): Promise<WakeOutcome>
  /**
   * Whether an Android phone should be let sign up now [2026-10-20, SECURITY_REVIEW G13].
   * False while this forwarder cannot get an access token from Google: a phone that signed
   * up then would close its own connection and never be rung.
   */
  acceptsRegistrations(): boolean
  close(): Promise<void>
}

/** Google's FCM host. The only one this sender ever connects to outside a test. */
const FCM_ORIGIN = 'https://fcm.googleapis.com'

const SEND_PATH = (projectId: string) =>
  `/v1/projects/${encodeURIComponent(projectId)}/messages:send`

/**
 * The connection to Google is opened at start-up and kept, checked on a schedule and
 * replaced in the background (`h2-session.ts`, SECURITY_REVIEW G14). Kept as its own name
 * because PROTOCOL.md §9.2 cites it.
 */
export const FCM_KEEPALIVE_MS = KEEPALIVE_MS

/**
 * How long sends pause after a 429 or 503 that names no `Retry-After` [2026-10-20,
 * SECURITY_REVIEW G17]. Google asks a rate-limited sender (429) to wait at least a minute,
 * and an unavailable one (503) to back off; ten seconds is the start of its suggested
 * back-off.
 */
const DEFAULT_PAUSE_MS: Record<number, number> = { 429: 60 * 1000, 503: 10 * 1000 }

/** Nor longer than this, whatever `Retry-After` says. Delivery degrades to drain-on-open
 *  meanwhile, which is the no-forwarder behaviour (PROTOCOL.md §7), not an outage. */
const MAX_PAUSE_MS = 60 * 60 * 1000

/**
 * A doorbell that stops ringing after five minutes, matching APNs. Past that the phone
 * finds the message when it opens, which is the honest fallback anyway.
 */
const WAKE_TTL = '300s'

/** Google coalesces undelivered rings sharing this key, as Apple does with collapse-id. */
const WAKE_COLLAPSE_KEY = 'wake'

/**
 * The entire payload. A data-only message with no `notification` block is what makes this
 * silent: Android hands it to the app's messaging service and draws nothing itself. The
 * one field exists because a message must carry something, and it says only "wake up".
 */
const WAKE_DATA = { wake: '1' } as const

/**
 * True only for the Google answer that PROVES a registration token is dead: `404` with
 * `UNREGISTERED`, which Google returns when the app has been uninstalled or the token has
 * been rotated out.
 *
 * `400 INVALID_ARGUMENT` is deliberately NOT here, for the same asymmetry that keeps
 * `BadDeviceToken` out of the Apple equivalent: Google gives it both for a malformed token
 * and for a live token presented with credentials from a DIFFERENT Firebase project, and
 * the answer does not say which. An operator who points the forwarder at the wrong project
 * would otherwise watch it unregister every working phone on its first ring.
 */
export function isDeviceGone(status: number, errorCode: string): boolean {
  return status === 404 && errorCode === 'UNREGISTERED'
}

/** Google's "I will not accept this token here". Not evidence the device is gone; the
 *  caller logs it with the fix rather than acting on it. */
export function isWrongProject(outcome: WakeOutcome): boolean {
  return !outcome.ok && outcome.status === 400 && outcome.reason === 'INVALID_ARGUMENT'
}

/** Dry-run sender: accepts every wake and rings nobody. Local development only. */
export class NoopFcmSender implements FcmSender {
  async wake(): Promise<WakeOutcome> {
    return { ok: true }
  }
  acceptsRegistrations(): boolean {
    return true
  }
  async close(): Promise<void> {}
}

/** Records wake calls for assertions. Never touches the network. */
export class FakeFcmSender implements FcmSender {
  readonly calls: FcmWakeRequest[] = []
  /** When set, the NEXT wake returns this outcome instead of success. */
  failNext: WakeOutcome | null = null
  /** When set, every wake blocks on this promise after being RECORDED, which is what
   *  lets a test prove the route replied without waiting for Google. */
  gate: Promise<void> | null = null
  /** When set, sign-ups are refused, as when Google refuses the forwarder's credential. */
  refusingRegistrations = false
  closed = false

  acceptsRegistrations(): boolean {
    return !this.refusingRegistrations
  }

  async wake(request: FcmWakeRequest): Promise<WakeOutcome> {
    this.calls.push(request)
    if (this.gate) await this.gate
    if (this.failNext) {
      const outcome = this.failNext
      this.failNext = null
      return outcome
    }
    return { ok: true }
  }

  async close(): Promise<void> {
    this.closed = true
  }
}

export interface HttpFcmSenderOptions {
  /** Test seam for the token exchange. Production posts to Google's token endpoint. */
  exchange?: TokenExchange
  /** Test seam for the refresh timer. */
  schedule?: Scheduler
  /** Told when a background token refresh fails; the operator's log, in production. */
  onTokenRefreshError?: (err: Error) => void
  /**
   * Test seam: a local fake of Google, with the TLS options it needs. Production always
   * connects to `fcm.googleapis.com` with default verification; there is no setting
   * that changes either.
   */
  origin?: string
  connectOptions?: SecureClientSessionOptions
  /** Test seam: how often the connection is checked. Production: `FCM_KEEPALIVE_MS`. */
  keepAliveMs?: number
  /** Test seam: the pause before a background reconnect. Production picks at random. */
  reconnectDelayMs?: () => number
  /** Test seam: the clock that times a pause Google asked for. */
  now?: () => number
}

/**
 * The real client: HTTP/2 to Google over one kept session (`h2-session.ts`). It used to be
 * plain `fetch`, which dropped the connection after four seconds idle; see
 * `FCM_KEEPALIVE_MS`.
 */
export class HttpFcmSender implements FcmSender {
  private readonly tokens: FcmTokenSource
  private readonly projectId: string
  private readonly connection: KeptSession
  private readonly maxInFlight: number
  private readonly now: () => number
  /** Rings between their start and their outcome, the wait for a token included. */
  private inFlight = 0
  /** Until when Google asked for no sends (`Retry-After`). */
  private pausedUntil = 0

  constructor(config: FcmConfig, options: HttpFcmSenderOptions = {}) {
    const json =
      config.serviceAccountJson ?? readFileSync(config.serviceAccountPath as string, 'utf8')
    const account = loadServiceAccount(json)
    this.projectId = account.projectId
    this.maxInFlight = config.maxInFlight
    this.now = options.now ?? (() => Date.now())
    this.tokens = new FcmTokenSource(
      account,
      config.timeoutMs,
      options.exchange ?? fetchAccessToken,
      () => Date.now(),
      options.schedule ?? unrefScheduler,
      options.onTokenRefreshError,
    )
    // The first exchange happens now, at boot, rather than on the first ring.
    this.tokens.start()
    // And the connection is opened now and kept (`FCM_KEEPALIVE_MS`).
    this.connection = new KeptSession({
      origin: options.origin ?? FCM_ORIGIN,
      ...(options.connectOptions ? { connectOptions: options.connectOptions } : {}),
      timeoutMs: config.timeoutMs,
      ...(options.keepAliveMs ? { keepAliveMs: options.keepAliveMs } : {}),
      ...(options.reconnectDelayMs ? { reconnectDelayMs: options.reconnectDelayMs } : {}),
    })
  }

  acceptsRegistrations(): boolean {
    return this.tokens.healthy
  }

  async wake(request: FcmWakeRequest): Promise<WakeOutcome> {
    // [2026-10-20, SECURITY_REVIEW G17] Google asked for a pause: no send until it is over.
    // The ring is dropped, as any ring Google refused is; the phone collects when it next
    // checks in or opens.
    if (this.now() < this.pausedUntil) {
      return failed(
        `Paused: Google asked for no sends for another ${Math.ceil((this.pausedUntil - this.now()) / 1000)} s`,
      )
    }
    // [G17] A ceiling on rings in flight. With Google stalled, rings used to pile up without
    // limit: 600 of them added 145 MB on a machine with 1 GB. Past the ceiling a ring is
    // dropped at once rather than queued.
    if (this.inFlight >= this.maxInFlight) {
      return failed(`Busy: ${this.maxInFlight} rings already waiting on Google`)
    }
    this.inFlight += 1
    try {
      return await this.send(request)
    } finally {
      this.inFlight -= 1
    }
  }

  private async send(request: FcmWakeRequest): Promise<WakeOutcome> {
    let accessToken: string
    try {
      accessToken = await this.tokens.current()
    } catch (err) {
      // A credential problem is the forwarder's, not the device's. Never `deviceGone`:
      // dropping rows because our own key is wrong would empty the table on a
      // misconfiguration.
      return failed((err as Error).message)
    }

    const body = JSON.stringify({
      message: {
        token: request.fcmToken,
        data: WAKE_DATA,
        android: {
          // high priority is what reaches a dozing phone at all; a normal-priority data
          // message may be held until the device next wakes for its own reasons, which is
          // precisely the delay this path exists to remove.
          priority: 'high',
          ttl: WAKE_TTL,
          collapse_key: WAKE_COLLAPSE_KEY,
        },
      },
    })

    const reply = await this.connection.request(
      {
        [constants.HTTP2_HEADER_METHOD]: 'POST',
        [constants.HTTP2_HEADER_PATH]: SEND_PATH(this.projectId),
        [constants.HTTP2_HEADER_AUTHORIZATION]: `Bearer ${accessToken}`,
        [constants.HTTP2_HEADER_CONTENT_TYPE]: 'application/json',
        [constants.HTTP2_HEADER_CONTENT_LENGTH]: Buffer.byteLength(body),
      },
      body,
    )
    if (!reply.answered) return failed(reply.reason)
    // [G17] Google no longer takes this access token: drop it rather than use it for the
    // rest of its hour.
    if (reply.status === 401) this.tokens.invalidate(accessToken)
    if (reply.status === 429 || reply.status === 503) {
      const pause =
        retryAfterMs(reply.headers['retry-after'], this.now()) ??
        (DEFAULT_PAUSE_MS[reply.status] as number)
      this.pausedUntil = Math.max(this.pausedUntil, this.now() + Math.min(pause, MAX_PAUSE_MS))
    }
    return outcomeOf(reply.status, reply.body)
  }

  /** Stop refreshing, checking and reconnecting, and close the session. */
  async close(): Promise<void> {
    this.tokens.stop()
    this.connection.close()
  }
}

function failed(reason: string): WakeOutcome {
  return { ok: false, deviceGone: false, status: 0, reason }
}

/**
 * Read a `Retry-After` header, in seconds or as an HTTP date, as ms from `now`. Undefined
 * for a missing or unreadable one.
 */
export function retryAfterMs(
  header: string | string[] | undefined,
  now: number,
): number | undefined {
  const raw = Array.isArray(header) ? header[0] : header
  if (raw === undefined || raw.trim() === '') return undefined
  if (/^\d+$/.test(raw.trim())) return Number(raw.trim()) * 1000
  const at = Date.parse(raw)
  return Number.isNaN(at) ? undefined : Math.max(at - now, 0)
}

/** Read Google's answer. Only 200 is success; the error body decides `deviceGone`. */
function outcomeOf(status: number, body: Buffer): WakeOutcome {
  if (status === 200) return { ok: true }
  let raw: unknown = {}
  try {
    raw = JSON.parse(body.toString('utf8'))
  } catch {
    // Leave it empty; the status alone is still reported.
  }
  const errorCode = readErrorCode(raw)
  return { ok: false, deviceGone: isDeviceGone(status, errorCode), status, reason: errorCode }
}

/**
 * Google reports the actionable code twice: once as `error.status` and once, more
 * specifically, inside `error.details[]` as an `errorCode`. The detail is the one that
 * distinguishes an uninstalled app (`UNREGISTERED`) from a generic `NOT_FOUND`, so it wins
 * where present.
 */
function readErrorCode(raw: unknown): string {
  const error = ((raw ?? {}) as { error?: unknown }).error
  if (!error || typeof error !== 'object') return 'Unknown'
  const bag = error as { status?: unknown; details?: unknown }
  if (Array.isArray(bag.details)) {
    for (const detail of bag.details) {
      const code = (detail as { errorCode?: unknown })?.errorCode
      if (typeof code === 'string' && code !== '') return code
    }
  }
  return typeof bag.status === 'string' && bag.status !== '' ? bag.status : 'Unknown'
}

/** Pick a sender from config: the real one when Google credentials are present, the no-op
 *  under FCM_DRY_RUN, and nothing at all when this forwarder serves no Android devices. */
export function createFcmSender(
  config: Config,
  options: HttpFcmSenderOptions = {},
): FcmSender | undefined {
  if (config.fcm) return new HttpFcmSender(config.fcm, options)
  return config.fcmDryRun ? new NoopFcmSender() : undefined
}
