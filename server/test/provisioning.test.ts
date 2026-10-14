import type { ApiError, SendResponse } from '@tabsend/shared'
import { afterEach, describe, expect, it } from 'vitest'
import type { GroupUsage } from '../src/tenancy'
import {
  connectWs,
  envelopeFor,
  http,
  pairingCodeFromLink,
  register,
  startTestServer,
  type TestServer,
} from './helpers'

/**
 * `/admin/provisioning/*` — the control plane's surface on the relay [0031]
 * (HOSTED_PLAN §4.2).
 *
 * Three properties here are the ones a later edit could quietly break, so they are
 * tested hardest rather than thoroughly:
 *
 *  1. **Both access factors, or nothing.** Loopback alone is a location, not an
 *     identity; a credential alone would be reachable from the internet. Every failure
 *     answers the ordinary 404, byte for byte, so nothing scanning the relay learns the
 *     surface is here.
 *  2. **Usage is aggregates only.** §2.2 promises the control plane sees no device
 *     labels, names or per-endpoint rows. That promise is a JSON shape, so it is
 *     asserted over the live response rather than over a comment.
 *  3. **Suspension does not unpair anybody.** It refuses new work and touches nothing
 *     else — the failure mode §5 names is somebody's card expiring and their devices
 *     silently going away.
 */

const TOKEN = 'test-provisioning-credential'
const OTHER_TOKEN = 'test-provisioning-credentiaL' // one bit different, same length

let server: TestServer

afterEach(async () => {
  await server?.close()
})

interface CreatedGroup {
  groupId: string
  createdAt: string
  suspended: boolean
}

interface MintedPairing {
  link: string
  qrLink: string
  expiresAt: string
}

interface CapsBody {
  groupId: string
  overrides: Record<string, number | null>
  effective: Record<string, number>
}

interface DeletionBody {
  groupId: string
  existed: boolean
  deleted: Record<string, number>
  socketsClosed: number
}

/** Boot a hosted-shaped relay: several groups, none creatable over the public API. */
async function startHosted(extra: Parameters<typeof startTestServer>[0] = {}): Promise<TestServer> {
  return startTestServer({ groupCreation: 'provisioned', provisioningToken: TOKEN, ...extra })
}

async function createGroup(base: string): Promise<string> {
  const res = await http.post<CreatedGroup>(base, '/admin/provisioning/groups', undefined, TOKEN)
  expect(res.status).toBe(201)
  return res.body.groupId
}

async function mintFirstLink(base: string, groupId: string): Promise<MintedPairing> {
  const res = await http.post<MintedPairing>(
    base,
    `/admin/provisioning/groups/${groupId}/pairing`,
    undefined,
    TOKEN,
  )
  expect(res.status).toBe(201)
  return res.body
}

const usageOf = (base: string, groupId: string) =>
  http.get<GroupUsage>(base, `/admin/provisioning/groups/${groupId}/usage`, TOKEN)

/** Every key name appearing anywhere in a JSON value, at any depth. */
function everyKey(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) everyKey(item, out)
    return out
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      out.push(key)
      everyKey(nested, out)
    }
  }
  return out
}

describe('provisioning API: it does not exist without a credential', () => {
  it('serves nothing at all on a relay with no PROVISIONING_TOKEN', async () => {
    server = await startTestServer({ groupCreation: 'provisioned' })

    const created = await http.post<ApiError>(server.baseUrl, '/admin/provisioning/groups')
    expect(created.status).toBe(404)
    // Not "registered and refusing": a self-hosted relay is the relay it always was.
    const typo = await http.get<ApiError>(server.baseUrl, '/admin/nope')
    expect(created.body).toEqual(typo.body)

    // And presenting a credential does not conjure it into being.
    const withToken = await http.post<ApiError>(
      server.baseUrl,
      '/admin/provisioning/groups',
      undefined,
      TOKEN,
    )
    expect(withToken.status).toBe(404)
  })
})

describe('provisioning API: access needs BOTH factors', () => {
  it('answers the ordinary 404 to every failure, and 201 only to a direct local call with the credential', async () => {
    server = await startHosted()
    const url = '/admin/provisioning/groups'
    const notFound = (await http.get<ApiError>(server.baseUrl, '/admin/nope')).body

    // No credential at all.
    const anonymous = await http.post<ApiError>(server.baseUrl, url)
    expect(anonymous.status).toBe(404)
    expect(anonymous.body).toEqual(notFound)

    // A credential, but the wrong one — same length, so a length check could not be
    // what refused it.
    const wrong = await http.post<ApiError>(server.baseUrl, url, undefined, OTHER_TOKEN)
    expect(wrong.status).toBe(404)
    expect(wrong.body).toEqual(notFound)

    // The RIGHT credential, arriving through a reverse proxy. docs/DEPLOY.md's
    // recommended deploy puts Caddy on this same host, so every proxied request has
    // socket peer 127.0.0.1 — a loopback check alone would publish this to the
    // internet, and the forwarding header is the evidence that separates the two.
    for (const header of ['x-forwarded-for', 'x-real-ip', 'forwarded', 'x-forwarded-host']) {
      const proxied = await server.app.inject({
        method: 'POST',
        url,
        remoteAddress: '127.0.0.1',
        headers: { authorization: `Bearer ${TOKEN}`, [header]: '203.0.113.9' },
      })
      expect(proxied.statusCode, `${header} should not get through`).toBe(404)
      expect(proxied.json()).toEqual(notFound)
    }

    // The right credential from another machine. inject() is the only way to present
    // a non-loopback peer; a real socket in this suite is always 127.0.0.1.
    const remote = await server.app.inject({
      method: 'POST',
      url,
      remoteAddress: '192.168.1.50',
      headers: { authorization: `Bearer ${TOKEN}` },
    })
    expect(remote.statusCode).toBe(404)
    expect(remote.json()).toEqual(notFound)

    // Both factors: the only shape that works.
    const allowed = await http.post<CreatedGroup>(server.baseUrl, url, undefined, TOKEN)
    expect(allowed.status).toBe(201)
    expect(allowed.body.groupId.length).toBeGreaterThan(0)
    expect(allowed.body.suspended).toBe(false)
  })

  it('refuses a credential presented in the wrong scheme, and logs which factor failed', async () => {
    const logs: unknown[] = []
    server = await startHosted({ captureLogs: logs })

    const res = await server.app.inject({
      method: 'POST',
      url: '/admin/provisioning/groups',
      headers: { authorization: TOKEN }, // no "Bearer"
    })
    expect(res.statusCode).toBe(404)

    const refusal = logs.find(
      (line): line is Record<string, unknown> =>
        typeof line === 'object' &&
        line !== null &&
        String((line as { msg?: unknown }).msg ?? '').includes('Refused a provisioning call'),
    )
    expect(refusal).toBeDefined()
    expect(refusal?.local).toBe(true)
    expect(refusal?.credential).toBe('absent')
    // The credential presented is never written down, whatever it was.
    expect(JSON.stringify(logs)).not.toContain(TOKEN)
  })
})

describe('provisioning API: the tenancy lifecycle', () => {
  it('runs create → mint → pair → usage → suspend → resume → delete → delete again', async () => {
    server = await startHosted()
    const base = server.baseUrl

    // 1. Create. A provisioned relay makes no group at boot [0029], so this is the
    //    first one that exists.
    const groupId = await createGroup(base)
    const usageFresh = await usageOf(base, groupId)
    expect(usageFresh.status).toBe(200)
    expect(usageFresh.body.endpoints).toBe(0)
    expect(usageFresh.body.suspended).toBe(false)

    // 2. Mint the first link, and 3. pair a real device with it.
    const pairing = await mintFirstLink(base, groupId)
    expect(pairing.link).toContain('#')
    const device = await register(base, { pairingCode: pairingCodeFromLink(pairing.link) })
    expect(device.groupId).toBe(groupId)

    // 4. Usage reflects it, and a queued tab shows up as one live queued message.
    const second = await register(base, {
      pairingCode: await mintPairingFromDevice(base, device.token),
      label: 'Second',
    })
    const sent = await http.post<SendResponse>(
      base,
      '/v1/messages',
      {
        items: [
          {
            id: 'm-1',
            targetEndpointId: second.endpointId,
            envelope: envelopeFor(second.e2ePubkey),
          },
        ],
      },
      device.token,
    )
    expect(sent.body.accepted).toEqual(['m-1'])

    const busy = await usageOf(base, groupId)
    expect(busy.body.endpoints).toBe(2)
    expect(busy.body.queue.messages).toBe(1)
    expect(busy.body.queue.bytes).toBeGreaterThan(0)
    expect(busy.body.queue.oldestPendingSeconds).toBe(0)

    // 5. Suspend. Sends are refused and say why; joining and minting are refused too.
    const suspended = await http.post<{ suspended: boolean; suspendedAt: string | null }>(
      base,
      `/admin/provisioning/groups/${groupId}/suspend`,
      undefined,
      TOKEN,
    )
    expect(suspended.status).toBe(200)
    expect(suspended.body.suspended).toBe(true)
    expect(suspended.body.suspendedAt).not.toBeNull()

    const refusedSend = await http.post<ApiError>(
      base,
      '/v1/messages',
      {
        items: [
          {
            id: 'm-2',
            targetEndpointId: second.endpointId,
            envelope: envelopeFor(second.e2ePubkey),
          },
        ],
      },
      device.token,
    )
    expect(refusedSend.status).toBe(403)
    expect(refusedSend.body.error.code).toBe('forbidden')
    expect(refusedSend.body.error.message).toContain('suspended')
    // Actionable, and honest about what did NOT happen.
    expect(refusedSend.body.error.message).toContain('paired')

    const refusedMint = await http.post<ApiError>(base, '/v1/pairing', undefined, device.token)
    expect(refusedMint.status).toBe(403)
    expect(refusedMint.body.error.code).toBe('forbidden')

    // A link minted BEFORE the suspension is still a credential; register is where it
    // is turned away, and the link survives the refusal.
    const preMinted = await mintPairingBeforeSuspension(groupId)
    const refusedJoin = await http.post<ApiError>(base, '/v1/endpoints/register', {
      label: 'Latecomer',
      kind: 'extension',
      browser: 'chrome',
      platform: 'macos',
      pushSubscription: {
        transport: 'webpush',
        endpoint: 'https://push.test/endpoint',
        keys: { p256dh: 'p', auth: 'a' },
      },
      e2ePubkey: 'pk-late',
      pairingCode: preMinted,
    })
    expect(refusedJoin.status).toBe(403)
    expect(refusedJoin.body.error.code).toBe('forbidden')
    const codeRow = await server.db
      .selectFrom('pairing_codes')
      .select('consumed_at')
      .where('code', '=', preMinted)
      .executeTakeFirstOrThrow()
    expect(codeRow.consumed_at).toBeNull() // rolled back with the refusal

    // Nobody was unpaired, and the tab queued before the suspension still arrives.
    const pending = await http.get<Array<{ id: string }>>(
      base,
      '/v1/messages?pending=1',
      second.token,
    )
    expect(pending.status).toBe(200)
    expect(pending.body.map((m) => m.id)).toEqual(['m-1'])
    const acked = await http.post(base, '/v1/messages/m-1/ack', undefined, second.token)
    expect(acked.status).toBe(200)

    // 6. Resume, and sending works again.
    const resumed = await http.post<{ suspended: boolean }>(
      base,
      `/admin/provisioning/groups/${groupId}/resume`,
      undefined,
      TOKEN,
    )
    expect(resumed.body.suspended).toBe(false)
    const afterResume = await http.post<SendResponse>(
      base,
      '/v1/messages',
      {
        items: [
          {
            id: 'm-3',
            targetEndpointId: second.endpointId,
            envelope: envelopeFor(second.e2ePubkey),
          },
        ],
      },
      device.token,
    )
    expect(afterResume.body.accepted).toEqual(['m-3'])

    // 7. Delete: everything the group owned, gone.
    const deleted = await http.del<DeletionBody>(
      base,
      `/admin/provisioning/groups/${groupId}`,
      TOKEN,
    )
    expect(deleted.status).toBe(200)
    expect(deleted.body.existed).toBe(true)
    expect(deleted.body.deleted.endpoints).toBe(2)
    expect(deleted.body.deleted.messages).toBeGreaterThan(0)

    for (const table of [
      'endpoints',
      'messages',
      'group_keys',
      'pairing_codes',
      'removed_endpoints',
    ] as const) {
      const left = await server.db
        .selectFrom(table)
        .select((eb) => eb.fn.countAll().as('n'))
        .where('group_id', '=', groupId)
        .executeTakeFirst()
      expect(Number(left?.n ?? 0), `${table} should be empty`).toBe(0)
    }
    const group = await server.db
      .selectFrom('groups')
      .select('id')
      .where('id', '=', groupId)
      .executeTakeFirst()
    expect(group).toBeUndefined()

    // The device tokens went with the endpoint rows, which is where the relay keeps
    // them (hashed, ADR-0024) — so they authenticate nothing.
    const orphaned = await http.get<ApiError>(base, '/v1/endpoints', device.token)
    expect(orphaned.status).toBe(401)
    expect(orphaned.body.error.code).toBe('unauthorized')

    // 8. Deleting it again succeeds. HOSTED_PLAN §5: a teardown must be safe to re-run
    //    until everything is gone, because a half-deleted tenant is the worst state.
    const again = await http.del<DeletionBody>(base, `/admin/provisioning/groups/${groupId}`, TOKEN)
    expect(again.status).toBe(200)
    expect(again.body.existed).toBe(false)
    expect(again.body.deleted).toEqual({
      endpoints: 0,
      messages: 0,
      groupKeys: 0,
      pairingCodes: 0,
      removedEndpoints: 0,
      quotaCounters: 0,
    })
  })

  /** Mint a pairing link the ordinary way, from a device that is already in the group. */
  async function mintPairingFromDevice(base: string, token: string): Promise<string> {
    const res = await http.post<{ link: string }>(base, '/v1/pairing', undefined, token)
    expect(res.status).toBe(201)
    return pairingCodeFromLink(res.body.link)
  }

  /**
   * A pairing code that already existed when the group was suspended. Written straight
   * to the store because the route that mints one is (correctly) refused by then.
   */
  async function mintPairingBeforeSuspension(groupId: string): Promise<string> {
    const code = `pre-suspend-${Math.random().toString(36).slice(2)}`
    await server.db
      .insertInto('pairing_codes')
      .values({
        code,
        group_id: groupId,
        created_at: '2026-07-16T12:00:00.000Z',
        expires_at: '2030-01-01T00:00:00.000Z',
        consumed_at: null,
      })
      .execute()
    return code
  }
})

/**
 * `Idempotency-Key` on create [0031]. The header was read and logged from the first
 * version of this route and honoured nowhere, so a create the control plane retried
 * after a timeout left the account owning TWO tenancies — one of which nobody ever
 * names again, and which counts against nothing because the relay knows no accounts.
 * This is the one route where a retry is expensive.
 */
describe('provisioning API: creating a group is idempotent on a key', () => {
  // Driven through `app.inject` rather than the HTTP helper, because this is the one
  // route whose behaviour depends on a request HEADER.
  const create = (key?: string) =>
    server.app.inject({
      method: 'POST',
      url: '/admin/provisioning/groups',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        ...(key === undefined ? {} : { 'idempotency-key': key }),
      },
    })

  it('answers the same group to a repeat of the key, and 200 rather than 201', async () => {
    server = await startHosted()
    const first = await create('signup-7')
    expect(first.statusCode).toBe(201)
    const groupId = (first.json() as CreatedGroup).groupId

    const replay = await create('signup-7')
    // 200, not 201: nothing was created this time, and a control plane counting its
    // 201s should be able to believe them.
    expect(replay.statusCode).toBe(200)
    expect((replay.json() as CreatedGroup).groupId).toBe(groupId)
    expect((replay.json() as CreatedGroup).createdAt).toBe((first.json() as CreatedGroup).createdAt)

    // One group, not two — the whole point.
    const groups = await server.db.selectFrom('groups').select('id').execute()
    expect(groups).toHaveLength(1)
  })

  it('reports the group as it is NOW, not as it was when the key was first used', async () => {
    server = await startHosted()
    const groupId = (await create('signup-8')).json<CreatedGroup>().groupId
    await http.post(
      server.baseUrl,
      `/admin/provisioning/groups/${groupId}/suspend`,
      undefined,
      TOKEN,
    )
    const replay = await create('signup-8')
    expect(replay.statusCode).toBe(200)
    expect(replay.json<CreatedGroup>().suspended).toBe(true)
  })

  it('keeps making a group per call when no key is sent, exactly as before', async () => {
    server = await startHosted()
    const a = await create()
    const b = await create()
    expect(a.statusCode).toBe(201)
    expect(b.statusCode).toBe(201)
    expect(a.json<CreatedGroup>().groupId).not.toBe(b.json<CreatedGroup>().groupId)
    expect(await server.db.selectFrom('groups').select('id').execute()).toHaveLength(2)
    // And nothing was recorded, so the table stays empty on a relay that never sends
    // the header.
    expect(
      await server.db.selectFrom('provisioning_idempotency').select('key').execute(),
    ).toHaveLength(0)
  })

  it('creates exactly one group when the same key arrives several times at once', async () => {
    server = await startHosted()
    const results = await Promise.all(Array.from({ length: 6 }, () => create('signup-race')))
    const ids = new Set(results.map((r) => r.json<CreatedGroup>().groupId))
    expect(ids.size).toBe(1)
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1)
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(5)
    expect(await server.db.selectFrom('groups').select('id').execute()).toHaveLength(1)
  })

  it('refuses to resurrect a tenancy that was deleted under the same key', async () => {
    // A record of a CALL, not of a group, so it outlives the group on purpose: a
    // create retried after the account was torn down must not quietly bring it back.
    server = await startHosted()
    const groupId = (await create('signup-9')).json<CreatedGroup>().groupId
    await http.del(server.baseUrl, `/admin/provisioning/groups/${groupId}`, TOKEN)

    const replay = await create('signup-9')
    expect(replay.statusCode).toBe(404)
    expect(replay.json<ApiError>().error.message).toContain('Idempotency-Key')
    expect(await server.db.selectFrom('groups').select('id').execute()).toHaveLength(0)
  })
})

describe('provisioning API: the first link is only ever the FIRST', () => {
  it('refuses to mint once the group has a device, and 404s for a group that is not there', async () => {
    server = await startHosted()
    const groupId = await createGroup(server.baseUrl)

    const first = await mintFirstLink(server.baseUrl, groupId)
    await register(server.baseUrl, { pairingCode: pairingCodeFromLink(first.link) })

    // ADR-0021 extended (HOSTED_PLAN §5): once a device is in, pairing is device to
    // device, and nothing reaching this API can mint a way into a populated group —
    // including whoever takes over the account's email.
    const second = await http.post<ApiError>(
      server.baseUrl,
      `/admin/provisioning/groups/${groupId}/pairing`,
      undefined,
      TOKEN,
    )
    expect(second.status).toBe(403)
    expect(second.body.error.code).toBe('forbidden')
    expect(second.body.error.message).toContain('device to device')

    const missing = await http.post<ApiError>(
      server.baseUrl,
      '/admin/provisioning/groups/no-such-group/pairing',
      undefined,
      TOKEN,
    )
    expect(missing.status).toBe(404)
    expect(missing.body.error.message).toContain('No such group')
  })

  it('refuses to mint into a suspended group, rather than handing out a link that cannot be used', async () => {
    server = await startHosted()
    const groupId = await createGroup(server.baseUrl)
    await http.post(
      server.baseUrl,
      `/admin/provisioning/groups/${groupId}/suspend`,
      undefined,
      TOKEN,
    )

    const res = await http.post<ApiError>(
      server.baseUrl,
      `/admin/provisioning/groups/${groupId}/pairing`,
      undefined,
      TOKEN,
    )
    expect(res.status).toBe(403)
    expect(res.body.error.message).toContain('suspended')
  })
})

describe('provisioning API: caps', () => {
  it('sets overrides, reads them back, and keeps null and 0 apart', async () => {
    server = await startHosted({ caps: { endpoints: 5, queuedMessages: 9 } })
    const groupId = await createGroup(server.baseUrl)
    const capsUrl = `/admin/provisioning/groups/${groupId}/caps`

    // A fresh group has no overrides at all: every cap follows the relay.
    const fresh = await http.get<CapsBody>(server.baseUrl, capsUrl, TOKEN)
    expect(fresh.status).toBe(200)
    expect(fresh.body.overrides).toEqual({
      endpoints: null,
      queuedMessages: null,
      queuedBytes: null,
      sendsPerWindow: null,
    })
    expect(fresh.body.effective.endpoints).toBe(5)

    // Set two, leave two alone. 0 means "unlimited for this group", which is a
    // DIFFERENT answer from null [0030].
    const set = await http.patch<CapsBody>(
      server.baseUrl,
      capsUrl,
      { endpoints: 2, queuedMessages: 0 },
      TOKEN,
    )
    expect(set.status).toBe(200)
    expect(set.body.overrides).toEqual({
      endpoints: 2,
      queuedMessages: 0,
      queuedBytes: null,
      sendsPerWindow: null,
    })
    expect(set.body.effective.endpoints).toBe(2)
    expect(set.body.effective.queuedMessages).toBe(0) // 0 wins over the relay's 9

    // The cap is real, not just recorded: a third device is refused.
    const pairing = await mintFirstLink(server.baseUrl, groupId)
    await register(server.baseUrl, { pairingCode: pairingCodeFromLink(pairing.link) })
    const usage = await usageOf(server.baseUrl, groupId)
    expect(usage.body.caps.remaining.endpoints).toBe(1)
    expect(usage.body.caps.remaining.queuedMessages).toBeNull() // unlimited: no headroom to state

    // Clearing an override puts the group back on the relay-wide default.
    const cleared = await http.patch<CapsBody>(server.baseUrl, capsUrl, { endpoints: null }, TOKEN)
    expect(cleared.body.overrides.endpoints).toBeNull()
    expect(cleared.body.effective.endpoints).toBe(5)
  })

  it('rejects a cap that is not a whole number, and 404s for a group that is not there', async () => {
    server = await startHosted()
    const groupId = await createGroup(server.baseUrl)

    const bad = await http.patch<ApiError>(
      server.baseUrl,
      `/admin/provisioning/groups/${groupId}/caps`,
      { endpoints: -1 },
      TOKEN,
    )
    expect(bad.status).toBe(400)
    expect(bad.body.error.code).toBe('invalid_request')

    const missing = await http.patch<ApiError>(
      server.baseUrl,
      '/admin/provisioning/groups/no-such-group/caps',
      { endpoints: 1 },
      TOKEN,
    )
    expect(missing.status).toBe(404)

    const missingRead = await http.get<ApiError>(
      server.baseUrl,
      '/admin/provisioning/groups/no-such-group/caps',
      TOKEN,
    )
    expect(missingRead.status).toBe(404)
  })
})

describe('provisioning API: usage is aggregates and NOTHING else', () => {
  it('names no device, anywhere, at any depth', async () => {
    server = await startHosted()
    const groupId = await createGroup(server.baseUrl)
    const pairing = await mintFirstLink(server.baseUrl, groupId)
    const device = await register(server.baseUrl, {
      pairingCode: pairingCodeFromLink(pairing.link),
      label: 'Chrome on the work laptop',
      deviceName: 'WorkBook',
    })

    const usage = await usageOf(server.baseUrl, groupId)
    expect(usage.status).toBe(200)
    const body = usage.body
    const serialised = JSON.stringify(body)

    // §4.2 names the exact thing this must not become: /admin/status's device listing.
    for (const forbidden of [
      'label',
      'deviceName',
      'device_name',
      'list',
      'endpointId',
      'pushTransport',
      'pushSubscription',
      'pushFailures',
      'deviceToken',
      'kind',
      'platform',
      'lastSeenAt',
    ]) {
      expect(everyKey(body), `usage must not carry a "${forbidden}" key`).not.toContain(forbidden)
    }
    // And no VALUE that identifies a device either — a key check alone would pass a
    // response that simply renamed the field.
    expect(serialised).not.toContain('Chrome on the work laptop')
    expect(serialised).not.toContain('WorkBook')
    expect(serialised).not.toContain(device.endpointId)
    expect(serialised).not.toContain(device.token)

    // What it DOES carry: counts, sizes, ages, caps, state.
    expect(body.endpoints).toBe(1)
    expect(body.queue).toEqual({ messages: 0, bytes: 0, oldestPendingSeconds: null })
    expect(body.suspended).toBe(false)
    expect(typeof body.createdAt).toBe('string')
    expect(body.caps.effective.endpoints).toBe(0)
  })
})

describe('provisioning API: one group never reaches another', () => {
  it('suspends, reads and deletes group A without touching group B', async () => {
    server = await startHosted()
    const base = server.baseUrl
    const groupA = await createGroup(base)
    const groupB = await createGroup(base)

    const linkA = await mintFirstLink(base, groupA)
    const linkB = await mintFirstLink(base, groupB)
    const deviceA = await register(base, { pairingCode: pairingCodeFromLink(linkA.link) })
    const deviceB = await register(base, { pairingCode: pairingCodeFromLink(linkB.link) })
    expect(deviceA.groupId).toBe(groupA)
    expect(deviceB.groupId).toBe(groupB)

    // Usage is scoped: A's numbers are A's.
    await http.patch(base, `/admin/provisioning/groups/${groupA}/caps`, { endpoints: 3 }, TOKEN)
    expect((await usageOf(base, groupA)).body.caps.overrides.endpoints).toBe(3)
    expect((await usageOf(base, groupB)).body.caps.overrides.endpoints).toBeNull()

    // Suspending A leaves B able to mint links and send.
    await http.post(base, `/admin/provisioning/groups/${groupA}/suspend`, undefined, TOKEN)
    expect((await usageOf(base, groupB)).body.suspended).toBe(false)
    const bMints = await http.post(base, '/v1/pairing', undefined, deviceB.token)
    expect(bMints.status).toBe(201)
    const aMints = await http.post(base, '/v1/pairing', undefined, deviceA.token)
    expect(aMints.status).toBe(403)

    // Deleting A leaves B entirely intact, device and token included.
    const deleted = await http.del<DeletionBody>(
      base,
      `/admin/provisioning/groups/${groupA}`,
      TOKEN,
    )
    expect(deleted.body.deleted.endpoints).toBe(1)
    const bStillThere = await http.get<unknown[]>(base, '/v1/endpoints', deviceB.token)
    expect(bStillThere.status).toBe(200)
    expect(bStillThere.body).toHaveLength(1)
    expect((await usageOf(base, groupB)).body.endpoints).toBe(1)
  })
})

describe('provisioning API: deleting a group closes its live sockets', () => {
  it('hangs up on an endpoint whose group no longer exists', async () => {
    server = await startHosted()
    const groupId = await createGroup(server.baseUrl)
    const pairing = await mintFirstLink(server.baseUrl, groupId)
    const device = await register(server.baseUrl, {
      pairingCode: pairingCodeFromLink(pairing.link),
    })

    const ws = await connectWs(server.wsUrl)
    ws.send({ type: 'hello', deviceToken: device.token })
    ws.send({ type: 'ping' })
    await ws.next((m) => m.type === 'pong')

    const deleted = await http.del<DeletionBody>(
      server.baseUrl,
      `/admin/provisioning/groups/${groupId}`,
      TOKEN,
    )
    expect(deleted.body.socketsClosed).toBe(1)
    // A socket authenticates once, in its hello frame, and then holds its registration
    // for as long as it stays open. Deleting the tenancy is when it gets told.
    const closed = await ws.closed
    expect(closed.code).toBe(1001)
  })
})

describe('provisioning API: the audit mirror', () => {
  it('writes one line per call, with ids and outcomes and never a pairing link', async () => {
    const logs: unknown[] = []
    server = await startHosted({ captureLogs: logs })
    const base = server.baseUrl

    const created = await http.post<CreatedGroup>(
      base,
      '/admin/provisioning/groups',
      undefined,
      TOKEN,
    )
    const groupId = created.body.groupId

    // A caller-supplied correlation id, so the relay's mirror can be lined up with the
    // control plane's authoritative entry for the same call (HOSTED_PLAN §4.2).
    const minted = await server.app.inject({
      method: 'POST',
      url: `/admin/provisioning/groups/${groupId}/pairing`,
      headers: { authorization: `Bearer ${TOKEN}`, 'idempotency-key': 'signup-42' },
    })
    expect(minted.statusCode).toBe(201)
    const link = (minted.json() as MintedPairing).link

    await http.del(base, `/admin/provisioning/groups/${groupId}`, TOKEN)
    // A refusal is audited too: "who tried" is the half a destructive API most needs.
    await http.post<ApiError>(base, '/admin/provisioning/groups', undefined, OTHER_TOKEN)

    const audit = logs.filter(
      (line): line is Record<string, unknown> =>
        typeof line === 'object' &&
        line !== null &&
        (line as Record<string, unknown>).audit === 'provisioning',
    )
    const lineFor = (operation: string, outcome: string) =>
      audit.find((line) => line.operation === operation && line.outcome === outcome)

    // Four calls in, four audit lines out — including the one that was refused.
    expect(audit).toHaveLength(4)

    const createLine = lineFor('create_group', 'ok')
    expect(createLine?.groupId).toBe(groupId)

    const mintLine = lineFor('mint_first_pairing', 'ok')
    expect(mintLine?.requestId).toBe('signup-42')
    expect(mintLine?.groupId).toBe(groupId)
    // The expiry is recorded. The LINK is not, and this is the one place in the whole
    // module where a link exists at all.
    expect(mintLine?.expiresAt).toBe((minted.json() as MintedPairing).expiresAt)
    expect(mintLine).not.toHaveProperty('link')

    const deleteLine = lineFor('delete_group', 'ok')
    expect(deleteLine?.existed).toBe(true)
    expect(deleteLine?.groupId).toBe(groupId)

    // "Who tried and was turned away" is the half a destructive API most needs.
    expect(lineFor('create_group', 'not_found')).toBeDefined()

    // Nothing anywhere in the relay's log carries the pairing credential or the
    // provisioning token.
    const everything = JSON.stringify(logs)
    expect(everything).not.toContain(link)
    expect(everything).not.toContain(pairingCodeFromLink(link))
    expect(everything).not.toContain(TOKEN)
  })
})

describe('/admin/status reports suspension relay-wide', () => {
  it('counts suspended groups without naming any of them', async () => {
    server = await startHosted()
    const groupA = await createGroup(server.baseUrl)
    await createGroup(server.baseUrl)

    const before = await http.get<{ groups: { count: number; suspended: number } }>(
      server.baseUrl,
      '/admin/status',
    )
    expect(before.body.groups).toMatchObject({ count: 2, suspended: 0 })

    await http.post(
      server.baseUrl,
      `/admin/provisioning/groups/${groupA}/suspend`,
      undefined,
      TOKEN,
    )
    const after = await http.get<{ groups: { count: number; suspended: number } }>(
      server.baseUrl,
      '/admin/status',
    )
    expect(after.body.groups).toMatchObject({ count: 2, suspended: 1 })
  })
})
