import type { ClientStreamEvent, DeviceToken, ServerStreamEvent } from '@tabsend/shared'
import { WS_CLIENT_PING_INTERVAL_SECONDS, WS_CLIENT_PONG_TIMEOUT_SECONDS } from '@tabsend/shared'

/**
 * WS /v1/stream client — the latency-only fast path (ADR-0001 / §11). Correctness
 * NEVER depends on it: the controller keeps a poll loop running regardless, so if
 * this socket is down nothing is lost (the relay queues; the poll drains). On any
 * drop we reconnect with backoff; while disconnected the caller degrades to polling.
 *
 * Lifecycle per the contract: send `{type:'hello', deviceToken}` as the FIRST frame,
 * then ping every WS_CLIENT_PING_INTERVAL_SECONDS; the server replies `pong`.
 * A ping with no frame of any kind back within WS_CLIENT_PONG_TIMEOUT_SECONDS
 * means the socket died without closing (a network switch, a NAT that forgot
 * it): it is dropped and reconnected at once, instead of left to the browser,
 * which can take minutes to notice [2026-10-27].
 */
export interface StreamHandlers {
  onEvent(event: ServerStreamEvent): void
  onOpen?(): void
  onClose?(): void
}

type WebSocketCtor = new (url: string) => WebSocket

const PING_MS = WS_CLIENT_PING_INTERVAL_SECONDS * 1000
const PONG_TIMEOUT_MS = WS_CLIENT_PONG_TIMEOUT_SECONDS * 1000
const BASE_BACKOFF_MS = 1000
const MAX_BACKOFF_MS = 30_000

export class StreamClient {
  private ws: WebSocket | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private pongTimer: ReturnType<typeof setTimeout> | null = null
  private attempts = 0
  private stopped = false

  constructor(
    private readonly relayUrl: string,
    private readonly deviceToken: string,
    private readonly handlers: StreamHandlers,
    private readonly WebSocketImpl: WebSocketCtor = WebSocket,
  ) {}

  /** Resolve the ws(s):// URL for /v1/stream from the relay base (same-origin default). */
  streamUrl(): string {
    if (this.relayUrl === '') {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws'
      return `${proto}://${location.host}/v1/stream`
    }
    const httpUrl = new URL('/v1/stream', this.relayUrl)
    httpUrl.protocol = httpUrl.protocol === 'https:' ? 'wss:' : 'ws:'
    return httpUrl.toString()
  }

  start(): void {
    this.stopped = false
    this.connect()
  }

  stop(): void {
    this.stopped = true
    this.clearTimers()
    if (this.ws) {
      this.ws.onclose = null
      try {
        this.ws.close()
      } catch {
        // already closing
      }
      this.ws = null
    }
  }

  private connect(): void {
    if (this.stopped) return
    let ws: WebSocket
    try {
      ws = new this.WebSocketImpl(this.streamUrl())
    } catch {
      this.scheduleReconnect()
      return
    }
    this.ws = ws

    ws.onopen = () => {
      this.attempts = 0
      this.send({ type: 'hello', deviceToken: this.deviceToken as DeviceToken })
      this.startPing()
      this.handlers.onOpen?.()
    }

    ws.onmessage = (ev: MessageEvent) => {
      // Any frame is an answer, not only `pong`.
      this.clearPong()
      let event: ServerStreamEvent
      try {
        event = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data))
      } catch {
        return
      }
      this.handlers.onEvent(event)
    }

    ws.onclose = () => this.down()

    ws.onerror = () => {
      // onclose follows; reconnect is handled there.
    }
  }

  private send(event: ClientStreamEvent): void {
    if (this.ws && this.ws.readyState === this.ws.OPEN) {
      this.ws.send(JSON.stringify(event))
    }
  }

  /** The socket is gone: tidy up, tell the caller, and try again with backoff. */
  private down(): void {
    this.clearTimers()
    this.ws = null
    this.handlers.onClose?.()
    this.scheduleReconnect()
  }

  private startPing(): void {
    this.clearPing()
    this.pingTimer = setInterval(() => this.ping(), PING_MS)
  }

  private ping(): void {
    const ws = this.ws
    if (!ws) return
    // Armed before the send, and left alone if the previous ping's window is open.
    if (!this.pongTimer) {
      this.pongTimer = setTimeout(() => {
        this.pongTimer = null
        if (this.ws !== ws) return
        // Nobody is answering. Detach first: the browser may wait a long time for
        // the close handshake, and that late close must schedule nothing.
        ws.onclose = null
        ws.onmessage = null
        try {
          ws.close()
        } catch {
          // already closing
        }
        this.down()
      }, PONG_TIMEOUT_MS)
    }
    this.send({ type: 'ping' })
  }

  private clearPong(): void {
    if (this.pongTimer) {
      clearTimeout(this.pongTimer)
      this.pongTimer = null
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return
    this.attempts += 1
    const backoff = Math.min(BASE_BACKOFF_MS * 2 ** (this.attempts - 1), MAX_BACKOFF_MS)
    const jitter = Math.random() * backoff * 0.25
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, backoff + jitter)
  }

  private clearPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
  }

  private clearTimers(): void {
    this.clearPing()
    this.clearPong()
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }
}
