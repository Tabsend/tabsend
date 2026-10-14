import { PAIRING_LINK } from '@tabsend/shared'
import { describe, expect, it } from 'vitest'
import { ApiClientError } from './api'
import {
  classifyMintFailure,
  isLoopbackRelayUrl,
  pairingLinkRelayUrl,
  parsePairingInput,
} from './pairing'

describe('parsePairingInput', () => {
  it('rejects a bare secret because it does not identify or authenticate the relay', () => {
    expect(parsePairingInput('abc12345')).toBeNull()
    expect(parsePairingInput('  ABC12345  ')).toBeNull()
  })

  it('parses a full pairing link into code + relay', () => {
    expect(parsePairingInput('https://relay.example/pair#c=ABC12345')).toEqual({
      code: 'ABC12345',
      relayUrl: 'https://relay.example',
    })
  })

  it('round-trips the canonical PAIRING_LINK helper', () => {
    const link = PAIRING_LINK({
      relayUrl: 'https://relay.example',
      code: 'PQ7RSTUV' as never,
    })
    expect(parsePairingInput(link)).toEqual({
      code: 'PQ7RSTUV',
      relayUrl: 'https://relay.example',
    })
  })

  it('handles a self-host base path before /pair', () => {
    expect(parsePairingInput('https://host.example/tabsend/pair#c=ABC12345')).toEqual({
      code: 'ABC12345',
      relayUrl: 'https://host.example/tabsend',
    })
  })

  it('handles a localhost dev relay', () => {
    expect(parsePairingInput('http://localhost:8787/pair#c=ABC12345')).toEqual({
      code: 'ABC12345',
      relayUrl: 'http://localhost:8787',
    })
  })

  it('parses a link carrying a cert fingerprint without corrupting the code', () => {
    expect(parsePairingInput('https://192.168.1.20:8787/pair#c=ABC12345&fp=qL8x_Zk0')).toEqual({
      code: 'ABC12345',
      relayUrl: 'http://192.168.1.20:8786',
      certFingerprint: 'qL8x_Zk0',
    })
  })

  it('uses the advertised browser route, including custom ports', () => {
    const link = PAIRING_LINK({
      relayUrl: 'https://relay.lan:9443',
      browserRelayUrl: 'http://relay.lan:9080/base',
      code: 'ABC12345' as never,
      certFingerprint: 'PIN',
    })
    expect(parsePairingInput(link)).toEqual({
      code: 'ABC12345',
      relayUrl: 'http://relay.lan:9080/base',
      certFingerprint: 'PIN',
    })
    expect(pairingLinkRelayUrl(link)).toBe('https://relay.lan:9443')
  })

  it('does not rewrite hosted links or non-default legacy ports', () => {
    expect(parsePairingInput('https://relay.example/pair#c=ABC12345')).toMatchObject({
      relayUrl: 'https://relay.example',
    })
    expect(parsePairingInput('https://relay.lan:9443/pair#c=ABC12345&fp=PIN')).toMatchObject({
      relayUrl: 'https://relay.lan:9443',
    })
  })

  it('round-trips PAIRING_LINK when the payload includes a fingerprint', () => {
    const link = PAIRING_LINK({
      relayUrl: 'https://relay.example',
      code: 'PQ7RSTUV' as never,
      certFingerprint: 'AbC-123_xyz',
    })
    expect(parsePairingInput(link)).toEqual({
      code: 'PQ7RSTUV',
      relayUrl: 'https://relay.example',
      certFingerprint: 'AbC-123_xyz',
    })
  })

  it('ignores unknown fragment params', () => {
    expect(parsePairingInput('https://relay.example/pair#c=ABC12345&x=1&fp=FF00')).toEqual({
      code: 'ABC12345',
      relayUrl: 'https://relay.example',
      certFingerprint: 'FF00',
    })
  })

  it('returns null for empty input, a fragment with no secret, or a non-pairing URL', () => {
    expect(parsePairingInput('')).toBeNull()
    expect(parsePairingInput('   ')).toBeNull()
    expect(parsePairingInput('https://relay.example/pair#c=')).toBeNull()
    expect(parsePairingInput('https://relay.example/pair')).toBeNull()
  })
})

/**
 * The whole point is catching the dev-relay QR before it reaches a phone
 * (dogfood 2026-07-27), so the false cases matter as much as the true ones: a
 * substring test would have condemned `localhost.example.com`, a real relay.
 */
describe('isLoopbackRelayUrl', () => {
  it('flags the loopback hostnames a dev relay names itself by', () => {
    expect(isLoopbackRelayUrl('http://localhost:8787')).toBe(true)
    expect(isLoopbackRelayUrl('http://127.0.0.1:8787')).toBe(true)
    expect(isLoopbackRelayUrl('https://[::1]:8787')).toBe(true)
    expect(isLoopbackRelayUrl('http://0.0.0.0:8787')).toBe(true)
  })

  it('leaves reachable relays alone, including LAN addresses', () => {
    expect(isLoopbackRelayUrl('https://relay.example.com')).toBe(false)
    // The address a self-hoster actually pairs a phone against.
    expect(isLoopbackRelayUrl('https://192.168.1.30:8787')).toBe(false)
    // Hostname MATCH, not substring: this is a public host that merely reads local.
    expect(isLoopbackRelayUrl('https://localhost.example.com')).toBe(false)
  })

  it('returns false for anything unparseable rather than throwing', () => {
    expect(isLoopbackRelayUrl('not a url')).toBe(false)
    expect(isLoopbackRelayUrl('')).toBe(false)
    expect(isLoopbackRelayUrl('localhost:8787')).toBe(false)
  })
})

/**
 * Minting is the only pairing step that needs a live relay round-trip, so this
 * classification is what stands between "the relay is down, go start it" and the
 * silent dead button every pairing surface used to show (dogfood 2026-07-24).
 */
describe('classifyMintFailure', () => {
  const relayUrl = 'http://localhost:8787'

  it('treats a raw fetch rejection as an unreachable relay', () => {
    // What fetch throws when nothing is listening — Chrome's wording; Firefox
    // words it differently, which is why the message is rewritten, not shown.
    expect(classifyMintFailure(new TypeError('Failed to fetch'), relayUrl)).toEqual({
      kind: 'unreachable',
      relayUrl,
    })
  })

  it('treats 401 as this browser no longer being in the group', () => {
    const err = new ApiClientError(401, 'unauthorized', 'Unknown device token.')
    expect(classifyMintFailure(err, relayUrl)).toEqual({ kind: 'unauthorized' })
  })

  it('passes any other relay refusal through with its message', () => {
    const err = new ApiClientError(429, 'rate_limited', 'Too many pairing links.')
    expect(classifyMintFailure(err, relayUrl)).toEqual({
      kind: 'relay',
      detail: 'Too many pairing links.',
    })
  })

  it('classifies a non-Error throw rather than crashing', () => {
    expect(classifyMintFailure('boom', relayUrl)).toEqual({ kind: 'unreachable', relayUrl })
  })
})
