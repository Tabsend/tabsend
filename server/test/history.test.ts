import type { GroupSealed, HistoryResponse, SendResponse } from '@tabsend/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sweepExpired } from '../src/sweep'
import {
  envelopeFor,
  http,
  pairingCodeFromLink,
  register,
  startTestServer,
  type TestServer,
} from './helpers'

/**
 * Group history [ADR-0028]. The relay's job here is narrow and worth pinning
 * precisely: hold an opaque blob beside the routing row it describes, serve it to
 * the whole GROUP rather than just the two ends, keep it after ack (unlike the
 * envelope), and never look inside it.
 */
let server: TestServer

beforeEach(async () => {
  server = await startTestServer()
})
afterEach(async () => {
  await server.close()
})

function blob(marker: string): GroupSealed {
  return {
    alg: 'xsalsa20-poly1305/secretbox',
    keyId: 'test-key-id',
    nonce: Buffer.from('nonce-24-bytes-padding!!').toString('base64'),
    ciphertext: Buffer.from(marker).toString('base64'),
  }
}

/** Three endpoints in one group: two ends of a send, plus an uninvolved bystander. */
async function trio() {
  const { baseUrl } = server
  const a = await register(baseUrl, { label: 'Chrome · Work' })
  const link = async () =>
    pairingCodeFromLink(
      (await http.post<{ link: string }>(baseUrl, '/v1/pairing', undefined, a.token)).body.link,
    )
  const b = await register(baseUrl, { label: 'Pixel · Phone', pairingCode: await link() })
  const c = await register(baseUrl, { label: 'iPad', pairingCode: await link() })
  return { a, b, c }
}

async function send(
  from: { token: string },
  to: { endpointId: string; e2ePubkey: string },
  id: string,
  history?: GroupSealed,
) {
  const res = await http.post<SendResponse>(
    server.baseUrl,
    '/v1/messages',
    {
      items: [
        {
          id,
          targetEndpointId: to.endpointId,
          envelope: envelopeFor(to.e2ePubkey),
          ...(history ? { history } : {}),
        },
      ],
    },
    from.token,
  )
  expect(res.status).toBe(200)
  return res.body
}

const historyOf = async (token: string) =>
  http.get<HistoryResponse>(server.baseUrl, '/v1/messages?history=1', token)

describe('group history', () => {
  it('is visible to a device that was neither end of the send', async () => {
    const { a, b, c } = await trio()
    await send(a, b, 'm1', blob('tab-one'))

    // This is the whole point of ADR-0028: C sent nothing and received nothing.
    const res = await historyOf(c.token)
    expect(res.status).toBe(200)
    expect(res.body).toHaveLength(1)
    expect(res.body[0]?.sourceEndpointId).toBe(a.endpointId)
    expect(res.body[0]?.targetEndpointId).toBe(b.endpointId)
    expect(res.body[0]?.blob.ciphertext).toBe(blob('tab-one').ciphertext)
  })

  it('survives the ack that deletes the envelope', async () => {
    const { a, b } = await trio()
    await send(a, b, 'm1', blob('tab-one'))

    await http.get(server.baseUrl, '/v1/messages?pending=1', b.token)
    const ack = await http.post(server.baseUrl, '/v1/messages/m1/ack', undefined, b.token)
    expect(ack.status).toBe(200)

    // The payload is gone from the delivery queue...
    const pending = await http.get<unknown[]>(server.baseUrl, '/v1/messages?pending=1', b.token)
    expect(pending.body).toEqual([])
    // ...and the history copy is not, which is what makes it a record rather
    // than a second delivery queue.
    const res = await historyOf(a.token)
    expect(res.body).toHaveLength(1)
    expect(res.body[0]?.ackedAt).not.toBeNull()
  })

  it('reports a tab that was accepted but never picked up', async () => {
    const { a, b } = await trio()
    await send(a, b, 'm1', blob('never-arrives'))

    const res = await historyOf(a.token)
    // Accepted by the relay, never delivered, never acked. This is the state
    // ADR-0008's "Sent" could never distinguish, and the reason P-7 alone
    // could not help: nothing was received, so nothing was recorded anywhere.
    expect(res.body[0]?.deliveredAt).toBeNull()
    expect(res.body[0]?.ackedAt).toBeNull()
  })

  it('omits sends that carried no history blob, rather than inventing rows', async () => {
    const { a, b, c } = await trio()
    await send(a, b, 'no-blob') // a pre-0028 client, or a group with no key yet
    await send(a, b, 'with-blob', blob('kept'))

    const res = await historyOf(c.token)
    expect(res.body.map((e) => e.id)).toEqual(['with-blob'])
  })

  it('never leaks another group', async () => {
    // Two groups on ONE relay. This used to register the stranger on a second test
    // server with its own database, so it could not fail: removing the group filter
    // from the history read passed (review 2026-10-13).
    const multi = await startTestServer({ groupCreation: 'open' })
    try {
      const a = await register(multi.baseUrl, { label: 'A' })
      const code = pairingCodeFromLink(
        (await http.post<{ link: string }>(multi.baseUrl, '/v1/pairing', undefined, a.token)).body
          .link,
      )
      const b = await register(multi.baseUrl, { label: 'B', pairingCode: code })
      const sent = await http.post<SendResponse>(
        multi.baseUrl,
        '/v1/messages',
        {
          items: [
            {
              id: 'm1',
              targetEndpointId: b.endpointId,
              envelope: envelopeFor(b.e2ePubkey),
              history: blob('mine'),
            },
          ],
        },
        a.token,
      )
      expect(sent.body.accepted).toEqual(['m1'])
      expect(
        (await http.get<HistoryResponse>(multi.baseUrl, '/v1/messages?history=1', a.token)).body,
      ).toHaveLength(1)

      const stranger = await register(multi.baseUrl) // its own group, same database
      const res = await http.get<HistoryResponse>(
        multi.baseUrl,
        '/v1/messages?history=1',
        stranger.token,
      )
      expect(res.body).toEqual([])
    } finally {
      await multi.close()
    }
  })

  it('serves nothing older than the window, even before the sweeper has run', async () => {
    const short = await startTestServer({ historyRetentionMs: 60_000 })
    try {
      const a = await register(short.baseUrl, { label: 'A' })
      const code = pairingCodeFromLink(
        (await http.post<{ link: string }>(short.baseUrl, '/v1/pairing', undefined, a.token)).body
          .link,
      )
      const b = await register(short.baseUrl, { label: 'B', pairingCode: code })
      await http.post<SendResponse>(
        short.baseUrl,
        '/v1/messages',
        {
          items: [
            {
              id: 'old',
              targetEndpointId: b.endpointId,
              envelope: envelopeFor(b.e2ePubkey),
              history: blob('old'),
            },
          ],
        },
        a.token,
      )
      short.clock.advance(61_000)
      const res = await http.get<HistoryResponse>(short.baseUrl, '/v1/messages?history=1', a.token)
      expect(res.body).toEqual([])
    } finally {
      await short.close()
    }
  })

  it('requires authentication', async () => {
    const res = await http.get(server.baseUrl, '/v1/messages?history=1')
    expect(res.status).toBe(401)
  })

  it('returns newest first', async () => {
    const { a, b } = await trio()
    await send(a, b, 'older', blob('1'))
    server.clock.advance(60_000)
    await send(a, b, 'newer', blob('2'))

    const res = await historyOf(a.token)
    expect(res.body.map((e) => e.id)).toEqual(['newer', 'older'])
  })
})

describe('history retention', () => {
  it('serves nothing when the relay has history switched off', async () => {
    const off = await startTestServer({ historyRetentionMs: 0 })
    try {
      const a = await register(off.baseUrl, { label: 'A' })
      const link = pairingCodeFromLink(
        (await http.post<{ link: string }>(off.baseUrl, '/v1/pairing', undefined, a.token)).body
          .link,
      )
      const b = await register(off.baseUrl, { label: 'B', pairingCode: link })
      // The send still SUCCEEDS with a blob attached — an older or differently
      // configured client must never start failing because of a relay setting.
      const res = await http.post<SendResponse>(
        off.baseUrl,
        '/v1/messages',
        {
          items: [
            {
              id: 'm1',
              targetEndpointId: b.endpointId,
              envelope: envelopeFor(b.e2ePubkey),
              history: blob('x'),
            },
          ],
        },
        a.token,
      )
      expect(res.body.accepted).toEqual(['m1'])
      expect((await http.get(off.baseUrl, '/v1/messages?history=1', a.token)).body).toEqual([])
      // And not STORED either: a relay with history off held every blob for
      // expiry + grace (14 days by default), counted by no cap (review 2026-10-13).
      const row = await off.db
        .selectFrom('messages')
        .select('history_blob')
        .where('id', '=', 'm1')
        .executeTakeFirstOrThrow()
      expect(row.history_blob).toBeNull()
    } finally {
      await off.close()
    }
  })

  it('keeps a history row alive past the tombstone window, then drops it', async () => {
    const { a, b } = await trio()
    await send(a, b, 'kept', blob('long-lived'))
    await send(a, b, 'plain') // no blob: prunes on the ordinary schedule

    const db = server.db
    const ttlMs = server.config.messageTtlMs
    const graceMs = server.config.sweepGraceMs
    const historyMs = 30 * 24 * 60 * 60 * 1000

    // Past expiry + grace: the plain row is gone, the history row is not.
    const afterTombstone = new Date(server.clock.now().getTime() + ttlMs + graceMs + 1000)
    await sweepExpired(db, afterTombstone, graceMs, historyMs)
    const left = await db.selectFrom('messages').select('id').execute()
    expect(left.map((r) => r.id).sort()).toEqual(['kept'])

    // Its ciphertext WAS purged on schedule, though — the history blob has a
    // different lifetime from the envelope, and only one of them lingers.
    const row = await db
      .selectFrom('messages')
      .select(['envelope', 'history_blob'])
      .where('id', '=', 'kept')
      .executeTakeFirstOrThrow()
    expect(row.envelope).toBeNull()
    expect(row.history_blob).not.toBeNull()

    // Past the history window too: now it goes.
    const afterHistory = new Date(server.clock.now().getTime() + historyMs + 1000)
    await sweepExpired(db, afterHistory, graceMs, historyMs)
    expect(await db.selectFrom('messages').select('id').execute()).toEqual([])
  })
})

describe('a history blob does not outlive its window', () => {
  it('is dropped at the window even while its row must stay for replay protection', async () => {
    // A window shorter than TTL + grace: the row is owed for longer than the blob.
    const { a, b } = await trio()
    await send(a, b, 'short', blob('one-day'))
    const graceMs = server.config.sweepGraceMs
    const dayMs = 24 * 60 * 60 * 1000

    const afterWindow = new Date(server.clock.now().getTime() + dayMs + 1000)
    const result = await sweepExpired(server.db, afterWindow, graceMs, dayMs)
    expect(result.blobsDropped).toBe(1)
    const row = await server.db
      .selectFrom('messages')
      .select(['id', 'history_blob'])
      .where('id', '=', 'short')
      .executeTakeFirst()
    expect(row?.history_blob ?? null).toBeNull()
    // The row is still there: expiry + grace has not passed, and it is what
    // turns a replay of this id into a no-op.
    expect(row?.id).toBe('short')
  })
})

describe('the relay does not interpret a history blob', () => {
  it('refuses an unknown algorithm rather than storing whatever it is given', async () => {
    const { a, b } = await trio()
    const res = await http.post<{ error: { code: string } }>(
      server.baseUrl,
      '/v1/messages',
      {
        items: [
          {
            id: 'm1',
            targetEndpointId: b.endpointId,
            envelope: envelopeFor(b.e2ePubkey),
            history: { alg: 'rot13', keyId: 'k', nonce: 'n', ciphertext: 'c' },
          },
        ],
      },
      a.token,
    )
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('invalid_request')
  })

  it('round-trips the blob byte for byte', async () => {
    const { a, b } = await trio()
    const original = blob('exact bytes matter: é✓')
    await send(a, b, 'm1', original)
    const res = await historyOf(b.token)
    expect(res.body[0]?.blob).toEqual(original)
  })
})
