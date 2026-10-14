import type { GroupKeyRecord } from '@tabsend/shared'
import { describe, expect, it } from 'vitest'
import { keyById, mayMintGroupKey, mergeKeys, sortKeys } from './keyring'

function key(keyId: string, createdAt: string): GroupKeyRecord {
  return { key: `secret-${keyId}`, keyId, createdAt } as GroupKeyRecord
}

describe('ordering the ring', () => {
  it('puts the newest key first', () => {
    const ring = sortKeys([
      key('a', '2026-08-01T00:00:00.000Z'),
      key('b', '2026-08-05T00:00:00.000Z'),
    ])
    expect(ring.map((k) => k.keyId)).toEqual(['b', 'a'])
  })

  it('breaks a same-instant tie deterministically, so every device agrees', () => {
    const same = '2026-08-05T00:00:00.000Z'
    // Two devices that received the same two keys in opposite orders must end up
    // with the same ring, or they would disagree about which key is current.
    expect(sortKeys([key('aaa', same), key('bbb', same)]).map((k) => k.keyId)).toEqual(
      sortKeys([key('bbb', same), key('aaa', same)]).map((k) => k.keyId),
    )
  })
})

describe('finding the key a blob names', () => {
  it('keeps older keys reachable by id, which is what makes old history readable', () => {
    const ring = [key('old', '2026-07-01T00:00:00.000Z'), key('new', '2026-08-01T00:00:00.000Z')]
    expect(keyById(ring, 'old')?.key).toBe('secret-old')
  })

  it('misses cleanly for a key we never received (the metadata-only row)', () => {
    expect(keyById([key('a', '2026-08-01T00:00:00.000Z')], 'rotated-away')).toBeUndefined()
  })
})

describe('merging keys as they arrive', () => {
  it('never drops one, because an old key is what opens old history', () => {
    const ring = [key('a', '2026-07-01T00:00:00.000Z')]
    expect(mergeKeys(ring, [key('b', '2026-08-01T00:00:00.000Z')]).map((k) => k.keyId)).toEqual([
      'b',
      'a',
    ])
  })

  it('is idempotent on keyId, so re-reading the undeleted relay copies costs nothing', () => {
    const ring = [key('a', '2026-07-01T00:00:00.000Z')]
    expect(mergeKeys(ring, [key('a', '2026-07-01T00:00:00.000Z')])).toHaveLength(1)
  })

  it('keeps the record already held when the same id arrives again', () => {
    const ring = [key('a', '2026-07-01T00:00:00.000Z')]
    const merged = mergeKeys(ring, [{ ...key('a', '2026-08-01T00:00:00.000Z'), key: 'imposter' }])
    expect(merged[0]!.key).toBe('secret-a')
  })
})

describe('minting', () => {
  it('never happens on a console, whatever the group looks like', () => {
    // The canonical rule elects the lowest endpoint id with an empty ring, which
    // a console can easily satisfy. It still refuses: a reader that cannot send
    // must not become the group's key authority.
    expect(mayMintGroupKey()).toBe(false)
  })
})
