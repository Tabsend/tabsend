import type { ApiError, GroupKeyResponse, SendResponse } from '@tabsend/shared'
import { sql } from 'kysely'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mintFirstPairingForGroup } from '../src/bootstrap'
import { deleteGroupCascade, type GroupDeletion } from '../src/tenancy'
import {
  envelopeFor,
  http,
  pairingCodeFromLink,
  type RegisteredEndpoint,
  register,
  startTestServer,
  type TestServer,
  USE_POSTGRES,
} from './helpers'
import { holdGroupRow, type Watched, waitForBlockedBehind, watch } from './locks'

/**
 * The races a hosted relay has that a household one does not [0031 amended]: a tenancy
 * torn down while its devices are still writing to it, a device removed while the rest
 * of its group is writing to it, and the first pairing link minted while a device joins.
 *
 * POSTGRES ONLY, and that is not a gap. On SQLite these interleavings cannot exist:
 * Kysely serves one connection behind a mutex, so a transaction is exclusive of every
 * other statement in the process. Postgres is where two writers really do overlap,
 * which is why every one of these paths holds the group row there, first, and why the
 * tests that prove it have to run there. `TABSEND_TEST_PG=1` runs them; CI runs both
 * dialects.
 *
 * HOW THESE ARE MADE DETERMINISTIC: each test holds the group row itself (locks.ts),
 * starts the operations one at a time, and confirms each one is WAITING behind that hold
 * before starting the next. Waiters get the row in the order they queued, so the
 * interleaving under test is chosen rather than hoped for, and a path that stopped
 * taking the row fails the wait instead of passing quietly. Each test names the defect
 * it would catch.
 */

let server: TestServer

afterEach(async () => {
  await server?.close()
})

/** Two devices in one group: `a` paired first, `b` joined with a link `a` minted. */
async function pairedGroup(): Promise<{
  a: RegisteredEndpoint
  b: RegisteredEndpoint
  groupId: string
}> {
  const a = await register(server.baseUrl, { label: 'Chrome · Work' })
  const code = pairingCodeFromLink(
    (await http.post<{ link: string }>(server.baseUrl, '/v1/pairing', undefined, a.token)).body
      .link,
  )
  const b = await register(server.baseUrl, { label: 'Pixel · Phone', pairingCode: code })
  return { a, b, groupId: a.groupId as unknown as string }
}

async function rowsFor(table: 'messages' | 'group_keys' | 'removed_endpoints', groupId: string) {
  return server.db.selectFrom(table).selectAll().where('group_id', '=', groupId).execute()
}

const send = (from: RegisteredEndpoint, to: RegisteredEndpoint) =>
  http.post<SendResponse | ApiError>(
    server.baseUrl,
    '/v1/messages',
    { items: [{ id: 'm1', targetEndpointId: to.endpointId, envelope: envelopeFor(to.e2ePubkey) }] },
    from.token,
  )

const uploadKey = (from: RegisteredEndpoint, to: RegisteredEndpoint) =>
  http.post<GroupKeyResponse | ApiError>(
    server.baseUrl,
    '/v1/group-keys',
    { items: [{ id: 'k1', targetEndpointId: to.endpointId, envelope: envelopeFor(to.e2ePubkey) }] },
    from.token,
  )

const removeDevice = (by: RegisteredEndpoint, id: string) =>
  http.del<{ ok: true } | ApiError>(server.baseUrl, `/v1/endpoints/${id}`, by.token)

describe.skipIf(!USE_POSTGRES)('deleting a tenancy while its devices are writing', () => {
  /**
   * Catches a send that does not hold the group row. The teardown was atomic but not
   * ORDERED: a send that had read past the group row could commit after the teardown
   * swept `messages` and before it removed the group, leaving ciphertext in a tenancy
   * reported as deleted (`messages.group_id` is not a foreign key).
   */
  it('refuses a send queued behind the teardown, and stores nothing', async () => {
    server = await startTestServer()
    const { a, b, groupId } = await pairedGroup()

    const hold = holdGroupRow(server.db, groupId)
    let teardown!: Watched<GroupDeletion>
    let sending!: Watched<Awaited<ReturnType<typeof send>>>
    try {
      const holder = await hold.ready
      teardown = watch(deleteGroupCascade(server.db, true, groupId))
      await waitForBlockedBehind(server.db, holder, 1)
      sending = watch(send(a, b))
      await waitForBlockedBehind(server.db, holder, 2)
      expect(teardown.settled()).toBe(false)
      expect(sending.settled()).toBe(false)
    } finally {
      hold.release()
      await hold.done
    }

    expect((await teardown.value).existed).toBe(true)
    const result = await sending.value
    // Told what happened rather than a 500 on a group that vanished.
    expect(result.status).toBe(404)
    expect((result.body as ApiError).error.code).toBe('not_found')
    expect(await rowsFor('messages', groupId)).toEqual([])
  })

  /**
   * Catches a teardown that does not hold the group row FIRST. The send wins the row,
   * so its tab really is stored, and the teardown queued behind it must sweep it. A
   * teardown that only reached the group row at its final DELETE would sweep `messages`
   * before the send committed, and leave the tab behind.
   */
  it('sweeps a send that won the row, and reports it', async () => {
    server = await startTestServer()
    const { a, b, groupId } = await pairedGroup()

    const hold = holdGroupRow(server.db, groupId)
    let teardown!: Watched<GroupDeletion>
    let sending!: Watched<Awaited<ReturnType<typeof send>>>
    try {
      const holder = await hold.ready
      sending = watch(send(a, b))
      await waitForBlockedBehind(server.db, holder, 1)
      teardown = watch(deleteGroupCascade(server.db, true, groupId))
      await waitForBlockedBehind(server.db, holder, 2)
    } finally {
      hold.release()
      await hold.done
    }

    const result = await sending.value
    expect(result.status).toBe(200)
    expect((result.body as SendResponse).accepted).toEqual(['m1'])
    const deletion = await teardown.value
    expect(deletion.deleted.messages).toBe(1)
    expect(await rowsFor('messages', groupId)).toEqual([])
  })

  /** The same pair of orderings for `group_keys`, the other table with no foreign key. */
  it('refuses a group-key upload queued behind the teardown', async () => {
    server = await startTestServer()
    const { a, b, groupId } = await pairedGroup()

    const hold = holdGroupRow(server.db, groupId)
    let teardown!: Watched<GroupDeletion>
    let upload!: Watched<Awaited<ReturnType<typeof uploadKey>>>
    try {
      const holder = await hold.ready
      teardown = watch(deleteGroupCascade(server.db, true, groupId))
      await waitForBlockedBehind(server.db, holder, 1)
      upload = watch(uploadKey(a, b))
      await waitForBlockedBehind(server.db, holder, 2)
    } finally {
      hold.release()
      await hold.done
    }

    await teardown.value
    expect((await upload.value).status).toBe(404)
    expect(await rowsFor('group_keys', groupId)).toEqual([])
  })

  it('sweeps a group-key upload that won the row', async () => {
    server = await startTestServer()
    const { a, b, groupId } = await pairedGroup()

    const hold = holdGroupRow(server.db, groupId)
    let teardown!: Watched<GroupDeletion>
    let upload!: Watched<Awaited<ReturnType<typeof uploadKey>>>
    try {
      const holder = await hold.ready
      upload = watch(uploadKey(a, b))
      await waitForBlockedBehind(server.db, holder, 1)
      teardown = watch(deleteGroupCascade(server.db, true, groupId))
      await waitForBlockedBehind(server.db, holder, 2)
    } finally {
      hold.release()
      await hold.done
    }

    expect(((await upload.value).body as GroupKeyResponse).accepted).toEqual(['k1'])
    expect((await teardown.value).deleted.groupKeys).toBe(1)
    expect(await rowsFor('group_keys', groupId)).toEqual([])
  })

  /**
   * Catches the deadlock [2026-10-01 follow-up review, R1]. A join used to consume its
   * pairing code and only then reach the group row, through its endpoint insert's
   * foreign key; the teardown holds the group row and then deletes pairing codes. Two
   * locks in opposite orders: Postgres broke the cycle after a second by failing one
   * side with a 500, and a failed teardown leaves a tenancy its owner asked to delete.
   */
  it('turns away a join queued behind the teardown cleanly, without a deadlock', async () => {
    server = await startTestServer()
    const a = await register(server.baseUrl)
    const groupId = a.groupId as unknown as string
    const link = (
      await http.post<{ link: string }>(server.baseUrl, '/v1/pairing', undefined, a.token)
    ).body.link

    const hold = holdGroupRow(server.db, groupId)
    let teardown!: Watched<GroupDeletion>
    let join!: Watched<Awaited<ReturnType<typeof http.post<ApiError>>>>
    try {
      const holder = await hold.ready
      teardown = watch(deleteGroupCascade(server.db, true, groupId))
      await waitForBlockedBehind(server.db, holder, 1)
      join = watch(
        http.post<ApiError>(server.baseUrl, '/v1/endpoints/register', {
          label: 'Late',
          kind: 'extension',
          browser: 'chrome',
          platform: 'macos',
          e2ePubkey: 'late-key',
          pushSubscription: { transport: 'none' },
          pairingCode: pairingCodeFromLink(link),
        }),
      )
      await waitForBlockedBehind(server.db, holder, 2)
    } finally {
      hold.release()
      await hold.done
    }

    // Both finish, neither as a 500: the deletion completes, and the join is told its
    // link no longer works, which is true.
    expect((await teardown.value).existed).toBe(true)
    const joined = await join.value
    expect(joined.status).toBe(400)
    expect(joined.body.error.code).toBe('invalid_pairing_code')
    expect(
      await server.db
        .selectFrom('endpoints')
        .select('id')
        .where('group_id', '=', groupId)
        .execute(),
    ).toEqual([])
  })

  /** The other order: the join wins the row, and the teardown takes its device too. */
  it('sweeps a device whose join won the row', async () => {
    server = await startTestServer()
    const a = await register(server.baseUrl)
    const groupId = a.groupId as unknown as string
    const link = (
      await http.post<{ link: string }>(server.baseUrl, '/v1/pairing', undefined, a.token)
    ).body.link

    const hold = holdGroupRow(server.db, groupId)
    let teardown!: Watched<GroupDeletion>
    let join!: Watched<Awaited<ReturnType<typeof register>>>
    try {
      const holder = await hold.ready
      join = watch(register(server.baseUrl, { pairingCode: pairingCodeFromLink(link) }))
      await waitForBlockedBehind(server.db, holder, 1)
      teardown = watch(deleteGroupCascade(server.db, true, groupId))
      await waitForBlockedBehind(server.db, holder, 2)
    } finally {
      hold.release()
      await hold.done
    }

    expect((await join.value).endpointId).toBeTruthy()
    expect((await teardown.value).deleted.endpoints).toBe(2)
  })

  /**
   * Catches a device removal that does not hold the group row [R8]. `removed_endpoints`
   * has no foreign key to `groups`, so an unordered removal could commit its tombstone
   * (a token hash and ids) after the teardown swept that table, in a tenancy reported
   * as gone.
   */
  it('turns away a device removal queued behind the teardown, and leaves no tombstone', async () => {
    server = await startTestServer()
    const { a, b, groupId } = await pairedGroup()

    const hold = holdGroupRow(server.db, groupId)
    let teardown!: Watched<GroupDeletion>
    let removal!: Watched<Awaited<ReturnType<typeof removeDevice>>>
    try {
      const holder = await hold.ready
      teardown = watch(deleteGroupCascade(server.db, true, groupId))
      await waitForBlockedBehind(server.db, holder, 1)
      removal = watch(removeDevice(a, b.endpointId as unknown as string))
      await waitForBlockedBehind(server.db, holder, 2)
    } finally {
      hold.release()
      await hold.done
    }

    await teardown.value
    expect((await removal.value).status).toBe(404)
    expect(await rowsFor('removed_endpoints', groupId)).toEqual([])
  })
})

describe.skipIf(!USE_POSTGRES)('removing a device while the rest of its group is writing', () => {
  /**
   * Catches a write that reads its targets before taking the group row [R16]. The read
   * used to happen first, so a removal could land between it and the insert, and the
   * relay stored a key copy (or queued a tab) for a device no longer in the group. The
   * upload here is confirmed to be queued behind the removal before the row is let go.
   */
  it('stores no key copy for a device removed just before the upload', async () => {
    server = await startTestServer()
    const { a, b, groupId } = await pairedGroup()

    const hold = holdGroupRow(server.db, groupId)
    let removal!: Watched<Awaited<ReturnType<typeof removeDevice>>>
    let upload!: Watched<Awaited<ReturnType<typeof uploadKey>>>
    try {
      const holder = await hold.ready
      removal = watch(removeDevice(a, b.endpointId as unknown as string))
      await waitForBlockedBehind(server.db, holder, 1)
      upload = watch(uploadKey(a, b))
      // Queued in process behind the removal, so its target read has not happened yet.
      await vi.waitFor(() => expect(server.groupWrites.pendingFor(groupId)).toBe(2), {
        timeout: 5_000,
      })
    } finally {
      hold.release()
      await hold.done
    }

    expect((await removal.value).status).toBe(200)
    const result = (await upload.value).body as GroupKeyResponse
    expect(result.accepted).toEqual([])
    expect(result.rejected).toEqual([{ id: 'k1', reason: 'unknown_target' }])
    expect(await rowsFor('group_keys', groupId)).toEqual([])
  })

  it('queues no tab for a device removed just before the send', async () => {
    server = await startTestServer()
    const { a, b, groupId } = await pairedGroup()

    const hold = holdGroupRow(server.db, groupId)
    let removal!: Watched<Awaited<ReturnType<typeof removeDevice>>>
    let sending!: Watched<Awaited<ReturnType<typeof send>>>
    try {
      const holder = await hold.ready
      removal = watch(removeDevice(a, b.endpointId as unknown as string))
      await waitForBlockedBehind(server.db, holder, 1)
      sending = watch(send(a, b))
      await vi.waitFor(() => expect(server.groupWrites.pendingFor(groupId)).toBe(2), {
        timeout: 5_000,
      })
    } finally {
      hold.release()
      await hold.done
    }

    expect((await removal.value).status).toBe(200)
    const result = (await sending.value).body as SendResponse
    expect(result.accepted).toEqual([])
    expect(result.rejected).toEqual([{ id: 'm1', reason: 'unknown_target' }])
    expect(await rowsFor('messages', groupId)).toEqual([])
  })
})

describe.skipIf(!USE_POSTGRES)('a join waits for its group only with a live code', () => {
  /**
   * Catches a join that takes the group row before judging its code [2026-10-01]. Join
   * needs no device token, and the group row is what every write of that group waits
   * on, so a join that queued for the row first let anybody holding any code of a
   * group, a used or expired one included, park a pooled connection behind it. A dead
   * code is now refused before anything is locked or queued.
   */
  it('refuses a used code at once, even while the group row is held', async () => {
    server = await startTestServer()
    const a = await register(server.baseUrl)
    const groupId = a.groupId as unknown as string
    const link = (
      await http.post<{ link: string }>(server.baseUrl, '/v1/pairing', undefined, a.token)
    ).body.link
    await register(server.baseUrl, { pairingCode: pairingCodeFromLink(link) })

    const hold = holdGroupRow(server.db, groupId)
    try {
      await hold.ready
      const again = await Promise.race([
        http.post<ApiError>(server.baseUrl, '/v1/endpoints/register', {
          label: 'Again',
          kind: 'extension',
          browser: 'chrome',
          platform: 'macos',
          e2ePubkey: 'again-key',
          pushSubscription: { transport: 'none' },
          pairingCode: pairingCodeFromLink(link),
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('the join waited for the held group row')), 2_000),
        ),
      ])
      expect(again.status).toBe(400)
      expect(again.body.error.message).toBe('Pairing link already used.')
    } finally {
      hold.release()
      await hold.done
    }
  })
})

describe.skipIf(!USE_POSTGRES)('a device removed while its own request waits', () => {
  /**
   * The removal re-reads the caller under the hold, as the mint does: a device removed
   * a moment ago gets the answer its next call would get, not one last removal of
   * somebody else.
   */
  it('turns away a removal sent by a device that was removed first', async () => {
    server = await startTestServer()
    const { a, b, groupId } = await pairedGroup()
    const c = await register(server.baseUrl, {
      pairingCode: pairingCodeFromLink(
        (await http.post<{ link: string }>(server.baseUrl, '/v1/pairing', undefined, b.token)).body
          .link,
      ),
    })
    const aRow = await server.db
      .selectFrom('endpoints')
      .select(['device_token_hash'])
      .where('id', '=', a.endpointId as unknown as string)
      .executeTakeFirstOrThrow()

    const hold = holdGroupRow(server.db, groupId)
    let removal!: Watched<Awaited<ReturnType<typeof removeDevice>>>
    try {
      const holder = await hold.ready
      removal = watch(removeDevice(a, c.endpointId as unknown as string))
      await waitForBlockedBehind(server.db, holder, 1)
      // A is removed while its own request waits for the row.
      await server.db
        .insertInto('removed_endpoints')
        .values({
          device_token_hash: aRow.device_token_hash,
          endpoint_id: a.endpointId as unknown as string,
          group_id: groupId,
          removed_at: server.clock.now().toISOString(),
        })
        .execute()
      await server.db
        .deleteFrom('endpoints')
        .where('id', '=', a.endpointId as unknown as string)
        .execute()
    } finally {
      hold.release()
      await hold.done
    }

    const res = await removal.value
    expect(res.status).toBe(401)
    expect((res.body as ApiError).error.code).toBe('endpoint_removed')
    const left = await server.db
      .selectFrom('endpoints')
      .select('id')
      .where('id', '=', c.endpointId as unknown as string)
      .execute()
    expect(left).toHaveLength(1)
  })
})

describe.skipIf(!USE_POSTGRES)('minting the first pairing link while a device joins', () => {
  const RETIRED = 'stopped working when the first device joined'

  /** A provisioned group with nobody in it, and its first link. */
  async function emptyGroup(id: string): Promise<{ link: string }> {
    server = await startTestServer({ groupCreation: 'provisioned' })
    await server.db
      .insertInto('groups')
      .values({ id, created_at: '2026-07-16T12:00:00.000Z' })
      .execute()
    const first = await mintFirstPairingForGroup(
      server.db,
      server.config,
      id,
      undefined,
      new Date('2026-07-16T12:00:00.000Z'),
    )
    if (first.status !== 'minted') throw new Error('expected a first link')
    return first.pairing
  }

  const mintAt = (groupId: string, minute: number) =>
    mintFirstPairingForGroup(
      server.db,
      server.config,
      groupId,
      undefined,
      new Date(`2026-07-16T12:${String(minute).padStart(2, '0')}:00.000Z`),
    )

  const joinWith = (link: string) =>
    http.post<ApiError>(server.baseUrl, '/v1/endpoints/register', {
      label: 'Joiner',
      kind: 'extension',
      browser: 'chrome',
      platform: 'macos',
      e2ePubkey: `key-${link.slice(-8)}`,
      pushSubscription: { transport: 'none' },
      pairingCode: pairingCodeFromLink(link),
    })

  async function liveLinks(groupId: string) {
    return server.db
      .selectFrom('pairing_codes')
      .select('code')
      .where('group_id', '=', groupId)
      .where('consumed_at', 'is', null)
      .where('expires_at', '>', server.clock.now().toISOString())
      .execute()
  }

  /**
   * Catches a mint that checks emptiness outside the hold. The check and the insert
   * used to be two statements with nothing between them, so a device joining in the gap
   * left a link minted "for an empty group" that was in fact a way into a populated one
   * (HOSTED_PLAN §5, "the account page cannot mint into a populated group").
   */
  it('refuses a mint queued behind a join, even though it was asked for first', async () => {
    const groupId = 'g-mint-race'
    const first = await emptyGroup(groupId)

    const hold = holdGroupRow(server.db, groupId)
    let join!: Watched<Awaited<ReturnType<typeof joinWith>>>
    let mint!: Watched<Awaited<ReturnType<typeof mintAt>>>
    try {
      const holder = await hold.ready
      join = watch(joinWith(first.link))
      await waitForBlockedBehind(server.db, holder, 1)
      mint = watch(mintAt(groupId, 5))
      await waitForBlockedBehind(server.db, holder, 2)
    } finally {
      hold.release()
      await hold.done
    }

    expect((await join.value).status).toBe(201)
    expect((await mint.value).status).toBe('populated')
    expect(await liveLinks(groupId)).toEqual([])
  })

  /**
   * Catches a join that does not retire the group's other first links [R2]. The mint
   * wins the row and makes a second link; the join behind it is the group's first, and
   * the link the mint just made must stop working the moment it lands.
   */
  it('retires the link a mint made just before the first join', async () => {
    const groupId = 'g-mint-then-join'
    const first = await emptyGroup(groupId)

    const hold = holdGroupRow(server.db, groupId)
    let mint!: Watched<Awaited<ReturnType<typeof mintAt>>>
    let join!: Watched<Awaited<ReturnType<typeof joinWith>>>
    try {
      const holder = await hold.ready
      mint = watch(mintAt(groupId, 5))
      await waitForBlockedBehind(server.db, holder, 1)
      join = watch(joinWith(first.link))
      await waitForBlockedBehind(server.db, holder, 2)
    } finally {
      hold.release()
      await hold.done
    }

    const second = await mint.value
    expect(second.status).toBe('minted')
    expect((await join.value).status).toBe(201)
    expect(await liveLinks(groupId)).toEqual([])
    if (second.status !== 'minted') return
    const late = await joinWith(second.pairing.link)
    expect(late.status).toBe(400)
    expect(late.body.error.message).toContain(RETIRED)
  })

  /**
   * Two mints racing on an empty group, held so they really do queue together. Both
   * stand until somebody pairs, because each is a way to become the FIRST device; the
   * first join then retires the other, so none survives into a populated group.
   */
  it('lets two racing mints both stand until the first join retires the other', async () => {
    const groupId = 'g-double-mint'
    await emptyGroup(groupId)

    const hold = holdGroupRow(server.db, groupId)
    let one!: Watched<Awaited<ReturnType<typeof mintAt>>>
    let two!: Watched<Awaited<ReturnType<typeof mintAt>>>
    try {
      const holder = await hold.ready
      one = watch(mintAt(groupId, 1))
      await waitForBlockedBehind(server.db, holder, 1)
      two = watch(mintAt(groupId, 2))
      await waitForBlockedBehind(server.db, holder, 2)
    } finally {
      hold.release()
      await hold.done
    }

    const [first, second] = [await one.value, await two.value]
    if (first.status !== 'minted' || second.status !== 'minted') {
      throw new Error('expected both mints to stand on an empty group')
    }
    // The boot-style link from emptyGroup plus these two.
    expect(await liveLinks(groupId)).toHaveLength(3)

    expect((await joinWith(first.pairing.link)).status).toBe(201)
    expect(await liveLinks(groupId)).toEqual([])
    const late = await joinWith(second.pairing.link)
    expect(late.status).toBe(400)
    expect(late.body.error.message).toContain(RETIRED)
  })
})

describe.skipIf(!USE_POSTGRES)('authenticating a device that is being removed', () => {
  /**
   * Catches authentication that trusts its first read [R16]. The token check reads the
   * endpoint, then writes its presence. A removal (or a whole tenancy deletion) landing
   * between the two used to leave the request holding a snapshot of a device that no
   * longer existed, and carrying on with it: that is how a WebSocket hello straddling a
   * deletion registered a socket for a tenancy the control plane had been told was gone.
   * Now a presence write that finds no row is answered like the token it now is.
   */
  it('turns the request away when the device goes between the check and the write', async () => {
    server = await startTestServer()
    const { b } = await pairedGroup()
    const tokenHash = await server.db
      .selectFrom('endpoints')
      .select(['device_token_hash', 'group_id'])
      .where('id', '=', b.endpointId as unknown as string)
      .executeTakeFirstOrThrow()

    // A removal in flight: tombstone written, row deleted, not yet committed.
    let release!: () => void
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    let markReady!: (pid: number) => void
    const ready = new Promise<number>((resolve) => {
      markReady = resolve
    })
    const removal = server.db.transaction().execute(async (trx) => {
      await trx
        .insertInto('removed_endpoints')
        .values({
          device_token_hash: tokenHash.device_token_hash,
          endpoint_id: b.endpointId as unknown as string,
          group_id: tokenHash.group_id,
          removed_at: server.clock.now().toISOString(),
        })
        .execute()
      await trx
        .deleteFrom('endpoints')
        .where('id', '=', b.endpointId as unknown as string)
        .execute()
      const { rows } = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(trx)
      markReady(Number(rows[0]?.pid))
      await released
    })

    let call!: Watched<Awaited<ReturnType<typeof http.get<ApiError>>>>
    try {
      const holder = await ready
      // The token check still sees the device (the removal has not committed); its
      // presence write then waits on the row the removal is deleting.
      call = watch(http.get<ApiError>(server.baseUrl, '/v1/endpoints', b.token))
      await waitForBlockedBehind(server.db, holder, 1)
    } finally {
      release()
      await removal
    }

    const res = await call.value
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('endpoint_removed')
  })
})
