import type {
  ApiError,
  GroupResetState,
  GroupStateResponse,
  StopGroupResetResponse,
} from '@tabsend/shared'
import { afterEach, describe, expect, it } from 'vitest'
import type { GroupUsage } from '../src/tenancy'
import {
  connectWs,
  delay,
  http,
  pairingCodeFromLink,
  register,
  startTestServer,
  type TestServer,
  type TestWs,
} from './helpers'

/**
 * The reset that waits [PLANS P-18 item 12].
 *
 * The control plane schedules a reset of a hosted group whose owner lost every device;
 * for the wait, every device still paired can see it and stop it. The relay holds the
 * state, shows it, tells the group when it changes and rings the phones, and never
 * carries a reset out. What a later edit could quietly break, and so what is tested:
 *
 *  1. **Any device in the group can stop it, and only a device in the group.** That is
 *     the whole safeguard against someone who got into the owner's email.
 *  2. **A retried schedule never moves the clock** the devices are counting down to.
 *  3. **A phone nobody has open still hears about it**: scheduling rings the same
 *     content-free doorbell a new tab does.
 *  4. **Suspension does not stop a Stop.**
 */

const TOKEN = 'test-provisioning-credential'
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

let server: TestServer

afterEach(async () => {
  await server?.close()
})

interface ResetBody {
  groupId: string
  reset: GroupResetState | null
  stoppedAt: string | null
}

async function startHosted(extra: Parameters<typeof startTestServer>[0] = {}) {
  return startTestServer({ groupCreation: 'provisioned', provisioningToken: TOKEN, ...extra })
}

async function createGroup(): Promise<string> {
  const res = await http.post<{ groupId: string }>(
    server.baseUrl,
    '/admin/provisioning/groups',
    undefined,
    TOKEN,
  )
  expect(res.status).toBe(201)
  return res.body.groupId
}

/** A group with its first device in it. */
async function groupWithDevice(label = 'Laptop') {
  const groupId = await createGroup()
  const minted = await http.post<{ link: string }>(
    server.baseUrl,
    `/admin/provisioning/groups/${groupId}/pairing`,
    undefined,
    TOKEN,
  )
  const device = await register(server.baseUrl, {
    pairingCode: pairingCodeFromLink(minted.body.link),
    label,
  })
  return { groupId, device }
}

async function invite(token: string): Promise<string> {
  const res = await http.post<{ link: string }>(server.baseUrl, '/v1/pairing', undefined, token)
  expect(res.status).toBe(201)
  return pairingCodeFromLink(res.body.link)
}

const inHours = (hours: number) => new Date(server.clock.now().getTime() + hours * HOUR)

const schedule = (groupId: string, body: unknown) =>
  http.post<ResetBody>(server.baseUrl, `/admin/provisioning/groups/${groupId}/reset`, body, TOKEN)

const cancel = (groupId: string) =>
  http.del<ResetBody>(server.baseUrl, `/admin/provisioning/groups/${groupId}/reset`, TOKEN)

const groupState = (token: string) =>
  http.get<GroupStateResponse>(server.baseUrl, '/v1/group', token)

const stop = (token?: string) =>
  http.post<StopGroupResetResponse>(server.baseUrl, '/v1/group/reset/stop', undefined, token)

const usageOf = (groupId: string) =>
  http.get<GroupUsage>(server.baseUrl, `/admin/provisioning/groups/${groupId}/usage`, TOKEN)

async function listening(token: string): Promise<TestWs> {
  const ws = await connectWs(server.wsUrl)
  ws.send({ type: 'hello', deviceToken: token })
  ws.send({ type: 'ping' })
  await ws.next((m) => m.type === 'pong')
  return ws
}

/** Wait until the fake push sender has recorded `n` wakes (forwarder wakes are detached). */
async function wakes(n: number): Promise<void> {
  const deadline = Date.now() + 5_000
  while (server.push.calls.length < n) {
    if (Date.now() > deadline) {
      throw new Error(`rang ${server.push.calls.length} doorbell(s), expected ${n}`)
    }
    await delay(5)
  }
}

describe('group reset: schedule, see, stop, cancel', () => {
  it('runs schedule → devices see it → a device stops it → usage records the stop → owner cancels', async () => {
    server = await startHosted({ wakeForwarderUrl: 'https://wake.test' })
    const { groupId, device: laptop } = await groupWithDevice()
    const phone = await register(server.baseUrl, {
      pairingCode: await invite(laptop.token),
      label: 'Phone',
      kind: 'mobile',
      platform: 'ios',
      pushSubscription: {
        transport: 'forwarder',
        wakeToken: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      },
    })

    // Nothing pending on a fresh group.
    expect((await groupState(laptop.token)).body).toEqual({ reset: null })
    const fresh = await usageOf(groupId)
    expect(fresh.body.reset).toBeNull()
    expect(fresh.body.resetStoppedAt).toBeNull()

    const ws = await listening(laptop.token)
    const wakesBefore = server.push.calls.length

    // Schedule. The answer carries the reset as stored; usage and both devices agree.
    const resetsAt = inHours(72).toISOString()
    const scheduled = await schedule(groupId, { resetsAt })
    expect(scheduled.status).toBe(200)
    const requestedAt = server.clock.now().toISOString()
    expect(scheduled.body).toEqual({ groupId, reset: { requestedAt, resetsAt }, stoppedAt: null })

    // The live socket hears it at once, carrying nothing but its type.
    expect(await ws.next((m) => m.type === 'group_updated')).toEqual({ type: 'group_updated' })

    // And EVERY device's doorbell rings, content-free: the laptop's Web Push, and the
    // phone nobody has open through the forwarder. That phone has no socket, so this
    // is the only way it learns a reset is coming while there is time to stop it.
    await wakes(wakesBefore + 2)
    const rung = server.push.calls.slice(wakesBefore).map((s) => s.transport)
    expect(rung.sort()).toEqual(['forwarder', 'webpush'])

    for (const token of [laptop.token, phone.token]) {
      expect((await groupState(token)).body).toEqual({ reset: { requestedAt, resetsAt } })
    }
    const pending = await usageOf(groupId)
    expect(pending.body.reset).toEqual({ requestedAt, resetsAt })
    expect(pending.body.resetStoppedAt).toBeNull()

    // The phone stops it. Everyone sees it gone; usage says a device did, and when.
    server.clock.advance(HOUR)
    const stoppedAt = server.clock.now().toISOString()
    const stopped = await stop(phone.token)
    expect(stopped.status).toBe(200)
    expect(stopped.body).toEqual({ reset: null })
    expect(await ws.next((m) => m.type === 'group_updated')).toEqual({ type: 'group_updated' })
    expect((await groupState(laptop.token)).body).toEqual({ reset: null })
    const afterStop = await usageOf(groupId)
    expect(afterStop.body.reset).toBeNull()
    expect(afterStop.body.resetStoppedAt).toBe(stoppedAt)

    // A second Stop with nothing pending reads as done, and changes nothing.
    const again = await stop(laptop.token)
    expect(again.status).toBe(200)
    expect(again.body).toEqual({ reset: null })
    expect((await usageOf(groupId)).body.resetStoppedAt).toBe(stoppedAt)

    // The owner cancelling with nothing pending is a 200 too, and leaves the stop alone.
    const idle = await cancel(groupId)
    expect(idle.status).toBe(200)
    expect(idle.body).toEqual({ groupId, reset: null, stoppedAt })

    // A new schedule clears the old stop; the owner then cancels it from the account.
    const second = await schedule(groupId, { resetsAt: inHours(72).toISOString() })
    expect(second.body.stoppedAt).toBeNull()
    expect(second.body.reset).not.toBeNull()
    const cancelled = await cancel(groupId)
    expect(cancelled.status).toBe(200)
    expect(cancelled.body).toEqual({ groupId, reset: null, stoppedAt: null })
    expect((await groupState(phone.token)).body).toEqual({ reset: null })
    const afterCancel = await usageOf(groupId)
    expect(afterCancel.body.reset).toBeNull()
    expect(afterCancel.body.resetStoppedAt).toBeNull()
    ws.close()
  })

  it('keeps the original time when a schedule is retried, and rings nobody twice', async () => {
    server = await startHosted()
    const { groupId, device } = await groupWithDevice()
    const resetsAt = inHours(72).toISOString()
    const first = await schedule(groupId, { resetsAt })
    expect(first.status).toBe(200)
    const wakesAfterFirst = server.push.calls.length
    expect(wakesAfterFirst).toBe(1)

    // An hour later the control plane retries with a different time (a fresh 72 hours).
    server.clock.advance(HOUR)
    const retry = await schedule(groupId, { resetsAt: inHours(72).toISOString() })
    expect(retry.status).toBe(200)
    expect(retry.body.reset).toEqual(first.body.reset)
    expect(server.push.calls.length).toBe(wakesAfterFirst)
    expect((await groupState(device.token)).body.reset).toEqual(first.body.reset)
  })

  it('stores the time in UTC however the caller wrote its zone', async () => {
    server = await startHosted()
    const { groupId } = await groupWithDevice()
    // 2026-07-16T12:00Z is the test clock; 14:00+02:00 two days later is 12:00Z.
    const res = await schedule(groupId, { resetsAt: '2026-07-18T14:00:00+02:00' })
    expect(res.status).toBe(200)
    expect(res.body.reset?.resetsAt).toBe('2026-07-18T12:00:00.000Z')
  })
})

describe('group reset: what the control plane may ask for', () => {
  it('refuses a time in the past, now, more than 30 days out, or not a real instant', async () => {
    server = await startHosted()
    const { groupId } = await groupWithDevice()
    const now = server.clock.now().getTime()

    for (const body of [
      { resetsAt: new Date(now - 1).toISOString() },
      { resetsAt: new Date(now).toISOString() },
      { resetsAt: new Date(now + 30 * DAY + 1).toISOString() },
      { resetsAt: 'tomorrow' },
      { resetsAt: '2026-07-18' }, // a date with no time and no zone
      { resetsAt: '2026-07-18T12:00:00' }, // a time with no zone
      { resetsAt: '2026-13-45T12:00:00Z' }, // shaped right, not a date
      { resetsAt: 1_784_000_000_000 },
      {},
    ]) {
      const res = await schedule(groupId, body)
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect((res.body as unknown as ApiError).error.code).toBe('invalid_request')
    }
    // No body at all.
    const bare = await schedule(groupId, undefined)
    expect(bare.status).toBe(400)

    // Nothing was stored by any of them.
    expect((await usageOf(groupId)).body.reset).toBeNull()

    // Exactly 30 days is allowed.
    const edge = await schedule(groupId, { resetsAt: new Date(now + 30 * DAY).toISOString() })
    expect(edge.status).toBe(200)
  })

  it('answers 404 for a group that is not there, on both calls', async () => {
    server = await startHosted()
    const missing = '00000000-0000-0000-0000-000000000000'
    expect((await schedule(missing, { resetsAt: inHours(72).toISOString() })).status).toBe(404)
    expect((await cancel(missing)).status).toBe(404)
  })

  it('is behind the same two factors as every provisioning call', async () => {
    server = await startHosted()
    const { groupId } = await groupWithDevice()
    const body = { resetsAt: inHours(72).toISOString() }
    const path = `/admin/provisioning/groups/${groupId}/reset`
    expect((await http.post(server.baseUrl, path, body)).status).toBe(404)
    expect((await http.post(server.baseUrl, path, body, 'not-the-credential')).status).toBe(404)
    expect((await http.del(server.baseUrl, path)).status).toBe(404)
    expect((await usageOf(groupId)).body.reset).toBeNull()
  })
})

describe('group reset: only the group can see or stop it', () => {
  it("never shows group A's reset to a device in group B, nor lets one stop it", async () => {
    server = await startHosted()
    const a = await groupWithDevice('A laptop')
    const b = await groupWithDevice('B laptop')
    const wsB = await listening(b.device.token)

    const scheduled = await schedule(a.groupId, { resetsAt: inHours(72).toISOString() })
    expect(scheduled.status).toBe(200)

    // B sees nothing pending, and its socket heard nothing.
    expect((await groupState(b.device.token)).body).toEqual({ reset: null })
    wsB.send({ type: 'ping' })
    await wsB.next((m) => m.type === 'pong')
    expect(wsB.messages.some((m) => m.type === 'group_updated')).toBe(false)

    // B's Stop is about B's own group: it answers "nothing pending" and A's stays.
    const fromB = await stop(b.device.token)
    expect(fromB.status).toBe(200)
    expect((await usageOf(a.groupId)).body.reset).toEqual(scheduled.body.reset)
    expect((await usageOf(a.groupId)).body.resetStoppedAt).toBeNull()
    expect((await groupState(a.device.token)).body.reset).toEqual(scheduled.body.reset)
    wsB.close()
  })

  it('refuses a Stop and a read with no token, or a token it does not know', async () => {
    server = await startHosted()
    const { groupId, device } = await groupWithDevice()
    await schedule(groupId, { resetsAt: inHours(72).toISOString() })

    for (const token of [undefined, 'not-a-device-token']) {
      const res = await stop(token)
      expect(res.status).toBe(401)
      expect((res.body as unknown as ApiError).error.code).toBe('unauthorized')
      expect((await groupState(token as string)).status).toBe(401)
    }
    expect((await groupState(device.token)).body.reset).not.toBeNull()
  })

  it('refuses a Stop from a device that was removed from the group', async () => {
    server = await startHosted()
    const { groupId, device: laptop } = await groupWithDevice()
    const old = await register(server.baseUrl, { pairingCode: await invite(laptop.token) })
    expect(
      (await http.del(server.baseUrl, `/v1/endpoints/${old.endpointId}`, laptop.token)).status,
    ).toBe(200)
    await schedule(groupId, { resetsAt: inHours(72).toISOString() })

    const res = await stop(old.token)
    expect(res.status).toBe(401)
    expect((res.body as unknown as ApiError).error.code).toBe('endpoint_removed')
    expect((await groupState(laptop.token)).body.reset).not.toBeNull()
  })
})

describe('group reset: suspension does not stop a Stop', () => {
  it('lets a paused group see a reset coming and stop it', async () => {
    server = await startHosted()
    const { groupId, device } = await groupWithDevice()
    const suspended = await http.post(
      server.baseUrl,
      `/admin/provisioning/groups/${groupId}/suspend`,
      undefined,
      TOKEN,
    )
    expect(suspended.status).toBe(200)

    const scheduled = await schedule(groupId, { resetsAt: inHours(72).toISOString() })
    expect(scheduled.status).toBe(200)
    expect((await groupState(device.token)).body.reset).toEqual(scheduled.body.reset)
    expect((await stop(device.token)).status).toBe(200)
    expect((await usageOf(groupId)).body.reset).toBeNull()
  })
})

describe('group reset: a self-hosted relay', () => {
  it('answers GET /v1/group with nothing pending, and a Stop as done', async () => {
    server = await startTestServer()
    const device = await register(server.baseUrl)
    expect((await groupState(device.token)).body).toEqual({ reset: null })
    expect((await stop(device.token)).body).toEqual({ reset: null })
    // And it has no way to schedule one: the provisioning API is not there.
    expect(
      (await http.post(server.baseUrl, `/admin/provisioning/groups/${device.groupId}/reset`))
        .status,
    ).toBe(404)
  })
})

interface RunBody {
  groupId: string
  existed: boolean
  deleted: Record<string, number>
  socketsClosed: number
}

const run = (groupId: string) =>
  http.post<RunBody>(
    server.baseUrl,
    `/admin/provisioning/groups/${groupId}/reset/run`,
    undefined,
    TOKEN,
  )

describe('group reset: carrying it out only when it is still due', () => {
  it('deletes a group whose reset is pending and due, and closes its sockets', async () => {
    server = await startHosted()
    const { groupId, device } = await groupWithDevice()
    await schedule(groupId, { resetsAt: inHours(72).toISOString() })
    const ws = await listening(device.token)

    server.clock.advance(72 * HOUR)
    const res = await run(groupId)
    expect(res.status).toBe(200)
    expect(res.body.existed).toBe(true)
    expect(res.body.deleted.endpoints).toBe(1)
    expect(res.body.socketsClosed).toBe(1)
    // Never the deleted devices' wake tokens: those stay server-side.
    expect(JSON.stringify(res.body)).not.toContain('push')
    expect((await ws.closed).code).toBe(1001)
    expect((await usageOf(groupId)).status).toBe(404)
    expect((await groupState(device.token)).status).toBe(401)

    // A control plane re-running it after a crash is told it is done.
    const again = await run(groupId)
    expect(again.status).toBe(200)
    expect(again.body.existed).toBe(false)
  })

  it('answers 200 existed:false for a group that was never there', async () => {
    server = await startHosted()
    const res = await run('00000000-0000-0000-0000-000000000000')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ existed: false, socketsClosed: 0 })
  })

  it('refuses 409 reset_not_due, and changes nothing, when it is not due yet, was stopped, cancelled or never scheduled', async () => {
    server = await startHosted()
    const { groupId, device } = await groupWithDevice()
    const notDue = async () => {
      const res = await run(groupId)
      expect(res.status).toBe(409)
      expect((res.body as unknown as ApiError).error.code).toBe('reset_not_due')
      expect((await usageOf(groupId)).body.endpoints).toBe(1)
      expect((await groupState(device.token)).status).toBe(200)
    }

    await notDue() // never scheduled

    const scheduled = await schedule(groupId, { resetsAt: inHours(72).toISOString() })
    server.clock.advance(72 * HOUR - 1)
    await notDue() // one millisecond early
    expect((await usageOf(groupId)).body.reset).toEqual(scheduled.body.reset)

    // Stopped by a device just before the time; the time then passes.
    expect((await stop(device.token)).status).toBe(200)
    server.clock.advance(HOUR)
    await notDue()

    // Cancelled by the owner after it fell due.
    await schedule(groupId, { resetsAt: inHours(1).toISOString() })
    server.clock.advance(2 * HOUR)
    expect((await cancel(groupId)).status).toBe(200)
    await notDue()
  })

  it('never both stops and deletes when a Stop and a run arrive together', async () => {
    server = await startHosted()
    let stopsWon = 0
    let runsWon = 0
    for (let i = 0; i < 6; i++) {
      const { groupId, device } = await groupWithDevice(`Laptop ${i}`)
      await schedule(groupId, { resetsAt: inHours(1).toISOString() })
      server.clock.advance(2 * HOUR)

      // Alternate who is sent first, so both orders get exercised.
      const [stopped, ran] =
        i % 2 === 0
          ? await Promise.all([stop(device.token), run(groupId)])
          : await Promise.all([run(groupId), stop(device.token)]).then(([r, s]) => [s, r] as const)

      const usage = await usageOf(groupId)
      if (ran.status === 200) {
        runsWon += 1
        // The group is gone, so the Stop cannot have been accepted.
        expect(ran.body.existed).toBe(true)
        expect(stopped.status).not.toBe(200)
        expect(usage.status).toBe(404)
      } else {
        stopsWon += 1
        // The Stop won: the run refused and the group is whole, with the stop recorded.
        expect(ran.status).toBe(409)
        expect(stopped.status).toBe(200)
        expect(usage.status).toBe(200)
        expect(usage.body.endpoints).toBe(1)
        expect(usage.body.reset).toBeNull()
        expect(usage.body.resetStoppedAt).not.toBeNull()
      }
    }
    expect(stopsWon + runsWon).toBe(6)
  })
})
