import type { ApiError, GroupKeyResponse, GroupKeysResponse } from '@tabsend/shared'
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
 * Group history key distribution [ADR-0028].
 *
 * The relay holds a sealed copy for a device that is not online yet and hands it
 * over when it is. It can read none of it, and it must not become a second
 * message queue: nothing here opens, notifies, or is consumed on read.
 */
let server: TestServer

beforeEach(async () => {
  server = await startTestServer()
})
afterEach(async () => {
  await server.close()
})

/** Swap the per-test relay for one with different options, closing the old one. */
async function restart(options: Parameters<typeof startTestServer>[0]) {
  await server.close()
  server = await startTestServer(options)
}

async function pair() {
  const { baseUrl } = server
  const a = await register(baseUrl, { label: 'Chrome · Work' })
  const code = pairingCodeFromLink(
    (await http.post<{ link: string }>(baseUrl, '/v1/pairing', undefined, a.token)).body.link,
  )
  const b = await register(baseUrl, { label: 'Pixel · Phone', pairingCode: code })
  return { a, b }
}

async function give(
  from: { token: string },
  to: { endpointId: string; e2ePubkey: string },
  id: string,
  opts: { targetKeyId?: string } = {},
) {
  return http.post<GroupKeyResponse>(
    server.baseUrl,
    '/v1/group-keys',
    { items: [{ id, targetEndpointId: to.endpointId, envelope: envelopeFor(to.e2ePubkey, opts) }] },
    from.token,
  )
}

const keysFor = async (token: string) =>
  http.get<GroupKeysResponse>(server.baseUrl, '/v1/group-keys', token)

describe('handing the group key to a device', () => {
  it('reaches only the endpoint it was sealed to', async () => {
    const { a, b } = await pair()
    expect((await give(a, b, 'k1')).body.accepted).toEqual(['k1'])

    const mine = await keysFor(b.token)
    expect(mine.body).toHaveLength(1)
    expect(mine.body[0]?.sourceEndpointId).toBe(a.endpointId)

    // The sender does NOT get its own copy back: it already has the key, and a
    // copy sealed to someone else would be undecryptable noise.
    expect((await keysFor(a.token)).body).toEqual([])
  })

  it('is idempotent, so two devices racing to help a newcomer is a no-op', async () => {
    const { a, b } = await pair()
    await give(a, b, 'same-id')
    await give(a, b, 'same-id')
    expect((await keysFor(b.token)).body).toHaveLength(1)
  })

  it('is NOT consumed on read, so a client that crashes mid-store can retry', async () => {
    const { a, b } = await pair()
    await give(a, b, 'k1')
    expect((await keysFor(b.token)).body).toHaveLength(1)
    expect((await keysFor(b.token)).body).toHaveLength(1)
  })

  it('refuses a copy sealed to a key the target has replaced', async () => {
    const { a, b } = await pair()
    const res = await give(a, b, 'k1', { targetKeyId: 'stale-key-id' })
    expect(res.body.accepted).toEqual([])
    expect(res.body.rejected).toEqual([{ id: 'k1', reason: 'expired_key' }])
    // Storing it would leave the device permanently without a key it looks like
    // it was given.
    expect((await keysFor(b.token)).body).toEqual([])
  })

  /**
   * Refused, and refused INDISTINGUISHABLY [0029]. This route carried the same
   * `not_in_group` ladder as the send route, so the endpoint-existence oracle
   * (HOSTED_PLAN §4.6) lived here twice over — and a fix on one route alone would
   * have left it fully readable through the other.
   */
  it('answers an endpoint outside the caller’s group exactly as an unknown one', async () => {
    const multi = await startTestServer({ groupCreation: 'open' })
    try {
      const mine = await register(multi.baseUrl)
      const stranger = await register(multi.baseUrl) // own group
      const res = await http.post<GroupKeyResponse>(
        multi.baseUrl,
        '/v1/group-keys',
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
      expect(res.body.accepted).toEqual([])
      // Same reason, same shape: nothing here says which of the two ids is real.
      expect(res.body.rejected).toEqual([
        { id: 'foreign', reason: 'unknown_target' },
        { id: 'ghost', reason: 'unknown_target' },
      ])
    } finally {
      await multi.close()
    }
  })

  it('reports an unknown target rather than failing the batch', async () => {
    const { a, b } = await pair()
    const res = await http.post<GroupKeyResponse>(
      server.baseUrl,
      '/v1/group-keys',
      {
        items: [
          { id: 'good', targetEndpointId: b.endpointId, envelope: envelopeFor(b.e2ePubkey) },
          { id: 'bad', targetEndpointId: 'nope', envelope: envelopeFor('whatever') },
        ],
      },
      a.token,
    )
    expect(res.body.accepted).toEqual(['good'])
    expect(res.body.rejected).toEqual([{ id: 'bad', reason: 'unknown_target' }])
  })

  it('requires authentication in both directions', async () => {
    expect((await http.get(server.baseUrl, '/v1/group-keys')).status).toBe(401)
    expect((await http.post(server.baseUrl, '/v1/group-keys', { items: [] })).status).toBe(401)
  })
})

describe('a key copy does not outlive its purpose', () => {
  it('goes when the endpoint it was sealed to is removed', async () => {
    const { a, b } = await pair()
    await give(a, b, 'k1')

    const del = await http.del(server.baseUrl, `/v1/endpoints/${b.endpointId}`, a.token)
    expect(del.status).toBe(200)

    const left = await server.db.selectFrom('group_keys').select('id').execute()
    // A rotation exists to end the state where a departed device has group key
    // material; leaving its copy on the relay would half-undo that.
    expect(left).toEqual([])
  })

  it('goes when the endpoint that SENT it is removed, so it cannot block a rotation', async () => {
    // A device about to be removed fills a member's 64 slots with copies of its
    // own. Left behind, they refused the rotation that follows its removal for
    // the whole history window (review 2026-10-13).
    const { baseUrl } = server
    const { a, b } = await pair()
    const code = pairingCodeFromLink(
      (await http.post<{ link: string }>(baseUrl, '/v1/pairing', undefined, a.token)).body.link,
    )
    const c = await register(baseUrl, { label: 'Stolen phone', pairingCode: code })
    const junk = Array.from({ length: 64 }, (_, i) => ({
      id: `junk${i}`,
      targetEndpointId: a.endpointId,
      envelope: envelopeFor(a.e2ePubkey),
    }))
    await http.post(baseUrl, '/v1/group-keys', { items: junk }, c.token)
    expect((await give(b, a, 'before')).body.rejected).toEqual([
      { id: 'before', reason: 'limit_reached' },
    ])

    expect((await http.del(baseUrl, `/v1/endpoints/${c.endpointId}`, a.token)).status).toBe(200)
    expect((await give(b, a, 'rotated')).body.accepted).toEqual(['rotated'])
  })

  it('ages out with the history it could open', async () => {
    const { a, b } = await pair()
    await give(a, b, 'k1')
    const historyMs = 30 * 24 * 60 * 60 * 1000

    const before = new Date(server.clock.now().getTime() + historyMs - 1000)
    const early = await sweepExpired(server.db, before, server.config.sweepGraceMs, historyMs)
    expect(early.keysDropped).toBe(0)
    expect((await keysFor(b.token)).body).toHaveLength(1)

    const after = new Date(server.clock.now().getTime() + historyMs + 1000)
    const late = await sweepExpired(server.db, after, server.config.sweepGraceMs, historyMs)
    expect(late.keysDropped).toBe(1)
    expect((await keysFor(b.token)).body).toEqual([])
  })

  it('goes on the next pass when the relay has history switched off', async () => {
    const { a, b } = await pair()
    await give(a, b, 'k1')
    const later = new Date(server.clock.now().getTime() + 1000)
    const result = await sweepExpired(server.db, later, server.config.sweepGraceMs, 0)
    expect(result.keysDropped).toBe(1)
  })
})

describe('key distribution is not a second message queue', () => {
  it('never appears as a pending message, so no client tries to open it', async () => {
    const { a, b } = await pair()
    await give(a, b, 'k1')
    // The whole reason this is its own route: as a message it would be a TAB to
    // every already-shipped client.
    expect(
      (await http.get<unknown[]>(server.baseUrl, '/v1/messages?pending=1', b.token)).body,
    ).toEqual([])
    expect(
      (await http.get<unknown[]>(server.baseUrl, '/v1/messages?outbox=1', a.token)).body,
    ).toEqual([])
    expect(
      (await http.get<unknown[]>(server.baseUrl, '/v1/messages?history=1', a.token)).body,
    ).toEqual([])
  })
})

/**
 * What bounds this route [0031 amended].
 *
 * It used to be bounded by nothing: a row per item, held for the whole history window,
 * counted by no cap and reported by no usage figure. A tenant — a suspended one
 * included, since key distribution deliberately stays open under suspension — could
 * fill a relay's disk while every number an operator looked at said it was well inside
 * its quota. The queue caps still do not apply here, and still deliberately so: a
 * device refused its key because somebody's inbox is full stays unable to read history
 * it is entitled to, and unlike a queue that does not clear itself.
 */
describe('what bounds key distribution', () => {
  it('refuses an envelope far too large to be a group key', async () => {
    const { a, b } = await pair()
    const huge = {
      ...envelopeFor(b.e2ePubkey),
      ciphertext: 'A'.repeat(64 * 1024),
    }

    const res = await http.post<ApiError>(
      server.baseUrl,
      '/v1/group-keys',
      { items: [{ id: 'k-big', targetEndpointId: b.endpointId, envelope: huge }] },
      a.token,
    )
    // A shape error, not a limit: what belongs in one of these is a sealed 32-byte key,
    // so no retry of this item could ever succeed and holding it would be a lie.
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('invalid_request')
    expect(res.body.error.message).toContain('4096 bytes')
    expect(await server.db.selectFrom('group_keys').select('id').execute()).toEqual([])
  })

  it('spends the group send window, when the group has one', async () => {
    await restart({ caps: { sendsPerWindow: 2 } })
    const { a, b } = await pair()

    expect((await give(a, b, 'k1')).body.accepted).toEqual(['k1'])
    expect((await give(a, b, 'k2')).body.accepted).toEqual(['k2'])

    const third = await give(a, b, 'k3')
    expect(third.body.accepted).toEqual([])
    // `limit_reached` is the one per-item answer a client HOLDS rather than drops, and
    // every client already re-offers a key copy it was not told was accepted. The
    // window rolls over in CAP_SEND_WINDOW_SECONDS.
    expect(third.body.rejected).toEqual([
      { id: 'k3', reason: 'limit_reached', limit: 'sends_per_window' },
    ])
    expect(await server.db.selectFrom('group_keys').select('id').execute()).toHaveLength(2)
  })

  it('does not charge a replay a second time', async () => {
    await restart({ caps: { sendsPerWindow: 2 } })
    const { a, b } = await pair()

    expect((await give(a, b, 'k1')).body.accepted).toEqual(['k1'])
    // The same id again: already stored, so it occupies exactly what it occupied the
    // first time. Charging for it would let a client retrying a timed-out request talk
    // itself out of its own budget.
    expect((await give(a, b, 'k1')).body.accepted).toEqual(['k1'])
    expect((await give(a, b, 'k2')).body.accepted).toEqual(['k2'])
  })

  /**
   * The count bound, which needs no cap at all [0030 amended 2026-10-01]. The first
   * version of this fix leaned on the send window for the count, which is off by
   * default: with it off, a group (a suspended one included) could still store copies
   * without end. A real device holds one copy per key generation it has been handed.
   */
  it('holds at most 64 copies for one device, with no cap configured', async () => {
    const { a, b } = await pair()
    const items = Array.from({ length: 65 }, (_, i) => ({
      id: `k${i}`,
      targetEndpointId: b.endpointId,
      envelope: envelopeFor(b.e2ePubkey),
    }))
    const res = await http.post<GroupKeyResponse>(
      server.baseUrl,
      '/v1/group-keys',
      { items },
      a.token,
    )
    expect(res.body.accepted).toHaveLength(64)
    // Held and retried by every client, like any `limit_reached`; no `limit` name,
    // because this is a structural bound and not one of the group's caps.
    expect(res.body.rejected).toEqual([{ id: 'k64', reason: 'limit_reached' }])

    // A replay of a stored copy is still accepted: it takes no new slot.
    expect((await give(a, b, 'k0')).body.accepted).toEqual(['k0'])
    // The bound is per device, so another device is unaffected.
    expect((await give(b, a, 'for-a')).body.accepted).toEqual(['for-a'])
    expect(
      await server.db
        .selectFrom('group_keys')
        .select('id')
        .where('target_endpoint_id', '=', b.endpointId)
        .execute(),
    ).toHaveLength(64)
  })

  it('refuses an id too long to be a handle', async () => {
    const { a, b } = await pair()
    const atLimit = 'k'.repeat(128)
    expect((await give(a, b, atLimit)).body.accepted).toEqual([atLimit])

    // An id is the one part of a stored row nothing measured, so an unbounded one rode
    // past the size bound above, and on Postgres a long one failed its index with a 500.
    const res = await http.post<ApiError>(
      server.baseUrl,
      '/v1/group-keys',
      {
        items: [
          {
            id: 'k'.repeat(129),
            targetEndpointId: b.endpointId,
            envelope: envelopeFor(b.e2ePubkey),
          },
        ],
      },
      a.token,
    )
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('invalid_request')
    expect(res.body.error.message).toContain('at most 128 characters')
  })
})
