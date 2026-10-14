import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { InboxItem } from '../lib/model'

/**
 * The arrival notification [owner report 2026-10-07]: it must say which window
 * a received tab landed in, and a click must go to that tab — even after the
 * worker that posted it has died — falling back to the history page only when
 * the tab is gone. And none of it may ever throw into the deliver loop.
 */

const h = vi.hoisted(() => {
  const session: Record<string, unknown> = {}
  const state = {
    unread: 0,
    settings: { notifyOnReceive: true },
    windows: [] as Array<{ id: number; incognito?: boolean }>,
    tabs: [] as Array<{
      id: number
      windowId: number
      active?: boolean
      title?: string
      url?: string
    }>,
    sessionAvailable: true,
  }
  const sessionArea = {
    get: async (key: string) => (key in session ? { [key]: structuredClone(session[key]) } : {}),
    set: async (bag: Record<string, unknown>) => {
      Object.assign(session, structuredClone(bag))
    },
  }
  const ext = {
    storage: {
      get session() {
        return state.sessionAvailable ? sessionArea : undefined
      },
    },
    runtime: { getURL: (p: string) => `ext://${p}` },
    notifications: {
      create: vi.fn(async (id: string) => id),
      clear: vi.fn(async () => true),
      onClicked: { addListener: vi.fn() },
    },
    windows: {
      get: vi.fn(async (id: number) => {
        const w = state.windows.find((x) => x.id === id)
        if (!w) throw new Error('No window')
        return w
      }),
      getAll: vi.fn(async () => state.windows.filter((w) => !w.incognito)),
      update: vi.fn(async () => ({})),
    },
    tabs: {
      query: vi.fn(async (q: { active: boolean; windowId: number }) =>
        state.tabs.filter((t) => t.windowId === q.windowId && !!t.active === q.active),
      ),
      get: vi.fn(async (id: number) => {
        const t = state.tabs.find((x) => x.id === id)
        if (!t) throw new Error(`No tab with id: ${id}`)
        return t
      }),
      update: vi.fn(async () => ({})),
      create: vi.fn(async () => ({})),
    },
  }
  return { session, state, ext }
})

vi.mock('../lib/ext', () => ({ ext: h.ext }))
vi.mock('../lib/storage', () => ({
  getSettings: vi.fn(async () => h.state.settings),
  getUnreadReceived: vi.fn(async () => h.state.unread),
  setUnreadReceived: vi.fn(async (v: number) => {
    h.state.unread = v
  }),
}))

const notify = await import('./notify')

function item(id: string, title?: string, sourceLabel = 'Pixel 8'): InboxItem {
  return {
    id,
    url: `https://example.com/${id}`,
    title,
    sourceLabel,
    sentAt: '2026-10-07T10:00:00.000Z',
    receivedAt: 1000,
  }
}

function lastNotification(): { id: string; title: string; message: string } {
  const call = h.ext.notifications.create.mock.calls.at(-1) as unknown as [
    string,
    { title: string; message: string },
  ]
  return { id: call[0], title: call[1].title, message: call[1].message }
}

beforeEach(() => {
  vi.clearAllMocks()
  for (const k of Object.keys(h.session)) delete h.session[k]
  h.state.unread = 0
  h.state.settings = { notifyOnReceive: true }
  h.state.sessionAvailable = true
  h.state.windows = [{ id: 1 }, { id: 2 }]
  h.state.tabs = [
    { id: 10, windowId: 1, active: true, title: 'Inbox – Gmail' },
    { id: 20, windowId: 2, active: true, title: 'Docs' },
    { id: 11, windowId: 1, title: 'Lemon pasta with peas' },
  ]
})

describe('notifyDelivered', () => {
  it('names the window by its showing tab, with the sender as the title', async () => {
    await notify.notifyDelivered([item('a', 'Lemon pasta with peas')], [{ tabId: 11, windowId: 1 }])
    const n = lastNotification()
    expect(n.title).toBe('Tab received from Pixel 8')
    expect(n.message).toBe(
      'Lemon pasta with peas — opened in the window with “Inbox – Gmail”. Click to show it.',
    )
    expect(h.state.unread).toBe(1)
  })

  it('just says "background tab" when there is only one window', async () => {
    h.state.windows = [{ id: 1 }]
    await notify.notifyDelivered([item('a', 'Lemon pasta with peas')], [{ tabId: 11, windowId: 1 }])
    expect(lastNotification().message).toBe(
      'Lemon pasta with peas — opened in a background tab. Click to show it.',
    )
  })

  it('degrades when the arrival is the tab showing in its window', async () => {
    h.state.tabs = [{ id: 11, windowId: 1, active: true, title: 'Lemon pasta with peas' }]
    await notify.notifyDelivered([item('a', 'Lemon')], [{ tabId: 11, windowId: 1 }])
    expect(lastNotification().message).toBe('Lemon — opened in a new tab. Click to show it.')
  })

  it('degrades for an incognito window and for an unknown tab', async () => {
    h.state.windows = [{ id: 1, incognito: true }, { id: 2 }]
    await notify.notifyDelivered([item('a', 'X')], [{ tabId: 11, windowId: 1 }])
    expect(lastNotification().message).toBe('X — opened in a new tab. Click to show it.')
    await notify.notifyDelivered([item('b', 'Y')])
    expect(lastNotification().message).toBe('Y — opened in a new tab. Click to show it.')
  })

  it('posts nothing when switched off, but still counts the badge', async () => {
    h.state.settings = { notifyOnReceive: false }
    await notify.notifyDelivered([item('a')], [{ tabId: 11, windowId: 1 }])
    expect(h.ext.notifications.create).not.toHaveBeenCalled()
    expect(h.state.unread).toBe(1)
  })

  it('never throws, even when every API fails', async () => {
    h.ext.notifications.create.mockRejectedValueOnce(new Error('denied'))
    h.ext.windows.get.mockRejectedValueOnce(new Error('gone'))
    await expect(
      notify.notifyDelivered([item('a')], [{ tabId: 11, windowId: 1 }]),
    ).resolves.toBeUndefined()
  })
})

describe('handleNotificationClick', () => {
  it('focuses the window and shows the tab, from session storage after a worker restart', async () => {
    await notify.notifyDelivered(
      [item('a'), item('b')],
      [
        { tabId: 11, windowId: 1 },
        { tabId: 12, windowId: 1 },
      ],
    )
    const { id } = lastNotification()
    expect(Object.keys(h.session.notificationTargets as object)).toContain(id)

    // A fresh worker: new module instance, empty memory; only storage.session remains.
    vi.resetModules()
    const fresh = await import('./notify')
    await fresh.handleNotificationClick(id)

    expect(h.ext.windows.update).toHaveBeenCalledWith(1, { focused: true })
    expect(h.ext.tabs.update).toHaveBeenCalledWith(11, { active: true })
    expect(h.ext.tabs.create).not.toHaveBeenCalled()
    expect(h.ext.notifications.clear).toHaveBeenCalledWith(id)
    // Both arrivals this notification covered are now seen.
    expect(h.state.unread).toBe(0)
    expect(h.session.notificationTargets).not.toHaveProperty(id)
  })

  it('follows a tab that was dragged to another window', async () => {
    await notify.notifyDelivered([item('a')], [{ tabId: 11, windowId: 1 }])
    const tab = h.state.tabs.find((t) => t.id === 11)
    if (tab) tab.windowId = 2
    await notify.handleNotificationClick(lastNotification().id)
    expect(h.ext.windows.update).toHaveBeenCalledWith(2, { focused: true })
  })

  it('opens the history page when the tab has been closed', async () => {
    h.state.unread = 3
    await notify.notifyDelivered([item('a')], [{ tabId: 11, windowId: 1 }])
    h.state.tabs = h.state.tabs.filter((t) => t.id !== 11)
    await notify.handleNotificationClick(lastNotification().id)
    expect(h.ext.tabs.create).toHaveBeenCalledWith({ url: 'ext://history.html' })
    expect(h.ext.tabs.update).not.toHaveBeenCalled()
    // history.html clears the count itself when looked at; the click does not.
    expect(h.state.unread).toBe(4)
  })

  it('falls back to memory without storage.session, and to history once that is gone', async () => {
    h.state.sessionAvailable = false
    await notify.notifyDelivered([item('a')], [{ tabId: 11, windowId: 1 }])
    const { id } = lastNotification()
    await notify.handleNotificationClick(id)
    expect(h.ext.tabs.update).toHaveBeenCalledWith(11, { active: true })

    await notify.notifyDelivered([item('b')], [{ tabId: 11, windowId: 1 }])
    const second = lastNotification().id
    vi.resetModules()
    const fresh = await import('./notify')
    await fresh.handleNotificationClick(second)
    expect(h.ext.tabs.create).toHaveBeenCalledWith({ url: 'ext://history.html' })
  })

  it('ignores notifications that are not ours', async () => {
    await notify.handleNotificationClick('something-else')
    expect(h.ext.tabs.create).not.toHaveBeenCalled()
    expect(h.ext.notifications.clear).not.toHaveBeenCalled()
  })
})
