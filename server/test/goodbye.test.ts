import type {
  ApiError,
  LeaveResponse,
  LeaveTokenResponse,
  ListEndpointsResponse,
  ServerConfigResponse,
} from '@tabsend/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { hashToken } from '../src/ids'
import {
  connectWs,
  http,
  pairingCodeFromLink,
  register,
  startTestServer,
  type TestServer,
} from './helpers'

/**
 * The uninstall page [PLANS P-31 item 1]: a leave token minted per device, a route that
 * removes exactly that device with it, and the `/goodbye` page that posts it. Runs on
 * SQLite and, with `TABSEND_TEST_PG=1`, on Postgres.
 */

let server: TestServer | undefined

afterEach(async () => {
  await server?.close()
  server = undefined
})

async function pair(options: Parameters<typeof startTestServer>[0] = {}) {
  server = await startTestServer(options)
  const base = server.baseUrl
  const phone = await register(base, { label: 'Phone' })
  const code = pairingCodeFromLink(
    (await http.post<{ link: string }>(base, '/v1/pairing', undefined, phone.token)).body.link,
  )
  const dia = await register(base, { label: 'Dia', pairingCode: code })
  return { base, phone, dia }
}

async function leaveToken(base: string, id: string, token: string): Promise<string> {
  const res = await http.post<LeaveTokenResponse>(
    base,
    `/v1/endpoints/${id}/leave-token`,
    undefined,
    token,
  )
  expect(res.status).toBe(200)
  return res.body.leaveToken
}

describe('leave tokens', () => {
  it('says the relay has the goodbye page', async () => {
    server = await startTestServer()
    const config = await http.get<ServerConfigResponse>(server.baseUrl, '/v1/config')
    expect(config.body.goodbyePage).toBe(true)
  })

  it('is minted for the caller only, and stored hashed', async () => {
    const { base, phone, dia } = await pair()
    const other = await http.post<ApiError>(
      base,
      `/v1/endpoints/${phone.endpointId}/leave-token`,
      undefined,
      dia.token,
    )
    expect(other.status).toBe(403)

    const token = await leaveToken(base, dia.endpointId, dia.token)
    expect(token.length).toBeGreaterThanOrEqual(40)
    const row = await server!.db
      .selectFrom('endpoints')
      .select('leave_token_hash')
      .where('id', '=', dia.endpointId)
      .executeTakeFirstOrThrow()
    expect(row.leave_token_hash).toBe(hashToken(token))
    expect(row.leave_token_hash).not.toBe(token)
  })

  it('removes that one device the way any removal does, and the group hears it', async () => {
    const { base, phone, dia } = await pair()
    const token = await leaveToken(base, dia.endpointId, dia.token)
    const ws = await connectWs(server!.wsUrl)
    ws.send({ type: 'hello', deviceToken: phone.token })
    ws.send({ type: 'ping' })
    await ws.next((m) => m.type === 'pong')

    const res = await http.post<LeaveResponse>(base, '/v1/endpoints/leave', { leaveToken: token })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ removed: true, label: 'Dia' })

    const removed = await ws.next((m) => m.type === 'endpoint_removed')
    expect(removed.endpointId).toBe(dia.endpointId)
    ws.close()

    const list = await http.get<ListEndpointsResponse>(base, '/v1/endpoints', phone.token)
    expect(list.body.map((e) => e.label)).toEqual(['Phone'])
    // The removed device is told so definitively, as after any removal.
    const after = await http.get<ApiError>(base, '/v1/endpoints', dia.token)
    expect(after.status).toBe(401)
    expect(after.body.error.code).toBe('endpoint_removed')
  })

  it('answers removed: false for a token that names nothing, and twice in a row', async () => {
    const { base, dia } = await pair()
    const token = await leaveToken(base, dia.endpointId, dia.token)
    expect(
      (await http.post<LeaveResponse>(base, '/v1/endpoints/leave', { leaveToken: 'nope' })).body,
    ).toEqual({ removed: false })
    expect(
      (await http.post<LeaveResponse>(base, '/v1/endpoints/leave', { leaveToken: token })).body
        .removed,
    ).toBe(true)
    expect(
      (await http.post<LeaveResponse>(base, '/v1/endpoints/leave', { leaveToken: token })).body,
    ).toEqual({ removed: false })
  })

  it('stops working once replaced, and the device token is not a leave token', async () => {
    const { base, phone, dia } = await pair()
    const first = await leaveToken(base, dia.endpointId, dia.token)
    const second = await leaveToken(base, dia.endpointId, dia.token)
    expect(second).not.toBe(first)
    for (const leave of [first, dia.token, phone.token]) {
      const res = await http.post<LeaveResponse>(base, '/v1/endpoints/leave', { leaveToken: leave })
      expect(res.body).toEqual({ removed: false })
    }
    const list = await http.get<ListEndpointsResponse>(base, '/v1/endpoints', phone.token)
    expect(list.body).toHaveLength(2)
  })

  it('refuses a body without a token', async () => {
    const { base } = await pair()
    const res = await http.post<ApiError>(base, '/v1/endpoints/leave', {})
    expect(res.status).toBe(400)
  })
})

describe('GET /goodbye', () => {
  it('serves a private page that reads the token from the fragment and posts it', async () => {
    server = await startTestServer()
    const res = await fetch(`${server.baseUrl}/goodbye`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
    const html = await res.text()
    expect(html).toContain("new URLSearchParams(location.hash.slice(1)).get('t')")
    expect(html).toContain("'v1/endpoints/leave'")
    expect(html).toContain(' was removed from your devices')
    expect(html).toContain(
      'Your other devices won\\u2019t send links to it any more. To use Tabsend here again, install it and pair it.',
    )
    expect(html).toContain(' wurde aus deinen Ger')
    // No em dashes in shipped copy.
    expect(html).not.toContain('—')
  })

  it('has no feedback box on a self-hosted relay, and refuses notes there', async () => {
    server = await startTestServer()
    const html = await (await fetch(`${server.baseUrl}/goodbye`)).text()
    expect(html).toContain('const WITH_NOTE = false')
    const res = await http.post<ApiError>(server.baseUrl, '/goodbye/note', { note: 'hi' })
    expect(res.status).toBe(404)
    expect(await server.db.selectFrom('goodbye_notes').selectAll().execute()).toEqual([])
  })

  it('keeps a hosted note with its time and nothing else', async () => {
    server = await startTestServer({ profile: 'hosted' })
    const html = await (await fetch(`${server.baseUrl}/goodbye`)).text()
    expect(html).toContain('const WITH_NOTE = true')
    expect(html).toContain('Why did you remove Tabsend? (optional)')
    const res = await http.post(server.baseUrl, '/goodbye/note', { note: '  too many tabs  ' })
    expect(res.status).toBe(201)
    const rows = await server.db.selectFrom('goodbye_notes').selectAll().execute()
    expect(rows).toHaveLength(1)
    expect(Object.keys(rows[0]!).sort()).toEqual(['created_at', 'id', 'note'])
    expect(rows[0]!.note).toBe('too many tabs')
    const long = await http.post(server.baseUrl, '/goodbye/note', { note: 'x'.repeat(2001) })
    expect(long.status).toBe(400)
  })
})
