import type { IsoTimestamp } from '@tabsend/shared'
import { describe, expect, it } from 'vitest'
import { makeEndpoint } from './fixtures'
import { isStaleEndpoint, relativeTime, STALE_ENDPOINT_THRESHOLD_MS } from './time'

const NOW = Date.parse('2026-07-18T12:00:00.000Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()

describe('relativeTime', () => {
  it('buckets recent times', () => {
    expect(relativeTime(ago(10_000), NOW)).toBe('just now')
    expect(relativeTime(ago(5 * 60_000), NOW)).toBe('5m ago')
    expect(relativeTime(ago(3 * 3_600_000), NOW)).toBe('3h ago')
    expect(relativeTime(ago(2 * 86_400_000), NOW)).toBe('2d ago')
  })

  it('buckets months and years', () => {
    expect(relativeTime(ago(45 * 86_400_000), NOW)).toBe('1mo ago')
    expect(relativeTime(ago(400 * 86_400_000), NOW)).toBe('1y ago')
  })

  it('handles a bad timestamp', () => {
    expect(relativeTime('not-a-date', NOW)).toBe('unknown')
  })
})

describe('isStaleEndpoint', () => {
  it('is never stale when online', () => {
    const e = makeEndpoint({
      presence: 'online',
      lastSeenAt: ago(365 * 86_400_000) as IsoTimestamp,
    })
    expect(isStaleEndpoint(e, NOW)).toBe(false)
  })

  it('is not stale when recently offline', () => {
    const e = makeEndpoint({ presence: 'offline', lastSeenAt: ago(3 * 86_400_000) as IsoTimestamp })
    expect(isStaleEndpoint(e, NOW)).toBe(false)
  })

  it('is stale past the 30-day horizon', () => {
    const e = makeEndpoint({
      presence: 'offline',
      lastSeenAt: ago(STALE_ENDPOINT_THRESHOLD_MS + 86_400_000) as IsoTimestamp,
    })
    expect(isStaleEndpoint(e, NOW)).toBe(true)
  })
})
