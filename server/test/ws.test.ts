import type { CreatePairingResponse } from '@tabsend/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  connectWs,
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

/** Open a socket, authenticate, and confirm registration via ping→pong. */
async function connectAuthed(token: string) {
  const ws = await connectWs(server.wsUrl)
  ws.send({ type: 'hello', deviceToken: token })
  ws.send({ type: 'ping' })
  await ws.next((m) => m.type === 'pong')
  return ws
}

describe('WS /v1/stream', () => {
  it('closes a socket that presents a bad token on hello', async () => {
    const ws = await connectWs(server.wsUrl)
    ws.send({ type: 'hello', deviceToken: 'garbage-token' })
    const { code } = await ws.closed
    expect(code).toBe(1008)
  })

  it('closes a socket whose first frame is not hello', async () => {
    const ws = await connectWs(server.wsUrl)
    ws.send({ type: 'ping' })
    const { code } = await ws.closed
    expect(code).toBe(1008)
  })

  it('closes a socket that does not authenticate before the hello deadline', async () => {
    await server.close()
    server = await startTestServer({ streamHelloTimeoutMs: 30 })
    const ws = await connectWs(server.wsUrl)
    const { code } = await ws.closed
    expect(code).toBe(1008)
  })

  it('closes an authenticated socket that stops pinging', async () => {
    await server.close()
    server = await startTestServer({ streamIdleTimeoutMs: 40 })
    const endpoint = await register(server.baseUrl)
    const ws = await connectAuthed(endpoint.token)
    const { code } = await ws.closed
    expect(code).toBe(1001)
  })

  it('rejects malformed JSON instead of holding the socket open', async () => {
    const ws = await connectWs(server.wsUrl)
    ws.sendRaw('{not json')
    const { code } = await ws.closed
    expect(code).toBe(1007)
  })

  it('enforces the per-process connection cap before authentication', async () => {
    await server.close()
    server = await startTestServer({ streamMaxConnections: 1 })
    const first = await connectWs(server.wsUrl)
    const second = await connectWs(server.wsUrl)
    const { code } = await second.closed
    expect(code).toBe(1013)
    first.close()
  })

  it('enforces the per-endpoint authenticated connection cap', async () => {
    await server.close()
    server = await startTestServer({ streamMaxConnectionsPerEndpoint: 1 })
    const endpoint = await register(server.baseUrl)
    const first = await connectAuthed(endpoint.token)
    const second = await connectWs(server.wsUrl)
    second.send({ type: 'hello', deviceToken: endpoint.token })
    const { code } = await second.closed
    expect(code).toBe(1013)
    first.close()
  })

  it('enforces a per-group connection cap, so one tenant cannot take them all', async () => {
    await server.close()
    server = await startTestServer({ streamMaxConnectionsPerGroup: 2 })
    const a = await register(server.baseUrl)
    const b = await register(server.baseUrl, { pairingCode: await mintPairing(a.token) })
    const first = await connectAuthed(a.token)
    const second = await connectAuthed(b.token)

    // A third socket from the same group, from either device, is past the group's
    // share of the process-wide allowance [2026-10-01].
    const third = await connectWs(server.wsUrl)
    third.send({ type: 'hello', deviceToken: a.token })
    expect((await third.closed).code).toBe(1013)

    // Freed slots are reusable.
    second.close()
    await second.closed
    const again = await connectAuthed(b.token)
    again.close()
    first.close()
  })

  it('rejects frames above the configured parser limit', async () => {
    await server.close()
    server = await startTestServer({ streamMaxFrameBytes: 64 })
    const ws = await connectWs(server.wsUrl)
    ws.sendRaw('x'.repeat(65))
    const { code } = await ws.closed
    expect(code).toBe(1009)
  })

  it('delivers a message event to the target on send', async () => {
    const a = await register(server.baseUrl)
    const code = await mintPairing(a.token)
    const b = await register(server.baseUrl, { pairingCode: code })

    const bWs = await connectAuthed(b.token)

    await http.post(
      server.baseUrl,
      '/v1/messages',
      {
        items: [{ id: 'ws-1', targetEndpointId: b.endpointId, envelope: envelopeFor(b.e2ePubkey) }],
      },
      a.token,
    )

    const evt = await bWs.next((m) => m.type === 'message')
    expect(evt.message.id).toBe('ws-1')
    expect(evt.message.targetEndpointId).toBe(b.endpointId)
    expect(evt.message.envelope.ciphertext).toBeTruthy()

    bWs.close()
  })

  it('delivers an acked event to the source when the target acks', async () => {
    const a = await register(server.baseUrl)
    const code = await mintPairing(a.token)
    const b = await register(server.baseUrl, { pairingCode: code })

    const aWs = await connectAuthed(a.token)

    await http.post(
      server.baseUrl,
      '/v1/messages',
      {
        items: [{ id: 'ws-2', targetEndpointId: b.endpointId, envelope: envelopeFor(b.e2ePubkey) }],
      },
      a.token,
    )
    await http.post(server.baseUrl, '/v1/messages/ws-2/ack', undefined, b.token)

    const evt = await aWs.next((m) => m.type === 'acked')
    expect(evt.messageId).toBe('ws-2')
    expect(evt.targetEndpointId).toBe(b.endpointId)
    expect(evt.ackedAt).toBeTruthy()

    aWs.close()
  })

  it('emits endpoint_added to existing peers when a new endpoint joins', async () => {
    const a = await register(server.baseUrl)
    const aWs = await connectAuthed(a.token)

    const code = await mintPairing(a.token)
    const b = await register(server.baseUrl, { pairingCode: code })

    const evt = await aWs.next((m) => m.type === 'endpoint_added')
    expect(evt.endpoint.id).toBe(b.endpointId)
    // Peer-facing endpoint must never carry the push subscription.
    expect(evt.endpoint).not.toHaveProperty('pushSubscription')

    aWs.close()
  })

  it('emits endpoint_removed to peers on delete', async () => {
    const a = await register(server.baseUrl)
    const code = await mintPairing(a.token)
    const b = await register(server.baseUrl, { pairingCode: code })

    const aWs = await connectAuthed(a.token)
    await http.del(server.baseUrl, `/v1/endpoints/${b.endpointId}`, a.token)

    const evt = await aWs.next((m) => m.type === 'endpoint_removed')
    expect(evt.endpointId).toBe(b.endpointId)

    aWs.close()
  })

  it("closes the removed device's own socket, after telling it", async () => {
    const a = await register(server.baseUrl)
    const b = await register(server.baseUrl, { pairingCode: await mintPairing(a.token) })
    const bWs = await connectAuthed(b.token)

    await http.del(server.baseUrl, `/v1/endpoints/${b.endpointId}`, a.token)

    // Told first, on the socket it still had...
    const evt = await bWs.next((m) => m.type === 'endpoint_removed')
    expect(evt.endpointId).toBe(b.endpointId)
    // ...then dropped [2026-10-01]. Its token stopped working at once; before this its
    // fast path did not, and it went on hearing the group's broadcasts, every later
    // device's name and public key included, for as long as it kept the socket open.
    expect((await bWs.closed).code).toBe(1001)

    // And nothing that happens in the group afterwards reaches it.
    const c = await register(server.baseUrl, { pairingCode: await mintPairing(a.token) })
    expect(c.endpointId).toBeTruthy()
    expect(bWs.messages.some((m) => m.type === 'endpoint_added')).toBe(false)
  })

  it('emits endpoint_updated to peers on rename', async () => {
    const a = await register(server.baseUrl)
    const code = await mintPairing(a.token)
    const b = await register(server.baseUrl, { pairingCode: code })

    const aWs = await connectAuthed(a.token)
    await http.patch(server.baseUrl, `/v1/endpoints/${b.endpointId}`, { label: 'Renamed' }, a.token)

    const evt = await aWs.next((m) => m.type === 'endpoint_updated')
    expect(evt.endpoint.id).toBe(b.endpointId)
    expect(evt.endpoint.label).toBe('Renamed')
    // Peer-facing endpoint must never carry the push subscription.
    expect(evt.endpoint).not.toHaveProperty('pushSubscription')

    aWs.close()
  })
})
