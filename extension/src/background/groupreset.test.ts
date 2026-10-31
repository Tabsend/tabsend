import type { GroupResetState, IsoTimestamp } from '@tabsend/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GroupResetRecord } from '../lib/model'

/**
 * The reset that waits on the extension (PLANS.md P-18 item 12). Covers the wiring:
 * the system notification goes up once per request, "It was me" hides that request
 * only, an older relay (404) reads as no reset, Stop clears it, a failed Stop keeps
 * it, and the `group_updated` stream event makes the background read again.
 */

const h = vi.hoisted(() => {
  const state = {
    record: undefined as GroupResetRecord | undefined,
    reset: null as GroupResetState | null,
    /** What GET /v1/group does instead of answering. */
    getFails: undefined as Error | undefined,
    stopFails: undefined as Error | undefined,
    selfId: 'me',
  }
  const ext = {
    runtime: { getURL: (p: string) => `ext://${p}` },
    notifications: {
      create: vi.fn(async (id: string) => id),
      clear: vi.fn(async () => true),
    },
    tabs: { create: vi.fn(async () => ({})) },
  }
  return { state, ext }
})

vi.mock('../lib/ext', () => ({ ext: h.ext }))
vi.mock('../lib/platform', () => ({ IS_FIREFOX: false }))
vi.mock('../lib/storage', () => ({
  getGroupResetRecord: vi.fn(async () => structuredClone(h.state.record)),
  setGroupResetRecord: vi.fn(async (v: GroupResetRecord) => {
    // A slow write widens the window two overlapping reads would race in.
    await new Promise((r) => setTimeout(r, 5))
    h.state.record = structuredClone(v)
  }),
}))
vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>()
  return {
    ...actual,
    getGroupState: vi.fn(async () => {
      if (h.state.getFails) throw h.state.getFails
      return { reset: h.state.reset }
    }),
    stopGroupReset: vi.fn(async () => {
      if (h.state.stopFails) throw h.state.stopFails
      h.state.reset = null
      return { reset: null }
    }),
  }
})
vi.mock('./session', () => ({
  currentSession: vi.fn(async () => ({
    registration: { endpointId: h.state.selfId, relayUrl: 'https://relay', deviceToken: 't' },
  })),
}))
// stream.ts's other neighbours, which these tests do not exercise.
vi.mock('./endpoints', () => ({ fetchEndpoints: vi.fn(async () => []) }))
vi.mock('./menus', () => ({ rebuildMenus: vi.fn(async () => undefined) }))
vi.mock('./receive', () => ({ deliverPushed: vi.fn(async () => undefined) }))

const api = await import('../lib/api')
const gr = await import('./groupreset')
const { handleStreamEvent } = await import('./stream')
const { clockLine, groupResetCopy, monthDayLine } = await import('../lib/strings')

function waiting(requestedAt: string, resetsAt: string): GroupResetState {
  return { requestedAt: requestedAt as IsoTimestamp, resetsAt: resetsAt as IsoTimestamp }
}

const RESET = waiting('2026-10-27T12:00:00.000Z', '2026-10-30T12:00:00.000Z')

beforeEach(() => {
  h.state.record = undefined
  h.state.reset = null
  h.state.getFails = undefined
  h.state.stopFails = undefined
  h.state.selfId = 'me'
  vi.clearAllMocks()
})

describe('noticing a reset that waits', () => {
  it('posts the system notification once per request, however often it is read', async () => {
    h.state.reset = RESET
    await Promise.all([gr.refreshGroupReset(), gr.refreshGroupReset()])
    await gr.refreshGroupReset()
    expect(h.ext.notifications.create).toHaveBeenCalledTimes(1)
    const [id, options] = h.ext.notifications.create.mock.calls[0] as unknown as [
      string,
      { title: string; message: string },
    ]
    expect(id).toBe(`tabsend-reset-${RESET.requestedAt}`)
    expect(options.title).toBe('Tabsend')
    expect(options.message).toBe(
      `Someone asked to remove all your devices on ${monthDayLine(RESET.requestedAt)}. Open Tabsend to stop it.`,
    )
    expect(await gr.groupResetNotice()).toEqual(RESET)

    // A new request is a new alert.
    h.state.reset = waiting('2026-11-02T08:00:00.000Z', '2026-11-05T08:00:00.000Z')
    await gr.refreshGroupReset()
    expect(h.ext.notifications.create).toHaveBeenCalledTimes(2)
  })

  it('shows nothing when none is waiting', async () => {
    await gr.refreshGroupReset()
    expect(h.ext.notifications.create).not.toHaveBeenCalled()
    expect(await gr.groupResetNotice()).toBeUndefined()
  })

  it('reads an older relay (404) as no reset, quietly', async () => {
    h.state.getFails = new api.ApiClientError(404, 'not_found', 'Not found.')
    await expect(gr.refreshGroupReset()).resolves.toBeNull()
    expect(h.ext.notifications.create).not.toHaveBeenCalled()
    expect(await gr.groupResetNotice()).toBeUndefined()
  })

  it('keeps the last answer when the relay cannot be asked', async () => {
    h.state.reset = RESET
    await gr.refreshGroupReset()
    h.state.getFails = new TypeError('Failed to fetch')
    await expect(gr.refreshGroupReset()).rejects.toThrow()
    expect(await gr.groupResetNotice()).toEqual(RESET)
  })

  it('shows nothing for a pairing that is not this one', async () => {
    h.state.reset = RESET
    await gr.refreshGroupReset()
    h.state.selfId = 'someone-else'
    expect(await gr.groupResetNotice()).toBeUndefined()
  })
})

describe('answering it', () => {
  it('"It was me" hides this request only, and does not alert it again', async () => {
    h.state.reset = RESET
    await gr.refreshGroupReset()
    await gr.dismissGroupReset(RESET.requestedAt)
    expect(await gr.groupResetNotice()).toBeUndefined()
    await gr.refreshGroupReset()
    expect(await gr.groupResetNotice()).toBeUndefined()
    expect(h.ext.notifications.create).toHaveBeenCalledTimes(1)

    const next = waiting('2026-11-02T08:00:00.000Z', '2026-11-05T08:00:00.000Z')
    h.state.reset = next
    await gr.refreshGroupReset()
    expect(await gr.groupResetNotice()).toEqual(next)
  })

  it('Stop clears it at the relay and here, and takes the notification down', async () => {
    h.state.reset = RESET
    await gr.refreshGroupReset()
    await gr.stopPendingGroupReset()
    expect(api.stopGroupReset).toHaveBeenCalledWith('https://relay', 't')
    expect(await gr.groupResetNotice()).toBeUndefined()
    await gr.refreshGroupReset()
    expect(await gr.groupResetNotice()).toBeUndefined()
    await vi.waitFor(() =>
      expect(h.ext.notifications.clear).toHaveBeenCalledWith(`tabsend-reset-${RESET.requestedAt}`),
    )
  })

  it('a failed Stop says why and keeps the card', async () => {
    h.state.reset = RESET
    await gr.refreshGroupReset()
    h.state.stopFails = new TypeError('Failed to fetch')
    await expect(gr.stopPendingGroupReset()).rejects.toThrow(groupResetCopy.stopFailedOffline)
    h.state.stopFails = new api.ApiClientError(500, 'internal', 'Request failed (500).')
    await expect(gr.stopPendingGroupReset()).rejects.toThrow(
      "Couldn't stop the reset: Request failed (500). The reset is still waiting. Try again.",
    )
    expect(await gr.groupResetNotice()).toEqual(RESET)
  })
})

describe('the stream and the notification', () => {
  it('reads the group again on group_updated, and alerts a new reset from there', async () => {
    h.state.reset = RESET
    await handleStreamEvent({ type: 'group_updated' })
    expect(api.getGroupState).toHaveBeenCalledTimes(1)
    expect(h.ext.notifications.create).toHaveBeenCalledTimes(1)
  })

  it('a click opens the manage screen; other notifications are not its business', async () => {
    expect(await gr.handleGroupResetNotificationClick('tabsend-device-1')).toBe(false)
    expect(await gr.handleGroupResetNotificationClick(`tabsend-reset-${RESET.requestedAt}`)).toBe(
      true,
    )
    expect(h.ext.tabs.create).toHaveBeenCalledWith({ url: 'ext://firstrun.html' })
  })
})

describe('the copy', () => {
  it('names the day and the local time, with no em dash', () => {
    const body = groupResetCopy.body(RESET.requestedAt, RESET.resetsAt)
    expect(body).toBe(
      `From your account page on ${monthDayLine(RESET.requestedAt)}. On ${monthDayLine(RESET.resetsAt)} at ${clockLine(RESET.resetsAt)}, every device is removed, this one too. If it wasn't you, stop it now, then change your email password.`,
    )
    // Noon UTC is the same calendar day in every time zone from UTC-11 to UTC+11.
    expect(monthDayLine(RESET.requestedAt)).toBe('October 27')
    expect(clockLine(RESET.resetsAt)).toMatch(/^\d{1,2}:\d{2} (AM|PM)$/)
    for (const line of [body, groupResetCopy.alertMessage(RESET.requestedAt), groupResetCopy.title])
      expect(line).not.toContain('—')
  })
})
