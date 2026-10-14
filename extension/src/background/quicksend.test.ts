import type { Endpoint, EndpointId, IsoTimestamp, SendPayload } from '@tabsend/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SendBanner } from '../lib/strings'

/**
 * Quick-send's feedback contract (dogfood 2026-07-29).
 *
 * The bug: quick-send announced "Sent to Arc" the instant you clicked, four
 * seconds BEFORE the send it described was attempted, and then threw the actual
 * result away. With the relay on a mini PC that had stopped answering, that
 * meant a confident green confirmation followed by silence — for every send, for
 * days. These tests pin both halves: the optimistic banner may only claim
 * "Sending", and the real outcome must come back afterwards.
 */

const TAB_ID = 42

vi.mock('../lib/ext', () => ({
  ext: {
    tabs: { query: vi.fn(async () => [{ id: TAB_ID }]), create: vi.fn(async () => ({})) },
    windows: { create: vi.fn(async () => ({})) },
    runtime: { getURL: (p: string) => p },
  },
}))

let pendingUndo: unknown = null
const settings = { showSuccessToast: true }
vi.mock('../lib/storage', () => ({
  getCachedEndpoints: vi.fn(async () => []),
  getPendingUndo: vi.fn(async () => pendingUndo),
  setPendingUndo: vi.fn(async (v: unknown) => {
    pendingUndo = v
  }),
  getPrefs: vi.fn(async () => ({
    primaryTargetId: null,
    primaryPinned: false,
    recentTargetIds: [],
  })),
  getSettings: vi.fn(async () => settings),
}))

const target: Endpoint = {
  id: 'arc-1' as EndpointId,
  groupId: 'g' as Endpoint['groupId'],
  kind: 'extension',
  browser: 'chrome',
  platform: 'macos',
  label: 'Arc · Mac mini',
  e2ePubkey: 'k',
  presence: 'online',
  lastSeenAt: '2026-07-29T12:00:00.000Z' as IsoTimestamp,
  createdAt: '2026-07-29T00:00:00.000Z' as IsoTimestamp,
}

vi.mock('./endpoints', () => ({
  fetchEndpoints: vi.fn(async () => [target]),
  targetEndpoints: vi.fn(async () => [target]),
}))

vi.mock('./session', () => ({ currentSession: vi.fn(async () => ({ registration: {} })) }))

const payload: SendPayload = {
  url: 'https://example.com/relay',
  title: 'Setting up a LAN relay',
  sentAt: '2026-07-29T12:00:00.000Z' as IsoTimestamp,
}
const sendToTarget = vi.fn(async () => ({ ok: true, queued: false, offline: false }))
vi.mock('./send', () => ({
  captureSelectedTabs: vi.fn(async () => [payload]),
  sendToTarget: (...args: unknown[]) => sendToTarget(...(args as [])),
}))

const showFeedback = vi.fn(async () => true)
vi.mock('./feedback', () => ({
  showFeedback: (...args: unknown[]) => showFeedback(...(args as [])),
}))

import { flushUndo, quickSend } from './quicksend'

function bannerOf(call: unknown[]): SendBanner {
  return call[0] as SendBanner
}

beforeEach(() => {
  vi.useFakeTimers()
  pendingUndo = null
  settings.showSuccessToast = true
  sendToTarget.mockClear()
  showFeedback.mockClear()
})

describe('quickSend', () => {
  it('claims only "Sending" while the undo window is open — nothing has left yet', async () => {
    await quickSend()

    expect(sendToTarget).not.toHaveBeenCalled() // still holdable
    const banner = bannerOf(showFeedback.mock.calls[0] as unknown[])
    expect(banner.tone).toBe('pending')
    expect(banner.headline).toBe('Sending to Arc · Mac mini')
    expect(banner.headline).not.toMatch(/^Sent\b/)
  })

  it('names the tab, so several sends in a row stay distinguishable', async () => {
    await quickSend()
    expect(bannerOf(showFeedback.mock.calls[0] as unknown[]).title).toBe('Setting up a LAN relay')
  })

  it('shows the banner on the tab it was fired from, with an Undo affordance', async () => {
    await quickSend()
    const opts = (showFeedback.mock.calls[0] as unknown[])[1] as {
      tabId?: number
      undoId?: string
    }
    expect(opts.tabId).toBe(TAB_ID)
    expect(opts.undoId).toBeTruthy()
  })
})

describe('flushUndo', () => {
  it('dispatches the held send and routes its outcome back to the origin tab', async () => {
    await quickSend()
    await flushUndo(true)

    expect(sendToTarget).toHaveBeenCalledTimes(1)
    const [targetId, sentPayloads, opts] = sendToTarget.mock.calls[0] as unknown as [
      string,
      SendPayload[],
      { feedbackTabId?: number },
    ]
    expect(targetId).toBe('arc-1')
    // The held batch dispatches whole — one payload per tab that was selected.
    expect(sentPayloads).toEqual([payload])
    // Without this the real outcome would land on whatever tab happened to be
    // active seconds later — or nowhere at all, which is what used to happen.
    expect(opts.feedbackTabId).toBe(TAB_ID)
  })

  it('does nothing when nothing is armed', async () => {
    await flushUndo(true)
    expect(sendToTarget).not.toHaveBeenCalled()
  })

  it('holds the send until the window elapses', async () => {
    await quickSend()
    await flushUndo() // not forced, window still open
    expect(sendToTarget).not.toHaveBeenCalled()

    vi.setSystemTime(Date.now() + 5000)
    await flushUndo()
    expect(sendToTarget).toHaveBeenCalledTimes(1)
  })
})
