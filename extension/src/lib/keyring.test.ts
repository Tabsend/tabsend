import type { Endpoint, GroupKeyRecord } from '@tabsend/shared'
import { describe, expect, it } from 'vitest'
import {
  currentKey,
  deliveryId,
  keyById,
  MAX_HANDED_KEYS,
  mergeKeys,
  pendingKeyDeliveries,
  rotatedKey,
  shouldMintFirstKey,
  sortKeys,
} from './keyring'

function key(keyId: string, createdAt: string): GroupKeyRecord {
  return { key: `secret-${keyId}`, keyId, createdAt } as GroupKeyRecord
}

function endpoint(id: string, kind = 'extension'): Endpoint {
  return { id, kind, label: id, e2ePubkey: `pk-${id}` } as Endpoint
}

describe('choosing which key to seal under', () => {
  it('takes the newest', () => {
    const ring = [key('a', '2026-08-01T00:00:00.000Z'), key('b', '2026-08-05T00:00:00.000Z')]
    expect(currentKey(ring)?.keyId).toBe('b')
  })

  it('breaks a same-instant tie deterministically, so every device agrees', () => {
    const same = '2026-08-05T00:00:00.000Z'
    const one = [key('aaa', same), key('bbb', same)]
    const other = [key('bbb', same), key('aaa', same)]
    // Two devices that received the same two keys in opposite orders must still
    // seal new history under the same one.
    expect(currentKey(one)?.keyId).toBe(currentKey(other)?.keyId)
    expect(currentKey(one)?.keyId).toBe('bbb')
  })

  it('has none while the group has never had a key', () => {
    expect(currentKey([])).toBeUndefined()
  })

  it('keeps older keys reachable by id, which is what makes old history readable', () => {
    const ring = [key('old', '2026-07-01T00:00:00.000Z'), key('new', '2026-08-01T00:00:00.000Z')]
    expect(keyById(ring, 'old')?.key).toBe('secret-old')
    expect(keyById(ring, 'nope')).toBeUndefined()
  })
})

describe('merging keys as they arrive', () => {
  it('never drops one, because an old key is what opens old history', () => {
    const ring = [key('a', '2026-07-01T00:00:00.000Z')]
    const merged = mergeKeys(ring, [key('b', '2026-08-01T00:00:00.000Z')])
    expect(merged.map((k) => k.keyId)).toEqual(['b', 'a'])
  })

  it('is idempotent on keyId', () => {
    const ring = [key('a', '2026-07-01T00:00:00.000Z')]
    expect(mergeKeys(ring, [key('a', '2026-07-01T00:00:00.000Z')])).toHaveLength(1)
  })

  it('converges two devices that minted different keys at the same moment', () => {
    const same = '2026-08-05T00:00:00.000Z'
    const deviceA = mergeKeys([key('aaa', same)], [key('zzz', same)])
    const deviceB = mergeKeys([key('zzz', same)], [key('aaa', same)])
    expect(currentKey(deviceA)?.keyId).toBe(currentKey(deviceB)?.keyId)
    // And the loser is still held, so whatever was written under it survives.
    expect(keyById(deviceA, 'aaa')).toBeDefined()
    expect(keyById(deviceB, 'aaa')).toBeDefined()
  })

  it('sorts a ring newest first', () => {
    const ring = sortKeys([
      key('mid', '2026-07-15T00:00:00.000Z'),
      key('new', '2026-08-01T00:00:00.000Z'),
      key('old', '2026-07-01T00:00:00.000Z'),
    ])
    expect(ring.map((k) => k.keyId)).toEqual(['new', 'mid', 'old'])
  })
})

describe('electing who mints the first key', () => {
  const group = [endpoint('a'), endpoint('b'), endpoint('c')]

  it('picks exactly one device, without any coordination', () => {
    const elected = group.filter((e) => shouldMintFirstKey([], group, e.id as string))
    expect(elected.map((e) => e.id)).toEqual(['a'])
  })

  it('nobody mints once the group has a key', () => {
    const ring = [key('a', '2026-08-01T00:00:00.000Z')]
    expect(group.some((e) => shouldMintFirstKey(ring, group, e.id as string))).toBe(false)
  })

  it('moves to the next device when the elected one leaves', () => {
    const remaining = [endpoint('b'), endpoint('c')]
    expect(shouldMintFirstKey([], remaining, 'b')).toBe(true)
    expect(shouldMintFirstKey([], remaining, 'c')).toBe(false)
  })

  it('does not mint from a stale endpoint list that lacks this device', () => {
    // An empty or not-yet-refreshed list must not make a device think it is alone
    // and in charge.
    expect(shouldMintFirstKey([], [], 'a')).toBe(false)
    expect(shouldMintFirstKey([], [endpoint('b')], 'a')).toBe(false)
  })
})

describe('handing the key to the rest of the group', () => {
  const ring = [key('k1', '2026-08-01T00:00:00.000Z')]
  const group = [endpoint('self'), endpoint('phone'), endpoint('desk')]

  it('covers every member except this device', () => {
    const pending = pendingKeyDeliveries(ring, group, 'self', [])
    expect(pending.map((p) => p.targetEndpointId).sort()).toEqual(['desk', 'phone'])
    expect(pending[0]?.targetPubkey).toBe('pk-phone')
  })

  it('includes a console, which reads history like anything else', () => {
    const withConsole = [...group, endpoint('web', 'console')]
    const pending = pendingKeyDeliveries(ring, withConsole, 'self', [])
    expect(pending.map((p) => p.targetEndpointId)).toContain('web')
  })

  it('never hands a key to a device the key itself names as gone (X14)', () => {
    const named = [{ ...key('k2', '2026-08-02T00:00:00.000Z'), departed: ['desk'] }]
    const pending = pendingKeyDeliveries(named, group, 'self', [])
    expect(pending.map((p) => p.targetEndpointId)).toEqual(['phone'])
  })

  it('skips what has already been delivered', () => {
    const done = [deliveryId('k1', 'phone')]
    const pending = pendingKeyDeliveries(ring, group, 'self', done)
    expect(pending.map((p) => p.targetEndpointId)).toEqual(['desk'])
  })

  it('re-delivers after a rotation, because the id names the key', () => {
    const done = [deliveryId('k1', 'phone'), deliveryId('k1', 'desk')]
    expect(pendingKeyDeliveries(ring, group, 'self', done)).toEqual([])
    const rotated = [...ring, key('k2', '2026-08-09T00:00:00.000Z')]
    expect(pendingKeyDeliveries(rotated, group, 'self', done)).toHaveLength(2)
  })

  it('has nothing to deliver while the group has no key', () => {
    expect(pendingKeyDeliveries([], group, 'self', [])).toEqual([])
  })

  it('hands a newcomer the older keys too, so history from before a rotation opens', () => {
    const rotated = [key('k1', '2026-08-01T00:00:00.000Z'), key('k2', '2026-08-09T00:00:00.000Z')]
    // Everyone already in the group has both; the new phone has neither.
    const done = ['k1', 'k2'].flatMap((k) => [deliveryId(k, 'desk')])
    const pending = pendingKeyDeliveries(rotated, group, 'self', done)
    expect(pending.map((p) => [p.record.keyId, p.targetEndpointId])).toEqual([
      ['k2', 'phone'],
      ['k1', 'phone'],
    ])
  })

  it('keeps a device any key names as gone out of every key, old ones included', () => {
    const rotated = [
      key('k1', '2026-08-01T00:00:00.000Z'),
      { ...key('k2', '2026-08-09T00:00:00.000Z'), departed: ['desk'] },
    ]
    const pending = pendingKeyDeliveries(rotated, group, 'self', [])
    expect(new Set(pending.map((p) => p.targetEndpointId))).toEqual(new Set(['phone']))
    expect(pending).toHaveLength(2)
  })

  it('hands on at most MAX_HANDED_KEYS keys, newest first', () => {
    const many = Array.from({ length: MAX_HANDED_KEYS + 4 }, (_, i) =>
      key(
        `k${String(i).padStart(2, '0')}`,
        `2026-08-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`,
      ),
    )
    const pending = pendingKeyDeliveries(many, [endpoint('self'), endpoint('phone')], 'self', [])
    expect(pending).toHaveLength(MAX_HANDED_KEYS)
    expect(pending[0]?.record.keyId).toBe(`k${MAX_HANDED_KEYS + 3}`)
  })
})

describe('rotating', () => {
  it('always sorts newer than the key it replaces', () => {
    const ring = [key('old', '2026-08-05T00:00:00.000Z')]
    const fresh = rotatedKey(ring, 'secret', 'new', new Date('2026-08-06T00:00:00.000Z'))
    expect(currentKey(mergeKeys(ring, [fresh]))?.keyId).toBe('new')
  })

  it('still sorts newer when the clock is behind the key it replaces', () => {
    // A device with a slow clock must not silently un-rotate the group by minting
    // a "new" key that sorts older than the one it is replacing.
    const ring = [key('old', '2026-08-05T00:00:00.000Z')]
    const fresh = rotatedKey(ring, 'secret', 'new', new Date('2026-08-01T00:00:00.000Z'))
    expect(currentKey(mergeKeys(ring, [fresh]))?.keyId).toBe('new')
  })

  it('dates the first key by the clock, with nothing to outrank', () => {
    const fresh = rotatedKey([], 'secret', 'first', new Date('2026-08-06T00:00:00.000Z'))
    expect(fresh.createdAt).toBe('2026-08-06T00:00:00.000Z')
  })
})

describe('a key already held', () => {
  it('is never overwritten by an incoming record with the same keyId', () => {
    const held = key('k1', '2026-08-01T00:00:00.000Z')
    const impostor = { ...held, key: 'other-secret' } as GroupKeyRecord
    expect(mergeKeys([held], [impostor])).toEqual([held])
  })
})
