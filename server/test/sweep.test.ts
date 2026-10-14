import type { PendingMessagesResponse, SendResponse } from '@tabsend/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { sweepExpired } from '../src/sweep'
import {
  envelopeFor,
  http,
  pairingCodeFromLink,
  register,
  startTestServer,
  type TestServer,
} from './helpers'

let server: TestServer

afterEach(async () => {
  await server?.close()
})

async function seedMessage(id: string, ttlMs: number) {
  server = await startTestServer({ messageTtlMs: ttlMs })
  const { baseUrl } = server
  const a = await register(baseUrl)
  const linkRes = await http.post<{ link: string }>(baseUrl, '/v1/pairing', undefined, a.token)
  const b = await register(baseUrl, { pairingCode: pairingCodeFromLink(linkRes.body.link) })
  const send = await http.post<SendResponse>(
    baseUrl,
    '/v1/messages',
    { items: [{ id, targetEndpointId: b.endpointId, envelope: envelopeFor(b.e2ePubkey) }] },
    a.token,
  )
  expect(send.body.accepted).toEqual([id])
  return { a, b }
}

/** Read the raw stored envelope for a message id straight from the store. */
async function storedEnvelope(id: string): Promise<string | null | undefined> {
  const row = await server.db
    .selectFrom('messages')
    .select('envelope')
    .where('id', '=', id)
    .executeTakeFirst()
  return row?.envelope
}

async function rowExists(id: string): Promise<boolean> {
  const row = await server.db
    .selectFrom('messages')
    .select('id')
    .where('id', '=', id)
    .executeTakeFirst()
  return row !== undefined
}

describe('TTL sweeper', () => {
  it('purges the ciphertext of an expired-but-unacked message (privacy)', async () => {
    const { b } = await seedMessage('sweep-1', 1000)
    // Before expiry: envelope is intact.
    expect(await storedEnvelope('sweep-1')).toBeTruthy()

    server.clock.advance(2000) // past the 1s TTL

    // A grace far larger than the elapsed time → purge only, no delete.
    const result = await sweepExpired(server.db, server.clock.now(), 60_000, 0)
    expect(result.purged).toBe(1)
    expect(result.deleted).toBe(0)

    // Ciphertext gone; the routing tombstone remains.
    expect(await storedEnvelope('sweep-1')).toBeNull()
    expect(await rowExists('sweep-1')).toBe(true)

    // And the target can never pull it.
    const pending = await http.get<PendingMessagesResponse>(
      server.baseUrl,
      '/v1/messages?pending=1',
      b.token,
    )
    expect(pending.body).toHaveLength(0)
  })

  it('is idempotent — a second purge pass changes nothing', async () => {
    await seedMessage('sweep-2', 1000)
    server.clock.advance(2000)
    const first = await sweepExpired(server.db, server.clock.now(), 60_000, 0)
    expect(first.purged).toBe(1)
    const second = await sweepExpired(server.db, server.clock.now(), 60_000, 0)
    expect(second.purged).toBe(0)
    expect(second.deleted).toBe(0)
  })

  it('prunes the tombstone once it is older than the grace window', async () => {
    await seedMessage('sweep-3', 1000) // expires at t0+1s
    server.clock.advance(2000) // now t0+2s: expired, but only 1s past
    const early = await sweepExpired(server.db, server.clock.now(), 10_000, 0) // 10s grace
    expect(early.purged).toBe(1) // ciphertext purged
    expect(early.deleted).toBe(0) // not yet past grace
    expect(await rowExists('sweep-3')).toBe(true)

    server.clock.advance(10_000) // now t0+12s: 11s past expiry, beyond the 10s grace
    const late = await sweepExpired(server.db, server.clock.now(), 10_000, 0)
    expect(late.deleted).toBe(1)
    expect(await rowExists('sweep-3')).toBe(false)
  })

  it('leaves a live (unexpired) message untouched', async () => {
    await seedMessage('sweep-4', 60_000)
    const result = await sweepExpired(server.db, server.clock.now(), 1000, 0)
    expect(result.purged).toBe(0)
    expect(result.deleted).toBe(0)
    expect(await storedEnvelope('sweep-4')).toBeTruthy()
  })
})

/**
 * Pairing codes [0031 amended]. Nothing removed these before, so a relay kept one row
 * per link ever minted, for as long as it ran — the other half of the live-code limit
 * in caps.test.ts, which bounds what is outstanding but says nothing about what is dead.
 */
describe('sweeping dead pairing codes', () => {
  it('keeps a used link readable for the grace window, then drops it', async () => {
    server = await startTestServer({ pairingCodeTtlMs: 60_000 })
    const a = await register(server.baseUrl)
    const link = await http.post<{ link: string }>(
      server.baseUrl,
      '/v1/pairing',
      undefined,
      a.token,
    )
    const code = pairingCodeFromLink(link.body.link)
    await register(server.baseUrl, { pairingCode: code })

    const grace = 120_000
    // Just past expiry: still there, because the register route reads the row to tell
    // somebody "this link was already used" rather than "unknown link".
    const early = new Date(server.clock.now().getTime() + 61_000)
    expect((await sweepExpired(server.db, early, grace, 0)).pairingCodesDropped).toBe(0)
    const used = await http.post<{ error: { message: string } }>(
      server.baseUrl,
      '/v1/endpoints/register',
      {
        label: 'Late',
        kind: 'extension',
        browser: 'chrome',
        platform: 'macos',
        e2ePubkey: 'late-key',
        pushSubscription: { transport: 'none' },
        pairingCode: code,
      },
    )
    expect(used.body.error.message).toContain('already used')

    // Past expiry by the grace window: dead, and gone.
    const late = new Date(server.clock.now().getTime() + 61_000 + grace)
    expect((await sweepExpired(server.db, late, grace, 0)).pairingCodesDropped).toBeGreaterThan(0)
    const left = await server.db
      .selectFrom('pairing_codes')
      .select('code')
      .where('code', '=', code)
      .execute()
    expect(left).toEqual([])
  })

  it('leaves a link that is still usable alone, however long ago it was made', async () => {
    server = await startTestServer({ pairingCodeTtlMs: 600_000 })
    const a = await register(server.baseUrl)
    const minted = await http.post<{ link: string }>(
      server.baseUrl,
      '/v1/pairing',
      undefined,
      a.token,
    )
    const code = pairingCodeFromLink(minted.body.link)

    // Halfway through its life, and well past the grace window since it was MADE. The
    // sweep is dated by expiry, so the link stays; one dated by creation would drop a
    // link somebody is about to use.
    // (The relay's own first-run link may go in the same pass: the first join retired
    // it, so it is dead, which is the other half of what this sweep is for.)
    const halfway = new Date(server.clock.now().getTime() + 300_000)
    await sweepExpired(server.db, halfway, 60_000, 0)
    expect(
      await server.db.selectFrom('pairing_codes').select('code').where('code', '=', code).execute(),
    ).toHaveLength(1)
  })

  it('leaves a first-run link alone for the whole of its longer life', async () => {
    server = await startTestServer()
    const first = server.firstRunPairing
    expect(first).not.toBeNull()

    // Six hours after the boot log printed it, inside its 24-hour life.
    server.clock.advance(6 * 60 * 60_000)
    expect((await sweepExpired(server.db, server.clock.now(), 60_000, 0)).pairingCodesDropped).toBe(
      0,
    )
    const joined = await register(server.baseUrl, {
      pairingCode: pairingCodeFromLink((first as { link: string }).link),
    })
    expect(joined.endpointId).toBeTruthy()
  })
})
