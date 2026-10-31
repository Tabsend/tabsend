import { WS_CLIENT_PING_INTERVAL_SECONDS, WS_CLIENT_PONG_TIMEOUT_SECONDS } from '@tabsend/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StreamClient } from './stream'

/**
 * The stream's dead-connection check [2026-10-27]: a socket the relay has stopped
 * answering is dropped within one ping and its answer window, instead of looking
 * open until the browser notices, which can take minutes.
 */

const PING_MS = WS_CLIENT_PING_INTERVAL_SECONDS * 1000
const PONG_MS = WS_CLIENT_PONG_TIMEOUT_SECONDS * 1000

class FakeSocket {
  static all: FakeSocket[] = []
  readonly OPEN = 1
  readyState = 0
  sent: string[] = []
  closeCalls = 0
  answering = true
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null

  constructor(readonly url: string) {
    FakeSocket.all.push(this)
  }

  open(): void {
    this.readyState = 1
    this.onopen?.()
  }

  frame(data: unknown): void {
    this.onmessage?.({ data: JSON.stringify(data) })
  }

  send(text: string): void {
    this.sent.push(text)
    if (this.answering && JSON.parse(text).type === 'ping') this.frame({ type: 'pong' })
  }

  /** A dead path: the close handshake never completes, so no onclose. */
  close(): void {
    this.closeCalls += 1
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
})

afterEach(() => {
  vi.useRealTimers()
})

function connected() {
  const handlers = { onEvent: vi.fn(), onOpen: vi.fn(), onClose: vi.fn() }
  const client = new StreamClient(
    'https://relay.example',
    'tok',
    handlers,
    FakeSocket as unknown as new (
      url: string,
    ) => WebSocket,
  )
  client.start()
  const ws = socketAt(0)
  ws.open()
  return { client, ws, handlers }
}

describe('StreamClient dead-connection check', () => {
  it('keeps a socket whose relay answers every ping', () => {
    const { ws, handlers } = connected()
    vi.advanceTimersByTime(10 * 60_000)
    expect(ws.pings()).toBe(20)
    expect(ws.closeCalls).toBe(0)
    expect(handlers.onClose).not.toHaveBeenCalled()
  })

  it('drops a socket that stops answering and opens a new one', () => {
    const { ws, handlers } = connected()
    vi.advanceTimersByTime(5 * 60_000)
    ws.answering = false

    vi.advanceTimersByTime(PING_MS + PONG_MS)
    expect(ws.closeCalls).toBe(1)
    expect(handlers.onClose).toHaveBeenCalledTimes(1)

    // Reconnects after the first backoff step (1 s plus jitter), with no onclose.
    vi.advanceTimersByTime(2_000)
    expect(FakeSocket.all).toHaveLength(2)
    const next = socketAt(1)
    next.open()
    expect(JSON.parse(next.sent[0] ?? '{}')).toMatchObject({ type: 'hello', deviceToken: 'tok' })
    expect(handlers.onOpen).toHaveBeenCalledTimes(2)
  })

  it('counts any frame as an answer, not only pong', () => {
    const { ws, handlers } = connected()
    ws.answering = false
    // A frame lands 3 s after each ping, though no pong ever does.
    vi.advanceTimersByTime(3_000)
    for (let i = 0; i < 6; i++) {
      vi.advanceTimersByTime(PING_MS)
      ws.frame({ type: 'presence' })
    }
    expect(ws.closeCalls).toBe(0)
    expect(handlers.onClose).not.toHaveBeenCalled()
  })

  it('stop() during the answer window schedules nothing', () => {
    const { client, ws } = connected()
    ws.answering = false
    vi.advanceTimersByTime(PING_MS + 1)
    client.stop()
    vi.advanceTimersByTime(5 * 60_000)
    expect(FakeSocket.all).toHaveLength(1)
  })
})
