import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type {
  ApiError,
  PushSubscription,
  SendResponse,
  ServerConfigResponse,
} from '@tabsend/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { FakePushSender, ForwarderWakeError, ForwarderWakeSender } from '../src/push'
import {
  connectWs,
  delay,
  envelopeFor,
  http,
  pairingCodeFromLink,
  register,
  startTestServer,
  type TestServer,
} from './helpers'

/**
 * The relay half of the iOS wake-up forwarder [0032] (HOSTED_PLAN §6, PLANS P-5
 * option 1, forwarder `PROTOCOL.md` §7).
 *
 * Four properties, and every one of them is something a later edit could break while
 * every other suite stayed green:
 *
 *  1. **A wake never fails a send.** The forwarder is a doorbell. If it times out,
 *     429s or answers nonsense, the tab is still accepted, still queued, and still
 *     drains on open — which is exactly the behaviour of no forwarder at all.
 *  2. **The relay rings its OWN forwarder.** The wire variant carries a token and no
 *     URL, so no register body can point the relay's outbound request anywhere.
 *  3. **A relay without a forwarder refuses the transport, and says so.** Accepting
 *     it would leave a phone paired, apparently set up, and permanently silent.
 *  4. **The wake token never reaches a log line.** Same rule as the forwarder's own
 *     (`PROTOCOL.md` §8), asserted the same way: capture every line and look.
 */

const FORWARDER_URL = 'https://wake.test'
const WAKE_TOKEN = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

let server: TestServer

afterEach(async () => {
  await server?.close()
})

interface WakeCall {
  url: string
  method: string
  authorization: string | null
  body: string
}

const accepted = () => new Response(null, { status: 202 })

/**
 * A `fetch` that rings nothing, records everything, and answers what it is told to.
 *
 * `settled(n)` exists because a forwarder wake is DETACHED from the send [0032]: the
 * response comes back without waiting for it, so `calls` is not necessarily populated
 * when the assertion runs. It waits for the nth call and then one more turn of the
 * loop, so the relay's own catch — the `push wake failed` warn line, the failure
 * accounting it deliberately does not do — has run before anything is asserted.
 */
function fakeForwarder(reply: (url: string) => Response = accepted) {
  const calls: WakeCall[] = []
  const impl: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers)
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      authorization: headers.get('authorization'),
      body: typeof init?.body === 'string' ? init.body : '',
    })
    return reply(String(input))
  }
  const tick = () => new Promise((resolve) => setTimeout(resolve, 5))
  async function settled(n = 1, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (calls.length < n) {
      if (Date.now() > deadline) {
        throw new Error(`the forwarder was rung ${calls.length} time(s), expected ${n}`)
      }
      await tick()
    }
    await tick()
  }
  return { calls, impl, settled }
}

async function mintCode(token: string): Promise<string> {
  const res = await http.post<{ link: string }>(server.baseUrl, '/v1/pairing', undefined, token)
  return pairingCodeFromLink(res.body.link)
}

/** Source endpoint plus an iPhone-shaped target registered on the forwarder path. */
async function pairSenderAndPhone() {
  const source = await register(server.baseUrl, { e2ePubkey: 'source-key' })
  const phone = await register(server.baseUrl, {
    pairingCode: await mintCode(source.token),
    kind: 'mobile',
    platform: 'ios',
    e2ePubkey: 'phone-key',
    pushSubscription: { transport: 'forwarder', wakeToken: WAKE_TOKEN },
  })
  return { source, phone }
}

function sendTo(sourceToken: string, targetId: string, targetPubkey: string) {
  return http.post<SendResponse>(
    server.baseUrl,
    '/v1/messages',
    {
      items: [
        { id: randomUUID(), targetEndpointId: targetId, envelope: envelopeFor(targetPubkey) },
      ],
    },
    sourceToken,
  )
}

describe('registering on the forwarder transport', () => {
  it('is accepted when the relay has a forwarder configured', async () => {
    server = await startTestServer({ wakeForwarderUrl: FORWARDER_URL })
    const { phone } = await pairSenderAndPhone()

    const stored = await server.db
      .selectFrom('endpoints')
      .select('push_subscription')
      .where('id', '=', phone.endpointId)
      .executeTakeFirstOrThrow()
    expect(JSON.parse(stored.push_subscription)).toEqual({
      transport: 'forwarder',
      wakeToken: WAKE_TOKEN,
    })
  })

  it('is refused with an actionable message when the relay has no forwarder', async () => {
    server = await startTestServer()
    const source = await register(server.baseUrl, { e2ePubkey: 'source-key' })

    const res = await http.post<ApiError>(server.baseUrl, '/v1/endpoints/register', {
      label: 'iPhone',
      kind: 'mobile',
      browser: null,
      platform: 'ios',
      e2ePubkey: 'phone-key',
      pairingCode: await mintCode(source.token),
      pushSubscription: { transport: 'forwarder', wakeToken: WAKE_TOKEN },
    })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('invalid_request')
    // Refused rather than silently accepted, and the message says what to do about it
    // instead of only what went wrong — a phone that registered and never rang would
    // leave nothing anywhere to look at.
    expect(res.body.error.message).toContain('wake-up forwarder')
    expect(res.body.error.message).toContain('"none"')
    expect(res.body.error.message).toContain('WAKE_FORWARDER_URL')
  })

  it('refuses the same rotation through heartbeat, so the two paths cannot disagree', async () => {
    server = await startTestServer()
    const endpoint = await register(server.baseUrl)

    const res = await http.post<ApiError>(
      server.baseUrl,
      `/v1/endpoints/${endpoint.endpointId}/heartbeat`,
      { pushSubscription: { transport: 'forwarder', wakeToken: WAKE_TOKEN } },
      endpoint.token,
    )
    expect(res.status).toBe(400)
    expect(res.body.error.message).toContain('wake-up forwarder')
  })

  it('keeps only the token, so a register body cannot choose where the relay calls', async () => {
    // The contract has no url field (shared §2). One sent anyway is dropped rather
    // than honoured: this is the SSRF boundary, and it holds structurally because the
    // validator returns a fresh literal instead of whatever arrived.
    const forwarder = fakeForwarder()
    server = await startTestServer({ wakeForwarderUrl: FORWARDER_URL, wakeFetch: forwarder.impl })
    const source = await register(server.baseUrl, { e2ePubkey: 'source-key' })
    const phone = await register(server.baseUrl, {
      pairingCode: await mintCode(source.token),
      e2ePubkey: 'phone-key',
      pushSubscription: {
        transport: 'forwarder',
        wakeToken: WAKE_TOKEN,
        url: 'http://169.254.169.254/latest/meta-data',
      } as unknown as PushSubscription,
    })

    const stored = await server.db
      .selectFrom('endpoints')
      .select('push_subscription')
      .where('id', '=', phone.endpointId)
      .executeTakeFirstOrThrow()
    expect(JSON.parse(stored.push_subscription)).toEqual({
      transport: 'forwarder',
      wakeToken: WAKE_TOKEN,
    })

    await sendTo(source.token, phone.endpointId, 'phone-key')
    await forwarder.settled(1)
    expect(forwarder.calls).toHaveLength(1)
    expect(forwarder.calls[0]!.url).toBe(`${FORWARDER_URL}/v1/wake`)
  })
})

describe('ringing the forwarder on send', () => {
  it('POSTs /v1/wake with the token in the Authorization header and an empty body', async () => {
    const forwarder = fakeForwarder()
    server = await startTestServer({ wakeForwarderUrl: FORWARDER_URL, wakeFetch: forwarder.impl })
    const { source, phone } = await pairSenderAndPhone()

    const send = await sendTo(source.token, phone.endpointId, 'phone-key')
    expect(send.status).toBe(200)
    expect(send.body.accepted).toHaveLength(1)

    await forwarder.settled(1)
    expect(forwarder.calls).toHaveLength(1)
    const call = forwarder.calls[0]!
    expect(call.method).toBe('POST')
    expect(call.url).toBe(`${FORWARDER_URL}/v1/wake`)
    expect(call.authorization).toBe(`Bearer ${WAKE_TOKEN}`)
    // The token rides a header and never the URL (forwarder PROTOCOL §6, ADR-0009 §3).
    expect(call.url).not.toContain(WAKE_TOKEN)
    // No content, because there is nowhere in the request for content to go.
    expect(call.body).toBe('{}')
  })

  it('leaves every other transport to the sender underneath', async () => {
    const forwarder = fakeForwarder()
    server = await startTestServer({ wakeForwarderUrl: FORWARDER_URL, wakeFetch: forwarder.impl })
    const source = await register(server.baseUrl, { e2ePubkey: 'source-key' })
    const browser = await register(server.baseUrl, {
      pairingCode: await mintCode(source.token),
      e2ePubkey: 'browser-key',
    })

    await sendTo(source.token, browser.endpointId, 'browser-key')
    expect(forwarder.calls).toHaveLength(0)
    expect(server.push.calls).toHaveLength(1)
    expect(server.push.calls[0]!.transport).toBe('webpush')
  })

  it('does not ring a relay that has no forwarder, and the send is unaffected', async () => {
    // Nothing can register the transport there, so the only thing to prove is the
    // other half: an ordinary relay is byte-for-byte what it was before [0032].
    server = await startTestServer()
    const source = await register(server.baseUrl, { e2ePubkey: 'source-key' })
    const target = await register(server.baseUrl, {
      pairingCode: await mintCode(source.token),
      e2ePubkey: 'target-key',
      pushSubscription: { transport: 'none' },
    })

    const send = await sendTo(source.token, target.endpointId, 'target-key')
    expect(send.body.accepted).toHaveLength(1)
    expect(server.push.calls).toHaveLength(1) // the no-op wake, as before
  })
})

/**
 * How often a send rings [2026-10-01 follow-up review, R15]. A wake carries nothing and
 * a woken device drains its whole queue, so the doorbell rings once per target per send.
 * It used to ring once per TAB: a 150-tab send rang the forwarder 150 times against a
 * per-caller limit that every tenant on the relay draws from.
 */
describe('ringing once, and only when it helps', () => {
  function sendMany(sourceToken: string, targetId: string, targetPubkey: string, n: number) {
    return http.post<SendResponse>(
      server.baseUrl,
      '/v1/messages',
      {
        items: Array.from({ length: n }, () => ({
          id: randomUUID(),
          targetEndpointId: targetId,
          envelope: envelopeFor(targetPubkey),
        })),
      },
      sourceToken,
    )
  }

  it('rings a phone once for a send of many tabs', async () => {
    const forwarder = fakeForwarder()
    server = await startTestServer({ wakeForwarderUrl: FORWARDER_URL, wakeFetch: forwarder.impl })
    const { source, phone } = await pairSenderAndPhone()

    const send = await sendMany(source.token, phone.endpointId, 'phone-key', 5)
    expect(send.body.accepted).toHaveLength(5)
    await forwarder.settled(1)
    await delay(50)
    expect(forwarder.calls).toHaveLength(1)
  })

  it('wakes a browser once for a send of many tabs as well', async () => {
    server = await startTestServer()
    const source = await register(server.baseUrl, { e2ePubkey: 'source-key' })
    const browser = await register(server.baseUrl, {
      pairingCode: await mintCode(source.token),
      e2ePubkey: 'browser-key',
    })

    await sendMany(source.token, browser.endpointId, 'browser-key', 5)
    expect(server.push.calls).toHaveLength(1)
  })

  it('does not ring a phone whose socket just took the message', async () => {
    const forwarder = fakeForwarder()
    server = await startTestServer({ wakeForwarderUrl: FORWARDER_URL, wakeFetch: forwarder.impl })
    const { source, phone } = await pairSenderAndPhone()
    const ws = await connectWs(server.wsUrl)
    ws.send({ type: 'hello', deviceToken: phone.token })
    ws.send({ type: 'ping' })
    await ws.next((m) => m.type === 'pong')

    await sendTo(source.token, phone.endpointId, 'phone-key')
    // Delivered on the socket, which is the whole point of not ringing...
    expect((await ws.next((m) => m.type === 'message')).message).toBeTruthy()
    await delay(50)
    // ...so the doorbell is left alone and the phone's six-a-minute budget is kept for
    // when it is actually asleep (ADR-0032's recorded next step).
    expect(forwarder.calls).toHaveLength(0)

    // Once the app goes to the background it closes its socket, and the ring is back.
    ws.close()
    await ws.closed
    await delay(50)
    await sendTo(source.token, phone.endpointId, 'phone-key')
    await forwarder.settled(1)
  })

  it('still rings a phone whose socket has gone quiet', async () => {
    const forwarder = fakeForwarder()
    server = await startTestServer({ wakeForwarderUrl: FORWARDER_URL, wakeFetch: forwarder.impl })
    const { source, phone } = await pairSenderAndPhone()
    const ws = await connectWs(server.wsUrl)
    ws.send({ type: 'hello', deviceToken: phone.token })
    ws.send({ type: 'ping' })
    await ws.next((m) => m.type === 'pong')

    // A minute with no ping: the phone lost signal, say, and then went to the
    // background, so its close never reached the relay. The socket is still
    // registered, but it has not proved itself alive lately, so it is not trusted to
    // have taken the message, and the phone is rung.
    server.clock.advance(60_000)
    await sendTo(source.token, phone.endpointId, 'phone-key')
    await forwarder.settled(1)
    ws.close()
  })
})

/**
 * A redirect is an answer, not a detour [2026-10-01]. Followed, a 3xx led to whatever
 * answered at the other end, and a 202 there counted as a wake although the forwarder
 * never rang anything. Driven with the REAL fetch against real local servers, because a
 * fake fetch has no redirect handling to get wrong.
 */
describe('a forwarder that redirects', () => {
  const servers: Server[] = []
  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
    )
  })

  async function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
    const s = createServer(handler)
    servers.push(s)
    await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', () => resolve()))
    return `http://127.0.0.1:${(s.address() as AddressInfo).port}`
  }

  it('is a failed wake, and the redirect is not followed', async () => {
    let followed = 0
    const elsewhere = await listen((_req, res) => {
      followed += 1
      res.writeHead(202).end()
    })
    const forwarderUrl = await listen((_req, res) => {
      res.writeHead(307, { location: `${elsewhere}/v1/wake` }).end()
    })
    const sender = new ForwarderWakeSender(forwarderUrl, new FakePushSender())

    const wake = sender.wake({ transport: 'forwarder', wakeToken: WAKE_TOKEN })
    await expect(wake).rejects.toBeInstanceOf(ForwarderWakeError)
    await expect(wake).rejects.toMatchObject({ status: 307 })
    expect(followed).toBe(0)
  })
})

describe('a wake is best effort and never fails a send', () => {
  it('accepts the tab when the forwarder refuses the call', async () => {
    const forwarder = fakeForwarder(() => new Response(null, { status: 429 }))
    server = await startTestServer({ wakeForwarderUrl: FORWARDER_URL, wakeFetch: forwarder.impl })
    const { source, phone } = await pairSenderAndPhone()

    const send = await sendTo(source.token, phone.endpointId, 'phone-key')
    expect(send.status).toBe(200)
    expect(send.body.accepted).toHaveLength(1)
    expect(send.body.rejected).toEqual([])

    // And the tab is genuinely there to be drained on open, which is the whole of the
    // forwarder's degradation contract (PROTOCOL §7).
    const pending = await http.get<unknown[]>(server.baseUrl, '/v1/messages?pending=1', phone.token)
    expect(pending.body).toHaveLength(1)
  })

  it('does not make the send WAIT for the forwarder, however long it hangs', async () => {
    // The strongest version of "a wake never fails a send": a forwarder that simply
    // never answers used to charge every iPhone target the full 3 s abort, serially,
    // before the sender heard anything. The relay fires the wake and moves on now, so
    // a hung doorbell costs the send nothing at all.
    let release: (() => void) | undefined
    const hang = new Promise<void>((resolve) => {
      release = resolve
    })
    const impl: typeof fetch = async () => {
      await hang
      return accepted()
    }
    server = await startTestServer({ wakeForwarderUrl: FORWARDER_URL, wakeFetch: impl })
    const { source, phone } = await pairSenderAndPhone()

    const startedAt = Date.now()
    const send = await sendTo(source.token, phone.endpointId, 'phone-key')
    const elapsed = Date.now() - startedAt
    expect(send.status).toBe(200)
    expect(send.body.accepted).toHaveLength(1)
    // Well inside the 3 s abort the wake itself is bounded by (push.ts), which is the
    // number this would have paid if the send were still waiting on it.
    expect(elapsed).toBeLessThan(1_000)

    release?.()
  })

  it('accepts the tab when the forwarder cannot be reached at all', async () => {
    const forwarder = fakeForwarder(() => {
      throw new TypeError('fetch failed')
    })
    server = await startTestServer({ wakeForwarderUrl: FORWARDER_URL, wakeFetch: forwarder.impl })
    const { source, phone } = await pairSenderAndPhone()

    const send = await sendTo(source.token, phone.endpointId, 'phone-key')
    expect(send.status).toBe(200)
    expect(send.body.accepted).toHaveLength(1)
  })

  it('never counts a forwarder failure against the endpoint, however often it repeats', async () => {
    // The dead-subscription counter exists for a push service that says "this
    // subscription is gone" (404/410). The forwarder cannot say that: it answers 202
    // to a live token, a revoked one and an invented one alike, so a 404 from it means
    // the URL is wrong, not that the phone is. Counting it would let a misconfigured
    // relay switch off wakes for phones that were never at fault.
    const forwarder = fakeForwarder(() => new Response(null, { status: 404 }))
    server = await startTestServer({
      wakeForwarderUrl: FORWARDER_URL,
      wakeFetch: forwarder.impl,
      pushDeadThreshold: 2,
    })
    const { source, phone } = await pairSenderAndPhone()

    await sendTo(source.token, phone.endpointId, 'phone-key')
    await sendTo(source.token, phone.endpointId, 'phone-key')
    await sendTo(source.token, phone.endpointId, 'phone-key')
    await forwarder.settled(3)

    const row = await server.db
      .selectFrom('endpoints')
      .select('push_failures')
      .where('id', '=', phone.endpointId)
      .executeTakeFirstOrThrow()
    expect(Number(row.push_failures)).toBe(0)
    // Still ringing on the third send: nothing was ever marked dead.
    expect(forwarder.calls).toHaveLength(3)
  })

  /**
   * A 200 or a 204 is a URL pointing at something that is not a forwarder — a load
   * balancer's health page, a static site, an unrelated API. The relay used to accept
   * every 2xx, so that misconfiguration produced a relay logging delivered wakes,
   * `push_failures` at zero, and phones that never rang: silent, and only visible as
   * "iPhone notifications don't work" with nothing anywhere to look at.
   */
  it.each([200, 204, 201])('treats %i from the forwarder as a failure, not a wake', async (ok) => {
    const logs: unknown[] = []
    const forwarder = fakeForwarder(() => new Response(null, { status: ok }))
    server = await startTestServer({
      wakeForwarderUrl: FORWARDER_URL,
      wakeFetch: forwarder.impl,
      captureLogs: logs,
    })
    const { source, phone } = await pairSenderAndPhone()

    const send = await sendTo(source.token, phone.endpointId, 'phone-key')
    // Still best effort: the tab is accepted and drains on open either way.
    expect(send.status).toBe(200)
    expect(send.body.accepted).toHaveLength(1)

    await forwarder.settled(1)
    const lines = logs.map((entry) => JSON.stringify(entry))
    expect(lines.some((line) => line.includes('push wake failed'))).toBe(true)
    expect(lines.some((line) => line.includes(`returned ${ok}`))).toBe(true)

    // And still not the phone's fault: a wrong URL is the operator's problem [0032].
    const row = await server.db
      .selectFrom('endpoints')
      .select('push_failures')
      .where('id', '=', phone.endpointId)
      .executeTakeFirstOrThrow()
    expect(Number(row.push_failures)).toBe(0)
  })

  it("accepts 202, which is the forwarder's one success answer", async () => {
    const logs: unknown[] = []
    const forwarder = fakeForwarder()
    server = await startTestServer({
      wakeForwarderUrl: FORWARDER_URL,
      wakeFetch: forwarder.impl,
      captureLogs: logs,
    })
    const { source, phone } = await pairSenderAndPhone()
    await sendTo(source.token, phone.endpointId, 'phone-key')
    await forwarder.settled(1)

    const lines = logs.map((entry) => JSON.stringify(entry))
    expect(lines.some((line) => line.includes('push wake failed'))).toBe(false)
  })

  it('writes the failure to the log without the wake token in any line', async () => {
    const logs: unknown[] = []
    const forwarder = fakeForwarder(() => new Response(null, { status: 500 }))
    server = await startTestServer({
      wakeForwarderUrl: FORWARDER_URL,
      wakeFetch: forwarder.impl,
      captureLogs: logs,
    })
    const { source, phone } = await pairSenderAndPhone()
    await sendTo(source.token, phone.endpointId, 'phone-key')
    await forwarder.settled(1)

    const lines = logs.map((entry) => JSON.stringify(entry))
    expect(lines.some((line) => line.includes('push wake failed'))).toBe(true)
    for (const line of lines) {
      expect(line).not.toContain(WAKE_TOKEN)
    }
  })
})

/**
 * A deleted device's doorbell is retired [2026-10-20, PLANS P-17]. The forwarder drops a
 * phone's record when the phone unpairs, re-registers, or Apple or Google say the app is
 * gone; a phone removed by another device, or deleted with its group, does none of
 * those and is never rung again, so its record stayed at the forwarder for good.
 */
describe('deleting a device revokes its wake token', () => {
  const PROVISIONING = 'test-provisioning-credential'
  const OTHER_WAKE_TOKEN = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'
  /** The forwarder's one revoke answer is 200; its one wake answer is 202. */
  const forwarderReply = (url: string) =>
    new Response(null, { status: url.endsWith('/v1/revoke') ? 200 : 202 })

  it('POSTs /v1/revoke with the token in the header when another device removes a phone', async () => {
    const forwarder = fakeForwarder(forwarderReply)
    server = await startTestServer({ wakeForwarderUrl: FORWARDER_URL, wakeFetch: forwarder.impl })
    const { source, phone } = await pairSenderAndPhone()

    const removed = await http.del<{ ok: boolean }>(
      server.baseUrl,
      `/v1/endpoints/${phone.endpointId}`,
      source.token,
    )
    expect(removed.status).toBe(200)

    await forwarder.settled(1)
    expect(forwarder.calls).toEqual([
      {
        url: `${FORWARDER_URL}/v1/revoke`,
        method: 'POST',
        authorization: `Bearer ${WAKE_TOKEN}`,
        body: '{}',
      },
    ])
  })

  it('revokes it when the phone removes itself as well', async () => {
    const forwarder = fakeForwarder(forwarderReply)
    server = await startTestServer({ wakeForwarderUrl: FORWARDER_URL, wakeFetch: forwarder.impl })
    const { phone } = await pairSenderAndPhone()

    const removed = await http.del(server.baseUrl, `/v1/endpoints/${phone.endpointId}`, phone.token)
    expect(removed.status).toBe(200)

    await forwarder.settled(1)
    expect(forwarder.calls.map((call) => call.url)).toEqual([`${FORWARDER_URL}/v1/revoke`])
  })

  it('calls nothing for a device that is not on the forwarder', async () => {
    const forwarder = fakeForwarder(forwarderReply)
    server = await startTestServer({ wakeForwarderUrl: FORWARDER_URL, wakeFetch: forwarder.impl })
    const source = await register(server.baseUrl, { e2ePubkey: 'source-key' })
    const browser = await register(server.baseUrl, {
      pairingCode: await mintCode(source.token),
      e2ePubkey: 'browser-key',
    })

    const removed = await http.del(
      server.baseUrl,
      `/v1/endpoints/${browser.endpointId}`,
      source.token,
    )
    expect(removed.status).toBe(200)
    await delay(50)
    expect(forwarder.calls).toEqual([])
  })

  it("revokes every phone's token when the group is deleted, and shows none of them", async () => {
    const logs: unknown[] = []
    const forwarder = fakeForwarder(forwarderReply)
    server = await startTestServer({
      groupCreation: 'provisioned',
      provisioningToken: PROVISIONING,
      wakeForwarderUrl: FORWARDER_URL,
      wakeFetch: forwarder.impl,
      captureLogs: logs,
    })
    const created = await http.post<{ groupId: string }>(
      server.baseUrl,
      '/admin/provisioning/groups',
      undefined,
      PROVISIONING,
    )
    const groupId = created.body.groupId
    const first = await http.post<{ link: string }>(
      server.baseUrl,
      `/admin/provisioning/groups/${groupId}/pairing`,
      undefined,
      PROVISIONING,
    )
    const browser = await register(server.baseUrl, {
      pairingCode: pairingCodeFromLink(first.body.link),
    })
    for (const wakeToken of [WAKE_TOKEN, OTHER_WAKE_TOKEN]) {
      await register(server.baseUrl, {
        pairingCode: await mintCode(browser.token),
        kind: 'mobile',
        platform: 'ios',
        pushSubscription: { transport: 'forwarder', wakeToken },
      })
    }

    const deleted = await http.del<unknown>(
      server.baseUrl,
      `/admin/provisioning/groups/${groupId}`,
      PROVISIONING,
    )
    expect(deleted.status).toBe(200)

    await forwarder.settled(2)
    expect(forwarder.calls.map((call) => [call.url, call.authorization]).sort()).toEqual(
      [
        [`${FORWARDER_URL}/v1/revoke`, `Bearer ${OTHER_WAKE_TOKEN}`],
        [`${FORWARDER_URL}/v1/revoke`, `Bearer ${WAKE_TOKEN}`],
      ].sort(),
    )
    // The tokens ride to the forwarder and nowhere else: not the control plane's answer,
    // not its audit line, not any other log line.
    for (const text of [JSON.stringify(deleted.body), ...logs.map((l) => JSON.stringify(l))]) {
      expect(text).not.toContain(WAKE_TOKEN)
      expect(text).not.toContain(OTHER_WAKE_TOKEN)
    }
  })

  it('removes the device anyway when the forwarder refuses, and logs it without the token', async () => {
    const logs: unknown[] = []
    const forwarder = fakeForwarder(() => new Response(null, { status: 500 }))
    server = await startTestServer({
      wakeForwarderUrl: FORWARDER_URL,
      wakeFetch: forwarder.impl,
      captureLogs: logs,
    })
    const { source, phone } = await pairSenderAndPhone()

    const removed = await http.del(
      server.baseUrl,
      `/v1/endpoints/${phone.endpointId}`,
      source.token,
    )
    expect(removed.status).toBe(200)
    await forwarder.settled(1)

    const gone = await http.get<ApiError>(server.baseUrl, '/v1/endpoints', phone.token)
    expect(gone.body.error.code).toBe('endpoint_removed')
    const lines = logs.map((entry) => JSON.stringify(entry))
    expect(lines.some((line) => line.includes('wake token revoke failed'))).toBe(true)
    for (const line of lines) expect(line).not.toContain(WAKE_TOKEN)
  })

  it('does not make the removal WAIT for the forwarder, however long it hangs', async () => {
    let release: (() => void) | undefined
    const hang = new Promise<void>((resolve) => {
      release = resolve
    })
    const impl: typeof fetch = async () => {
      await hang
      return new Response(null, { status: 200 })
    }
    server = await startTestServer({ wakeForwarderUrl: FORWARDER_URL, wakeFetch: impl })
    const { source, phone } = await pairSenderAndPhone()

    const startedAt = Date.now()
    const removed = await http.del(
      server.baseUrl,
      `/v1/endpoints/${phone.endpointId}`,
      source.token,
    )
    expect(removed.status).toBe(200)
    expect(Date.now() - startedAt).toBeLessThan(1_000)

    release?.()
  })
})

describe('GET /v1/config advertises the forwarder only where there is one', () => {
  it('omits the hint on a relay with no forwarder', async () => {
    server = await startTestServer()
    const res = await http.get<ServerConfigResponse>(server.baseUrl, '/v1/config')
    expect(res.status).toBe(200)
    // Absent, not false: an old client ignores unknown fields, and a relay without a
    // forwarder must stay byte-for-byte what it was.
    expect(res.body).not.toHaveProperty('wakeForwarder')
  })

  it('advertises the capability, and never the URL, when one is configured', async () => {
    server = await startTestServer({ wakeForwarderUrl: FORWARDER_URL })
    const res = await http.get<ServerConfigResponse>(server.baseUrl, '/v1/config')
    expect(res.body.wakeForwarder).toBe(true)
    expect(JSON.stringify(res.body)).not.toContain('wake.test')
  })
})
