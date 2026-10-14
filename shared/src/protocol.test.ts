import { describe, expect, it } from 'vitest'
import {
  CLIENT_PROTOCOL,
  MIN_RELAY_PROTOCOL,
  type ServerConfigResponse,
  checkProtocol,
  relayProtocol,
} from './types'

const config = (over: Partial<ServerConfigResponse> = {}): ServerConfigResponse => ({
  vapidPublicKey: '',
  ...over,
})

describe('relayProtocol', () => {
  it('treats a relay predating protocol discovery as v1', () => {
    expect(relayProtocol(config())).toBe(1)
  })

  it('reads the advertised protocol when present', () => {
    expect(relayProtocol(config({ protocol: 3 }))).toBe(3)
  })
})

describe('checkProtocol', () => {
  it('accepts a relay speaking exactly our protocol', () => {
    expect(checkProtocol(config({ protocol: CLIENT_PROTOCOL, minClientProtocol: 1 })).ok).toBe(true)
  })

  it('rejects a legacy relay that predates bootstrap pairing support', () => {
    // Missing fields mean protocol v1. That relay cannot create the first-run
    // group/code, so pairing must name it as stale before registration.
    expect(checkProtocol(config())).toEqual({
      ok: false,
      stale: 'relay',
      relayProtocol: 1,
      clientRequires: MIN_RELAY_PROTOCOL,
    })
  })

  it('names the CLIENT as stale when the relay requires a newer one', () => {
    const check = checkProtocol(config({ protocol: 9, minClientProtocol: CLIENT_PROTOCOL + 1 }))
    expect(check).toEqual({
      ok: false,
      stale: 'client',
      clientProtocol: CLIENT_PROTOCOL,
      relayRequires: CLIENT_PROTOCOL + 1,
    })
  })

  it('names the RELAY as stale when it speaks older than we support', () => {
    const check = checkProtocol(config({ protocol: MIN_RELAY_PROTOCOL - 1 }))
    expect(check).toEqual({
      ok: false,
      stale: 'relay',
      relayProtocol: MIN_RELAY_PROTOCOL - 1,
      clientRequires: MIN_RELAY_PROTOCOL,
    })
  })

  it('reports skew as skew — never as an unreachable relay', () => {
    // The regression this exists for: a reachable-but-incompatible relay was
    // reported as "couldn't reach the relay", sending the user to check a
    // healthy server (dogfood 2026-07-26).
    const check = checkProtocol(config({ minClientProtocol: CLIENT_PROTOCOL + 5 }))
    expect(check.ok).toBe(false)
    if (!check.ok) expect(check.stale).toBe('client')
  })
})

describe('the forgiving band', () => {
  it('keeps working when outdated but above the floor', () => {
    const check = checkProtocol(
      config({ protocol: 9, minClientProtocol: 1, recommendedClientProtocol: CLIENT_PROTOCOL + 3 }),
    )
    // The whole point: an outdated client still pairs and still sends.
    expect(check.ok).toBe(true)
    if (check.ok) {
      expect(check.outdated).toEqual({
        clientProtocol: CLIENT_PROTOCOL,
        recommended: CLIENT_PROTOCOL + 3,
      })
    }
  })

  it('does not nag a client that meets the recommendation', () => {
    const check = checkProtocol(
      config({ protocol: CLIENT_PROTOCOL, minClientProtocol: 1, recommendedClientProtocol: CLIENT_PROTOCOL }),
    )
    expect(check).toEqual({ ok: true })
  })

  it('treats a missing recommendation as "nothing to nag about"', () => {
    expect(checkProtocol(config({ protocol: CLIENT_PROTOCOL, minClientProtocol: 1 }))).toEqual({ ok: true })
  })

  it('still hard-fails below the floor, even with a recommendation set', () => {
    const check = checkProtocol(
      config({
        minClientProtocol: CLIENT_PROTOCOL + 1,
        recommendedClientProtocol: CLIENT_PROTOCOL + 3,
      }),
    )
    expect(check.ok).toBe(false)
  })
})
