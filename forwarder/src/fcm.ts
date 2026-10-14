import { randomInt } from 'node:crypto'
import { readFileSync } from 'node:fs'
import {
  type ClientHttp2Session,
  type ClientHttp2Stream,
  connect,
  constants,
  type SecureClientSessionOptions,
} from 'node:http2'
import type { Config, FcmConfig } from './config'
import {
  FcmTokenSource,
  fetchAccessToken,
  loadServiceAccount,
  type Scheduler,
  type TokenExchange,
  unrefScheduler,
} from './fcm-auth'
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
  close(): Promise<void>
}

/** Google's FCM host. The only one this sender ever connects to outside a test. */
const FCM_ORIGIN = 'https://fcm.googleapis.com'

const SEND_PATH = (projectId: string) =>
  `/v1/projects/${encodeURIComponent(projectId)}/messages:send`

/**
 * How often the connection to Google is checked with a PING [2026-10-02, SECURITY_REVIEW
 * G14 and its verification pass].
 *
 * The connection is opened at start-up and kept open, so no ring pays for a new one after
 * its reply. That cost, about 3 ms of TLS and HTTP/2 set-up, is work only a live Android
 * token causes, and it can be read from outside: `fetch` paid it on most rings, because
 * it dropped an idle connection after four seconds, and closing after four idle minutes
 * still let a prober who spaced its rings further apart than that tell a live token from
 * a dead one in about sixty rings. The PING runs on a fixed schedule that no ring moves.
 * It keeps the connection's path open through the usual cloud NAT idle limits (four
 * minutes on Azure, 350 seconds on AWS, ten on Google Cloud), and finds a connection that
 * died without saying so before a ring does. If Google closes the connection, for any
 * reason, objecting to the PINGs included, another is opened in the background.
 */
export const FCM_KEEPALIVE_MS = 2 * 60 * 1000

/**
 * After the connection closes, the next one is opened in the background after a random
 * pause in this range: never on a ring, and never at a moment set by when the last live
 * ring was (a server that closes idle connections would otherwise time the reconnect off
 * it). A ring that comes during the pause opens one itself.
 */
const RECONNECT_MIN_MS = 1_000
const RECONNECT_MAX_MS = 30_000

/**
 * Unanswered rings in a row after which a connection that still answers PINGs is
 * replaced anyway: something between here and Google that keeps the connection and loses
 * the requests.
 */
const MAX_UNANSWERED = 3

/** Google's error answers are a few hundred bytes. Past this, the rest is not read. */
const MAX_REPLY_BYTES = 64 * 1024

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
  closed = false

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
}

/**
 * The real client: HTTP/2 to Google over one session, opened at start-up, kept open and
 * re-established in the background whenever it closes. It used to be plain `fetch`, which
 * dropped the connection after four seconds idle; see `FCM_KEEPALIVE_MS`.
 */
export class HttpFcmSender implements FcmSender {
  private readonly tokens: FcmTokenSource
  private readonly projectId: string
  private readonly timeoutMs: number
  private readonly origin: string
  private readonly connectOptions: SecureClientSessionOptions | undefined
  private session: ClientHttp2Session | undefined
  /**
   * Settles once the current session's server has sent its settings, or the session has
   * gone. A ring opens its stream only after that [2026-10-02]: on a new connection Node
   * sends streams before the server has said how many it takes, assuming a hundred, and
   * the server refuses whatever is past its real limit (fifty rings at once against a
   * limit of two lost forty-eight). Once the settings have arrived, Node queues streams
   * past the limit itself. `fetch`, which this replaced, took care of both.
   */
  private ready: Promise<void> = Promise.resolve()
  /** Sessions whose server has sent its settings, so they finished setting up. */
  private readonly greeted = new WeakSet<ClientHttp2Session>()
  /** Sessions with a liveness check in flight, so a burst of timeouts sends one PING. */
  private readonly checking = new WeakSet<ClientHttp2Session>()
  /** Unanswered rings in a row, per session. Any answer resets it. */
  private readonly unanswered = new WeakMap<ClientHttp2Session, number>()
  /** When each session was opened, to judge one that never finished setting up. */
  private readonly openedAt = new WeakMap<ClientHttp2Session, number>()
  private running = true
  private readonly keepAliveTimer: NodeJS.Timeout
  private readonly reconnectDelayMs: () => number
  private reconnectTimer: NodeJS.Timeout | undefined

  constructor(config: FcmConfig, options: HttpFcmSenderOptions = {}) {
    const json =
      config.serviceAccountJson ?? readFileSync(config.serviceAccountPath as string, 'utf8')
    const account = loadServiceAccount(json)
    this.projectId = account.projectId
    this.timeoutMs = config.timeoutMs
    this.origin = options.origin ?? FCM_ORIGIN
    this.connectOptions = options.connectOptions
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
    this.reconnectDelayMs =
      options.reconnectDelayMs ?? (() => randomInt(RECONNECT_MIN_MS, RECONNECT_MAX_MS + 1))
    this.keepAliveTimer = setInterval(
      () => this.keepAlive(),
      options.keepAliveMs ?? FCM_KEEPALIVE_MS,
    )
    this.keepAliveTimer.unref()
    this.connection()
  }

  /**
   * Reuse the live session, or open one. A session Google has sent away reads as closed
   * (Node closes it on a GOAWAY), so it is replaced here rather than reused. Normally the
   * background has opened one already and a ring only ever reuses it.
   */
  private connection(): ClientHttp2Session {
    const existing = this.session
    if (existing && !existing.closed && !existing.destroyed) return existing
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
    const session = this.connectOptions
      ? connect(this.origin, this.connectOptions)
      : connect(this.origin)
    this.openedAt.set(session, Date.now())
    this.ready = new Promise<void>((resolve) => {
      session.once('remoteSettings', () => {
        this.greeted.add(session)
        resolve()
      })
      session.once('close', () => resolve())
      session.once('error', () => resolve())
    })
    // A dead session must not poison every later wake: forget it and open the next in
    // the background. An unhandled 'error' on an http2 session would end the process. A
    // GOAWAY counts: the session takes no new streams from then on, though it may stay
    // open until the rings already on it finish.
    const forget = () => {
      if (this.session !== session) return
      this.session = undefined
      this.reconnectLater()
    }
    session.on('error', forget)
    session.on('close', forget)
    session.on('goaway', forget)
    this.session = session
    return session
  }

  /** Open the next connection in the background, after a random pause. */
  private reconnectLater(): void {
    if (!this.running || this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      if (!this.running) return
      try {
        this.connection()
      } catch {
        // Thrown out of a timer, this would end the process. Try again after another pause.
        this.reconnectLater()
      }
    }, this.reconnectDelayMs())
    this.reconnectTimer.unref()
  }

  /**
   * The fixed-schedule check (`FCM_KEEPALIVE_MS`): a connection that finished setting up is
   * sent a PING, and one that has not within a ring's deadline is dropped.
   */
  private keepAlive(): void {
    const session = this.session
    if (!session || session.closed || session.destroyed) return
    if (this.greeted.has(session)) {
      this.check(session)
    } else if (Date.now() - (this.openedAt.get(session) ?? 0) > this.timeoutMs) {
      session.destroy()
    }
  }

  async wake(request: FcmWakeRequest): Promise<WakeOutcome> {
    let accessToken: string
    try {
      accessToken = await this.tokens.current()
    } catch (err) {
      // A credential problem is the forwarder's, not the device's. Never `deviceGone`:
      // dropping rows because our own key is wrong would empty the table on a
      // misconfiguration.
      return { ok: false, deviceGone: false, status: 0, reason: (err as Error).message }
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

    return await new Promise<WakeOutcome>((resolve) => {
      let settled = false
      let stream: ClientHttp2Stream | undefined
      let timer: NodeJS.Timeout | undefined
      const finish = (outcome: WakeOutcome) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(outcome)
      }
      const failed = (reason: string): WakeOutcome => ({
        ok: false,
        deviceGone: false,
        status: 0,
        reason,
      })

      let session: ClientHttp2Session
      try {
        session = this.connection()
      } catch (err) {
        finish(failed((err as Error).message))
        return
      }
      // One deadline for the whole ring, the wait for a new connection's settings included.
      timer = setTimeout(() => {
        stream?.close(constants.NGHTTP2_CANCEL)
        finish(failed('Timeout'))
        this.suspect(session)
      }, this.timeoutMs)
      void this.ready.then(() => {
        // A ring that ran out of time while waiting is not sent afterwards.
        if (settled) return
        let open: ClientHttp2Stream
        try {
          open = session.request({
            [constants.HTTP2_HEADER_METHOD]: 'POST',
            [constants.HTTP2_HEADER_PATH]: SEND_PATH(this.projectId),
            [constants.HTTP2_HEADER_AUTHORIZATION]: `Bearer ${accessToken}`,
            [constants.HTTP2_HEADER_CONTENT_TYPE]: 'application/json',
            [constants.HTTP2_HEADER_CONTENT_LENGTH]: Buffer.byteLength(body),
          })
        } catch (err) {
          finish(failed((err as Error).message))
          return
        }
        stream = open
        let status = 0
        let size = 0
        const chunks: Buffer[] = []
        open.on('response', (headers) => {
          status = Number(headers[constants.HTTP2_HEADER_STATUS] ?? 0)
          this.unanswered.delete(session)
        })
        open.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > MAX_REPLY_BYTES) {
            open.close(constants.NGHTTP2_CANCEL)
            finish(outcomeOf(status, Buffer.concat(chunks)))
            return
          }
          chunks.push(chunk)
        })
        open.on('end', () => finish(outcomeOf(status, Buffer.concat(chunks))))
        open.on('error', (err: Error) => finish(failed(err.message)))
        // A stream reset or a session closed under it ends without 'end' or 'error'.
        open.on('close', () =>
          finish(status === 0 ? failed('Closed') : outcomeOf(status, Buffer.concat(chunks))),
        )
        open.end(body)
      })
    })
  }

  /**
   * A ring went unanswered for its whole deadline, so the connection may be dead without
   * having said so [2026-10-02 verification pass]. A connection that is kept open is
   * closed by nothing a ring does: one that stalled while being set up, or went silent
   * afterwards (a dropped route, a NAT that forgot it), would fail every ring after it.
   * `fetch` reconnected after four idle seconds, which hid this. The scheduled PING
   * (`FCM_KEEPALIVE_MS`) usually finds such a connection first; this is for the ring
   * that finds it before the PING does.
   *
   * Not set up within a whole deadline: dropped now. Set up: asked with a PING, and
   * dropped unless Google answers within the same deadline, or after `MAX_UNANSWERED`
   * rings in a row went unanswered even so. Either way a fresh connection replaces it.
   */
  private suspect(session: ClientHttp2Session): void {
    if (session.closed || session.destroyed) return
    if (!this.greeted.has(session)) {
      session.destroy()
      return
    }
    const unanswered = (this.unanswered.get(session) ?? 0) + 1
    this.unanswered.set(session, unanswered)
    if (unanswered >= MAX_UNANSWERED) {
      session.destroy()
      return
    }
    this.check(session)
  }

  /** PING, and drop the connection unless Google answers within a ring's deadline. */
  private check(session: ClientHttp2Session): void {
    if (this.checking.has(session)) return
    this.checking.add(session)
    const deadline = setTimeout(() => session.destroy(), this.timeoutMs)
    deadline.unref()
    try {
      session.ping((err) => {
        clearTimeout(deadline)
        this.checking.delete(session)
        if (err) session.destroy()
      })
    } catch {
      clearTimeout(deadline)
      this.checking.delete(session)
      session.destroy()
    }
  }

  /** Stop refreshing, checking and reconnecting, and close the session. */
  async close(): Promise<void> {
    this.running = false
    clearInterval(this.keepAliveTimer)
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
    this.tokens.stop()
    this.session?.close()
    this.session = undefined
  }
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
