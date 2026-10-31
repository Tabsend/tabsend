import { WS_CLIENT_PING_INTERVAL_SECONDS, WS_CLIENT_PONG_TIMEOUT_SECONDS } from '@tabsend/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWsClient } from './ws'

/**
 * The stream's dead-connection check [2026-10-27]: a socket the relay has stopped
 * answering is dropped within one ping and its answer window, instead of looking
 * open until the browser notices, which can take minutes.
 */

const PING_MS = WS_CLIENT_PING_INTERVAL_SECONDS * 1000
const PONG_MS = WS_CLIENT_PONG_TIMEOUT_SECONDS * 1000

class FakeSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static all: FakeSocket[] = []

  readyState = FakeSocket.CONNECTING
  sent: string[] = []
  closeCalls = 0
  answering = true
  private listeners = new Map<string, ((ev: unknown) => void)[]>()

  constructor(readonly url: string) {
    FakeSocket.all.push(this)
  }

  addEventListener(type: string, fn: (ev: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn])
  }

  emit(type: string, ev: unknown = {}): void {
    for (const fn of this.listeners.get(type) ?? []) fn(ev)
  }

  open(): void {
    this.readyState = FakeSocket.OPEN
    this.emit('open')
  }

  frame(data: unknown): void {
    this.emit('message', { data: JSON.stringify(data) })
  }

  send(text: string): void {
    this.sent.push(text)
    if (this.answering && JSON.parse(text).type === 'ping') this.frame({ type: 'pong' })
  }

  /** A dead path: the close handshake never completes, so no 'close' event. */
  close(): void {
    this.closeCalls += 1
    this.readyState = FakeSocket.CLOSING
  }

  pings(): number {
    return this.sent.filter((t) => JSON.parse(t).type === 'ping').length
  }
}

function socketAt(i: number): FakeSocket {
  const ws = FakeSocket.all[i]
  if (!ws) throw new Error(`no socket ${i}`)
  return ws
}

beforeEach(() => {
  FakeSocket.all = []
  vi.useFakeTimers()
  vi.stubGlobal('WebSocket', FakeSocket)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function connected(onEvent = vi.fn()) {
  const client = createWsClient({ onEvent })
  client.applyConfig({ relayUrl: 'https://relay.example', deviceToken: 'tok' })
  const ws = socketAt(0)
  ws.open()
  return { client, ws, onEvent }
}

describe('createWsClient dead-connection check', () => {
  it('keeps a socket whose relay answers every ping', () => {
    const { ws } = connected()
    vi.advanceTimersByTime(10 * 60_000)
    expect(ws.pings()).toBe(20)
    expect(ws.closeCalls).toBe(0)
    expect(FakeSocket.all).toHaveLength(1)
  })

  it('drops a socket that stops answering and opens a new one', () => {
    const { ws } = connected()
    vi.advanceTimersByTime(5 * 60_000)
    ws.answering = false

    vi.advanceTimersByTime(PING_MS + PONG_MS)
    expect(ws.closeCalls).toBe(1)

    // Reconnects after the first backoff step (1 s plus jitter), with no 'close' event.
    vi.advanceTimersByTime(2_000)
    expect(FakeSocket.all).toHaveLength(2)
    const next = socketAt(1)
    next.open()
    expect(JSON.parse(next.sent[0] ?? '{}')).toMatchObject({ type: 'hello', deviceToken: 'tok' })
  })

  it('counts any frame as an answer, not only pong', () => {
    const { ws, onEvent } = connected()
    ws.answering = false
    // A frame lands 3 s after each ping, though no pong ever does.
    vi.advanceTimersByTime(3_000)
    for (let i = 0; i < 6; i++) {
      vi.advanceTimersByTime(PING_MS)
      ws.frame({ type: 'presence' })
    }
    expect(ws.closeCalls).toBe(0)
    expect(onEvent).toHaveBeenCalledTimes(6)
  })

  it('ignores a dropped socket that closes late', () => {
    const { ws } = connected()
    ws.answering = false
    vi.advanceTimersByTime(PING_MS + PONG_MS + 2_000)
    expect(FakeSocket.all).toHaveLength(2)

    // The old socket's close finally arrives: no second reconnect.
    ws.emit('close')
    vi.advanceTimersByTime(60_000)
    expect(FakeSocket.all).toHaveLength(2)
  })
})
