import { randomUUID } from 'node:crypto'
import type { Endpoint, SendResponse } from '@tabsend/shared'
import { afterEach, describe, expect, it } from 'vitest'
import {
  envelopeFor,
  http,
  pairingCodeFromLink,
  register,
  startTestServer,
  type TestServer,
} from './helpers'

/**
 * PLANS P-31 item 3: a phone whose push service proved the app uninstalled is marked, and
 * sends to it are refused with `target_uninstalled` instead of waiting forever.
 *
 * The proof comes from the wake-up forwarder's `POST /v1/status` (forwarder PROTOCOL.md
 * §3.5), asked after a ring. Nothing else counts: not a Web Push 404/410, not an older
 * forwarder without the route. The relay never removes the device itself.
 */

const FORWARDER_URL = 'https://wake.test'
const WAKE_TOKEN = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

let server: TestServer

afterEach(async () => {
  // Every test starts its own server, so this never closes one twice (the Postgres trap).
  await server?.close()
})

type StatusReply = () => Response | Promise<Response>

/** A forwarder that answers 202 to wakes and `status()` to status questions. */
function forwarder(status: StatusReply) {
  const statusCalls: string[] = []
  const impl: typeof fetch = async (input, init) => {
    const url = String(input)
    if (url.endsWith('/v1/status')) {
      statusCalls.push(new Headers(init?.headers).get('authorization') ?? '')
      return status()
    }
    return new Response(null, { status: url.endsWith('/v1/revoke') ? 200 : 202 })
  }
  return { impl, statusCalls }
}

const gone = () => Response.json({ gone: true })
const notGone = () => Response.json({ gone: false })

async function start(status: StatusReply) {
  const fwd = forwarder(status)
  server = await startTestServer({
    wakeForwarderUrl: FORWARDER_URL,
    wakeFetch: fwd.impl,
    wakeGoneCheckDelayMs: 0,
  })
  return fwd
}

async function pairSenderAndPhone() {
  const source = await register(server.baseUrl, { e2ePubkey: 'source-key' })
  const link = await http.post<{ link: string }>(
    server.baseUrl,
    '/v1/pairing',
    undefined,
    source.token,
  )
  const phone = await register(server.baseUrl, {
    pairingCode: pairingCodeFromLink(link.body.link),
    kind: 'mobile',
    platform: 'android',
    e2ePubkey: 'phone-key',
    pushSubscription: { transport: 'forwarder', wakeToken: WAKE_TOKEN },
  })
  return { source, phone }
}

function sendTo(sourceToken: string, targetId: string) {
  return http.post<SendResponse>(
    server.baseUrl,
    '/v1/messages',
    {
      items: [{ id: randomUUID(), targetEndpointId: targetId, envelope: envelopeFor('phone-key') }],
    },
    sourceToken,
  )
}

async function uninstalledAt(endpointId: string): Promise<string | null> {
  const row = await server.db
    .selectFrom('endpoints')
    .select('uninstalled_at')
    .where('id', '=', endpointId)
    .executeTakeFirst()
  return row?.uninstalled_at ?? null
}

async function waitFor(check: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

/** Let detached work finish: a few turns of the loop after the last status call. */
const settle = () => new Promise((r) => setTimeout(r, 50))

describe('a phone proved uninstalled', () => {
  it('is marked after a ring, listed with uninstalledAt, and refuses new sends', async () => {
    const fwd = await start(gone)
    const { source, phone } = await pairSenderAndPhone()

    const first = await sendTo(source.token, phone.endpointId)
    // The send that rang it was already accepted: the relay learns only afterwards.
    expect(first.body.accepted).toHaveLength(1)
    await waitFor(async () => (await uninstalledAt(phone.endpointId)) !== null, 'the mark')
    expect(fwd.statusCalls).toEqual([`Bearer ${WAKE_TOKEN}`])

    const list = await http.get<Endpoint[]>(server.baseUrl, '/v1/endpoints', source.token)
    const listed = list.body.find((e) => e.id === phone.endpointId)
    // Still listed: the relay never removes a device by itself.
    expect(listed).toBeDefined()
    expect(listed?.uninstalledAt).toBe(await uninstalledAt(phone.endpointId))
    expect(list.body.find((e) => e.id === source.endpointId)?.uninstalledAt).toBeUndefined()

    const second = await sendTo(source.token, phone.endpointId)
    expect(second.body.accepted).toEqual([])
    expect(second.body.rejected).toEqual([{ id: expect.any(String), reason: 'target_uninstalled' }])
    // Refused, so nothing waits for it.
    const queued = await server.db
      .selectFrom('messages')
      .select('id')
      .where('target_endpoint_id', '=', phone.endpointId)
      .execute()
    expect(queued).toHaveLength(1)
  })

  it('is not marked when the forwarder says not gone', async () => {
    const fwd = await start(notGone)
    const { source, phone } = await pairSenderAndPhone()
    await sendTo(source.token, phone.endpointId)
    await waitFor(async () => fwd.statusCalls.length === 1, 'the status call')
    await settle()
    expect(await uninstalledAt(phone.endpointId)).toBeNull()
    expect((await sendTo(source.token, phone.endpointId)).body.accepted).toHaveLength(1)
  })

  it('is not marked by an older forwarder that has no status route', async () => {
    const fwd = await start(() => new Response('not found', { status: 404 }))
    const { source, phone } = await pairSenderAndPhone()
    await sendTo(source.token, phone.endpointId)
    await waitFor(async () => fwd.statusCalls.length === 1, 'the status call')
    await settle()
    expect(await uninstalledAt(phone.endpointId)).toBeNull()
  })

  it('is cleared by any call from the phone itself', async () => {
    await start(gone)
    const { source, phone } = await pairSenderAndPhone()
    await sendTo(source.token, phone.endpointId)
    await waitFor(async () => (await uninstalledAt(phone.endpointId)) !== null, 'the mark')

    await http.get(server.baseUrl, '/v1/endpoints', phone.token)

    expect(await uninstalledAt(phone.endpointId)).toBeNull()
    expect((await sendTo(source.token, phone.endpointId)).body.accepted).toHaveLength(1)
  })

  it('is not marked when the phone called between the ring and the answer', async () => {
    let phoneToken = ''
    await start(async () => {
      // The phone shows up (a fresh token, an open app) before the forwarder answers
      // about the token that was rung: that answer is about the past.
      server.clock.advance(1_000)
      await http.get(server.baseUrl, '/v1/endpoints', phoneToken)
      return gone()
    })
    const { source, phone } = await pairSenderAndPhone()
    phoneToken = phone.token
    await sendTo(source.token, phone.endpointId)
    await settle()
    expect(await uninstalledAt(phone.endpointId)).toBeNull()
  })

  it('is never a browser: a Web Push 410 does not mark anything', async () => {
    server = await startTestServer({ wakeGoneCheckDelayMs: 0 })
    const source = await register(server.baseUrl, { e2ePubkey: 'source-key' })
    const link = await http.post<{ link: string }>(
      server.baseUrl,
      '/v1/pairing',
      undefined,
      source.token,
    )
    const browser = await register(server.baseUrl, {
      pairingCode: pairingCodeFromLink(link.body.link),
      e2ePubkey: 'phone-key',
    })
    server.push.failDeadNextStatus = 410
    await sendTo(source.token, browser.endpointId)
    await settle()
    expect(await uninstalledAt(browser.endpointId)).toBeNull()
    expect((await sendTo(source.token, browser.endpointId)).body.accepted).toHaveLength(1)
  })

  it('can be removed by another device, as before', async () => {
    await start(gone)
    const { source, phone } = await pairSenderAndPhone()
    await sendTo(source.token, phone.endpointId)
    await waitFor(async () => (await uninstalledAt(phone.endpointId)) !== null, 'the mark')

    const removed = await http.del(
      server.baseUrl,
      `/v1/endpoints/${phone.endpointId}`,
      source.token,
    )
    expect(removed.status).toBeLessThan(300)
    const list = await http.get<Endpoint[]>(server.baseUrl, '/v1/endpoints', source.token)
    expect(list.body.some((e) => e.id === phone.endpointId)).toBe(false)
  })
})
