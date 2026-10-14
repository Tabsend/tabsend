import type { ApiError, ListEndpointsResponse, RegisterResponse } from '@tabsend/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { autoPairingCode, http, startTestServer, type TestServer } from './helpers'

let server: TestServer

beforeEach(async () => {
  server = await startTestServer()
})
afterEach(async () => {
  await server.close()
})

/** A well-formed register body; tests override the field under scrutiny. */
function registerBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    label: 'Ladybird · Haiku box',
    kind: 'extension',
    browser: 'chrome',
    platform: 'macos',
    pushSubscription: {
      transport: 'webpush',
      endpoint: 'https://push.test/endpoint',
      keys: { p256dh: 'p256dh-key', auth: 'auth-key' },
    },
    e2ePubkey: 'pk-validate',
    ...overrides,
  }
}

describe('descriptive enums tolerate unknown values (P-6)', () => {
  // `browser` and `platform` only DESCRIBE a device; a client newer than this
  // relay (sending a family/OS we have never heard of) must still register.
  it('degrades an unknown browser and platform to other/unknown on register', async () => {
    const res = await http.post<RegisterResponse>(
      server.baseUrl,
      '/v1/endpoints/register',
      // A code because the relay owns its group (ADR-0023); the enum tolerance under
      // test is unrelated to how the endpoint got in.
      registerBody({
        browser: 'ladybird',
        platform: 'haiku',
        pairingCode: await autoPairingCode(server.baseUrl),
      }),
    )
    expect(res.status).toBe(201)

    const list = await http.get<ListEndpointsResponse>(
      server.baseUrl,
      '/v1/endpoints',
      res.body.deviceToken as unknown as string,
    )
    expect(list.status).toBe(200)
    expect(list.body).toHaveLength(1)
    expect(list.body[0]!.browser).toBe('other')
    expect(list.body[0]!.platform).toBe('unknown')
  })

  it('still accepts a null browser (console convention)', async () => {
    const res = await http.post<RegisterResponse>(
      server.baseUrl,
      '/v1/endpoints/register',
      registerBody({
        kind: 'console',
        browser: null,
        pairingCode: await autoPairingCode(server.baseUrl),
      }),
    )
    expect(res.status).toBe(201)
  })

  it('still rejects a non-string browser with 400', async () => {
    const res = await http.post<ApiError>(
      server.baseUrl,
      '/v1/endpoints/register',
      registerBody({ browser: 42 }),
    )
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('invalid_request')
  })

  it('still rejects a missing platform with 400', async () => {
    const body = registerBody()
    delete body.platform
    const res = await http.post<ApiError>(server.baseUrl, '/v1/endpoints/register', body)
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('invalid_request')
  })
})

describe('semantic enums stay strict', () => {
  // `kind` selects routing behaviour — an unknown kind is a request this relay
  // genuinely cannot serve, so it stays a 400 rather than degrading.
  it('rejects an unknown kind with 400 invalid_request', async () => {
    const res = await http.post<ApiError>(
      server.baseUrl,
      '/v1/endpoints/register',
      registerBody({ kind: 'hologram' }),
    )
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('invalid_request')
  })
})

describe('push endpoint validation', () => {
  it.each([
    'http://push.example/endpoint',
    'https://localhost/endpoint',
    'https://169.254.169.254/latest/meta-data',
  ])('rejects an unsafe client-controlled destination: %s', async (endpoint) => {
    const res = await http.post<ApiError>(
      server.baseUrl,
      '/v1/endpoints/register',
      registerBody({
        pushSubscription: {
          transport: 'webpush',
          endpoint,
          keys: { p256dh: 'p256dh-key', auth: 'auth-key' },
        },
      }),
    )
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('invalid_request')
  })
})
