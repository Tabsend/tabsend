import { describe, expect, it } from 'vitest'
import raw from '../vectors/group-key-records.json'
import { isAcceptableDeparted, isAcceptableKeyCreatedAt, vouchedDeparted } from './keyrecord'

// The same cases run on Android and iOS; see the header of keyrecord.ts.
const vectors = raw as {
  nowMs: number
  nowIso: string
  createdAt: { value: string; accept: boolean; why: string }[]
  departed: { value: unknown; accept: boolean; why: string }[]
  vouched: { departed: string[] | null; sender: string; expect: string[] | null; why: string }[]
}

describe('isAcceptableKeyCreatedAt (group-key-records vectors)', () => {
  it('the vector clock agrees with itself', () => {
    expect(new Date(vectors.nowMs).toISOString()).toBe(vectors.nowIso)
  })
  for (const c of vectors.createdAt) {
    it(`${c.accept ? 'accepts' : 'refuses'} ${JSON.stringify(c.value)} (${c.why})`, () => {
      expect(isAcceptableKeyCreatedAt(c.value, vectors.nowMs)).toBe(c.accept)
    })
  }
})

describe('isAcceptableDeparted (group-key-records vectors)', () => {
  for (const c of vectors.departed) {
    it(`${c.accept ? 'accepts' : 'refuses'} ${JSON.stringify(c.value)?.slice(0, 40)} (${c.why})`, () => {
      expect(isAcceptableDeparted(c.value)).toBe(c.accept)
    })
  }
  it('treats an absent field like null', () => {
    expect(isAcceptableDeparted(undefined)).toBe(true)
  })
})

describe('vouchedDeparted (group-key-records vectors)', () => {
  for (const c of vectors.vouched) {
    it(c.why, () => {
      expect(vouchedDeparted(c.departed, c.sender) ?? null).toEqual(c.expect)
    })
  }
})
