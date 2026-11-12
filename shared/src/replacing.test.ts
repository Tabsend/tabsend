import { describe, expect, it } from 'vitest'
import raw from '../vectors/replacing-devices.json'
import {
  appNameOf,
  findReplacedSelf,
  normalizeName,
  strictIsoMillis,
  withoutCounter,
  type ReplacingCandidate,
} from './replacing'

// The same cases run on Android and iOS; see the header of replacing.ts.
const vectors = raw as unknown as {
  cases: {
    name: string
    selfId: string
    removed: string[]
    now: string
    list: ReplacingCandidate[]
    expect: string | null
  }[]
}

describe('findReplacedSelf (PLANS.md P-31 item 2)', () => {
  it('has cases', () => {
    expect(vectors.cases.length).toBeGreaterThan(30)
  })

  for (const c of vectors.cases) {
    it(c.name, () => {
      const now = Date.parse(c.now)
      expect(findReplacedSelf(c.selfId, c.list, c.removed, now)?.id ?? null).toBe(c.expect)
    })
  }

  it('lowercases ASCII only and collapses ASCII spaces', () => {
    expect(normalizeName('  Dia\t2 \n')).toBe('dia 2')
    expect(normalizeName('ÄΣ')).toBe('ÄΣ')
  })

  it('strips only the counter the relay writes', () => {
    expect(withoutCounter('dia 2')).toBe('dia')
    expect(withoutCounter('dia 99')).toBe('dia')
    expect(withoutCounter('dia 1')).toBe('dia 1')
    expect(withoutCounter('dia 100')).toBe('dia 100')
    expect(withoutCounter('7')).toBe('7')
  })

  it('reads only canonical times', () => {
    expect(strictIsoMillis('2026-10-30T08:00:00.000Z')).toBe(Date.parse('2026-10-30T08:00:00.000Z'))
    expect(strictIsoMillis('2026-10-30T08:00:00Z')).toBeNull()
  })

  it('names the app half for the button', () => {
    expect(appNameOf('Dia · MacBook Pro')).toBe('Dia')
    expect(appNameOf('Pixel 8')).toBe('Pixel 8')
  })
})
