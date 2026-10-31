import type { Endpoint } from '@tabsend/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SendResult } from '../lib/model'
import type { UnreachableDevice } from '../lib/unreachable'

/**
 * A device a send could not reach (PLANS.md P-20): remembered after the failure,
 * shown as a "!" on the toolbar icon, and forgotten once it is answered.
 */

const h = vi.hoisted(() => ({
  list: [] as UnreachableDevice[],
  badge: vi.fn((_title: string) => undefined),
}))

vi.mock('../lib/ext', () => ({ ext: {} }))
vi.mock('../lib/storage', () => ({
  getUnreachableDevices: vi.fn(async () => structuredClone(h.list)),
  setUnreachableDevices: vi.fn(async (v: UnreachableDevice[]) => {
    h.list = structuredClone(v)
  }),
  UNREACHABLE_DEVICES_KEY: 'unreachableDevices',
}))
vi.mock('./badge', () => ({ setUnreachableBadge: h.badge }))

const u = await import('./unreachable')

function ep(id: string, label: string, createdAt: string): Endpoint {
  return {
    id,
    label,
    groupId: 'g',
    kind: 'mobile',
    platform: 'android',
    e2ePubkey: 'k',
    presence: 'offline',
    lastSeenAt: createdAt,
    createdAt,
  } as Endpoint
}

const gone = (failure: SendResult['failure'], label = 'Pixel 8'): SendResult => ({
  ok: false,
  queued: false,
  offline: false,
  targetLabel: label,
  ...(failure ? { failure } : {}),
})

beforeEach(() => {
  h.list = []
  h.badge.mockClear()
})

describe('remembering a device the relay no longer has', () => {
  it('records it when the relay says the target is unknown, or it is gone from the list', async () => {
    await u.noteSendOutcome('p1', gone({ kind: 'relay-rejected', reason: 'unknown_target' }))
    await u.noteSendOutcome('b1', gone({ kind: 'no-target' }, 'Firefox on Work laptop'))
    expect(h.list.map((d) => [d.endpointId, d.label])).toEqual([
      ['p1', 'Pixel 8'],
      ['b1', 'Firefox on Work laptop'],
    ])
  })

  it('does not record failures about the relay rather than the device', async () => {
    await u.noteSendOutcome('p1', gone({ kind: 'relay-unreachable', relayUrl: 'https://r' }))
    await u.noteSendOutcome('p1', gone({ kind: 'relay-rejected', reason: 'expired_key' }))
    await u.noteSendOutcome('p1', gone({ kind: 'browser-offline' }))
    expect(h.list).toEqual([])
  })

  it('forgets it after a send to it goes through, but not after one that was only held', async () => {
    await u.noteSendOutcome('p1', gone({ kind: 'no-target' }))
    await u.noteSendOutcome('p1', {
      ok: true,
      queued: false,
      offline: true,
      failure: { kind: 'browser-offline' },
    })
    expect(h.list).toHaveLength(1)
    await u.noteSendOutcome('p1', { ok: true, queued: false, offline: false })
    expect(h.list).toEqual([])
  })

  it('forgets it once a fresh list has it again, or a device of the same name joined since', async () => {
    h.list = [
      { endpointId: 'p1', label: 'Pixel 8', failedAt: '2026-10-30T10:00:00.000Z' },
      { endpointId: 'b1', label: 'Arc', failedAt: '2026-10-30T10:00:00.000Z' },
      { endpointId: 'i1', label: 'iPad', failedAt: '2026-10-30T10:00:00.000Z' },
    ]
    await u.pruneUnreachableWith([
      // Pixel 8 paired again after the failure: a new id, the same name.
      ep('p2', 'Pixel 8', '2026-10-30T10:05:00.000Z'),
      // Arc is listed again under its old id.
      ep('b1', 'Arc', '2026-01-01T00:00:00.000Z'),
      // An older iPad of the same name is not the iPad coming back.
      ep('i0', 'iPad', '2026-09-01T00:00:00.000Z'),
    ])
    expect(h.list.map((d) => d.endpointId)).toEqual(['i1'])
  })

  it('is dismissed one device at a time', async () => {
    h.list = [
      { endpointId: 'p1', label: 'Pixel 8', failedAt: '2026-10-30T10:00:00.000Z' },
      { endpointId: 'b1', label: 'Arc', failedAt: '2026-10-30T10:00:00.000Z' },
    ]
    await u.dismissUnreachable('p1')
    expect(h.list.map((d) => d.endpointId)).toEqual(['b1'])
  })
})

describe('the toolbar icon', () => {
  it('names the device on its tooltip, or counts them, and is blank when none are left', async () => {
    h.list = [{ endpointId: 'p1', label: 'Pixel 8', failedAt: '2026-10-30T10:00:00.000Z' }]
    await u.primeUnreachableBadge()
    expect(h.badge).toHaveBeenLastCalledWith(
      "Pixel 8 isn't connected any more. Open Tabsend to fix it.",
    )
    h.list.push({ endpointId: 'b1', label: 'Arc', failedAt: '2026-10-30T10:00:00.000Z' })
    await u.primeUnreachableBadge()
    expect(h.badge).toHaveBeenLastCalledWith(
      "2 devices aren't connected any more. Open Tabsend to fix them.",
    )
    h.list = []
    await u.primeUnreachableBadge()
    expect(h.badge).toHaveBeenLastCalledWith('')
  })
})
