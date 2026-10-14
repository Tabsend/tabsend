import type {
  ApiError,
  CreatePairingResponse,
  ListEndpointsResponse,
  SendResponse,
} from '@tabsend/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  envelopeFor,
  http,
  pairingCodeFromLink,
  register,
  startTestServer,
  type TestServer,
} from './helpers'

let server: TestServer

beforeEach(async () => {
  server = await startTestServer()
})
afterEach(async () => {
  await server.close()
})

async function mintPairing(token: string): Promise<string> {
  const res = await http.post<CreatePairingResponse>(
    server.baseUrl,
    '/v1/pairing',
    undefined,
    token,
  )
  return pairingCodeFromLink(res.body.link)
}

describe('authentication', () => {
  it('rejects a missing token with 401 unauthorized (contract error envelope)', async () => {
    const res = await http.get<ApiError>(server.baseUrl, '/v1/endpoints')
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('unauthorized')
  })

  it('rejects a bad token with 401', async () => {
    const res = await http.get<ApiError>(server.baseUrl, '/v1/endpoints', 'not-a-real-token')
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('unauthorized')
  })

  it("endpoint A's token cannot heartbeat as endpoint B", async () => {
    const a = await register(server.baseUrl)
    const code = await mintPairing(a.token)
    const b = await register(server.baseUrl, { pairingCode: code })
    // A tries to heartbeat B's endpoint id.
    const res = await http.post<ApiError>(
      server.baseUrl,
      `/v1/endpoints/${b.endpointId}/heartbeat`,
      {},
      a.token,
    )
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('forbidden')
  })

  it('endpoint A cannot ack a message addressed to endpoint B', async () => {
    const a = await register(server.baseUrl)
    const code = await mintPairing(a.token)
    const b = await register(server.baseUrl, { pairingCode: code })
    await http.post(
      server.baseUrl,
      '/v1/messages',
      { items: [{ id: 'x', targetEndpointId: b.endpointId, envelope: envelopeFor(b.e2ePubkey) }] },
      a.token,
    )
    // A (the sender) tries to ack B's message.
    const res = await http.post<ApiError>(server.baseUrl, '/v1/messages/x/ack', undefined, a.token)
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('not_found')
  })
})

/**
 * Multi-tenant relay (ADR-0022: opt-in, NOT the default). The isolation guarantee has
 * to hold wherever two groups can coexist — a hosted relay, or a self-hoster who
 * deliberately runs two — so this suite enables it explicitly rather than relying on a
 * default that no longer permits a second group.
 */
describe('cross-group isolation (multi-group relay)', () => {
  let multi: TestServer
  beforeEach(async () => {
    multi = await startTestServer({ allowMultipleGroups: true })
  })
  afterEach(async () => {
    await multi.close()
  })

  it('groups cannot see each other and cannot send across the boundary', async () => {
    // Two independent groups.
    const a1 = await register(multi.baseUrl) // group 1
    const b2 = await register(multi.baseUrl) // group 2 (separate create)
    expect(a1.groupId).not.toBe(b2.groupId)

    // group 1's list contains only itself.
    const list = await http.get<ListEndpointsResponse>(multi.baseUrl, '/v1/endpoints', a1.token)
    expect(list.body).toHaveLength(1)
    expect(list.body[0]!.id).toBe(a1.endpointId)

    // Sending from group 1 to a group-2 endpoint is refused as `unknown_target` —
    // the answer for an id that was never issued at all [0029]. It used to say
    // `not_in_group`, which confirmed the id was real somewhere else.
    const send = await http.post<SendResponse>(
      multi.baseUrl,
      '/v1/messages',
      {
        items: [
          { id: 'cross', targetEndpointId: b2.endpointId, envelope: envelopeFor(b2.e2ePubkey) },
        ],
      },
      a1.token,
    )
    expect(send.body.accepted).toEqual([])
    expect(send.body.rejected).toEqual([{ id: 'cross', reason: 'unknown_target' }])

    // group 1 cannot rename a group-2 endpoint.
    const patch = await http.patch<ApiError>(
      multi.baseUrl,
      `/v1/endpoints/${b2.endpointId}`,
      { label: 'hijacked' },
      a1.token,
    )
    expect(patch.status).toBe(404)
  })

  /**
   * The cross-tenant gate is INDISTINGUISHABILITY, not merely refusal (HOSTED_PLAN
   * §4.6 / the H2 gate). Refusing a foreign endpoint with its own distinct reason
   * would still answer the attacker's actual question: "is this id real?". On a
   * relay hosting strangers, that is an endpoint-existence oracle, and the only way
   * to close it is for the two cases to produce the same bytes.
   */
  it('answers a real foreign endpoint exactly as one that never existed', async () => {
    const mine = await register(multi.baseUrl)
    const stranger = await register(multi.baseUrl) // a different group

    const res = await http.post<SendResponse>(
      multi.baseUrl,
      '/v1/messages',
      {
        items: [
          {
            id: 'foreign',
            targetEndpointId: stranger.endpointId,
            envelope: envelopeFor(stranger.e2ePubkey),
          },
          {
            id: 'ghost',
            targetEndpointId: 'endpoint-that-was-never-issued',
            envelope: envelopeFor(stranger.e2ePubkey),
          },
        ],
      },
      mine.token,
    )

    expect(res.status).toBe(200)
    expect(res.body.accepted).toEqual([])
    expect(res.body.rejected).toHaveLength(2)
    // Identical apart from the id the CLIENT chose: same reason, same keys, same
    // key order, nothing extra on either side. Compared as JSON too, because a
    // difference in key order alone would still be a difference on the wire.
    const [foreign, ghost] = res.body.rejected
    const anonymise = (entry: unknown) => ({ ...(entry as object), id: 'same' })
    expect(anonymise(foreign)).toEqual(anonymise(ghost))
    expect(JSON.stringify(anonymise(foreign))).toBe(JSON.stringify(anonymise(ghost)))
    expect(foreign!.reason).toBe('unknown_target')
  })

  it('does not leak a foreign endpoint through the stale-key check either', async () => {
    const mine = await register(multi.baseUrl)
    const stranger = await register(multi.baseUrl)

    // A foreign id sealed to the WRONG key. If the relay looked the target up first
    // and checked the key second, this would answer `expired_key` and confirm the id
    // exists. It has to stay indistinguishable from the same call against a ghost.
    const res = await http.post<SendResponse>(
      multi.baseUrl,
      '/v1/messages',
      {
        items: [
          {
            id: 'foreign',
            targetEndpointId: stranger.endpointId,
            envelope: envelopeFor(stranger.e2ePubkey, { targetKeyId: 'not-the-real-key-id' }),
          },
          {
            id: 'ghost',
            targetEndpointId: 'endpoint-that-was-never-issued',
            envelope: envelopeFor(stranger.e2ePubkey, { targetKeyId: 'not-the-real-key-id' }),
          },
        ],
      },
      mine.token,
    )

    expect(res.body.rejected).toEqual([
      { id: 'foreign', reason: 'unknown_target' },
      { id: 'ghost', reason: 'unknown_target' },
    ])
  })
})

describe('per-item send rejections', () => {
  it('rejects unknown_target and expired_key while accepting the valid item', async () => {
    const a = await register(server.baseUrl)
    const code = await mintPairing(a.token)
    const b = await register(server.baseUrl, { pairingCode: code })

    const send = await http.post<SendResponse>(
      server.baseUrl,
      '/v1/messages',
      {
        items: [
          { id: 'ok', targetEndpointId: b.endpointId, envelope: envelopeFor(b.e2ePubkey) },
          { id: 'ghost', targetEndpointId: 'does-not-exist', envelope: envelopeFor(b.e2ePubkey) },
          {
            id: 'stale',
            targetEndpointId: b.endpointId,
            envelope: envelopeFor(b.e2ePubkey, { targetKeyId: 'stale-fingerprint' }),
          },
        ],
      },
      a.token,
    )
    expect(send.body.accepted).toEqual(['ok'])
    expect(send.body.rejected).toContainEqual({ id: 'ghost', reason: 'unknown_target' })
    expect(send.body.rejected).toContainEqual({ id: 'stale', reason: 'expired_key' })
  })
})

describe('pairing codes', () => {
  it('are single-use', async () => {
    const a = await register(server.baseUrl)
    const code = await mintPairing(a.token)
    const first = await register(server.baseUrl, { pairingCode: code })
    expect(first.groupId).toBe(a.groupId)

    // Reusing the consumed code fails.
    const second = await http.post<ApiError>(server.baseUrl, '/v1/endpoints/register', {
      label: 'Third',
      kind: 'extension',
      browser: 'chrome',
      platform: 'macos',
      pushSubscription: {
        transport: 'webpush',
        endpoint: 'https://p.test',
        keys: { p256dh: 'a', auth: 'b' },
      },
      e2ePubkey: 'pk3',
      pairingCode: code,
    })
    expect(second.status).toBe(400)
    expect(second.body.error.code).toBe('invalid_pairing_code')
  })

  it('expire after the TTL window', async () => {
    await server.close() // release the default server from beforeEach before replacing it
    server = await startTestServer({ pairingCodeTtlMs: 1000 })
    const a = await register(server.baseUrl)
    const res = await http.post<CreatePairingResponse>(
      server.baseUrl,
      '/v1/pairing',
      undefined,
      a.token,
    )
    const code = pairingCodeFromLink(res.body.link)

    server.clock.advance(2000) // past the 1s pairing TTL

    const join = await http.post<ApiError>(server.baseUrl, '/v1/endpoints/register', {
      label: 'Late',
      kind: 'extension',
      browser: 'chrome',
      platform: 'macos',
      pushSubscription: {
        transport: 'webpush',
        endpoint: 'https://p.test',
        keys: { p256dh: 'a', auth: 'b' },
      },
      e2ePubkey: 'pk-late',
      pairingCode: code,
    })
    expect(join.status).toBe(400)
    expect(join.body.error.code).toBe('invalid_pairing_code')
  })

  it('rejects an unknown pairing code', async () => {
    const join = await http.post<ApiError>(server.baseUrl, '/v1/endpoints/register', {
      label: 'Nope',
      kind: 'extension',
      browser: 'chrome',
      platform: 'macos',
      pushSubscription: {
        transport: 'webpush',
        endpoint: 'https://p.test',
        keys: { p256dh: 'a', auth: 'b' },
      },
      e2ePubkey: 'pk-nope',
      pairingCode: 'ZZZZZZZZ',
    })
    expect(join.status).toBe(400)
    expect(join.body.error.code).toBe('invalid_pairing_code')
  })
})

describe('push failure resilience', () => {
  it('still accepts a send when the push wake throws', async () => {
    const a = await register(server.baseUrl)
    const code = await mintPairing(a.token)
    const b = await register(server.baseUrl, { pairingCode: code })
    server.push.failNext = true

    const send = await http.post<SendResponse>(
      server.baseUrl,
      '/v1/messages',
      { items: [{ id: 'pf', targetEndpointId: b.endpointId, envelope: envelopeFor(b.e2ePubkey) }] },
      a.token,
    )
    expect(send.status).toBe(200)
    expect(send.body.accepted).toEqual(['pf']) // durable despite the failed wake
  })
})

describe('removal is distinguishable from an unrecognised token', () => {
  // Both cases are a 401 with the endpoint row absent. Clients act destructively
  // on removal (unpair, drop the outbound queue), so conflating the two means a
  // relay restarted on an empty db silently un-pairs healthy devices.
  it('answers a REMOVED endpoint with endpoint_removed', async () => {
    const owner = await register(server.baseUrl)
    const code = await mintPairing(owner.token)
    const victim = await register(server.baseUrl, { pairingCode: code })

    const del = await http.del(server.baseUrl, `/v1/endpoints/${victim.endpointId}`, owner.token)
    expect(del.status).toBe(200)

    const res = await http.get<ApiError>(server.baseUrl, '/v1/endpoints', victim.token)
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('endpoint_removed')
  })

  it('answers a merely UNKNOWN token with plain unauthorized', async () => {
    const res = await http.get<ApiError>(server.baseUrl, '/v1/endpoints', 'never-issued-token')
    expect(res.status).toBe(401)
    // Not endpoint_removed: we have no evidence this endpoint ever existed, which
    // is exactly the state of a wiped or restored database.
    expect(res.body.error.code).toBe('unauthorized')
  })

  it('keeps the tombstone answering after the endpoint is long gone', async () => {
    const owner = await register(server.baseUrl)
    const code = await mintPairing(owner.token)
    const victim = await register(server.baseUrl, { pairingCode: code })
    await http.del(server.baseUrl, `/v1/endpoints/${victim.endpointId}`, owner.token)

    // Repeat calls must stay definitive — a client that retries before acting
    // (or acts on the second failure) must not see the answer change under it.
    for (let i = 0; i < 3; i++) {
      const res = await http.get<ApiError>(server.baseUrl, '/v1/endpoints', victim.token)
      expect(res.body.error.code).toBe('endpoint_removed')
    }
  })
})
