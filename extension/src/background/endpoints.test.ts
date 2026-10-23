import type { Endpoint, EndpointId, IsoTimestamp, NewDeviceWatch } from '@tabsend/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OutboundItem } from '../lib/model'

/**
 * The popup's "waiting on this browser" rows for a tab whose device is gone
 * (P-15 item 3, SECURITY_REVIEW L3). The relay picks when such a row appears, so
 * what it offers is decided here from this browser's watch, not from the list.
 */

let list: Endpoint[] = []
let outbound: OutboundItem[] = []
let watch: NewDeviceWatch | undefined
vi.mock('../lib/storage', () => ({
  getCachedEndpoints: vi.fn(async () => list),
  getCachedEndpointsAt: vi.fn(async () => undefined),
  getOutbound: vi.fn(async () => outbound),
  getPrefs: vi.fn(async () => ({ primaryPinned: false, recentTargetIds: [] })),
}))
vi.mock('../lib/api', () => ({ getOutbox: vi.fn(async () => []), listEndpoints: vi.fn() }))
vi.mock('./health', () => ({ relayHealth: vi.fn(async () => undefined) }))
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
