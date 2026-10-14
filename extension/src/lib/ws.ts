import type { ClientStreamEvent, ServerStreamEvent } from '@tabsend/shared'
import { WS_CLIENT_PING_INTERVAL_SECONDS } from '@tabsend/shared'

/**
 * The delivery WebSocket client (WS /v1/stream, ADR-0001 / PRD §6.1) — the
 * foreground fast path, LATENCY-ONLY: if it's down, push + poll still deliver,
 * so every failure path is a quiet retry.
 *
 * Transport-agnostic so BOTH hosts reuse it:
 *  - Chrome: an offscreen document holds it (the MV3 service worker can't keep a
 *    socket across idle-termination) and forwards events to the SW.
 *  - Firefox: the EVENT PAGE holds it directly (no offscreen documents, no Push
 *    API — spike §3b) and handles events in-process.
 * The caller supplies `onEvent`; this module owns connect / hello / ping /
 * reconnect-with-backoff only.
 */

export interface WsClientConfig {
  relayUrl: string
  deviceToken: string
}

export interface WsClient {
  /** Point the socket at a config (or null to disconnect). No-op if unchanged. */
  applyConfig(config: WsClientConfig | null | undefined): void
  /** Force a connect attempt now if the socket is not open (activity/alarm wake). */
  connectNow(): void
}

const PING_MS = WS_CLIENT_PING_INTERVAL_SECONDS * 1000
const BACKOFF_BASE_MS = 1000
const BACKOFF_MAX_MS = 30_000

function wsUrlFor(relayUrl: string): string {
  const url = new URL(relayUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = `${url.pathname.replace(/\/$/, '')}/v1/stream`
  url.search = ''
  url.hash = ''
  return url.toString()
}

export function createWsClient(opts: { onEvent: (event: ServerStreamEvent) => void }): WsClient {
  let socket: WebSocket | null = null
  let pingTimer: ReturnType<typeof setInterval> | undefined
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let attempt = 0
  let currentRelay = ''
  let currentToken = ''

  function send(event: ClientStreamEvent): void {
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event))
  }

  function clearTimers(): void {
    if (pingTimer) clearInterval(pingTimer)
    if (reconnectTimer) clearTimeout(reconnectTimer)
    pingTimer = undefined
    reconnectTimer = undefined
  }

  function scheduleReconnect(): void {
    const backoff = Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_MAX_MS)
    const jitter = Math.random() * backoff * 0.3
    attempt += 1
    reconnectTimer = setTimeout(connect, backoff + jitter)
  }

  function connect(): void {
    if (!currentRelay || !currentToken) return
    if (
      socket &&
      (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)
    ) {
      return
    }
    clearTimers()

    let ws: WebSocket
    try {
      ws = new WebSocket(wsUrlFor(currentRelay))
    } catch {
      scheduleReconnect()
      return
    }
    socket = ws

    ws.addEventListener('open', () => {
      attempt = 0
      send({ type: 'hello', deviceToken: currentToken as never })
      pingTimer = setInterval(() => send({ type: 'ping' }), PING_MS)
    })

    ws.addEventListener('message', (ev: MessageEvent) => {
      let event: ServerStreamEvent
      try {
        event = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data))
      } catch {
        return
      }
      if (event.type === 'pong') return
      opts.onEvent(event)
    })

    // 'error' and 'close' both fire on a failed connection — handle a given
    // socket's death exactly once, and ignore an OLD socket's close after an
    // intentional switch (config change), or we'd schedule spurious reconnects.
    let downHandled = false
    const onDown = (): void => {
      if (downHandled) return
      downHandled = true
      if (socket !== ws) return // replaced deliberately — the new socket owns retry
      socket = null
      clearTimers()
      scheduleReconnect()
    }
    ws.addEventListener('close', onDown)
    ws.addEventListener('error', onDown)
  }

  return {
    applyConfig(config) {
      if (!config) {
        // Disconnect: clear the target so onDown's `socket !== ws` guard treats
        // this as a deliberate replacement and schedules no reconnect.
        if (!currentRelay && !currentToken) return
        currentRelay = ''
        currentToken = ''
        clearTimers()
        const old = socket
        socket = null
        old?.close()
        return
      }
      if (config.relayUrl === currentRelay && config.deviceToken === currentToken) return
      currentRelay = config.relayUrl
      currentToken = config.deviceToken
      attempt = 0
      const old = socket
      socket = null // mark any current socket as deliberately replaced
      old?.close()
      connect()
    },
    connectNow() {
      attempt = 0
      connect()
    },
  }
}
