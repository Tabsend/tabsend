import type { ApiError, RegisterResponse, ServerConfigResponse } from '@tabsend/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { mintFirstRunPairing } from '../src/bootstrap'
import { newPairingCode } from '../src/ids'
import { http, pairingCodeFromLink, register, startTestServer, type TestServer } from './helpers'

/**
 * The relay owns its group (ADR-0023).
 *
 * Setting up a relay and then separately "creating a group" was two steps for one
 * thing, and the second step was impossible on a phone — the iOS and Android apps only
 * ever join with a pairing link, so a fresh relay could not be adopted by the device
 * most likely to be reaching for it. The relay now creates its own group at boot and
 * hands out the first pairing link itself, so every client does the same single thing:
 * join.
 */

let server: TestServer
afterEach(async () => {
  await server?.close()
})

describe('relay-owned group (default, single-group)', () => {
  it('has a group before any client registers, so nothing is left to create', async () => {
    server = await startTestServer()

    // The whole point: no client has spoken to this relay, and the group already exists.
    const config = await http.get<ServerConfigResponse>(server.baseUrl, '/v1/config')
    expect(config.body.acceptsNewGroups).toBe(false)
  })

  it('mints a first-run pairing link that a phone can use with no browser involved', async () => {
    server = await startTestServer()
    const firstRun = server.firstRunPairing
    expect(firstRun).not.toBeNull()

    // A phone joins straight from the relay's own link — the case that was impossible
    // before, since a phone cannot create a group and nobody was paired to invite it.
    const phone = await register(server.baseUrl, {
      pairingCode: firstRun ? pairingCodeFromLink(firstRun.link) : undefined,
      kind: 'mobile',
      platform: 'ios',
      browser: null,
    })
    expect(phone.groupId).toBeTruthy()

    // And it is in the relay's OWN group, not one it made for itself.
    const config = await http.get<ServerConfigResponse>(server.baseUrl, '/v1/config')
    expect(config.body.acceptsNewGroups).toBe(false)
    expect(phone.endpointId).toBeTruthy()
  })

  it('refuses a create even as the very first client, and says where to get a link', async () => {
    server = await startTestServer()

    const res = await http.post<ApiError>(server.baseUrl, '/v1/endpoints/register', {
      label: 'Chrome · Mac',
      kind: 'extension',
      browser: 'chrome',
      platform: 'macos',
      pushSubscription: { transport: 'none' },
      e2ePubkey: 'pk-create',
    })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('group_exists')
    // A first-time operator has no paired device to be sent to, so the message must
    // also point at the relay's startup log.
    expect(res.body.error.message).toMatch(/startup log/i)
  })

  it('stops offering a first-run link once a device has joined', async () => {
    server = await startTestServer()
    const first = server.firstRunPairing
    await register(server.baseUrl, {
      pairingCode: first ? pairingCodeFromLink(first.link) : undefined,
    })

    // Rebooting against the SAME database must not hand out another free way in —
    // from here on, pairing is device-to-device. (Calling the boot step directly is
    // exactly what a restart does; no need to rebuild the listener to prove it.)
    const onReboot = await mintFirstRunPairing(
      server.db,
      server.config,
      undefined,
      server.clock.now(),
    )
    expect(onReboot).toBeNull()
  })

  it('does not reuse a consumed first-run link', async () => {
    server = await startTestServer()
    const code = server.firstRunPairing
      ? pairingCodeFromLink(server.firstRunPairing.link)
      : undefined

    await register(server.baseUrl, { pairingCode: code })
    const second = await http.post<ApiError>(server.baseUrl, '/v1/endpoints/register', {
      label: 'Second',
      kind: 'extension',
      browser: 'firefox',
      platform: 'macos',
      pushSubscription: { transport: 'none' },
      e2ePubkey: 'pk-second',
      pairingCode: code,
    })
    expect(second.status).toBe(400)
    expect(second.body.error.code).toBe('invalid_pairing_code')
  })
})

describe('multi-group relay (ALLOW_MULTIPLE_GROUPS)', () => {
  it('creates no group and no first-run code — every group there has an owner', async () => {
    server = await startTestServer({ allowMultipleGroups: true })

    expect(server.firstRunPairing).toBeNull()
    const config = await http.get<ServerConfigResponse>(server.baseUrl, '/v1/config')
    expect(config.body.acceptsNewGroups).toBe(true)

    // Clients still create their own groups here, which is the point of the mode.
    const a = await http.post<RegisterResponse>(server.baseUrl, '/v1/endpoints/register', {
      label: 'A',
      kind: 'extension',
      browser: 'chrome',
      platform: 'macos',
      pushSubscription: { transport: 'none' },
      e2ePubkey: 'pk-a',
    })
    expect(a.status).toBe(201)
  })
})

/**
 * No unclaimed first link survives the first join [0031 amended 2026-10-01]
 * (HOSTED_PLAN §5).
 *
 * The rule that makes the bootstrap window safe is "only while the group has no
 * endpoints", and it used to be enforced on the mint alone: two mints on an empty group
 * produced two valid links, the first device consumed one, and the other was a way into
 * a populated group that nobody had revoked. Reachable by restarting an unpaired relay
 * twice, no race required.
 *
 * The first fix deleted the earlier links at every mint, which broke the link an
 * earlier boot had printed. Now every printed link works until somebody pairs, and the
 * join that makes the group non-empty retires the rest.
 */
describe('first-run links stand until the first device joins, and not after', () => {
  const joinWith = (link: string) =>
    http.post<ApiError>(server.baseUrl, '/v1/endpoints/register', {
      label: 'Another',
      kind: 'extension',
      browser: 'chrome',
      platform: 'macos',
      e2ePubkey: `key-${link.slice(-8)}`,
      pushSubscription: { transport: 'none' },
      pairingCode: pairingCodeFromLink(link),
    })

  it('keeps the link an earlier boot printed working after a restart', async () => {
    server = await startTestServer()
    const first = server.firstRunPairing
    expect(first).not.toBeNull()

    // What a restart of a still-unpaired relay does: print another link.
    const second = await mintFirstRunPairing(
      server.db,
      server.config,
      undefined,
      server.clock.now(),
    )
    expect(second).not.toBeNull()

    // The OLDER one still works: somebody copied it out of yesterday's log.
    const joined = await joinWith((first as { link: string }).link)
    expect(joined.status).toBe(201)

    // And that join retired the newer one. Before, it would have let a second device
    // into a group that already had one; now it says why it stopped working.
    const stale = await joinWith((second as { link: string }).link)
    expect(stale.status).toBe(400)
    expect(stale.body.error.code).toBe('invalid_pairing_code')
    expect(stale.body.error.message).toContain('stopped working when the first device joined')
  })

  it('leaves device-to-device links alone once the group is populated', async () => {
    server = await startTestServer()
    const a = await register(server.baseUrl)
    const link = (
      await http.post<{ link: string }>(server.baseUrl, '/v1/pairing', undefined, a.token)
    ).body.link
    // A second device joining a populated group is not a first join, so the links the
    // group already holds are the devices' business and stay live.
    const other = (
      await http.post<{ link: string }>(server.baseUrl, '/v1/pairing', undefined, a.token)
    ).body.link
    expect((await joinWith(link)).status).toBe(201)
    expect((await joinWith(other)).status).toBe(201)
  })

  it('clears a first browser that never finished setup, on restart (PLANS P-21)', async () => {
    server = await startTestServer()
    const first = server.firstRunPairing
    await register(server.baseUrl, {
      pairingCode: pairingCodeFromLink((first as { link: string }).link),
    })
    // Still within the hour: it may be mid-setup, so a restart leaves it alone.
    server.clock.advance(59 * 60 * 1000)
    expect(
      await mintFirstRunPairing(server.db, server.config, undefined, server.clock.now()),
    ).toBeNull()

    server.clock.advance(60 * 1000)
    const fresh = await mintFirstRunPairing(server.db, server.config, undefined, server.clock.now())
    expect(fresh?.clearedLeftovers).toBe(1)
    expect((await joinWith((fresh as { link: string }).link)).status).toBe(201)
  })

  it('never clears a first device that chose its name, however long it is quiet', async () => {
    server = await startTestServer()
    const first = server.firstRunPairing
    await register(server.baseUrl, {
      pairingCode: pairingCodeFromLink((first as { link: string }).link),
      deviceName: 'MacBook',
    })
    server.clock.advance(30 * 24 * 60 * 60 * 1000)
    expect(
      await mintFirstRunPairing(server.db, server.config, undefined, server.clock.now()),
    ).toBeNull()
  })

  it('never clears a nameless device that joined more than a week ago (v0.9.0 review M1)', async () => {
    server = await startTestServer()
    const first = server.firstRunPairing
    // A web console, or a device paired before deviceName existed: no name, and the
    // group's messages long since swept. Days of downtime make it look quiet too.
    await register(server.baseUrl, {
      pairingCode: pairingCodeFromLink((first as { link: string }).link),
    })
    server.clock.advance(7 * 24 * 60 * 60 * 1000 + 60 * 1000)
    expect(
      await mintFirstRunPairing(server.db, server.config, undefined, server.clock.now()),
    ).toBeNull()
  })

  for (const table of ['group_keys', 'removed_endpoints'] as const) {
    it(`never clears a group that holds a row in ${table} (v0.9.0 review M1)`, async () => {
      server = await startTestServer()
      const first = server.firstRunPairing
      const a = await register(server.baseUrl, {
        pairingCode: pairingCodeFromLink((first as { link: string }).link),
      })
      const row = await server.db
        .selectFrom('endpoints')
        .select(['group_id', 'id'])
        .where('id', '=', a.endpointId)
        .executeTakeFirstOrThrow()
      const at = server.clock.now().toISOString()
      if (table === 'group_keys') {
        await server.db
          .insertInto('group_keys')
          .values({
            id: 'gk-1',
            group_id: row.group_id,
            source_endpoint_id: row.id,
            target_endpoint_id: row.id,
            envelope: '{}',
            created_at: at,
          })
          .execute()
      } else {
        await server.db
          .insertInto('removed_endpoints')
          .values({
            device_token_hash: 'removed-device',
            endpoint_id: 'ep-removed',
            group_id: row.group_id,
            removed_at: at,
          })
          .execute()
      }
      server.clock.advance(2 * 60 * 60 * 1000)
      expect(
        await mintFirstRunPairing(server.db, server.config, undefined, server.clock.now()),
      ).toBeNull()
    })
  }

  it('mints nothing once a device is in', async () => {
    server = await startTestServer()
    const first = server.firstRunPairing
    await register(server.baseUrl, {
      pairingCode: pairingCodeFromLink((first as { link: string }).link),
    })

    expect(
      await mintFirstRunPairing(server.db, server.config, undefined, server.clock.now()),
    ).toBeNull()
  })

  /**
   * A retired link stays dead whatever the clock says [2026-10-01]. Retiring pulls a
   * code's expiry back to at most the retiring join's clock, so a join whose clock read
   * earlier (a second relay process, a clock stepped back) would find it still in date.
   * The consume also requires that it is not retired.
   */
  it('keeps a retired link dead even for a join whose clock reads earlier', async () => {
    server = await startTestServer()
    const group = await server.db.selectFrom('groups').select('id').executeTakeFirstOrThrow()
    const now = server.clock.now().getTime()
    const code = newPairingCode()
    // As a retiring join with a clock two minutes fast would have left it.
    await server.db
      .insertInto('pairing_codes')
      .values({
        code,
        group_id: group.id,
        created_at: new Date(now + 120_000).toISOString(),
        expires_at: new Date(now + 60_000).toISOString(),
        consumed_at: null,
      })
      .execute()

    const late = await joinWith(`${server.baseUrl}/pair#c=${code}`)
    expect(late.status).toBe(400)
    expect(late.body.error.message).toContain('stopped working when the first device joined')
  })
})
