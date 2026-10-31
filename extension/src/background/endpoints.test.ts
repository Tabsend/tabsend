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
let toolbarClickMode: 'chooser' | 'quicksend' = 'chooser'
vi.mock('../lib/storage', () => ({
  getCachedEndpoints: vi.fn(async () => list),
  getCachedEndpointsAt: vi.fn(async () => undefined),
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

import { buildChooserView } from './endpoints'

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
