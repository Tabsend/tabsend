import type { Endpoint, EndpointId, IsoTimestamp, NewDeviceWatch } from '@tabsend/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OutboundItem } from '../lib/model'
import type { UnreachableDevice } from '../lib/unreachable'

/**
 * The popup's "waiting on this browser" rows for a tab whose device is gone
 * (P-15 item 3, SECURITY_REVIEW L3). The relay picks when such a row appears, so
 * what it offers is decided here from this browser's watch, not from the list.
 */

let list: Endpoint[] = []
let outbound: OutboundItem[] = []
let watch: NewDeviceWatch | undefined
let unreachable: UnreachableDevice[] = []
let listFetchedAt: number | undefined
let toolbarClickMode: 'chooser' | 'quicksend' = 'chooser'
vi.mock('../lib/storage', () => ({
  getCachedEndpoints: vi.fn(async () => list),
  getCachedEndpointsAt: vi.fn(async () => listFetchedAt),
  getOutbound: vi.fn(async () => outbound),
  getPrefs: vi.fn(async () => ({
    primaryPinned: false,
    primaryTargetId: 'pixel',
    recentTargetIds: [],
  })),
  getSettings: vi.fn(async () => ({ toolbarClickMode })),
  getUnreachableDevices: vi.fn(async () => unreachable),
  setUnreachableDevices: vi.fn(async (v: UnreachableDevice[]) => {
    unreachable = v
  }),
  UNREACHABLE_DEVICES_KEY: 'unreachableDevices',
}))
vi.mock('./badge', () => ({ setUnreachableBadge: vi.fn() }))
vi.mock('../lib/api', () => ({ getOutbox: vi.fn(async () => []), listEndpoints: vi.fn() }))
vi.mock('./health', () => ({ relayHealth: vi.fn(async () => undefined) }))
vi.mock('./groupreset', () => ({
  groupResetNotice: vi.fn(async () => undefined),
  refreshGroupReset: vi.fn(async () => null),
}))
vi.mock('./newdevices', () => ({
  currentDeviceWatch: vi.fn(async () => watch),
  newDeviceNotices: vi.fn(async () => []),
  recordEndpoints: vi.fn(),
  reviewNotices: vi.fn(async () => []),
  vanishedNotices: vi.fn(async () => []),
}))
vi.mock('./session', () => ({
  currentSession: vi.fn(async () => ({ registration: { endpointId: 'self' } })),
}))

import { listEndpoints } from '../lib/api'
import { buildChooserView, buildDevicesView, deviceChoicesForBrowser } from './endpoints'
import { refreshGroupReset } from './groupreset'

function device(id: string, kind: Endpoint['kind'] = 'mobile'): Endpoint {
  return {
    id: id as EndpointId,
    groupId: 'g' as Endpoint['groupId'],
    kind,
    browser: null,
    platform: 'android',
    label: id,
    e2ePubkey: `pk-${id}`,
    presence: 'online',
    lastSeenAt: '2026-10-01T00:00:00.000Z' as IsoTimestamp,
    createdAt: '2026-10-01T00:00:00.000Z' as IsoTimestamp,
  }
}

function heldFor(target: string, extra: Partial<OutboundItem> = {}): OutboundItem {
  return {
    id: `tab-${target}`,
    targetEndpointId: target,
    envelope: {
      alg: 'x25519-xsalsa20-poly1305/box',
      senderKeyId: 's',
      targetKeyId: 't',
      nonce: 'n',
      ciphertext: 'c',
    },
    createdAt: '2026-10-01T00:00:00.000Z',
    attempts: 0,
    url: 'https://example.com/',
    ...extra,
  }
}

beforeEach(() => {
  listFetchedAt = undefined
  unreachable = []
  toolbarClickMode = 'chooser'
  list = ['self', 'pixel', 'removed', 'pending', 'stranger'].map((id) => device(id))
  list.push(device('console', 'console'))
  watch = {
    selfId: 'self',
    known: ['self', 'pixel', 'removed', 'pending', 'console'],
    unconfirmed: [{ id: 'pending', label: 'pending', createdAt: list[0]!.createdAt }],
    keys: Object.fromEntries(list.map((e) => [e.id, e.e2ePubkey])),
    removed: ['removed'],
  }
})

describe('held tabs whose device is gone, in the popup', () => {
  it('offers only accepted, answered devices: never a removed, pending or unknown one', async () => {
    outbound = [heldFor('removed')]
    const view = await buildChooserView({ cached: true })
    expect(view.held[0]?.targetGone).toBe(true)
    expect(view.held[0]?.choices).toEqual(['pixel'])
  })

  it('says "was removed" only for a device this browser removed', async () => {
    outbound = [heldFor('removed'), heldFor('vanished')]
    const view = await buildChooserView({ cached: true })
    expect(view.held.map((h) => [h.targetGone, h.removedHere])).toEqual([
      [true, true],
      [true, undefined],
    ])
  })

  it('leaves alone a tab whose device is accepted, even with its notice unanswered', async () => {
    outbound = [heldFor('pixel'), heldFor('pending')]
    const view = await buildChooserView({ cached: true })
    expect(view.held.map((h) => h.targetGone)).toEqual([undefined, undefined])
  })

  it('takes nothing from a watch another pairing left behind (L7)', async () => {
    // A watch written under an earlier registration of this browser: it removed
    // "pixel" and never met "stranger". Neither verdict is this pairing's.
    watch = {
      selfId: 'old-self',
      known: ['old-self', 'removed'],
      unconfirmed: [],
      removed: ['pixel'],
    }
    outbound = [heldFor('pixel'), heldFor('stranger')]
    const view = await buildChooserView({ cached: true })
    expect(view.held.map((h) => [h.targetGone, h.removedHere, h.choices])).toEqual([
      [undefined, undefined, undefined],
      [undefined, undefined, undefined],
    ])
  })

  it('offers nothing to move a tab without a web address', async () => {
    outbound = [heldFor('removed', { url: 'file:///etc/hosts' })]
    const view = await buildChooserView({ cached: true })
    expect(view.held[0]?.targetGone).toBe(true)
    expect(view.held[0]?.choices).toBeUndefined()
  })
})

describe('a device a send could not reach, in the popup (P-20)', () => {
  it('is listed for the card, and its row says "not connected" while the list still shows it', async () => {
    outbound = []
    unreachable = [
      { endpointId: 'pixel', label: 'pixel', failedAt: '2026-10-30T10:00:00.000Z' },
      { endpointId: 'gone', label: 'Old laptop', failedAt: '2026-10-30T10:00:00.000Z' },
    ]
    const view = await buildChooserView({ cached: true })
    expect(view.unreachable.map((d) => d.label)).toEqual(['pixel', 'Old laptop'])
    expect(view.targets.find((t) => t.endpoint.id === 'pixel')?.unreachable).toBe(true)
    expect(view.targets.find((t) => t.endpoint.id === 'removed')?.unreachable).toBeUndefined()
  })
})

describe('the "Main" label in the popup', () => {
  const marked = async () =>
    (await buildChooserView({ cached: true })).targets
      .filter((t) => t.isPrimary)
      .map((t) => t.endpoint.id)

  it('marks the one-click device while "Send in one click" is on', async () => {
    toolbarClickMode = 'quicksend'
    expect(await marked()).toEqual(['pixel'])
  })

  it('marks nothing while it is off, since a click then sends nowhere by itself', async () => {
    expect(await marked()).toEqual([])
  })
})

describe('the device list repainted from the cache', () => {
  it('asks the relay nothing, so a repaint cannot set off another', async () => {
    vi.mocked(listEndpoints).mockClear()
    vi.mocked(refreshGroupReset).mockClear()
    const view = await buildDevicesView({ cached: true })
    expect(view.devices.map((d) => d.endpointId)).toContain('pixel')
    expect(listEndpoints).not.toHaveBeenCalled()
    expect(refreshGroupReset).not.toHaveBeenCalled()
  })
})

describe('the devices a joining browser can pick as its own', () => {
  // What the group looks like in practice: the iPhone app names its device, the
  // Android app does not, and two computers each carry a browser.
  const group: Endpoint[] = [
    { ...device('self', 'extension'), platform: 'macos', label: 'Chrome · Mac', deviceName: 'Mac' },
    {
      ...device('work-pc', 'extension'),
      platform: 'windows',
      label: 'Edge · Work PC',
      deviceName: 'Work PC',
    },
    {
      ...device('iphone', 'mobile'),
      platform: 'ios',
      label: 'Ben’s iPhone',
      deviceName: 'Ben’s iPhone',
    },
    { ...device('pixel', 'mobile'), platform: 'android', label: 'Pixel 8' },
  ]

  it('leaves out phones for a browser on a computer, the iPhone included', () => {
    expect(deviceChoicesForBrowser(group, 'self', 'macos')).toEqual(['Work PC'])
    expect(deviceChoicesForBrowser(group, 'self', 'unknown')).toEqual(['Work PC'])
  })

  it('offers only phones to a browser on a phone, and never itself', () => {
    expect(deviceChoicesForBrowser(group, 'pixel', 'android')).toEqual(['Ben’s iPhone'])
  })

  it('still takes a computer’s name from an older label with no device name', () => {
    const older: Endpoint[] = [
      { ...device('old', 'extension'), platform: 'linux', label: 'Firefox · Desk' },
    ]
    expect(deviceChoicesForBrowser(older, 'self', 'macos')).toEqual(['Desk'])
  })
})

describe('the status words in the device list', () => {
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString() as IsoTimestamp
  const labelsOf = async () =>
    Object.fromEntries(
      (await buildDevicesView({ cached: true })).devices.map((d) => [
        d.endpointId,
        d.presenceLabel,
      ]),
    )
  beforeEach(() => {
    list = [
      { ...device('here'), presence: 'online' },
      { ...device('recent'), presence: 'offline', lastSeenAt: ago(5 * 60_000) },
      { ...device('old'), presence: 'offline', lastSeenAt: ago(60 * 24 * 3_600_000) },
    ]
  })

  it('say online, last seen and inactive while the list is fresh', async () => {
    listFetchedAt = Date.now()
    expect(await labelsOf()).toEqual({
      here: 'online',
      recent: 'last seen 5m ago',
      old: 'inactive',
    })
  })

  it('claim nothing about now once the list is old: last seen only', async () => {
    listFetchedAt = undefined
    const labels = await labelsOf()
    expect(labels.recent).toBe('last seen 5m ago')
    expect(labels.old).toBe('last seen 60d ago')
    expect(labels.here).toMatch(/^last seen /)
  })
})
