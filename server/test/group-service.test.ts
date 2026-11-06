import type { ApiError, GroupStateResponse } from '@tabsend/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { http, pairingCodeFromLink, register, startTestServer, type TestServer } from './helpers'

/**
 * The plan words a group's phones are shown [PLANS P-19].
 *
 * The account site writes `service` (the trial and its end, the trial ended, or just "an
 * account") through the provisioning API; `GET /v1/group` hands it to the group's own
 * devices. The relay knows no plan and decides nothing from it. What a later edit could
 * quietly break, and so what is tested:
 *
 *  1. **Nothing written, nothing sent.** A relay with no account site answers exactly what
 *     it always did, so a phone shows no trial line and no Account entry for it.
 *  2. **Whole values only.** A trial without its end, or an account with one, is refused,
 *     so a phone is never handed half a plan.
 *  3. **A retry lands the same row**, and `null` clears it.
 *  4. **Suspension does not hide it.** The "trial ended" words are for a paused group.
 *  5. **It is not an open door**: the call needs the provisioning credential.
 */

const TOKEN = 'test-provisioning-credential'
let server: TestServer

afterEach(async () => {
  await server?.close()
})

async function startHosted() {
  return startTestServer({ groupCreation: 'provisioned', provisioningToken: TOKEN })
}

async function groupWithDevice() {
  const created = await http.post<{ groupId: string }>(
    server.baseUrl,
    '/admin/provisioning/groups',
    undefined,
    TOKEN,
  )
  expect(created.status).toBe(201)
  const groupId = created.body.groupId
  const minted = await http.post<{ link: string }>(
    server.baseUrl,
    `/admin/provisioning/groups/${groupId}/pairing`,
    undefined,
    TOKEN,
  )
  const device = await register(server.baseUrl, {
    pairingCode: pairingCodeFromLink(minted.body.link),
    label: 'Phone',
  })
  return { groupId, device }
}

const setService = (groupId: string, body: unknown, token: string | null = TOKEN) =>
  http.put<{ groupId: string; service: unknown } & ApiError>(
    server.baseUrl,
    `/admin/provisioning/groups/${groupId}/service`,
    body,
    token ?? undefined,
  )

const groupState = (token: string) =>
  http.get<GroupStateResponse>(server.baseUrl, '/v1/group', token)

describe('group service words', () => {
  it('sends nothing until the account site writes something', async () => {
    server = await startHosted()
    const { device } = await groupWithDevice()
    // Exactly the old answer: no `service` key at all.
    expect((await groupState(device.token)).body).toEqual({ reset: null })
  })

  it('shows a trial, then the trial ended while paused, then a paid account, then clears', async () => {
    server = await startHosted()
    const { groupId, device } = await groupWithDevice()
    const endsAt = '2026-11-18T10:00:00.000Z'

    const trial = await setService(groupId, { state: 'trial', trialEndsAt: endsAt })
    expect(trial.status).toBe(200)
    expect(trial.body.service).toEqual({ state: 'trial', trialEndsAt: endsAt })
    expect((await groupState(device.token)).body).toEqual({
      reset: null,
      service: { state: 'trial', trialEndsAt: endsAt },
    })

    // The trial ends: the account site pauses the group and says why. A paused group's
    // devices still read it (the route is not gated on suspension).
    const paused = await http.post(
      server.baseUrl,
      `/admin/provisioning/groups/${groupId}/suspend`,
      undefined,
      TOKEN,
    )
    expect(paused.status).toBe(200)
    await setService(groupId, { state: 'trial_ended', trialEndsAt: endsAt })
    expect((await groupState(device.token)).body.service).toEqual({
      state: 'trial_ended',
      trialEndsAt: endsAt,
    })

    // Paid: the end date goes away with the state.
    await setService(groupId, { state: 'account' })
    expect((await groupState(device.token)).body.service).toEqual({
      state: 'account',
      trialEndsAt: null,
    })

    // Cleared: back to sending nothing.
    const cleared = await setService(groupId, { state: null })
    expect(cleared.status).toBe(200)
    expect((await groupState(device.token)).body).toEqual({ reset: null })
  })

  it('lands the same row when a call is repeated, and normalises the instant', async () => {
    server = await startHosted()
    const { groupId, device } = await groupWithDevice()
    const body = { state: 'trial', trialEndsAt: '2026-11-18T05:00:00-05:00' }
    await setService(groupId, body)
    await setService(groupId, body)
    expect((await groupState(device.token)).body.service).toEqual({
      state: 'trial',
      trialEndsAt: '2026-11-18T10:00:00.000Z',
    })
  })

  it('refuses half a plan and unknown words, and changes nothing', async () => {
    server = await startHosted()
    const { groupId, device } = await groupWithDevice()
    await setService(groupId, { state: 'account' })
    const bad: unknown[] = [
      { state: 'trial' },
      { state: 'trial', trialEndsAt: null },
      { state: 'trial_ended', trialEndsAt: 'next Tuesday' },
      { state: 'trial', trialEndsAt: '2026-11-18' },
      { state: 'account', trialEndsAt: '2026-11-18T10:00:00.000Z' },
      { state: 'premium' },
      {},
    ]
    for (const body of bad) {
      const res = await setService(groupId, body)
      expect(res.status, JSON.stringify(body)).toBe(400)
    }
    expect((await groupState(device.token)).body.service).toEqual({
      state: 'account',
      trialEndsAt: null,
    })
  })

  it('answers 404 for a group that is not there', async () => {
    server = await startHosted()
    const res = await setService('no-such-group', { state: 'account' })
    expect(res.status).toBe(404)
  })

  it('needs the provisioning credential', async () => {
    server = await startHosted()
    const { groupId, device } = await groupWithDevice()
    expect((await setService(groupId, { state: 'account' }, null)).status).toBe(404)
    expect((await setService(groupId, { state: 'account' }, 'wrong')).status).toBe(404)
    // A device's own token is no credential either.
    expect((await setService(groupId, { state: 'account' }, device.token)).status).toBe(404)
    expect((await groupState(device.token)).body).toEqual({ reset: null })
  })
})
