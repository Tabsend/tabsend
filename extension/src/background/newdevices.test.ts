import type { Endpoint, NewDeviceWatch } from '@tabsend/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The "new device joined" notice on the extension (PLANS.md P-10). The rule
 * itself is covered by the shared vectors; this covers the wiring: every
 * recorded list is checked, a device is announced once even when fetches
 * overlap, the alert ignores the arrival-notification setting, and a click
 * opens the manage screen.
 */

const h = vi.hoisted(() => {
  const state = {
    watch: undefined as NewDeviceWatch | undefined,
    ring: [] as { key: string; keyId: string; createdAt: string }[],
    failWatchWrite: false,
    cache: [] as Endpoint[],
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
  getCachedEndpoints: vi.fn(async () => h.state.cache),
  getGroupKeys: vi.fn(async () => h.state.ring),
  setCachedEndpoints: vi.fn(async (v: Endpoint[]) => {
    h.state.cache = v
  }),
  getNewDeviceWatch: vi.fn(async () => structuredClone(h.state.watch)),
  setNewDeviceWatch: vi.fn(async (v: NewDeviceWatch) => {
    if (h.state.failWatchWrite) throw new Error('storage refused')
    // A slow write widens the window two overlapping passes would race in.
    await new Promise((r) => setTimeout(r, 5))
    h.state.watch = structuredClone(v)
  }),
}))
vi.mock('./session', () => ({
  currentSession: vi.fn(async () => ({ registration: { endpointId: h.state.selfId } })),
}))

const nd = await import('./newdevices')

function ep(id: string, label = id): Endpoint {
  return {
    id,
    label,
    groupId: 'g',
    kind: 'extension',
    browser: 'chrome',
    platform: 'macos',
    e2ePubkey: `pk-${id}`,
    presence: 'online',
    lastSeenAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  } as Endpoint
}

beforeEach(() => {
  h.state.watch = undefined
  h.state.ring = []
  h.state.failWatchWrite = false
  h.state.cache = []
  h.state.selfId = 'me'
  vi.clearAllMocks()
})

describe('the first look (GH6)', () => {
  it('asks once about the other devices in the first list, and stays answered', async () => {
    await nd.recordEndpoints([ep('me'), ep('a', 'Pixel 8'), ep('b', 'iPhone')], 'me')
    expect((await nd.reviewNotices()).map((n) => n.label)).toEqual(['Pixel 8', 'iPhone'])
    expect(h.ext.notifications.create).not.toHaveBeenCalled()

    await nd.confirmReviewAnswer()
    expect(await nd.reviewNotices()).toEqual([])
    await nd.recordEndpoints([ep('me'), ep('a', 'Pixel 8'), ep('b', 'iPhone')], 'me')
    expect(await nd.reviewNotices()).toEqual([])
  })

  it('has nothing to ask when this browser is alone in the group', async () => {
    await nd.recordEndpoints([ep('me')], 'me')
    expect(await nd.reviewNotices()).toEqual([])
  })

  it('takes the list the previous build cached as the baseline, so a device added since is announced', async () => {
    // A build from before the notice left this cache, and no watch.
    h.state.cache = [ep('me'), ep('a', 'Pixel 8')]
    await nd.recordEndpoints([ep('me'), ep('a', 'Pixel 8'), ep('x', 'Firefox · Linux')], 'me')
    expect(h.ext.notifications.create).toHaveBeenCalledTimes(1)
    expect(h.state.watch?.unconfirmed.map((n) => n.id)).toEqual(['x'])
    expect((await nd.reviewNotices()).map((n) => n.id)).toEqual(['a'])
  })

  it('does not trust a cache left by another pairing', async () => {
    h.state.cache = [ep('someone-else'), ep('old')]
    await nd.recordEndpoints([ep('me'), ep('a')], 'me')
    expect(h.ext.notifications.create).not.toHaveBeenCalled()
    expect((await nd.reviewNotices()).map((n) => n.id)).toEqual(['a'])
  })

  it('shows nothing for a pairing that is not this one', async () => {
    await nd.recordEndpoints([ep('me'), ep('a')], 'me')
    h.state.selfId = 'someone-else'
    expect(await nd.reviewNotices()).toEqual([])
    expect(await nd.vanishedNotices()).toEqual([])
  })
})

describe('a device that joined, then disappeared (GH7)', () => {
  it('stays on screen after its banner would have gone, until dismissed', async () => {
    await nd.recordEndpoints([ep('me'), ep('a')], 'me')
    await nd.recordEndpoints([ep('me'), ep('a'), ep('x', 'Firefox · Linux')], 'me')
    expect((await nd.newDeviceNotices()).map((n) => n.id)).toEqual(['x'])

    await nd.recordEndpoints([ep('me'), ep('a')], 'me')
    expect(await nd.newDeviceNotices()).toEqual([])
    expect((await nd.vanishedNotices()).map((n) => n.label)).toEqual(['Firefox · Linux'])
    await nd.recordEndpoints([ep('me'), ep('a')], 'me')
    expect((await nd.vanishedNotices()).map((n) => n.id)).toEqual(['x'])

    await nd.dismissVanishedNotice('x')
    expect(await nd.vanishedNotices()).toEqual([])
  })

  it('also reports a device that was on the first-look card and then hidden', async () => {
    await nd.recordEndpoints([ep('me'), ep('a'), ep('h', 'Chrome · Mac')], 'me')
    expect((await nd.reviewNotices()).map((n) => n.id)).toEqual(['a', 'h'])
    await nd.recordEndpoints([ep('me'), ep('a')], 'me')
    expect((await nd.reviewNotices()).map((n) => n.id)).toEqual(['a'])
    expect((await nd.vanishedNotices()).map((n) => n.label)).toEqual(['Chrome · Mac'])
  })

  it('does not report a browser that re-paired: same key under a new id, old id gone', async () => {
    await nd.recordEndpoints([ep('me'), ep('a')], 'me')
    await nd.recordEndpoints([ep('me'), ep('a'), ep('x', 'Firefox · Linux')], 'me')
    const repaired = { ...ep('y', 'Firefox · Linux'), e2ePubkey: 'pk-x' }
    await nd.recordEndpoints([ep('me'), ep('a'), repaired], 'me')
    expect(await nd.vanishedNotices()).toEqual([])
    expect((await nd.newDeviceNotices()).map((n) => n.id)).toEqual(['y'])
  })

  it('stays quiet when this browser removed the device itself', async () => {
    await nd.recordEndpoints([ep('me'), ep('a')], 'me')
    await nd.recordEndpoints([ep('me'), ep('a'), ep('x')], 'me')
    await nd.recordRemovedEndpoint('me', 'x')
    await nd.recordEndpoints([ep('me'), ep('a')], 'me')
    expect(await nd.vanishedNotices()).toEqual([])
  })

  it('stays quiet for a device the user already said is theirs', async () => {
    await nd.recordEndpoints([ep('me'), ep('a')], 'me')
    await nd.recordEndpoints([ep('me'), ep('a'), ep('x')], 'me')
    await nd.confirmNewDeviceNotice('x')
    await nd.recordEndpoints([ep('me'), ep('a')], 'me')
    expect(await nd.vanishedNotices()).toEqual([])
  })
})

describe('recordRemovedEndpoint (X13)', () => {
  it('writes a removal into the watch at once, against the key current now', async () => {
    await nd.recordEndpoints([ep('me'), ep('a'), ep('x')], 'me')
    h.state.ring = [{ key: 'k', keyId: 'k1', createdAt: '2026-10-01T00:00:00.000Z' }]
    await nd.recordRemovedEndpoint('me', 'x')
    expect(h.state.watch?.known).toEqual(['me', 'a'])
    expect(h.state.watch?.removed).toEqual(['x'])
    expect(h.state.watch?.rotateFor).toEqual(['x'])
    expect(h.state.watch?.rotateFrom).toBe('2026-10-01T00:00:00.000Z')
    expect(h.state.watch?.rotateOwedAt).toBeDefined()
  })

  it('announces the device again when a relay that answered the removal keeps listing it', async () => {
    await nd.recordEndpoints([ep('me'), ep('a'), ep('x')], 'me')
    await nd.recordRemovedEndpoint('me', 'x')
    await nd.recordEndpoints([ep('me'), ep('a'), ep('x', 'Firefox · Linux')], 'me')
    expect(h.ext.notifications.create).toHaveBeenCalledTimes(1)
    expect(h.state.watch?.unconfirmed.map((n) => n.id)).toEqual(['x'])
    // Announced once, not on every fetch, and still left out of the key sync.
    await nd.recordEndpoints([ep('me'), ep('a'), ep('x', 'Firefox · Linux')], 'me')
    expect(h.ext.notifications.create).toHaveBeenCalledTimes(1)
    expect(h.state.watch?.removed).toEqual(['x'])
  })

  it("leaves another pairing's record alone", async () => {
    await nd.recordEndpoints([ep('me'), ep('a')], 'me')
    await nd.recordRemovedEndpoint('someone-else', 'a')
    expect(h.state.watch?.known).toEqual(['me', 'a'])
    expect(h.state.watch?.removed).toBeUndefined()
  })
})

describe('recordEndpoints', () => {
  it('caches nothing when the watch cannot be stored, so nothing acts on an unjudged list', async () => {
    await nd.recordEndpoints([ep('me'), ep('a')], 'me')
    h.state.failWatchWrite = true
    await expect(nd.recordEndpoints([ep('me'), ep('a'), ep('evil')], 'me')).rejects.toThrow()
    expect(h.state.cache.map((e) => e.id)).toEqual(['me', 'a'])
  })

  it('owes a rotation against the key that was current when a device left', async () => {
    await nd.recordEndpoints([ep('me'), ep('a')], 'me')
    h.state.ring = [{ key: 'k', keyId: 'k1', createdAt: '2026-10-01T00:00:00.000Z' }]
    await nd.recordEndpoints([ep('me')], 'me')
    expect(h.state.watch?.rotateFrom).toBe('2026-10-01T00:00:00.000Z')
    expect(h.state.watch?.rotateOwedAt).toBeDefined()
  })

  it('refuses a list without this device: not cached, nothing announced', async () => {
    await nd.recordEndpoints([ep('me'), ep('a')], 'me')
    // The relay leaves this browser out and slips in a device of its own. The
    // rule ignores such a list, so nothing else may act on it either.
    await expect(nd.recordEndpoints([ep('a'), ep('evil')], 'me')).rejects.toBeInstanceOf(
      nd.ListWithoutSelfError,
    )
    expect(h.state.cache.map((e) => e.id)).toEqual(['me', 'a'])
    expect(h.ext.notifications.create).not.toHaveBeenCalled()
  })

  it('writes the cache and takes the first list as the baseline, silently', async () => {
    await nd.recordEndpoints([ep('me'), ep('a')], 'me')
    expect(h.state.cache.map((e) => e.id)).toEqual(['me', 'a'])
    expect(h.state.watch?.known).toEqual(['me', 'a'])
    expect(h.ext.notifications.create).not.toHaveBeenCalled()
  })

  it('alerts once for a device that was not there before, and keeps the banner', async () => {
    await nd.recordEndpoints([ep('me'), ep('a')], 'me')
    await nd.recordEndpoints([ep('me'), ep('a'), ep('x', 'Firefox · Linux')], 'me')
    await nd.recordEndpoints([ep('me'), ep('a'), ep('x', 'Firefox · Linux')], 'me')

    expect(h.ext.notifications.create).toHaveBeenCalledTimes(1)
    const [id, options] = h.ext.notifications.create.mock.calls[0] as unknown as [
      string,
      { title: string; message: string; requireInteraction?: boolean },
    ]
    expect(id.startsWith('tabsend-device-')).toBe(true)
    expect(options.title).toBe('New device: Firefox · Linux')
    expect(options.message).toBe(
      'Joined your Tabsend devices just now. Was this you? If not, remove it.',
    )
    expect(options.requireInteraction).toBe(true)
    expect((await nd.newDeviceNotices()).map((n) => n.id)).toEqual(['x'])
  })

  it('announces a device once when fetches overlap', async () => {
    await nd.recordEndpoints([ep('me')], 'me')
    const list = [ep('me'), ep('x')]
    await Promise.all([
      nd.recordEndpoints(list, 'me'),
      nd.recordEndpoints(list, 'me'),
      nd.recordEndpoints(list, 'me'),
    ])
    expect(h.ext.notifications.create).toHaveBeenCalledTimes(1)
  })

  it('names several devices in one alert', async () => {
    await nd.recordEndpoints([ep('me')], 'me')
    await nd.recordEndpoints([ep('me'), ep('y', 'Console'), ep('z', 'Edge · Windows')], 'me')
    const [, options] = h.ext.notifications.create.mock.calls[0] as unknown as [
      string,
      { title: string; message: string },
    ]
    expect(options.title).toBe('2 new devices joined')
    expect(options.message).toBe('Console and Edge · Windows. Were these you? If not, remove them.')
  })

  it('still writes the cache when the alert fails', async () => {
    h.ext.notifications.create.mockRejectedValueOnce(new Error('no permission'))
    await nd.recordEndpoints([ep('me')], 'me')
    await expect(nd.recordEndpoints([ep('me'), ep('x')], 'me')).resolves.toBeUndefined()
    expect(h.state.cache.map((e) => e.id)).toEqual(['me', 'x'])
    expect((await nd.newDeviceNotices()).map((n) => n.id)).toEqual(['x'])
  })
})

describe('answers and clicks', () => {
  it('"Yes, it\'s mine" drops only that banner', async () => {
    await nd.recordEndpoints([ep('me')], 'me')
    await nd.recordEndpoints([ep('me'), ep('x'), ep('y')], 'me')
    await nd.confirmNewDeviceNotice('x')
    expect((await nd.newDeviceNotices()).map((n) => n.id)).toEqual(['y'])
  })

  it('shows no banner left over from a previous pairing', async () => {
    await nd.recordEndpoints([ep('me')], 'me')
    await nd.recordEndpoints([ep('me'), ep('x')], 'me')
    h.state.selfId = 'me2'
    expect(await nd.newDeviceNotices()).toEqual([])
  })

  it('a click opens the manage screen; other notifications are left alone', async () => {
    expect(await nd.handleNewDeviceNotificationClick('tabsend-received-1')).toBe(false)
    expect(h.ext.tabs.create).not.toHaveBeenCalled()
    expect(await nd.handleNewDeviceNotificationClick('tabsend-device-1')).toBe(true)
    expect(h.ext.tabs.create).toHaveBeenCalledWith({ url: 'ext://firstrun.html' })
  })
})
