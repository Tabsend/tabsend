import type { Endpoint, EndpointId, SourcePrefs } from '@tabsend/shared'
import { describe, expect, it } from 'vitest'
import { orderTargets } from './prefs'

function endpoint(id: string, label: string): Endpoint {
  return {
    id: id as EndpointId,
    groupId: 'g' as Endpoint['groupId'],
    kind: 'extension',
    browser: 'chrome',
    platform: 'macos',
    label,
    e2ePubkey: `pk-${id}`,
    presence: 'online',
    lastSeenAt: '2026-07-16T12:00:00.000Z' as Endpoint['lastSeenAt'],
    createdAt: '2026-07-16T12:00:00.000Z' as Endpoint['createdAt'],
  }
}

const prefs = (over: Partial<SourcePrefs> = {}): SourcePrefs => ({
  primaryTargetId: null,
  primaryPinned: false,
  recentTargetIds: [],
  ...over,
})

describe('orderTargets (ADR-0002: primary → MRU → alphabetical)', () => {
  const a = endpoint('a', 'Zed · Work')
  const b = endpoint('b', 'Chrome · Home')
  const c = endpoint('c', 'Firefox · Dev')

  it('sorts alphabetically with no prefs', () => {
    expect(orderTargets([a, b, c], prefs()).map((e) => e.id)).toEqual(['b', 'c', 'a'])
  })

  it('puts the primary first', () => {
    const out = orderTargets([a, b, c], prefs({ primaryTargetId: 'a' as EndpointId }))
    expect(out[0]?.id).toBe('a')
  })

  it('orders recents by MRU after the primary', () => {
    const out = orderTargets(
      [a, b, c],
      prefs({
        primaryTargetId: 'c' as EndpointId,
        recentTargetIds: ['c', 'a'] as EndpointId[],
      }),
    )
    expect(out.map((e) => e.id)).toEqual(['c', 'a', 'b'])
  })
})
