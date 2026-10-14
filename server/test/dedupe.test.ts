import type { PendingMessagesResponse, SendResponse } from '@tabsend/shared'
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

async function pair() {
  const { baseUrl } = server
  const a = await register(baseUrl)
  const linkRes = await http.post<{ link: string }>(baseUrl, '/v1/pairing', undefined, a.token)
  const b = await register(baseUrl, { pairingCode: pairingCodeFromLink(linkRes.body.link) })
  return { a, b }
}

describe('concurrent dedupe (idempotency under racing replays)', () => {
  it('N simultaneous identical sends produce exactly one queued row', async () => {
    const { baseUrl } = server
    const { a, b } = await pair()
    const item = {
      id: 'race-1',
      targetEndpointId: b.endpointId,
      envelope: envelopeFor(b.e2ePubkey),
    }

    // Fire the same client-generated id many times AT ONCE. On Postgres these
    // truly race across pool connections; the PK + ON CONFLICT DO NOTHING must
    // still collapse them to a single row on both dialects.
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        http.post<SendResponse>(baseUrl, '/v1/messages', { items: [item] }, a.token),
      ),
    )

    // Every response is a well-formed 200 that "accepted" the id (idempotent).
    for (const res of results) {
      expect(res.status).toBe(200)
      expect(res.body.accepted).toEqual(['race-1'])
      expect(res.body.rejected).toEqual([])
    }

    // Exactly one durable row exists for that id.
    const pending = await http.get<PendingMessagesResponse>(
      baseUrl,
      '/v1/messages?pending=1',
      b.token,
    )
    expect(pending.body).toHaveLength(1)
    expect(pending.body[0]?.id).toBe('race-1')
  })

  it('a replay after ack never resurrects the message', async () => {
    const { baseUrl } = server
    const { a, b } = await pair()
    const item = {
      id: 'race-2',
      targetEndpointId: b.endpointId,
      envelope: envelopeFor(b.e2ePubkey),
    }

    await http.post<SendResponse>(baseUrl, '/v1/messages', { items: [item] }, a.token)
    await http.post(baseUrl, '/v1/messages/race-2/ack', undefined, b.token)

    // Late duplicate of the SAME id (e.g. an outbound-queue retry that crossed
    // the ack): ON CONFLICT DO NOTHING preserves the acked/emptied row.
    const replay = await http.post<SendResponse>(
      baseUrl,
      '/v1/messages',
      { items: [item] },
      a.token,
    )
    expect(replay.body.accepted).toEqual(['race-2'])

    const pending = await http.get<PendingMessagesResponse>(
      baseUrl,
      '/v1/messages?pending=1',
      b.token,
    )
    expect(pending.body).toHaveLength(0) // still delivered-and-gone, not re-queued
  })
})
