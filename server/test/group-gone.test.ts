import type { ApiError } from '@tabsend/shared'
import { sql } from 'kysely'
import { afterEach, describe, expect, it } from 'vitest'
import {
  envelopeFor,
  http,
  pairingCodeFromLink,
  register,
  startTestServer,
  type TestServer,
  USE_POSTGRES,
} from './helpers'

/**
 * What every group-scoped write says when its group went away underneath an
 * authenticated caller [0031 amended]: a 404 naming what happened, never a 500, and
 * nothing stored.
 *
 * On BOTH dialects. The race that reaches these answers for real is in
 * tenancy-races.test.ts and needs Postgres to interleave; these reach the same branches
 * deterministically by removing the group row alone, behind the relay's back, so the
 * caller's endpoint row (and with it authentication) survives. SQLite reaches them for
 * real too: a deletion's transaction can run between a request's authentication and its
 * own transaction.
 */

let server: TestServer

afterEach(async () => {
  await server?.close()
})

/** Delete only the `groups` row, leaving the rows that point at it. Test-only surgery. */
async function dropGroupRowOnly(groupId: string): Promise<void> {
  if (USE_POSTGRES) {
    await server.db.transaction().execute(async (trx) => {
      await sql`set local session_replication_role = replica`.execute(trx)
      await trx.deleteFrom('groups').where('id', '=', groupId).execute()
    })
    return
  }
  await sql`pragma foreign_keys = off`.execute(server.db)
  try {
    await server.db.deleteFrom('groups').where('id', '=', groupId).execute()
  } finally {
    await sql`pragma foreign_keys = on`.execute(server.db)
  }
}

async function orphanedPair() {
  server = await startTestServer()
  const a = await register(server.baseUrl)
  const code = pairingCodeFromLink(
    (await http.post<{ link: string }>(server.baseUrl, '/v1/pairing', undefined, a.token)).body
      .link,
  )
  const b = await register(server.baseUrl, { pairingCode: code })
  await dropGroupRowOnly(a.groupId as unknown as string)
  return { a, b }
}

function expectGroupGone(res: { status: number; body: unknown }) {
  expect(res.status).toBe(404)
  const error = (res.body as ApiError).error
  expect(error.code).toBe('not_found')
  expect(error.message).toContain('no longer exists')
}

describe(`a write whose group is gone (${USE_POSTGRES ? 'postgres' : 'sqlite'})`, () => {
  it('refuses a send, and stores nothing', async () => {
    const { a, b } = await orphanedPair()
    const res = await http.post<ApiError>(
      server.baseUrl,
      '/v1/messages',
      { items: [{ id: 'm1', targetEndpointId: b.endpointId, envelope: envelopeFor(b.e2ePubkey) }] },
      a.token,
    )
    expectGroupGone(res)
    expect(await server.db.selectFrom('messages').select('id').execute()).toEqual([])
  })

  it('refuses a group-key upload, and stores nothing', async () => {
    const { a, b } = await orphanedPair()
    const res = await http.post<ApiError>(
      server.baseUrl,
      '/v1/group-keys',
      { items: [{ id: 'k1', targetEndpointId: b.endpointId, envelope: envelopeFor(b.e2ePubkey) }] },
      a.token,
    )
    expectGroupGone(res)
    expect(await server.db.selectFrom('group_keys').select('id').execute()).toEqual([])
  })

  it('refuses a pairing mint', async () => {
    const { a } = await orphanedPair()
    expectGroupGone(await http.post<ApiError>(server.baseUrl, '/v1/pairing', undefined, a.token))
  })

  it('refuses a device removal, and writes no tombstone', async () => {
    const { a, b } = await orphanedPair()
    expectGroupGone(
      await http.del<ApiError>(server.baseUrl, `/v1/endpoints/${b.endpointId}`, a.token),
    )
    expect(await server.db.selectFrom('removed_endpoints').select('endpoint_id').execute()).toEqual(
      [],
    )
  })
})
