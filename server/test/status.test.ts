import { afterEach, describe, expect, it } from 'vitest'
import type { RelayStatus } from '../src/routes/status'
import { RelayStats } from '../src/stats'
import { envelopeFor, http, register, startTestServer, type TestServer } from './helpers'

/**
 * GET /admin/status — the ops surface behind scripts/relay-doctor.sh.
 *
 * The two properties worth guarding hardest are the ones a future edit could quietly
 * break: it must never be reachable from anywhere but the relay's own host, and it must
 * never carry a secret. Everything else about it is allowed to change shape.
 */

let server: TestServer

afterEach(async () => {
  await server?.close()
})

const codes = (status: RelayStatus) => status.warnings.map((w) => w.code)

describe('GET /admin/status', () => {
  it('answers a loopback caller with the full picture', async () => {
    server = await startTestServer()
    const { status, body } = await http.get<RelayStatus>(server.baseUrl, '/admin/status')

    expect(status).toBe(200)
    expect(body.relay.relayId.length).toBeGreaterThan(0)
    expect(body.relay.protocol).toBeGreaterThan(0)
    expect(body.listeners.publicRelayUrl).toBe(server.config.publicRelayUrl)
    expect(body.database.reachable).toBe(true)
    expect(body.database.backend).toMatch(/^(sqlite|postgres)$/)
    // The relay owns its group from boot (ADR-0023), so exactly one, with nobody in it.
    expect(body.groups.count).toBe(1)
    expect(body.devices.total).toBe(0)
    expect(body.messages.waiting).toBe(0)
  })

  it('is not reachable from off-host, and does not admit it exists', async () => {
    server = await startTestServer()
    // inject() is the only way to present a non-loopback peer: a real socket in this
    // suite is always 127.0.0.1.
    const res = await server.app.inject({
      method: 'GET',
      url: '/admin/status',
      remoteAddress: '192.168.1.50',
    })

    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: { code: 'not_found', message: 'Route not found.' } })
    // A LAN caller must not be able to tell this route apart from a typo.
    const missing = await server.app.inject({
      method: 'GET',
      url: '/admin/nope',
      remoteAddress: '192.168.1.50',
    })
    expect(missing.json()).toEqual(res.json())
  })

  it('refuses a loopback caller that arrived through a reverse proxy', async () => {
    server = await startTestServer()

    // docs/DEPLOY.md's recommended deploy is the relay on 127.0.0.1 with Caddy in
    // FRONT OF IT ON THE SAME HOST. Every proxied request then presents socket peer
    // 127.0.0.1, so a loopback check alone would publish this route to the internet.
    // The forwarding header is the evidence that separates the two.
    for (const header of ['x-forwarded-for', 'x-real-ip', 'forwarded', 'x-forwarded-host']) {
      const res = await server.app.inject({
        method: 'GET',
        url: '/admin/status',
        remoteAddress: '127.0.0.1',
        headers: { [header]: '203.0.113.9' },
      })
      expect(res.statusCode, `${header} should not get through`).toBe(404)
    }

    // The direct call the doctor script makes has none of them and still works.
    const direct = await server.app.inject({
      method: 'GET',
      url: '/admin/status',
      remoteAddress: '127.0.0.1',
    })
    expect(direct.statusCode).toBe(200)
  })

  it('never carries a device token, a push subscription or the database URL', async () => {
    server = await startTestServer()
    const device = await register(server.baseUrl, { label: 'Ben Laptop' })

    const { body } = await http.get<RelayStatus>(server.baseUrl, '/admin/status')
    const serialised = JSON.stringify(body)

    expect(serialised).not.toContain(device.token)
    // The fake subscription's endpoint from helpers.register.
    expect(serialised).not.toContain('push.test/endpoint')
    expect(serialised).not.toContain('p256dh-key')
    expect(serialised).not.toContain(server.config.databaseUrl)
    // The label IS expected: every paired device can already read it via /v1/endpoints.
    expect(serialised).toContain('Ben Laptop')
    expect(body.devices.list[0]?.pushTransport).toBe('webpush')
  })

  it('reports a registered device as online, then stale as the clock moves', async () => {
    server = await startTestServer()
    await register(server.baseUrl, { label: 'Phone', kind: 'mobile' })

    const fresh = await http.get<RelayStatus>(server.baseUrl, '/admin/status')
    expect(fresh.body.devices.total).toBe(1)
    expect(fresh.body.devices.online).toBe(1)
    expect(fresh.body.devices.byKind.mobile).toBe(1)
    expect(codes(fresh.body)).toContain('single_device')

    server.clock.advance(20 * 86_400_000) // 20 days
    const later = await http.get<RelayStatus>(server.baseUrl, '/admin/status')
    expect(later.body.devices.online).toBe(0)
    expect(codes(later.body)).toContain('device_stale')
  })

  it('warns that a relay with nobody paired cannot do anything yet', async () => {
    server = await startTestServer()
    const { body } = await http.get<RelayStatus>(server.baseUrl, '/admin/status')
    expect(codes(body)).toContain('no_devices')
  })

  it('names tabs that have been sitting in the queue for hours', async () => {
    server = await startTestServer()
    const sender = await register(server.baseUrl, { label: 'Desk' })
    const target = await register(server.baseUrl, { label: 'Phone', kind: 'mobile' })

    const sent = await http.post(
      server.baseUrl,
      '/v1/messages',
      {
        items: [
          {
            id: 'stuck-tab',
            targetEndpointId: target.endpointId,
            envelope: envelopeFor(target.e2ePubkey),
          },
        ],
      },
      sender.token,
    )
    expect(sent.status).toBe(200)

    const immediately = await http.get<RelayStatus>(server.baseUrl, '/admin/status')
    expect(immediately.body.messages.waiting).toBe(1)
    // Fresh: in flight, not stuck.
    expect(codes(immediately.body)).not.toContain('tabs_waiting')

    server.clock.advance(3 * 3_600_000) // 3 hours
    const later = await http.get<RelayStatus>(server.baseUrl, '/admin/status')
    expect(later.body.messages.waiting).toBe(1)
    expect(later.body.messages.oldestWaitingSeconds).toBeGreaterThan(3600)
    expect(codes(later.body)).toContain('tabs_waiting')
  })

  it('names only the tabs that are actually stuck, not the ones beside them', async () => {
    server = await startTestServer()
    const sender = await register(server.baseUrl, { label: 'Desk' })
    const target = await register(server.baseUrl, { label: 'Phone', kind: 'mobile' })

    const send = (id: string) =>
      http.post(
        server.baseUrl,
        '/v1/messages',
        {
          items: [
            { id, targetEndpointId: target.endpointId, envelope: envelopeFor(target.e2ePubkey) },
          ],
        },
        sender.token,
      )

    await send('old-one')
    server.clock.advance(3 * 3_600_000) // 3 hours
    await send('fresh-a')
    await send('fresh-b')

    const { body } = await http.get<RelayStatus>(server.baseUrl, '/admin/status')
    expect(body.messages.waiting).toBe(3)
    expect(body.messages.stuck).toBe(1)
    const stuckWarning = body.warnings.find((w) => w.code === 'tabs_waiting')
    // Quoting `waiting` here would send someone chasing two tabs that are in flight.
    expect(stuckWarning?.message).toContain('1 tab(s)')
  })

  it('does not call the cleanup job behind for a tab that expired moments ago', async () => {
    server = await startTestServer({ messageTtlMs: 60_000 })
    const sender = await register(server.baseUrl, { label: 'Desk' })
    const target = await register(server.baseUrl, { label: 'Phone', kind: 'mobile' })
    await http.post(
      server.baseUrl,
      '/v1/messages',
      {
        items: [
          {
            id: 'expiring',
            targetEndpointId: target.endpointId,
            envelope: envelopeFor(target.e2ePubkey),
          },
        ],
      },
      sender.token,
    )

    // Past expiry, but well inside the window the sweeper is allowed to take.
    server.clock.advance(90_000)
    const soon = await http.get<RelayStatus>(server.baseUrl, '/admin/status')
    expect(soon.body.messages.expiredNotSwept).toBe(1)
    expect(codes(soon.body)).not.toContain('sweeper_behind')

    // Hours later the same unpurged row is real evidence the sweeper is not working.
    server.clock.advance(4 * 3_600_000)
    const later = await http.get<RelayStatus>(server.baseUrl, '/admin/status')
    expect(codes(later.body)).toContain('sweeper_behind')
  })

  it('reports a switched-off cleanup job, which leaves tab contents un-erased forever', async () => {
    server = await startTestServer({ messageTtlMs: 60_000, sweepIntervalMs: 0 })
    const sender = await register(server.baseUrl, { label: 'Desk' })
    const target = await register(server.baseUrl, { label: 'Phone', kind: 'mobile' })
    await http.post(
      server.baseUrl,
      '/v1/messages',
      {
        items: [
          {
            id: 'never-erased',
            targetEndpointId: target.endpointId,
            envelope: envelopeFor(target.e2ePubkey),
          },
        ],
      },
      sender.token,
    )

    server.clock.advance(4 * 3_600_000)
    const { body } = await http.get<RelayStatus>(server.baseUrl, '/admin/status')
    expect(body.messages.expiredNotSwept).toBe(1)
    // The relay never sweeps here, so a runs-based check would report perfect health.
    expect(body.sweeper.runs).toBe(0)
    expect(codes(body)).toContain('sweeper_disabled')
    expect(codes(body)).not.toContain('sweeper_behind')
  })

  it('counts refused requests since boot', async () => {
    server = await startTestServer()
    const before = await http.get<RelayStatus>(server.baseUrl, '/admin/status')
    expect(before.body.refusals.unauthorized).toBe(0)

    const denied = await http.get(server.baseUrl, '/v1/endpoints', 'not-a-real-token')
    expect(denied.status).toBe(401)

    const after = await http.get<RelayStatus>(server.baseUrl, '/admin/status')
    expect(after.body.refusals.unauthorized).toBe(1)
    expect(after.body.refusals.internalError).toBe(0)
  })

  it('reports the second listener and the first as one relay', async () => {
    server = await startTestServer({ secondListener: true })
    const second = server.second
    if (!second) throw new Error('secondListener did not come up')

    const denied = await http.get(second.baseUrl, '/v1/endpoints', 'not-a-real-token')
    expect(denied.status).toBe(401)

    // Counted once, visible from EITHER door: dual-listen is one relay (server.ts).
    const viaFirst = await http.get<RelayStatus>(server.baseUrl, '/admin/status')
    const viaSecond = await http.get<RelayStatus>(second.baseUrl, '/admin/status')
    expect(viaFirst.body.refusals.unauthorized).toBe(1)
    expect(viaSecond.body.refusals.unauthorized).toBe(1)
    expect(viaSecond.body.relay.relayId).toBe(viaFirst.body.relay.relayId)
  })
})

describe('RelayStats', () => {
  it('accumulates sweeps and keeps only the newest error, truncated', async () => {
    const stats = new RelayStats(new Date('2026-08-16T10:00:00.000Z'))

    stats.recordSweep(
      {
        purged: 2,
        deleted: 1,
        blobsDropped: 0,
        keysDropped: 0,
        pairingCodesDropped: 0,
        quotaWindowsDropped: 0,
      },
      new Date('2026-08-16T10:01:00.000Z'),
    )
    stats.recordSweep(
      {
        purged: 3,
        deleted: 0,
        blobsDropped: 0,
        keysDropped: 0,
        pairingCodesDropped: 0,
        quotaWindowsDropped: 0,
      },
      new Date('2026-08-16T10:02:00.000Z'),
    )

    const snap = stats.snapshot()
    expect(snap.sweeps.runs).toBe(2)
    expect(snap.sweeps.totalPurged).toBe(5)
    expect(snap.sweeps.totalDeleted).toBe(1)
    expect(snap.sweeps.lastPurged).toBe(3)
    expect(snap.sweeps.lastRunAt).toBe('2026-08-16T10:02:00.000Z')

    stats.recordError(new Error('first'), new Date('2026-08-16T10:03:00.000Z'))
    stats.recordError(new Error('x'.repeat(500)), new Date('2026-08-16T10:04:00.000Z'))
    const withError = stats.snapshot()
    expect(withError.lastError?.message).not.toContain('first')
    expect(withError.lastError?.message.length).toBeLessThan(250)
  })

  it('hands out copies, so a caller cannot mutate the live counters', () => {
    const stats = new RelayStats()
    stats.countRefusal('unauthorized')
    const snap = stats.snapshot()
    snap.refusals.unauthorized = 999
    expect(stats.snapshot().refusals.unauthorized).toBe(1)
  })
})
