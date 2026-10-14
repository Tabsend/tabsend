import type { RegisterRequest } from '@tabsend/shared'
import { describe, expect, it } from 'vitest'
import {
  ApiClientError,
  type FetchLike,
  getConfig,
  getGroupHistory,
  getGroupKeys,
  isMissingRouteError,
  listEndpoints,
  register,
} from './api'

interface Captured {
  url: string
  method?: string
  headers: Record<string, string>
  body?: string
}

function fakeFetch(status: number, json: unknown, sink: Captured[]): FetchLike {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    sink.push({
      url: String(input),
      method: init?.method,
      headers: (init?.headers as Record<string, string>) ?? {},
      body: init?.body as string | undefined,
    })
    return new Response(JSON.stringify(json), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }) as FetchLike
}

describe('api client', () => {
  it('GETs /v1/config same-origin (relative) when relayUrl is empty', async () => {
    const calls: Captured[] = []
    const cfg = await getConfig({
      relayUrl: '',
      fetchImpl: fakeFetch(200, { vapidPublicKey: 'K' }, calls),
    })
    expect(cfg.vapidPublicKey).toBe('K')
    expect(calls[0]!.url).toBe('/v1/config')
    expect(calls[0]!.method).toBe('GET')
  })

  it('joins an absolute relay base', async () => {
    const calls: Captured[] = []
    await getConfig({
      relayUrl: 'https://relay.example/',
      fetchImpl: fakeFetch(200, { vapidPublicKey: '' }, calls),
    })
    expect(calls[0]!.url).toBe('https://relay.example/v1/config')
  })

  it('POSTs register with a JSON body and no auth header', async () => {
    const calls: Captured[] = []
    const body: RegisterRequest = {
      label: 'Web console',
      kind: 'console',
      browser: null,
      platform: 'macos',
      pushSubscription: { transport: 'unifiedpush', endpoint: 'https://push.invalid/x' },
      e2ePubkey: 'pub',
    }
    await register(
      {
        relayUrl: '',
        fetchImpl: fakeFetch(201, { endpointId: 'e', groupId: 'g', deviceToken: 't' }, calls),
      },
      body,
    )
    expect(calls[0]!.url).toBe('/v1/endpoints/register')
    expect(calls[0]!.method).toBe('POST')
    expect(calls[0]!.headers.authorization).toBeUndefined()
    expect(JSON.parse(calls[0]!.body ?? '{}').kind).toBe('console')
  })

  it('sends a Bearer token on authenticated routes', async () => {
    const calls: Captured[] = []
    await listEndpoints({ relayUrl: '', fetchImpl: fakeFetch(200, [], calls) }, 'tok-123')
    expect(calls[0]!.headers.authorization).toBe('Bearer tok-123')
  })

  it('asks for the whole group history, not just this endpoint', async () => {
    const calls: Captured[] = []
    await getGroupHistory({ relayUrl: '', fetchImpl: fakeFetch(200, [], calls) }, 'tok')
    expect(calls[0]!.url).toBe('/v1/messages?history=1')
  })

  it('reads group keys from their own route, not the message stream', async () => {
    const calls: Captured[] = []
    await getGroupKeys({ relayUrl: '', fetchImpl: fakeFetch(200, [], calls) }, 'tok')
    expect(calls[0]!.url).toBe('/v1/group-keys')
  })

  it('raises ApiClientError carrying the error envelope code', async () => {
    const calls: Captured[] = []
    const fetchImpl = fakeFetch(401, { error: { code: 'unauthorized', message: 'nope' } }, calls)
    await expect(listEndpoints({ relayUrl: '', fetchImpl }, 'bad')).rejects.toMatchObject({
      status: 401,
      code: 'unauthorized',
    })
    await expect(listEndpoints({ relayUrl: '', fetchImpl }, 'bad')).rejects.toBeInstanceOf(
      ApiClientError,
    )
  })
})

describe('telling an old relay from a broken one', () => {
  it('reads the refusals a pre-ADR-0028 relay gives as "no such feature"', () => {
    // ?history=1 is an unknown query to it (400 invalid_request); /v1/group-keys
    // is an unknown route (404). Both mean fall back, neither means fail.
    expect(isMissingRouteError(new ApiClientError(400, 'invalid_request', 'x'))).toBe(true)
    expect(isMissingRouteError(new ApiClientError(404, 'not_found', 'x'))).toBe(true)
  })

  it('never reads an outage or an auth problem that way', () => {
    // Treating these as "no such feature" would disable the panel over a blip.
    expect(isMissingRouteError(new ApiClientError(401, 'unauthorized', 'x'))).toBe(false)
    expect(isMissingRouteError(new ApiClientError(503, 'internal', 'x'))).toBe(false)
    expect(isMissingRouteError(new TypeError('network down'))).toBe(false)
  })
})
