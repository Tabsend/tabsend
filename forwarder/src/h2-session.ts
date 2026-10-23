import { randomInt } from 'node:crypto'
import {
  type ClientHttp2Session,
  type ClientHttp2Stream,
  connect,
  constants,
  type IncomingHttpHeaders,
  type OutgoingHttpHeaders,
  type SecureClientSessionOptions,
} from 'node:http2'

/**
 * One HTTP/2 connection to a push provider, opened at start-up, kept open, and replaced in
 * the background whenever it closes. Both senders ring through one of these: Google's
 * since 2026-10-02 (SECURITY_REVIEW G14), Apple's since 2026-10-20 (G25), which until then
 * opened its connection on a ring and sent streams before Apple had said how many it takes.
 *
 * What this does, and why each part is here, is the G14 story:
 *
 * - **Open at start-up, never closed for being idle.** A connection opened on a ring is
 *   about 3 ms of TLS and HTTP/2 work that only a live token causes, after its reply, and
 *   it can be read from outside (PROTOCOL.md §4).
 * - **A PING on a fixed schedule** (`KEEPALIVE_MS`) that no ring moves. It keeps the path
 *   open through the usual cloud NAT idle limits, and finds a connection that died without
 *   saying so before a ring does.
 * - **A background reconnect after a random pause** when the connection closes, never on a
 *   ring, and never at a moment set by when the last live ring was.
 * - **Rings wait for the server's settings** on a new connection. Before they arrive Node
 *   assumes a server takes a hundred streams at once and sends that many, and the server
 *   refuses whatever is past its real limit: fifty rings at once against a limit of two
 *   lost forty-eight. Once the settings have arrived, Node queues streams past the limit
 *   itself.
 * - **A ring that goes unanswered makes the connection suspect**: dropped at once if it
 *   never finished setting up, otherwise sent a PING and dropped unless the server answers,
 *   or after `MAX_UNANSWERED` unanswered rings in a row regardless.
 */

/** How often the connection is checked with a PING. */
export const KEEPALIVE_MS = 2 * 60 * 1000

/**
 * After the connection closes, the next one is opened in the background after a random
 * pause in this range. A ring that comes during the pause opens one itself.
 */
const RECONNECT_MIN_MS = 1_000
const RECONNECT_MAX_MS = 30_000

/**
 * Unanswered rings in a row after which a connection that still answers PINGs is
 * replaced anyway: something between here and the provider that keeps the connection and
 * loses the requests.
 */
const MAX_UNANSWERED = 3

/** Provider error answers are a few hundred bytes. Past this, the rest is not read. */
export const MAX_REPLY_BYTES = 64 * 1024

export interface KeptSessionOptions {
  origin: string
  /** Test seam: the TLS options a local fake needs. Production uses default verification. */
  connectOptions?: SecureClientSessionOptions
  /** One ring's whole deadline, the wait for a new connection's settings included. */
  timeoutMs: number
  /** Test seam: how often the connection is checked. Production: `KEEPALIVE_MS`. */
  keepAliveMs?: number
  /** Test seam: the pause before a background reconnect. Production picks at random. */
  reconnectDelayMs?: () => number
}

/** What one request came to: an answer, or the reason there was none. */
export type KeptReply =
  | { answered: true; status: number; headers: IncomingHttpHeaders; body: Buffer }
  | { answered: false; reason: string }

export class KeptSession {
  private session: ClientHttp2Session | undefined
  /** Settles once the current session's server has sent its settings, or it has gone. */
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

  constructor(private readonly options: KeptSessionOptions) {
    this.reconnectDelayMs =
      options.reconnectDelayMs ?? (() => randomInt(RECONNECT_MIN_MS, RECONNECT_MAX_MS + 1))
    this.keepAliveTimer = setInterval(() => this.keepAlive(), options.keepAliveMs ?? KEEPALIVE_MS)
    this.keepAliveTimer.unref()
    this.connection()
  }

  /**
   * Reuse the live session, or open one. A session the provider has sent away reads as
   * closed (Node closes it on a GOAWAY), so it is replaced here rather than reused.
   * Normally the background has opened one already and a ring only ever reuses it.
   */
  private connection(): ClientHttp2Session {
    const existing = this.session
    if (existing && !existing.closed && !existing.destroyed) return existing
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
    const session = this.options.connectOptions
      ? connect(this.options.origin, this.options.connectOptions)
      : connect(this.options.origin)
    this.openedAt.set(session, Date.now())
    this.ready = new Promise<void>((resolve) => {
      session.once('remoteSettings', () => {
        this.greeted.add(session)
        resolve()
      })
      session.once('close', () => resolve())
      session.once('error', () => resolve())
    })
    // A dead session must not poison every later ring: forget it and open the next in
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
   * The fixed-schedule check: a connection that finished setting up is sent a PING, and
   * one that has not within a ring's deadline is dropped.
   */
  private keepAlive(): void {
    const session = this.session
    if (!session || session.closed || session.destroyed) return
    if (this.greeted.has(session)) {
      this.check(session)
    } else if (Date.now() - (this.openedAt.get(session) ?? 0) > this.options.timeoutMs) {
      session.destroy()
    }
  }

  /**
   * Send one request and read its answer, within one deadline that includes the wait for
   * a new connection's settings. Never throws: a request that got no answer says why.
   */
  request(headers: OutgoingHttpHeaders, body: string): Promise<KeptReply> {
    return new Promise<KeptReply>((resolve) => {
      let settled = false
      let stream: ClientHttp2Stream | undefined
      let timer: NodeJS.Timeout | undefined
      const finish = (reply: KeptReply) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(reply)
      }
      const failed = (reason: string): KeptReply => ({ answered: false, reason })

      let session: ClientHttp2Session
      try {
        session = this.connection()
      } catch (err) {
        finish(failed((err as Error).message))
        return
      }
      timer = setTimeout(() => {
        stream?.close(constants.NGHTTP2_CANCEL)
        finish(failed('Timeout'))
        this.suspect(session)
      }, this.options.timeoutMs)
      void this.ready.then(() => {
        // A ring that ran out of time while waiting is not sent afterwards.
        if (settled) return
        let open: ClientHttp2Stream
        try {
          open = session.request(headers)
        } catch (err) {
          finish(failed((err as Error).message))
          return
        }
        stream = open
        let status = 0
        let answerHeaders: IncomingHttpHeaders = {}
        let size = 0
        const chunks: Buffer[] = []
        const answer = (): KeptReply => ({
          answered: true,
          status,
          headers: answerHeaders,
          body: Buffer.concat(chunks),
        })
        open.on('response', (received) => {
          status = Number(received[constants.HTTP2_HEADER_STATUS] ?? 0)
          answerHeaders = received
          this.unanswered.delete(session)
        })
        open.on('data', (chunk: Buffer | string) => {
          const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
          size += bytes.length
          if (size > MAX_REPLY_BYTES) {
            open.close(constants.NGHTTP2_CANCEL)
            finish(answer())
            return
          }
          chunks.push(bytes)
        })
        open.on('end', () => finish(answer()))
        open.on('error', (err: Error) => finish(failed(err.message)))
        // A stream reset or a session closed under it ends without 'end' or 'error'.
        open.on('close', () => finish(status === 0 ? failed('Closed') : answer()))
        open.end(body)
      })
    })
  }

  /**
   * A ring went unanswered for its whole deadline, so the connection may be dead without
   * having said so. Not set up within a whole deadline: dropped now. Set up: asked with a
   * PING, and dropped unless the server answers within the same deadline, or after
   * `MAX_UNANSWERED` rings in a row went unanswered even so.
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

  /** PING, and drop the connection unless the server answers within a ring's deadline. */
  private check(session: ClientHttp2Session): void {
    if (this.checking.has(session)) return
    this.checking.add(session)
    const deadline = setTimeout(() => session.destroy(), this.options.timeoutMs)
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

  /** Stop checking and reconnecting, and close the session. */
  close(): void {
    this.running = false
    clearInterval(this.keepAliveTimer)
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
    this.session?.close()
    this.session = undefined
  }
}
