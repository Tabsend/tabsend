import { randomUUID } from 'node:crypto'
import type { GroupSealed, SendResponse } from '@tabsend/shared'
import { afterEach, describe, expect, it } from 'vitest'
import {
  effectiveCaps,
  getGroupCapOverrides,
  insertPairingCodeWithinCap,
  type PairingMintOutcome,
  setGroupCapOverrides,
} from '../src/caps'
import { newPairingCode } from '../src/ids'
import type { GroupUsage } from '../src/tenancy'
import {
  envelopeFor,
  http,
  pairingCodeFromLink,
  register,
  startTestServer,
  type TestServer,
  USE_POSTGRES,
} from './helpers'
import { holdGroupRow, waitForBlockedBehind } from './locks'

/**
 * Per-group caps [0030] (HOSTED_PLAN §4.3).
 *
 * What these prove, in order of how much they would hurt to get wrong:
 *  1. OFF by default — an existing relay upgrading to this version is unchanged.
 *  2. Each cap refuses the right thing, with a reason that names WHICH cap.
 *  3. A batch splits per item rather than failing whole ("Sent 2 of 3").
 *  4. An idempotent replay of an accepted item never counts twice.
 *  5. A per-group override outranks the relay-wide default, and 0 still means
 *     unlimited there even when the relay default is not.
 *  6. Under real concurrency the cap holds EXACTLY, which is §10.1's bar and the
 *     only one a check-then-insert would fail.
 */

let server: TestServer
afterEach(async () => {
  await server?.close()
})

/** Everything a send needs: two endpoints in the relay's own group. */
async function pair(): Promise<{
  source: Awaited<ReturnType<typeof register>>
  target: Awaited<ReturnType<typeof register>>
}> {
  const source = await register(server.baseUrl, { e2ePubkey: 'source-key' })
  const link = await http.post<{ link: string }>(
    server.baseUrl,
    '/v1/pairing',
    undefined,
    source.token,
  )
  const target = await register(server.baseUrl, {
    pairingCode: pairingCodeFromLink(link.body.link),
    e2ePubkey: 'target-key',
  })
  return { source, target }
}

function item(targetId: string, id = randomUUID()) {
  return { id, targetEndpointId: targetId, envelope: envelopeFor('target-key') }
}

/** The group-history copy riding a send [0028]. Opaque to the relay; a fixed size here. */
function historyBlob(): GroupSealed {
  return {
    alg: 'xsalsa20-poly1305/secretbox',
    keyId: 'group-key-id',
    nonce: Buffer.from('nonce-24-bytes-padding!!').toString('base64'),
    ciphertext: Buffer.from('x'.repeat(240)).toString('base64'),
  }
}

/** Turns the provisioning API on for the one test that reads usage back. */
const TOKEN = 'test-provisioning-credential'

type SendItem = ReturnType<typeof item> & { history?: GroupSealed }

async function send(token: string, items: SendItem[]) {
  return http.post<SendResponse>(server.baseUrl, '/v1/messages', { items }, token)
}

async function queuedRows(groupId: string): Promise<number> {
  const rows = await server.db
    .selectFrom('messages')
    .select('id')
    .where('group_id', '=', groupId)
    .execute()
  return rows.length
}

describe('caps are off by default', () => {
  it('accepts sends and joins with no cap columns set and no cap env', async () => {
    server = await startTestServer()
    const { source, target } = await pair()
    const res = await send(source.token, [item(target.endpointId), item(target.endpointId)])
    expect(res.body.accepted).toHaveLength(2)
    expect(res.body.rejected).toEqual([])

    // And the group row carries no overrides, so nothing was invented at create.
    expect(await getGroupCapOverrides(server.db, source.groupId)).toEqual({
      endpoints: null,
      queuedMessages: null,
      queuedBytes: null,
      sendsPerWindow: null,
    })
  })
})

describe('endpoint count cap', () => {
  it('refuses the join that would exceed it, and leaves the pairing link unused', async () => {
    // The relay owns its group (ADR-0023) and starts empty, so two joins fit.
    server = await startTestServer({ caps: { endpoints: 2 } })
    const first = await register(server.baseUrl)
    const link = await http.post<{ link: string }>(
      server.baseUrl,
      '/v1/pairing',
      undefined,
      first.token,
    )
    await register(server.baseUrl, { pairingCode: pairingCodeFromLink(link.body.link) })

    // A third device: a fresh link, and a refusal that names the number.
    const third = await http.post<{ link: string }>(
      server.baseUrl,
      '/v1/pairing',
      undefined,
      first.token,
    )
    const code = pairingCodeFromLink(third.body.link)
    const refused = await http.post<{ error: { code: string; message: string } }>(
      server.baseUrl,
      '/v1/endpoints/register',
      {
        label: 'Third',
        kind: 'extension',
        browser: 'chrome',
        platform: 'macos',
        pushSubscription: {
          transport: 'webpush',
          endpoint: 'https://push.test/e',
          keys: { p256dh: 'p', auth: 'a' },
        },
        e2ePubkey: 'third-key',
        pairingCode: code,
      },
    )
    expect(refused.status).toBe(409)
    expect(refused.body.error.code).toBe('limit_reached')
    expect(refused.body.error.message).toContain('2')

    // The link was NOT burned: the whole join rolls back, so it still works once
    // somebody makes room. Burning a single-use credential on a refusal would cost
    // the user a link per attempt.
    const row = await server.db
      .selectFrom('pairing_codes')
      .select('consumed_at')
      .where('code', '=', code)
      .executeTakeFirstOrThrow()
    expect(row.consumed_at).toBeNull()

    // Make room, and the SAME link now joins.
    const list = await server.db.selectFrom('endpoints').select('id').execute()
    await server.db
      .deleteFrom('endpoints')
      .where('id', '=', list[list.length - 1]?.id as string)
      .execute()
    const joined = await register(server.baseUrl, { pairingCode: code, e2ePubkey: 'third-key' })
    expect(joined.endpointId).toBeTruthy()
  })

  it('holds exactly under parallel joins racing the last slot', async () => {
    server = await startTestServer({ caps: { endpoints: 3 } })
    const first = await register(server.baseUrl)
    // Six links, six simultaneous joins, two slots left. Exactly two may win.
    const codes = await Promise.all(
      Array.from({ length: 6 }, async () => {
        const res = await http.post<{ link: string }>(
          server.baseUrl,
          '/v1/pairing',
          undefined,
          first.token,
        )
        return pairingCodeFromLink(res.body.link)
      }),
    )
    const results = await Promise.all(
      codes.map((pairingCode, i) =>
        http.post<unknown>(server.baseUrl, '/v1/endpoints/register', {
          label: `Racer ${i}`,
          kind: 'extension',
          browser: 'chrome',
          platform: 'macos',
          pushSubscription: {
            transport: 'webpush',
            endpoint: 'https://push.test/e',
            keys: { p256dh: 'p', auth: 'a' },
          },
          e2ePubkey: `racer-${i}`,
          pairingCode,
        }),
      ),
    )
    expect(results.filter((r) => r.status === 201)).toHaveLength(2)
    expect(results.filter((r) => r.status === 409)).toHaveLength(4)
    const rows = await server.db.selectFrom('endpoints').select('id').execute()
    expect(rows).toHaveLength(3)
  })
})

describe('queued-messages cap', () => {
  it('splits a batch per item and names the limit', async () => {
    server = await startTestServer({ caps: { queuedMessages: 2 } })
    const { source, target } = await pair()
    const res = await send(source.token, [
      item(target.endpointId),
      item(target.endpointId),
      item(target.endpointId),
    ])
    expect(res.body.accepted).toHaveLength(2)
    expect(res.body.rejected).toHaveLength(1)
    expect(res.body.rejected[0]).toMatchObject({
      reason: 'limit_reached',
      limit: 'queued_messages',
    })
    expect(await queuedRows(source.groupId)).toBe(2)
  })

  it('frees a slot when the target acks, so a full group drains itself', async () => {
    server = await startTestServer({ caps: { queuedMessages: 1 } })
    const { source, target } = await pair()
    const first = item(target.endpointId)
    expect((await send(source.token, [first])).body.accepted).toHaveLength(1)
    expect((await send(source.token, [item(target.endpointId)])).body.rejected).toHaveLength(1)

    const ack = await http.post(
      server.baseUrl,
      `/v1/messages/${first.id}/ack`,
      undefined,
      target.token,
    )
    expect(ack.status).toBe(200)
    expect((await send(source.token, [item(target.endpointId)])).body.accepted).toHaveLength(1)
  })

  it('never counts an idempotent replay twice', async () => {
    server = await startTestServer({ caps: { queuedMessages: 1 } })
    const { source, target } = await pair()
    const only = item(target.endpointId)
    expect((await send(source.token, [only])).body.accepted).toEqual([only.id])

    // The same id again, at a group that is now full. It is already stored, so it
    // occupies nothing new and must be accepted, not refused.
    const replay = await send(source.token, [only])
    expect(replay.body.accepted).toEqual([only.id])
    expect(replay.body.rejected).toEqual([])
    expect(await queuedRows(source.groupId)).toBe(1)
  })
})

describe('queued-bytes cap', () => {
  it('measures the stored envelope and refuses the item that would overflow', async () => {
    // The relay stores `JSON.stringify(envelope)` after normalising it, and the
    // normalised key order is the one envelopeFor already emits — so this is the
    // exact byte count the guard sums.
    const stored = Buffer.byteLength(JSON.stringify(envelopeFor('target-key')), 'utf8')
    server = await startTestServer({ caps: { queuedBytes: stored * 2 } })
    const { source, target } = await pair()
    const res = await send(source.token, [
      item(target.endpointId),
      item(target.endpointId),
      item(target.endpointId),
    ])
    expect(res.body.accepted).toHaveLength(2)
    expect(res.body.rejected[0]).toMatchObject({ reason: 'limit_reached', limit: 'queued_bytes' })
  })

  it('refuses a single item larger than the whole cap', async () => {
    server = await startTestServer({ caps: { queuedBytes: 32 } })
    const { source, target } = await pair()
    const res = await send(source.token, [item(target.endpointId)])
    expect(res.body.accepted).toEqual([])
    expect(res.body.rejected[0]).toMatchObject({ reason: 'limit_reached', limit: 'queued_bytes' })
  })

  /**
   * The hole this closed [0030 amended]: `history_blob` survives ack ([0028]) and
   * nothing measured it, so send-then-ack in a loop stored unbounded bytes for a
   * capped group while every cap kept reporting healthy. A cap on bytes bounds bytes.
   */
  it('counts a retained history blob, so send-then-ack cannot store forever', async () => {
    const envelopeBytes = Buffer.byteLength(JSON.stringify(envelopeFor('target-key')), 'utf8')
    const blobBytes = Buffer.byteLength(JSON.stringify(historyBlob()), 'utf8')
    // Room for one item at a time, plus a couple of retained blobs. If blobs were
    // free, this loop would run forever.
    server = await startTestServer({ caps: { queuedBytes: envelopeBytes + blobBytes * 3 } })
    const { source, target } = await pair()

    let accepted = 0
    let refusal: SendResponse['rejected'][number] | undefined
    for (let i = 0; i < 20; i++) {
      const next = item(target.endpointId)
      const res = await send(source.token, [{ ...next, history: historyBlob() }])
      if (res.body.rejected.length > 0) {
        refusal = res.body.rejected[0]
        break
      }
      accepted += 1
      // Ack empties the QUEUE — the envelope is erased — and the blob stays.
      const ack = await http.post(
        server.baseUrl,
        `/v1/messages/${next.id}/ack`,
        undefined,
        target.token,
      )
      expect(ack.status).toBe(200)
    }

    expect(accepted).toBeGreaterThan(0)
    expect(accepted).toBeLessThan(20)
    expect(refusal).toMatchObject({ reason: 'limit_reached', limit: 'queued_bytes' })

    // The queue is empty and the group is still at its byte cap, which is the whole
    // point: the bytes it is refused for are bytes it genuinely has stored.
    const queued = await server.db
      .selectFrom('messages')
      .select('id')
      .where('group_id', '=', source.groupId)
      .where('envelope', 'is not', null)
      .execute()
    expect(queued).toHaveLength(0)
  })

  it('reports the same bytes to the provisioning API as the guard refuses on', async () => {
    // A control plane reading "N of M bytes" and a relay refusing the next send must
    // be counting the same thing, or the number an operator acts on is not the number
    // that refused their customer.
    server = await startTestServer({ caps: { queuedBytes: 100_000 }, provisioningToken: TOKEN })
    const { source, target } = await pair()
    const first = item(target.endpointId)
    await send(source.token, [{ ...first, history: historyBlob() }])
    await http.post(server.baseUrl, `/v1/messages/${first.id}/ack`, undefined, target.token)

    const usage = await http.get<GroupUsage>(
      server.baseUrl,
      `/admin/provisioning/groups/${source.groupId}/usage`,
      TOKEN,
    )
    expect(usage.status).toBe(200)
    // Nothing queued, and bytes still held: the acked row's history blob.
    expect(usage.body.queue.messages).toBe(0)
    expect(usage.body.queue.bytes).toBe(Buffer.byteLength(JSON.stringify(historyBlob()), 'utf8'))
    expect(usage.body.caps.remaining.queuedBytes).toBe(100_000 - usage.body.queue.bytes)
  })
})

describe('sends-per-window cap', () => {
  it('refuses past the budget and lets the next window through', async () => {
    server = await startTestServer({ caps: { sendsPerWindow: 2, sendWindowMs: 60_000 } })
    const { source, target } = await pair()
    const res = await send(source.token, [
      item(target.endpointId),
      item(target.endpointId),
      item(target.endpointId),
    ])
    expect(res.body.accepted).toHaveLength(2)
    expect(res.body.rejected[0]).toMatchObject({
      reason: 'limit_reached',
      limit: 'sends_per_window',
    })

    // Same window: still refused.
    expect((await send(source.token, [item(target.endpointId)])).body.rejected).toHaveLength(1)
    // Next window: allowed again, with no operator action.
    server.clock.advance(60_000)
    expect((await send(source.token, [item(target.endpointId)])).body.accepted).toHaveLength(1)
  })

  it('does not spend the window on a replay', async () => {
    server = await startTestServer({ caps: { sendsPerWindow: 2, sendWindowMs: 60_000 } })
    const { source, target } = await pair()
    const first = item(target.endpointId)
    await send(source.token, [first])
    await send(source.token, [first])
    await send(source.token, [first])
    // One unit spent, so one is left for a genuinely new tab.
    expect((await send(source.token, [item(target.endpointId)])).body.accepted).toHaveLength(1)
    expect((await send(source.token, [item(target.endpointId)])).body.rejected).toHaveLength(1)
  })
})

describe('per-group overrides', () => {
  it('outrank the relay-wide default, and 0 means unlimited for that group', async () => {
    server = await startTestServer({ caps: { queuedMessages: 1 } })
    const { source, target } = await pair()

    // The relay says 1. This group says 3.
    expect(await setGroupCapOverrides(server.db, source.groupId, { queuedMessages: 3 })).toBe(true)
    expect(
      (await effectiveCaps(server.db, server.config.caps, source.groupId)).queuedMessages,
    ).toBe(3)
    const three = await send(source.token, [
      item(target.endpointId),
      item(target.endpointId),
      item(target.endpointId),
    ])
    expect(three.body.accepted).toHaveLength(3)

    // 0 is an explicit "unlimited here", not "fall back to the relay".
    await setGroupCapOverrides(server.db, source.groupId, { queuedMessages: 0 })
    expect(
      (await effectiveCaps(server.db, server.config.caps, source.groupId)).queuedMessages,
    ).toBe(0)
    expect((await send(source.token, [item(target.endpointId)])).body.accepted).toHaveLength(1)

    // null clears it back to the relay-wide default, which is 1 and now exceeded.
    await setGroupCapOverrides(server.db, source.groupId, { queuedMessages: null })
    expect(
      (await effectiveCaps(server.db, server.config.caps, source.groupId)).queuedMessages,
    ).toBe(1)
    expect((await send(source.token, [item(target.endpointId)])).body.rejected).toHaveLength(1)
  })

  it('patch semantics: an omitted cap is untouched, and an unknown group reports false', async () => {
    server = await startTestServer()
    const { source } = await pair()
    await setGroupCapOverrides(server.db, source.groupId, { endpoints: 5, queuedBytes: 99 })
    await setGroupCapOverrides(server.db, source.groupId, { endpoints: 7 })
    expect(await getGroupCapOverrides(server.db, source.groupId)).toEqual({
      endpoints: 7,
      queuedMessages: null,
      queuedBytes: 99,
      sendsPerWindow: null,
    })
    expect(await setGroupCapOverrides(server.db, 'no-such-group', { endpoints: 1 })).toBe(false)
  })
})

describe('exactness under concurrency (HOSTED_PLAN §10.1)', () => {
  it(`holds the queued-messages cap exactly with parallel sends (${USE_POSTGRES ? 'postgres' : 'sqlite'})`, async () => {
    // The bar is "every cap still enforced EXACTLY at a further 10× overload". On
    // Postgres this is the test that fails a check-then-insert: READ COMMITTED gives
    // every racer the same pre-insert count, so each one would write and the cap
    // would overshoot by roughly the number of racers.
    const cap = 5
    server = await startTestServer({ caps: { queuedMessages: cap } })
    const { source, target } = await pair()

    const results = await Promise.all(
      Array.from({ length: 15 }, () => send(source.token, [item(target.endpointId)])),
    )
    const accepted = results.flatMap((r) => r.body.accepted)
    const rejected = results.flatMap((r) => r.body.rejected)
    expect(accepted).toHaveLength(cap)
    expect(rejected).toHaveLength(15 - cap)
    expect(rejected.every((r) => r.reason === 'limit_reached')).toBe(true)
    // The store agrees with the answers given, which is the half a client cannot see.
    expect(await queuedRows(source.groupId)).toBe(cap)
  })

  it(`holds the sends-per-window cap exactly with parallel sends (${USE_POSTGRES ? 'postgres' : 'sqlite'})`, async () => {
    const cap = 4
    server = await startTestServer({ caps: { sendsPerWindow: cap, sendWindowMs: 600_000 } })
    const { source, target } = await pair()
    const results = await Promise.all(
      Array.from({ length: 12 }, () => send(source.token, [item(target.endpointId)])),
    )
    expect(results.flatMap((r) => r.body.accepted)).toHaveLength(cap)
    expect(await queuedRows(source.groupId)).toBe(cap)
  })
})

/**
 * The live pairing-code limit [0031 amended].
 *
 * Not one of the four per-group caps and deliberately not overridable: it bounds a
 * TABLE, not a tier. `POST /v1/pairing` wrote a row per call, nothing counted them and
 * nothing removed them, so one authenticated device could grow a relay's database
 * without end and without touching any cap. On by default for that reason — nothing
 * legitimate comes near it, because a link is minted to hand to a device in front of
 * you and it expires in ten minutes.
 *
 * The relay's own first-run link (ADR-0023) is one of the group's live links and
 * occupies a slot, which is right and is why the arithmetic below counts it.
 */
describe('how many pairing links one group may have waiting', () => {
  const mint = (token: string) =>
    http.post<{ link: string } & { error?: { code: string; message: string } }>(
      server.baseUrl,
      '/v1/pairing',
      undefined,
      token,
    )

  /** Links this relay's group is holding: minted, unused, unexpired. */
  async function liveCodes(): Promise<number> {
    const rows = await server.db
      .selectFrom('pairing_codes')
      .select('code')
      .where('consumed_at', 'is', null)
      .where('expires_at', '>', server.clock.now().toISOString())
      .execute()
    return rows.length
  }

  it('refuses the one past the limit, and says how long to wait', async () => {
    server = await startTestServer({ pairingCodesMaxLive: 3 })
    const a = await register(server.baseUrl)
    // The relay's own first-run link stopped counting when this first device joined:
    // the first join retires every other first link the group held [0031 amended].
    expect(await liveCodes()).toBe(0)

    for (let i = 0; i < 3; i += 1) expect((await mint(a.token)).status).toBe(201)

    const past = await mint(a.token)
    expect(past.status).toBe(409)
    expect(past.body.error?.code).toBe('limit_reached')
    // What to do, and how long: no client can show an earlier link again, so "use one
    // of those" was never something a person could act on.
    expect(past.body.error?.message).toContain('Try again in 10 minutes')
    expect(past.body.error?.message).not.toContain('—')
    expect(await liveCodes()).toBe(3)
  })

  it('counts only LIVE codes, so using one frees its slot', async () => {
    server = await startTestServer({ pairingCodesMaxLive: 2 })
    const a = await register(server.baseUrl)

    const spare = await mint(a.token)
    expect(spare.status).toBe(201)
    expect((await mint(a.token)).status).toBe(201)
    expect((await mint(a.token)).status).toBe(409)

    // Consumed by a join: spent, so it is no longer one of the links this group holds.
    await register(server.baseUrl, { pairingCode: pairingCodeFromLink(spare.body.link) })
    expect((await mint(a.token)).status).toBe(201)
  })

  it('counts only UNEXPIRED codes, so a full group clears itself with time', async () => {
    server = await startTestServer({ pairingCodesMaxLive: 2 })
    const a = await register(server.baseUrl)
    expect((await mint(a.token)).status).toBe(201)
    expect((await mint(a.token)).status).toBe(201)
    expect((await mint(a.token)).status).toBe(409)

    // One link lifetime later, both have expired without being used.
    server.clock.advance(server.config.pairingCodeTtlMs + 1)
    expect((await mint(a.token)).status).toBe(201)
  })

  it(`holds the limit exactly under parallel mints (${USE_POSTGRES ? 'postgres' : 'sqlite'})`, async () => {
    server = await startTestServer({ pairingCodesMaxLive: 3 })
    const a = await register(server.baseUrl)

    const results = await Promise.all(Array.from({ length: 12 }, () => mint(a.token)))
    expect(await liveCodes()).toBe(3)
    expect(results.filter((r) => r.status === 201)).toHaveLength(3)
    expect(results.filter((r) => r.status === 409)).toHaveLength(9)
  })

  /**
   * The database half of that exactness, pinned on its own. The route queues a group's
   * mints in process (group-queue.ts), which on its own would make the test above pass
   * even with the row lock gone; but the lock is what holds across relay processes and
   * against a deletion. So these mints skip the queue, wait together behind the test's
   * own hold on the group row, and are released at once: without the lock every one of
   * them counts before waiting, and the limit overshoots every time.
   */
  it.skipIf(!USE_POSTGRES)(
    'holds the limit in the database itself, without the queue',
    async () => {
      server = await startTestServer({ pairingCodesMaxLive: 3 })
      const a = await register(server.baseUrl)
      const groupId = a.groupId as unknown as string
      const nowIso = server.clock.now().toISOString()
      const expiresAt = new Date(server.clock.now().getTime() + 600_000).toISOString()

      const hold = holdGroupRow(server.db, groupId)
      let outcomes: Promise<PairingMintOutcome[]> | undefined
      try {
        const holder = await hold.ready
        outcomes = Promise.all(
          Array.from({ length: 6 }, () =>
            insertPairingCodeWithinCap(
              server.db,
              true,
              {
                code: newPairingCode(),
                group_id: groupId,
                created_at: nowIso,
                expires_at: expiresAt,
              },
              a.endpointId as unknown as string,
              3,
              nowIso,
            ),
          ),
        )
        await waitForBlockedBehind(server.db, holder, 6)
      } finally {
        hold.release()
        await hold.done
      }

      const settled = await outcomes
      expect(settled.filter((o) => o === 'minted')).toHaveLength(3)
      expect(settled.filter((o) => o === 'capped')).toHaveLength(3)
      expect(await liveCodes()).toBe(3)
    },
  )

  it('is off when set to 0, like every other limit in this relay', async () => {
    server = await startTestServer({ pairingCodesMaxLive: 0 })
    const a = await register(server.baseUrl)
    for (let i = 0; i < 25; i += 1) {
      expect((await mint(a.token)).status).toBe(201)
    }
  })

  /**
   * The two answers that are not about the limit, on both dialects, asked of the
   * function directly because reaching them through the route takes a race.
   */
  it('mints nothing for a group that is gone, or for a device no longer in it', async () => {
    server = await startTestServer()
    const a = await register(server.baseUrl)
    const groupId = a.groupId as unknown as string
    const nowIso = server.clock.now().toISOString()
    const row = (group: string) => ({
      code: newPairingCode(),
      group_id: group,
      created_at: nowIso,
      expires_at: nowIso,
    })

    expect(
      await insertPairingCodeWithinCap(
        server.db,
        USE_POSTGRES,
        row('no-such-group'),
        'x',
        20,
        nowIso,
      ),
    ).toBe('gone')
    // Off as well as on: the limit is not what decides either of these.
    expect(
      await insertPairingCodeWithinCap(
        server.db,
        USE_POSTGRES,
        row('no-such-group'),
        'x',
        0,
        nowIso,
      ),
    ).toBe('gone')
    expect(
      await insertPairingCodeWithinCap(
        server.db,
        USE_POSTGRES,
        row(groupId),
        'removed-device',
        20,
        nowIso,
      ),
    ).toBe('caller_gone')
    expect(
      await insertPairingCodeWithinCap(
        server.db,
        USE_POSTGRES,
        row(groupId),
        a.endpointId as unknown as string,
        0,
        nowIso,
      ),
    ).toBe('minted')
  })
})
