import type {
  CreatePairingResponse,
  ListEndpointsResponse,
  OutboxMessagesResponse,
  PendingMessagesResponse,
  RegisterResponse,
  SendResponse,
} from '@tabsend/shared'
import { PRESENCE_ONLINE_THRESHOLD_SECONDS } from '@tabsend/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  autoPairingCode,
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
  expect(res.status).toBe(201)
  return pairingCodeFromLink(res.body.link)
}

describe('full lifecycle register → pair → join → send → pending → ack', () => {
  it('accepts Android empty-object bodies on payload-free POST routes', async () => {
    const a = await register(server.baseUrl)
    const pairing = await http.post<CreatePairingResponse>(
      server.baseUrl,
      '/v1/pairing',
      {},
      a.token,
    )
    expect(pairing.status).toBe(201)

    const code = pairingCodeFromLink(pairing.body.link)
    const b = await register(server.baseUrl, { pairingCode: code })
    await http.post(
      server.baseUrl,
      '/v1/messages',
      {
        items: [
          { id: 'android-ack', targetEndpointId: b.endpointId, envelope: envelopeFor(b.e2ePubkey) },
        ],
      },
      a.token,
    )
    const ack = await http.post<{ ackedAt: string }>(
      server.baseUrl,
      '/v1/messages/android-ack/ack',
      {},
      b.token,
    )
    expect(ack.status).toBe(200)
  })

  it('runs the whole happy path', async () => {
    const { baseUrl } = server

    // 1. Create a group (no pairing code). No recovery credential is minted (ADR-0021):
    // the response carries the endpoint's own ids and token, nothing else.
    const a = await register(baseUrl, { label: 'Chrome · Work' })
    expect(a.groupId).toBeTruthy()
    expect(a).not.toHaveProperty('recovery')

    // 2. A mints a pairing code; B joins the group with it.
    const code = await mintPairing(a.token)
    const b = await register(baseUrl, { label: 'Firefox · Laptop', pairingCode: code })
    expect(b.groupId).toBe(a.groupId)
    expect(b.endpointId).not.toBe(a.endpointId)

    // 3. Group list shows both, and never leaks push subscriptions.
    const list = await http.get<ListEndpointsResponse>(baseUrl, '/v1/endpoints', a.token)
    expect(list.status).toBe(200)
    expect(list.body).toHaveLength(2)
    for (const ep of list.body) {
      expect(ep).not.toHaveProperty('push_subscription')
      expect(ep).not.toHaveProperty('pushSubscription')
      expect(ep).not.toHaveProperty('device_token_hash')
    }

    // 4. A sends a tab to B.
    const send = await http.post<SendResponse>(
      baseUrl,
      '/v1/messages',
      {
        items: [
          { id: 'msg-1', targetEndpointId: b.endpointId, envelope: envelopeFor(b.e2ePubkey) },
        ],
      },
      a.token,
    )
    expect(send.status).toBe(200)
    expect(send.body.accepted).toEqual(['msg-1'])
    expect(send.body.rejected).toEqual([])
    // Push wake attempted to B exactly once.
    expect(server.push.calls).toHaveLength(1)

    // 5. B pulls pending; the message is there with the envelope intact.
    const pending = await http.get<PendingMessagesResponse>(
      baseUrl,
      '/v1/messages?pending=1',
      b.token,
    )
    expect(pending.status).toBe(200)
    expect(pending.body).toHaveLength(1)
    expect(pending.body[0]!.id).toBe('msg-1')
    expect(pending.body[0]!.envelope.ciphertext).toBeTruthy()
    expect(pending.body[0]!.deliveredAt).toBeTruthy() // first pull stamps delivered

    // 6. Source outbox shows the unacked message.
    const outboxBefore = await http.get<OutboxMessagesResponse>(
      baseUrl,
      '/v1/messages?outbox=1',
      a.token,
    )
    expect(outboxBefore.body.map((m) => m.id)).toEqual(['msg-1'])

    // 7. B acks. Envelope deleted; routing row retained (second ack still 200).
    const ack = await http.post(baseUrl, '/v1/messages/msg-1/ack', undefined, b.token)
    expect(ack.status).toBe(200)

    const pendingAfter = await http.get<PendingMessagesResponse>(
      baseUrl,
      '/v1/messages?pending=1',
      b.token,
    )
    expect(pendingAfter.body).toHaveLength(0)

    // 8. Outbox drains on ack.
    const outboxAfter = await http.get<OutboxMessagesResponse>(
      baseUrl,
      '/v1/messages?outbox=1',
      a.token,
    )
    expect(outboxAfter.body).toHaveLength(0)
  })
})

describe('deviceName (additive 5-ext contract)', () => {
  it('passes deviceName through register, PATCH, and list; absent stays absent', async () => {
    const { baseUrl } = server

    // Register WITH a deviceName (join-time grouping tie).
    const a = await register(baseUrl, { label: 'Chrome · MacBook', deviceName: 'MacBook' })
    // Register WITHOUT one — the field must be simply absent (pre-field rows work).
    const code = await mintPairing(a.token)
    const b = await register(baseUrl, { label: 'Firefox · Laptop', pairingCode: code })

    const list = await http.get<ListEndpointsResponse>(baseUrl, '/v1/endpoints', a.token)
    const seenA = list.body.find((e) => e.id === a.endpointId)
    const seenB = list.body.find((e) => e.id === b.endpointId)
    expect(seenA?.deviceName).toBe('MacBook')
    expect(seenB).not.toHaveProperty('deviceName') // null column ⇒ absent on the wire

    // PATCH can set the tie on B and rename in one call.
    const patch = await http.patch<{ label: string; deviceName?: string }>(
      baseUrl,
      `/v1/endpoints/${b.endpointId}`,
      { label: 'Firefox · MacBook', deviceName: 'MacBook' },
      b.token,
    )
    expect(patch.status).toBe(200)
    expect(patch.body.deviceName).toBe('MacBook')

    // PATCH with label only leaves the tie untouched.
    const renameOnly = await http.patch<{ label: string; deviceName?: string }>(
      baseUrl,
      `/v1/endpoints/${b.endpointId}`,
      { label: 'Firefox · The Mac' },
      b.token,
    )
    expect(renameOnly.body.deviceName).toBe('MacBook')
  })
})

describe('idempotency', () => {
  it('send replay is accepted and creates no duplicate delivery', async () => {
    const { baseUrl } = server
    const a = await register(baseUrl)
    const code = await mintPairing(a.token)
    const b = await register(baseUrl, { pairingCode: code })

    const item = { id: 'dup-1', targetEndpointId: b.endpointId, envelope: envelopeFor(b.e2ePubkey) }
    const first = await http.post<SendResponse>(baseUrl, '/v1/messages', { items: [item] }, a.token)
    const second = await http.post<SendResponse>(
      baseUrl,
      '/v1/messages',
      { items: [item] },
      a.token,
    )
    expect(first.body.accepted).toEqual(['dup-1'])
    expect(second.body.accepted).toEqual(['dup-1']) // replay still "accepted"

    const pending = await http.get<PendingMessagesResponse>(
      baseUrl,
      '/v1/messages?pending=1',
      b.token,
    )
    expect(pending.body).toHaveLength(1) // exactly one row, not two
  })

  it('ack is idempotent (routing row survives envelope deletion)', async () => {
    const { baseUrl } = server
    const a = await register(baseUrl)
    const code = await mintPairing(a.token)
    const b = await register(baseUrl, { pairingCode: code })
    await http.post(
      baseUrl,
      '/v1/messages',
      { items: [{ id: 'm', targetEndpointId: b.endpointId, envelope: envelopeFor(b.e2ePubkey) }] },
      a.token,
    )
    const first = await http.post<{ ackedAt: string }>(
      baseUrl,
      '/v1/messages/m/ack',
      undefined,
      b.token,
    )
    const second = await http.post<{ ackedAt: string }>(
      baseUrl,
      '/v1/messages/m/ack',
      undefined,
      b.token,
    )
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(second.body.ackedAt).toBe(first.body.ackedAt) // ackedAt not overwritten
  })
})

describe('TTL expiry', () => {
  it('persists before delivery but drops expired messages from pending', async () => {
    await server.close() // release the default server from beforeEach before replacing it
    server = await startTestServer({ messageTtlMs: 1000 })
    const { baseUrl } = server
    const a = await register(baseUrl)
    const code = await mintPairing(a.token)
    const b = await register(baseUrl, { pairingCode: code })

    const send = await http.post<SendResponse>(
      baseUrl,
      '/v1/messages',
      {
        items: [
          { id: 'ttl-1', targetEndpointId: b.endpointId, envelope: envelopeFor(b.e2ePubkey) },
        ],
      },
      a.token,
    )
    expect(send.body.accepted).toEqual(['ttl-1']) // accepted (queued) regardless

    server.clock.advance(2000) // past the 1s TTL

    const pending = await http.get<PendingMessagesResponse>(
      baseUrl,
      '/v1/messages?pending=1',
      b.token,
    )
    expect(pending.body).toHaveLength(0)

    const outbox = await http.get<OutboxMessagesResponse>(baseUrl, '/v1/messages?outbox=1', a.token)
    expect(outbox.body).toHaveLength(0)
  })
})

describe('presence', () => {
  it('flips to offline past the threshold and back online on heartbeat', async () => {
    const { baseUrl, clock } = server
    const a = await register(baseUrl)
    const code = await mintPairing(a.token)
    const b = await register(baseUrl, { pairingCode: code })

    // Observe A's presence via B so the query never refreshes A's own last_seen.
    const online = await http.get<ListEndpointsResponse>(baseUrl, '/v1/endpoints', b.token)
    expect(online.body.find((e) => e.id === a.endpointId)!.presence).toBe('online')

    clock.advance((PRESENCE_ONLINE_THRESHOLD_SECONDS + 5) * 1000)
    const offline = await http.get<ListEndpointsResponse>(baseUrl, '/v1/endpoints', b.token)
    expect(offline.body.find((e) => e.id === a.endpointId)!.presence).toBe('offline')

    // A heartbeats → back online.
    const hb = await http.post(baseUrl, `/v1/endpoints/${a.endpointId}/heartbeat`, {}, a.token)
    expect(hb.status).toBe(200)
    const back = await http.get<ListEndpointsResponse>(baseUrl, '/v1/endpoints', b.token)
    expect(back.body.find((e) => e.id === a.endpointId)!.presence).toBe('online')
  })
})

describe('register response', () => {
  it('returns 201 with endpointId, groupId, and deviceToken', async () => {
    const res = await http.post<RegisterResponse>(server.baseUrl, '/v1/endpoints/register', {
      label: 'X',
      kind: 'extension',
      browser: 'chrome',
      platform: 'macos',
      pushSubscription: {
        transport: 'webpush',
        endpoint: 'https://p.test',
        keys: { p256dh: 'a', auth: 'b' },
      },
      e2ePubkey: 'pk',
      // The relay owns its group (ADR-0023), so registering means joining it.
      pairingCode: await autoPairingCode(server.baseUrl),
    })
    expect(res.status).toBe(201)
    expect(res.body.endpointId).toBeTruthy()
    expect(res.body.groupId).toBeTruthy()
    expect(res.body.deviceToken).toBeTruthy()
  })
})

describe('push-less endpoints (transport "none") [0015]', () => {
  it('registers, joins, and receives sends with no push subscription at all', async () => {
    const { baseUrl } = server

    // A phone pairs with NO wake channel — WS + polling deliver (ADR-0015).
    const a = await register(baseUrl, { label: 'Chrome · Work' })
    const code = await mintPairing(a.token)
    const phone = await register(baseUrl, {
      label: 'Android · Pixel',
      kind: 'mobile',
      browser: null,
      platform: 'android',
      pushSubscription: { transport: 'none' },
      pairingCode: code,
    })
    expect(phone.groupId).toBe(a.groupId)

    // Sending to it is accepted and queues normally.
    const send = await http.post<SendResponse>(
      baseUrl,
      '/v1/messages',
      {
        items: [
          {
            id: '00000000-0000-4000-8000-0000000000f5',
            targetEndpointId: phone.endpointId,
            envelope: envelopeFor(phone.e2ePubkey),
          },
        ],
      },
      a.token,
    )
    expect(send.status).toBe(200)
    expect(send.body.accepted).toHaveLength(1)

    // The queued message is visible to the phone's poll.
    const pending = await http.get<PendingMessagesResponse>(
      baseUrl,
      '/v1/messages?pending=1',
      phone.token,
    )
    expect(pending.status).toBe(200)
    expect(pending.body).toHaveLength(1)
  })
})
