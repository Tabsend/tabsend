import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ApiClientError,
  deleteEndpoint,
  isHistoryUnsupported,
  listEndpoints,
  register,
  setUnauthorizedHandler,
} from './api'

/**
 * A device-removed browser must be told "you're out" instead of quietly
 * failing every call forever (identity.ts's handleRemoval hangs off this
 * signal). That only works if the 401 hook actually fires — and only for
 * calls that carried our device token, never for the token-less register call.
 */

function fakeFetch(status: number, json: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(json), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch
}

afterEach(() => {
  vi.unstubAllGlobals()
  setUnauthorizedHandler(() => {})
})

describe('setUnauthorizedHandler', () => {
  it('fires on a 401 from an authenticated call', async () => {
    vi.stubGlobal('fetch', fakeFetch(401, { error: { code: 'unauthorized', message: 'nope' } }))
    const handler = vi.fn()
    setUnauthorizedHandler(handler)

    await expect(listEndpoints('https://relay.example', 'dead-token')).rejects.toBeInstanceOf(
      ApiClientError,
    )
    expect(handler).toHaveBeenCalledTimes(1)
    // Which token was refused, so a reply about a retired pairing can be ignored.
    expect(handler).toHaveBeenCalledWith(false, 'dead-token')
  })

  it('does not fire on a 401 from the token-less register call', async () => {
    vi.stubGlobal(
      'fetch',
      fakeFetch(401, { error: { code: 'unauthorized', message: 'should not happen' } }),
    )
    const handler = vi.fn()
    setUnauthorizedHandler(handler)

    await expect(
      register('https://relay.example', {
        label: 'Dia',
        kind: 'extension',
        browser: 'chrome',
        platform: 'macos',
        pushSubscription: {
          transport: 'webpush',
          endpoint: 'https://push.invalid/x',
          keys: { p256dh: 'k', auth: 'a' },
        },
        e2ePubkey: 'pub',
      }),
    ).rejects.toBeInstanceOf(ApiClientError)
    expect(handler).not.toHaveBeenCalled()
  })

  it('does not fire on a non-401 error from an authenticated call', async () => {
    vi.stubGlobal('fetch', fakeFetch(403, { error: { code: 'forbidden', message: 'nope' } }))
    const handler = vi.fn()
    setUnauthorizedHandler(handler)

    await expect(deleteEndpoint('https://relay.example', 'tok', 'ep-1')).rejects.toBeInstanceOf(
      ApiClientError,
    )
    expect(handler).not.toHaveBeenCalled()
  })

  it('does not fire on success', async () => {
    vi.stubGlobal('fetch', fakeFetch(200, []))
    const handler = vi.fn()
    setUnauthorizedHandler(handler)

    await listEndpoints('https://relay.example', 'tok')
    expect(handler).not.toHaveBeenCalled()
  })
})

/**
 * A browser extension updates itself and a self-hosted relay is updated by hand,
 * so a new client against a pre-ADR-0028 relay is a normal state to be in for a
 * while, not a failure. Group history has to read that as "this relay has no
 * group history" and carry on, never as an error and never as a reason to retry
 * harder.
 */
describe('isHistoryUnsupported', () => {
  it('recognises a relay with no /v1/group-keys route', () => {
    expect(isHistoryUnsupported(new ApiClientError(404, 'not_found', 'nope'))).toBe(true)
  })

  it('recognises a relay that only knows ?pending=1 and ?outbox=1', () => {
    expect(
      isHistoryUnsupported(new ApiClientError(400, 'invalid_request', 'Specify ?pending=1')),
    ).toBe(true)
  })

  it('does not mistake a real failure for an old relay', () => {
    // A 401 must reach the removed-from-group path, and a 500 must not silence
    // history for an hour over one bad minute.
    expect(isHistoryUnsupported(new ApiClientError(401, 'unauthorized', 'nope'))).toBe(false)
    expect(isHistoryUnsupported(new ApiClientError(500, 'internal', 'boom'))).toBe(false)
    expect(isHistoryUnsupported(new ApiClientError(400, 'rate_limited', 'slow down'))).toBe(false)
  })

  it('does not treat an unreachable relay as an old one', () => {
    // Nothing answered, so nothing was learned about what the relay supports.
    expect(isHistoryUnsupported(new TypeError('Failed to fetch'))).toBe(false)
  })
})
