import { afterEach, describe, expect, it } from 'vitest'
import { ApiClientError } from './api'
import { classifySendFailure, isBrowserOnline, isRelayDown, OUTAGE_GRACE_MS } from './health'

/**
 * The whole point of this module: a self-hosted relay that stops answering must
 * be diagnosed as a RELAY problem, not as "no connection". Before the split,
 * every fetch rejection produced the offline copy, and a user whose mini PC had
 * gone down was told to check their internet (dogfood 2026-07-29).
 */

const RELAY = 'http://192.168.1.50:8787'

function setOnLine(value: boolean | undefined): void {
  const g = globalThis as { navigator?: { onLine?: boolean } }
  if (value === undefined) {
    delete (g as { navigator?: unknown }).navigator
    return
  }
  Object.defineProperty(g, 'navigator', { value: { onLine: value }, configurable: true })
}

afterEach(() => setOnLine(undefined))

describe('classifySendFailure', () => {
  it('names the relay when the network is up and nothing answered', () => {
    setOnLine(true)
    expect(classifySendFailure(new TypeError('Failed to fetch'), RELAY)).toEqual({
      kind: 'relay-unreachable',
      relayUrl: RELAY,
    })
  })

  it('blames the connection only when the browser really is offline', () => {
    setOnLine(false)
    expect(classifySendFailure(new TypeError('Failed to fetch'), RELAY)).toEqual({
      kind: 'browser-offline',
    })
  })

  it('treats an unknown onLine state as online — never guess "you are offline"', () => {
    setOnLine(undefined)
    expect(classifySendFailure(new TypeError('Failed to fetch'), RELAY)).toEqual({
      kind: 'relay-unreachable',
      relayUrl: RELAY,
    })
    expect(isBrowserOnline()).toBe(true)
  })

  it('a relay that ANSWERED and refused is an error, not an outage', () => {
    setOnLine(true)
    const err = new ApiClientError(404, 'not_found', 'No such endpoint.')
    expect(classifySendFailure(err, RELAY)).toEqual({ kind: 'relay-error', code: 'not_found' })
  })

  // The relay's prose is explicitly allowed to change and is written for a log,
  // so it must not be what reaches the banner — only the code travels.
  it('carries the code, never the relay message', () => {
    const err = new ApiClientError(500, 'internal', 'panic: nil map write')
    const failure = classifySendFailure(err, RELAY)
    expect(JSON.stringify(failure)).not.toContain('panic')
  })

  // A relay running ahead of this build can name a code we have no copy for.
  it('folds an unrecognised code into the generic one rather than leaking it', () => {
    const err = new ApiClientError(418, 'teapot_overheated', 'nope')
    expect(classifySendFailure(err, RELAY)).toEqual({ kind: 'relay-error', code: 'internal' })
  })

  // `limit_reached` [0030] is answered to a register, not a send, so this is
  // really a test of the code set: a member missing from it becomes `internal`,
  // and a relay enforcing its own device cap would read as a relay fault.
  it('keeps a cap refusal as itself rather than folding it to a fault', () => {
    const err = new ApiClientError(409, 'limit_reached', 'Group is full.')
    expect(classifySendFailure(err, RELAY)).toEqual({ kind: 'relay-error', code: 'limit_reached' })
  })

  it('separates a dead token from a dead relay', () => {
    const err = new ApiClientError(401, 'unauthorized', 'Bad token.')
    expect(classifySendFailure(err, RELAY)).toEqual({ kind: 'relay-unauthorized' })
  })

  /**
   * The status, not the code. A reverse proxy in front of a restarting relay
   * answers HTML 502 with no error envelope at all, so api.ts can only label it
   * `internal` — and reading that as a permanent relay bug threw the tab away,
   * which for a queue drain meant every held tab in one pass.
   */
  it('calls a 429 or any 5xx "not now" rather than a refusal', () => {
    expect(
      classifySendFailure(new ApiClientError(429, 'rate_limited', 'Slow down.'), RELAY),
    ).toEqual({ kind: 'relay-busy' })
    expect(classifySendFailure(new ApiClientError(500, 'internal', 'boom'), RELAY)).toEqual({
      kind: 'relay-busy',
    })
    // The proxy case: no envelope, so `parse` invented the code.
    expect(
      classifySendFailure(new ApiClientError(502, 'internal', 'Request failed (502).'), RELAY),
    ).toEqual({ kind: 'relay-busy' })
    expect(classifySendFailure(new ApiClientError(503, 'internal', 'restarting'), RELAY)).toEqual({
      kind: 'relay-busy',
    })
  })

  it('still calls a 4xx a refusal — those do not fix themselves', () => {
    expect(classifySendFailure(new ApiClientError(400, 'invalid_request', 'nope'), RELAY)).toEqual({
      kind: 'relay-error',
      code: 'invalid_request',
    })
    expect(classifySendFailure(new ApiClientError(403, 'forbidden', 'nope'), RELAY)).toEqual({
      kind: 'relay-error',
      code: 'forbidden',
    })
  })
})

describe('isRelayDown', () => {
  const now = Date.parse('2026-07-29T12:00:00.000Z')
  const at = (ms: number): string => new Date(now - ms).toISOString()

  it('is false with no verdict yet', () => {
    expect(isRelayDown(undefined, now)).toBe(false)
  })

  it('is false while the relay is answering', () => {
    expect(isRelayDown({ relayUrl: RELAY, reachable: true, since: at(60 * 60_000) }, now)).toBe(
      false,
    )
  })

  // A container restart or a laptop wake drops one call. Shouting about that
  // would train the user to ignore the warning that matters.
  it('holds fire during the grace period', () => {
    expect(
      isRelayDown({ relayUrl: RELAY, reachable: false, since: at(OUTAGE_GRACE_MS - 1000) }, now),
    ).toBe(false)
  })

  it('calls it once the silence has lasted', () => {
    expect(
      isRelayDown({ relayUrl: RELAY, reachable: false, since: at(OUTAGE_GRACE_MS + 1000) }, now),
    ).toBe(true)
  })
})
