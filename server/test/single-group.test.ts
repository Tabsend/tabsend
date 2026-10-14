import type { ApiError, CreatePairingResponse, ServerConfigResponse } from '@tabsend/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { http, pairingCodeFromLink, register, startTestServer, type TestServer } from './helpers'

/**
 * One relay, one group (ADR-0022) — the default.
 *
 * The failure this prevents is silent, which is why it is worth a policy: a browser that
 * picks "create a group" instead of "join" on a relay that already has one used to get a
 * second, invisible group. Both browsers then reported themselves as healthily paired,
 * neither could see the other, and nothing anywhere said why. Refusing the second create
 * turns that into an error message at the moment of the mistake.
 */

let server: TestServer
afterEach(async () => {
  await server?.close()
})

describe('single-group relay (default)', () => {
  it('refuses a create outright, because the relay already made the group', async () => {
    server = await startTestServer()

    const second = await http.post<ApiError>(server.baseUrl, '/v1/endpoints/register', {
      label: 'Second browser',
      kind: 'extension',
      browser: 'firefox',
      platform: 'macos',
      pushSubscription: { transport: 'none' },
      e2ePubkey: 'pubkey-second',
    })
    // 409, not 400: the request is well-formed, it conflicts with relay state.
    expect(second.status).toBe(409)
    expect(second.body.error.code).toBe('group_exists')
    // The message has to name the way forward, since this is a dead end otherwise.
    expect(second.body.error.message).toMatch(/pairing link/i)
  })

  it('still lets a second device join with a pairing link', async () => {
    server = await startTestServer()

    const first = await register(server.baseUrl)
    const minted = await http.post<CreatePairingResponse>(
      server.baseUrl,
      '/v1/pairing',
      undefined,
      first.token,
    )
    const second = await register(server.baseUrl, {
      pairingCode: pairingCodeFromLink(minted.body.link),
    })

    // The whole point: joining is unaffected, and lands in the SAME group.
    expect(second.groupId).toBe(first.groupId)
    expect(second.endpointId).not.toBe(first.endpointId)
  })

  it('advertises acceptsNewGroups=false from the very first boot', async () => {
    server = await startTestServer()

    // No longer a flip: the relay creates its group at boot (ADR-0023), so there is
    // never a window in which a client is invited to make one.
    const config = await http.get<ServerConfigResponse>(server.baseUrl, '/v1/config')
    expect(config.body.acceptsNewGroups).toBe(false)

    await register(server.baseUrl)

    const after = await http.get<ServerConfigResponse>(server.baseUrl, '/v1/config')
    expect(after.body.acceptsNewGroups).toBe(false)
    // A hint only — it leaks "in use", never ids, counts, or membership.
    expect(after.body).not.toHaveProperty('groupId')
  })
})

describe('open relay (GROUP_CREATION=open, formerly ALLOW_MULTIPLE_GROUPS)', () => {
  it('allows repeated creates and keeps advertising acceptsNewGroups', async () => {
    server = await startTestServer({ groupCreation: 'open' })

    const a = await register(server.baseUrl)
    const b = await register(server.baseUrl)
    expect(a.groupId).not.toBe(b.groupId)

    const config = await http.get<ServerConfigResponse>(server.baseUrl, '/v1/config')
    expect(config.body.acceptsNewGroups).toBe(true)
  })

  it('is still what the old ALLOW_MULTIPLE_GROUPS spelling asks for', async () => {
    server = await startTestServer({ allowMultipleGroups: true })
    expect(server.config.groupCreation).toBe('open')

    const a = await register(server.baseUrl)
    const b = await register(server.baseUrl)
    expect(a.groupId).not.toBe(b.groupId)
  })
})

/**
 * Provisioned groups [0029] (HOSTED_PLAN §4.1) — the mode a relay runs in when its
 * groups belong to people who did not set it up.
 *
 * `open` says "many groups, anyone may make one", which is right for a household and
 * wrong for a relay someone else operates: it lets a stranger mint a tenancy past
 * signup, billing and caps. `provisioned` keeps the many-groups half and shuts the
 * public create path for good, including while the relay is still empty, which is the
 * exact difference from the single-group relay's one-shot.
 */
describe('provisioned relay (GROUP_CREATION=provisioned)', () => {
  const createBody = {
    label: 'Uninvited browser',
    kind: 'extension',
    browser: 'firefox',
    platform: 'macos',
    pushSubscription: { transport: 'none' },
    e2ePubkey: 'pubkey-uninvited',
  }

  it('refuses a public create even with no group on the relay at all', async () => {
    server = await startTestServer({ groupCreation: 'provisioned' })

    // Nothing was bootstrapped: an empty provisioned relay is the normal state.
    const groups = await server.db.selectFrom('groups').select('id').execute()
    expect(groups).toEqual([])

    const res = await http.post<ApiError>(server.baseUrl, '/v1/endpoints/register', createBody)
    // 403, not the single-group relay's 409: nothing conflicts here, the caller is
    // simply never allowed to do this.
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('forbidden')
    // The copy has to leave the user somewhere to go, since they cannot fix this.
    expect(res.body.error.message).toMatch(/pairing link/i)
  })

  it('mints no first-run pairing link at boot', async () => {
    server = await startTestServer({ groupCreation: 'provisioned' })
    // A link belongs to one group, and on this relay no group exists yet — choosing
    // one is the provisioning path's job, not boot's.
    expect(server.firstRunPairing).toBeNull()
  })

  it('advertises acceptsNewGroups=false, so clients never offer "create"', async () => {
    server = await startTestServer({ groupCreation: 'provisioned' })

    const config = await http.get<ServerConfigResponse>(server.baseUrl, '/v1/config')
    expect(config.body.acceptsNewGroups).toBe(false)
    // Still only "in use / not in use": the hint does not name the policy.
    expect(config.body).not.toHaveProperty('groupCreation')
  })

  it('still lets a device join a group that was provisioned out of band', async () => {
    server = await startTestServer({ groupCreation: 'provisioned' })
    // Stand-in for the provisioning API a later change adds: the group exists
    // because the operator made it, not because a client asked.
    await server.db
      .insertInto('groups')
      .values({ id: 'provisioned-group', created_at: '2026-07-16T12:00:00.000Z' })
      .execute()

    // Joining is untouched — register() mints a code for the existing group exactly
    // as a paired device would for a newcomer.
    const first = await register(server.baseUrl)
    expect(first.groupId).toBe('provisioned-group')

    const minted = await http.post<CreatePairingResponse>(
      server.baseUrl,
      '/v1/pairing',
      undefined,
      first.token,
    )
    const second = await register(server.baseUrl, {
      pairingCode: pairingCodeFromLink(minted.body.link),
    })
    expect(second.groupId).toBe('provisioned-group')

    // And the create path is still shut, group or no group.
    const refused = await http.post<ApiError>(server.baseUrl, '/v1/endpoints/register', createBody)
    expect(refused.status).toBe(403)
    expect(refused.body.error.code).toBe('forbidden')
  })
})
