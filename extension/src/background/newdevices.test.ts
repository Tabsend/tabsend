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
    vouch: undefined as { endpointId: string; tags: string[] } | undefined,
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
  getPairingVouch: vi.fn(async () => structuredClone(h.state.vouch)),
  clearPairingVouch: vi.fn(async () => {
    h.state.vouch = undefined
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
  h.state.vouch = undefined
  vi.clearAllMocks()
})

/** The one notification's title and message, by call. */
function told(call = 0): { title: string; message: string } {
  const [, options] = h.ext.notifications.create.mock.calls[call] as unknown as [
    string,
    { title: string; message: string },
  ]
  return options
}

const phone = (id = 'phone') => ({ ...ep(id, 'Pixel 8'), kind: 'mobile' as const })

describe('told once, information only (P-23)', () => {
  it('tells once that a device was added, and keeps nothing waiting for an answer', async () => {
    await nd.recordEndpoints([ep('me'), ep('a')], 'me')
    vi.clearAllMocks()
    await nd.recordEndpoints([ep('me'), ep('a'), ep('x', 'Firefox · Linux')], 'me')
    await nd.recordEndpoints([ep('me'), ep('a'), ep('x', 'Firefox · Linux')], 'me')

    expect(h.ext.notifications.create).toHaveBeenCalledTimes(1)
    const [id] = h.ext.notifications.create.mock.calls[0] as unknown as [string]
    expect(id.startsWith('tabsend-device-')).toBe(true)
    expect(told()).toEqual({
      title: 'Firefox · Linux was added',
      message: "It joined your Tabsend devices just now. If that wasn't you, remove it in Tabsend.",
      type: 'basic',
      iconUrl: 'ext://icons/tabsend-128.png',
    })
    expect(h.state.watch?.unconfirmed).toEqual([])
    expect(await nd.newDeviceNotices()).toEqual([])
  })

  it('names several devices in one notification', async () => {
    await nd.recordEndpoints([ep('me')], 'me')
    await nd.recordEndpoints([ep('me'), ep('y', 'Console'), ep('z', 'Edge · Windows')], 'me')
    expect(told().title).toBe('2 devices were added')
    expect(told().message).toBe(
      "Console and Edge · Windows joined your Tabsend devices. If any wasn't you, remove it in Tabsend.",
    )
  })

  it('leaves the telling to the phone when the group has one', async () => {
    await nd.recordEndpoints([ep('me'), phone()], 'me')
    vi.clearAllMocks()
    await nd.recordEndpoints([ep('me'), phone(), ep('x')], 'me')
    expect(h.ext.notifications.create).not.toHaveBeenCalled()
    expect(h.state.watch?.unconfirmed).toEqual([])
  })

  it('still tells when the phone arrives in the same list as the newcomer', async () => {
    await nd.recordEndpoints([ep('me')], 'me')
    await nd.recordEndpoints([ep('me'), phone(), ep('x')], 'me')
    expect(h.ext.notifications.create).toHaveBeenCalledTimes(1)
  })

  it('tells once when fetches overlap', async () => {
    await nd.recordEndpoints([ep('me')], 'me')
    const list = [ep('me'), ep('x')]
    await Promise.all([
      nd.recordEndpoints(list, 'me'),
      nd.recordEndpoints(list, 'me'),
      nd.recordEndpoints(list, 'me'),
    ])
    expect(h.ext.notifications.create).toHaveBeenCalledTimes(1)
  })

  it('still writes the record and the cache when the notification fails', async () => {
    h.ext.notifications.create.mockRejectedValueOnce(new Error('no permission'))
    await nd.recordEndpoints([ep('me')], 'me')
    await expect(nd.recordEndpoints([ep('me'), ep('x')], 'me')).resolves.toBeUndefined()
    expect(h.state.cache.map((e) => e.id)).toEqual(['me', 'x'])
    expect(h.state.watch?.known).toEqual(['me', 'x'])
  })

  it('settles a record left by an earlier build, silently', async () => {
    h.state.watch = {
      selfId: 'me',
      known: ['me', 'a', 'x'],
      unconfirmed: [{ id: 'x', label: 'x', createdAt: '2026-10-29T00:00:00.000Z' as never }],
      review: [{ id: 'a', label: 'a', createdAt: '2026-10-29T00:00:00.000Z' as never }],
      keys: { me: 'pk-me', a: 'pk-a', x: 'pk-x' },
    }
    await nd.recordEndpoints([ep('me'), ep('a'), ep('x')], 'me')
    expect(h.state.watch?.unconfirmed).toEqual([])
    expect(h.state.watch?.review).toBeUndefined()
    expect(h.ext.notifications.create).not.toHaveBeenCalled()
  })
})

describe('a fresh pairing (GH6, P-23)', () => {
  it('takes the devices the pairing link vouched for without a word, and spends the tags', async () => {
    // Keys long enough to carry a tag; the link vouched for this browser and the Pixel.
    const key = (c: string) => `${c.repeat(43)}=`
    const list = [
      { ...ep('me'), e2ePubkey: key('M') },
      { ...ep('a', 'Pixel 8'), e2ePubkey: key('P') },
    ]
    h.state.vouch = { endpointId: 'me', tags: ['M'.repeat(16), 'P'.repeat(16)] }
    await nd.recordEndpoints(list, 'me')
    expect(h.ext.notifications.create).not.toHaveBeenCalled()
    expect(h.state.vouch).toBeUndefined()
    expect(h.state.watch?.review).toBeUndefined()
  })

  it('tells once about devices the link did not vouch for', async () => {
    const key = (c: string) => `${c.repeat(43)}=`
    const list = [
      { ...ep('me'), e2ePubkey: key('M') },
      { ...ep('a', 'Pixel 8'), e2ePubkey: key('P') },
      { ...ep('b', 'Chrome · Mac'), e2ePubkey: key('C') },
    ]
    h.state.vouch = { endpointId: 'me', tags: ['M'.repeat(16), 'P'.repeat(16)] }
    await nd.recordEndpoints(list, 'me')
    expect(told()).toMatchObject({
      title: 'Chrome · Mac is in your group',
      message:
        "The device you paired with didn't list it. If it isn't yours, remove it in Tabsend.",
    })
    await nd.recordEndpoints(list, 'me')
    expect(h.ext.notifications.create).toHaveBeenCalledTimes(1)
    expect(h.state.watch?.review).toBeUndefined()
  })

  it("tells about every device when the link vouched for none, or for another pairing's", async () => {
    h.state.vouch = { endpointId: 'someone-else', tags: ['p'.repeat(16)] }
    await nd.recordEndpoints([ep('me'), ep('a', 'Pixel 8'), ep('b', 'iPhone')], 'me')
    expect(told().title).toBe('2 devices are in your group')
  })

  it('says nothing when this browser is alone in the group', async () => {
    await nd.recordEndpoints([ep('me')], 'me')
    expect(h.ext.notifications.create).not.toHaveBeenCalled()
  })

  it('takes the list the previous build cached as the baseline, so a device added since is told', async () => {
    // A build from before the notice left this cache, and no watch.
    h.state.cache = [ep('me'), ep('a', 'Pixel 8')]
    await nd.recordEndpoints([ep('me'), ep('a', 'Pixel 8'), ep('x', 'Firefox · Linux')], 'me')
    expect(h.ext.notifications.create).toHaveBeenCalledTimes(1)
    expect(told().title).toBe('Firefox · Linux was added')
  })

  it('does not trust a cache left by another pairing', async () => {
    h.state.cache = [ep('someone-else'), ep('old')]
    await nd.recordEndpoints([ep('me'), ep('a')], 'me')
    expect(told().title).toBe('a is in your group')
  })
})

describe('a device that joined, then disappeared (GH7)', () => {
  it('shows a notice left by an earlier build until dismissed', async () => {
    h.state.watch = {
      selfId: 'me',
      known: ['me'],
      unconfirmed: [],
      vanished: [
        { id: 'x', label: 'Firefox · Linux', createdAt: '2026-10-29T00:00:00.000Z' as never },
      ],
    }
    expect((await nd.vanishedNotices()).map((n) => n.label)).toEqual(['Firefox · Linux'])
    await nd.dismissVanishedNotice('x')
    expect(await nd.vanishedNotices()).toEqual([])
  })

  it('shows nothing for a pairing that is not this one', async () => {
    await nd.recordEndpoints([ep('me'), ep('a')], 'me')
    h.state.selfId = 'someone-else'
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

  it('tells again when a relay that answered the removal keeps listing it', async () => {
    await nd.recordEndpoints([ep('me'), ep('a'), ep('x')], 'me')
    vi.clearAllMocks()
    await nd.recordRemovedEndpoint('me', 'x')
    await nd.recordEndpoints([ep('me'), ep('a'), ep('x', 'Firefox · Linux')], 'me')
    expect(h.ext.notifications.create).toHaveBeenCalledTimes(1)
    // Told once, not on every fetch, and still left out of the key sync.
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

  it('refuses a list without this device: not cached, nothing told', async () => {
    await nd.recordEndpoints([ep('me'), ep('a')], 'me')
    vi.clearAllMocks()
    // The relay leaves this browser out and slips in a device of its own. The
    // rule ignores such a list, so nothing else may act on it either.
    await expect(nd.recordEndpoints([ep('a'), ep('evil')], 'me')).rejects.toBeInstanceOf(
      nd.ListWithoutSelfError,
    )
    expect(h.state.cache.map((e) => e.id)).toEqual(['me', 'a'])
    expect(h.ext.notifications.create).not.toHaveBeenCalled()
  })
})

describe('clicks', () => {
  it('a click opens the manage screen; other notifications are left alone', async () => {
    expect(await nd.handleNewDeviceNotificationClick('tabsend-received-1')).toBe(false)
    expect(h.ext.tabs.create).not.toHaveBeenCalled()
    expect(await nd.handleNewDeviceNotificationClick('tabsend-device-1')).toBe(true)
    expect(h.ext.tabs.create).toHaveBeenCalledWith({ url: 'ext://firstrun.html' })
  })
})
