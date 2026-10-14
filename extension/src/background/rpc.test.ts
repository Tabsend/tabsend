import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcRequest, StateView } from '../lib/model'

/**
 * Pairing must not wait on push setup [ROADMAP, found 2026-10-01].
 *
 * Joining, creating a group and moving to a new relay address all end in the same
 * step, which brings the wake channels up. Chrome's push subscribe used to sit inside
 * it, and that call can stall for half a minute while the browser registers with its
 * push service: "Pair this browser" did nothing for 30 seconds, and the e2e rig's
 * 30-second wait for the next screen failed about one run in three. Every step here
 * is stubbed to answer at once except push setup, which answers only when a test
 * says so.
 */

const state = { registered: true } as StateView

vi.mock('./identity', () => ({
  joinGroup: vi.fn(async () => state),
  createGroup: vi.fn(async () => state),
  changeRelayUrl: vi.fn(async () => ({ relayUrl: 'https://relay.example', verified: true })),
}))

let finishPush: (outcome: 'subscribed' | 'failed') => void = () => {}
vi.mock('./push', () => ({
  ensurePushSubscription: vi.fn(
    () =>
      new Promise((resolve, reject) => {
        finishPush = (outcome) =>
          outcome === 'subscribed' ? resolve(null) : reject(new Error('storage write failed'))
      }),
  ),
}))

vi.mock('./heartbeat', () => ({ heartbeatNow: vi.fn(async () => undefined) }))
vi.mock('./receive', () => ({ pollPending: vi.fn(async () => undefined) }))
vi.mock('./offscreen', () => ({
  ensureOffscreen: vi.fn(async () => undefined),
  pushConfigToOffscreen: vi.fn(async () => undefined),
}))
vi.mock('./menus', () => ({ rebuildMenus: vi.fn(async () => undefined) }))
vi.mock('./health', () => ({ resetRelayHealthCache: vi.fn() }))
vi.mock('./fxwake', () => ({ refreshFirefoxWs: vi.fn(async () => undefined) }))
vi.mock('./badge', () => ({ clearBadge: vi.fn() }))
vi.mock('./endpoints', () => ({ buildChooserView: vi.fn(), buildDevicesView: vi.fn() }))
vi.mock('./history', () => ({ refreshHistory: vi.fn(async () => undefined) }))
vi.mock('./prefs', () => ({ setPrimary: vi.fn() }))
vi.mock('./send', () => ({
  cancelHeldTab: vi.fn(),
  processOutbound: vi.fn(),
  selectedTabCount: vi.fn(),
  sendToTarget: vi.fn(),
}))
vi.mock('./session', () => ({ currentSession: vi.fn() }))
vi.mock('./settings', () => ({ updateSettings: vi.fn() }))

import { heartbeatNow } from './heartbeat'
import { rebuildMenus } from './menus'
import { ensureOffscreen, pushConfigToOffscreen } from './offscreen'
import { ensurePushSubscription } from './push'
import { handleRpc } from './rpc'

const requests: Record<string, RpcRequest> = {
  joinGroup: {
    type: 'joinGroup',
    relayUrl: 'https://relay.example',
    code: 'ABCD2345',
    browserName: 'Chrome',
  },
  createGroup: {
    type: 'createGroup',
    relayUrl: 'https://relay.example',
    browserName: 'Chrome',
    deviceName: 'Mac',
  },
  changeRelayUrl: { type: 'changeRelayUrl', relayUrl: 'https://relay.example' },
}

/** The reply, or 'still waiting' if it has not come within a second. */
async function replyTo(req: RpcRequest): Promise<unknown> {
  return Promise.race([
    handleRpc(req),
    new Promise((resolve) => setTimeout(() => resolve('still waiting'), 1_000)),
  ])
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('push setup runs behind the reply, not in front of it', () => {
  it.each(Object.keys(requests))('%s answers while push setup is still running', async (name) => {
    const reply = await replyTo(requests[name] as RpcRequest)

    expect(reply).toMatchObject({ ok: true })
    expect(ensurePushSubscription).toHaveBeenCalledTimes(1)
    // The rest of the wake channels still came up before the reply.
    expect(ensureOffscreen).toHaveBeenCalledTimes(1)
    expect(pushConfigToOffscreen).toHaveBeenCalledTimes(1)
    expect(rebuildMenus).toHaveBeenCalledTimes(1)
    // The heartbeat carries the new subscription to the relay, so it waits for it.
    expect(heartbeatNow).not.toHaveBeenCalled()

    finishPush('subscribed')
    await vi.waitFor(() => expect(heartbeatNow).toHaveBeenCalledTimes(1))
  })

  it('a push setup that fails afterwards changes nothing about the reply', async () => {
    // An unhandled rejection here would fail the run, so this also proves the
    // detached setup swallows its own errors.
    const reply = await replyTo(requests.joinGroup as RpcRequest)
    expect(reply).toMatchObject({ ok: true })

    finishPush('failed')
    await new Promise((resolve) => setTimeout(resolve, 0))
    // Nothing new to carry, so no extra heartbeat; the poll alarm sends the next one.
    expect(heartbeatNow).not.toHaveBeenCalled()
  })
})
