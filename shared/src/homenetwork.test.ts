import { describe, expect, it } from 'vitest'
import raw from '../vectors/home-network.json'
import { HOME_NETWORK_HINT, isHomeNetworkRelay } from './homenetwork'

const vectors = raw as { cases: { url: string; home: boolean; why: string }[] }

describe('isHomeNetworkRelay (P-15 vectors)', () => {
  it('has cases on both sides', () => {
    expect(vectors.cases.some((c) => c.home)).toBe(true)
    expect(vectors.cases.some((c) => !c.home)).toBe(true)
  })

  for (const c of vectors.cases) {
    it(`${c.url || '(empty)'} is ${c.home ? '' : 'not '}home network: ${c.why}`, () => {
      expect(isHomeNetworkRelay(c.url)).toBe(c.home)
    })
  }
})

describe('HOME_NETWORK_HINT', () => {
  it('says why and what to do, without an em dash', () => {
    expect(HOME_NETWORK_HINT).toContain('home network')
    expect(HOME_NETWORK_HINT).toContain('VPN')
    expect(HOME_NETWORK_HINT).not.toContain('—')
  })
})
