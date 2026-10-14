import type { PairingPayload } from '@tabsend/shared'
import { CLIENT_PROTOCOL, PAIRING_LINK } from '@tabsend/shared'
import { describe, expect, it } from 'vitest'
import {
  isLoopbackRelayUrl,
  pairingLinkRelayUrl,
  parsePairingInput,
  protocolMismatchMessage,
} from './pairing'

describe('parsePairingInput', () => {
  it('rejects a bare secret because it cannot identify or trust the relay', () => {
    expect(parsePairingInput('ABC23XY')).toBeNull()
  })

  it('returns null for empty input', () => {
    expect(parsePairingInput('   ')).toBeNull()
  })

  it('parses a full pairing link (the shape PAIRING_LINK mints)', () => {
    const payload: PairingPayload = {
      relayUrl: 'https://relay.example',
      code: 'ABC234' as PairingPayload['code'],
    }
    const link = PAIRING_LINK(payload) // https://relay.example/pair#c=ABC234
    expect(parsePairingInput(link)).toEqual({ relayUrl: 'https://relay.example', code: 'ABC234' })
  })

  it('extracts a self-host relay base with a port and trailing slash', () => {
    const link = PAIRING_LINK({
      relayUrl: 'http://192.168.1.5:8787/',
      code: 'ZZ99AA' as PairingPayload['code'],
    })
    expect(parsePairingInput(link)).toEqual({ relayUrl: 'http://192.168.1.5:8787', code: 'ZZ99AA' })
  })

  it('parses a link carrying a cert fingerprint without corrupting the code', () => {
    const link = PAIRING_LINK({
      relayUrl: 'https://192.168.1.20:8787',
      code: 'ABC234' as PairingPayload['code'],
      certFingerprint: 'qL8x_Zk0',
    })
    expect(parsePairingInput(link)).toEqual({
      relayUrl: 'http://192.168.1.20:8786',
      code: 'ABC234',
      certFingerprint: 'qL8x_Zk0',
    })
  })

  it('uses an advertised browser route with custom ports', () => {
    const link = PAIRING_LINK({
      relayUrl: 'https://relay.lan:9443',
      browserRelayUrl: 'http://relay.lan:9080',
      code: 'ABC234' as PairingPayload['code'],
      certFingerprint: 'PIN',
    })
    expect(parsePairingInput(link)).toMatchObject({ relayUrl: 'http://relay.lan:9080' })
    expect(pairingLinkRelayUrl(link)).toBe('https://relay.lan:9443')
  })

  it('ignores unknown fragment params', () => {
    expect(parsePairingInput('https://relay.example/pair#c=ABC234&x=1')).toEqual({
      relayUrl: 'https://relay.example',
      code: 'ABC234',
    })
  })

  it('returns null for a URL with no code fragment', () => {
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
    expect(isLoopbackRelayUrl('https://192.168.68.65:8787')).toBe(false)
    // Hostname MATCH, not substring: this is a public host that merely reads local.
    expect(isLoopbackRelayUrl('https://localhost.example.com')).toBe(false)
  })

  it('returns false for anything unparseable rather than throwing', () => {
    expect(isLoopbackRelayUrl('not a url')).toBe(false)
    expect(isLoopbackRelayUrl('')).toBe(false)
    expect(isLoopbackRelayUrl('localhost:8787')).toBe(false)
  })
})

describe('protocolMismatchMessage', () => {
  it('names a stale relay before first-run pairing attempts registration', () => {
    expect(
      protocolMismatchMessage({ vapidPublicKey: '', protocol: 1, minClientProtocol: 1 }),
    ).toMatch(/Update the relay/)
  })

  it('allows a relay that supports bootstrap pairing', () => {
    expect(
      protocolMismatchMessage({
        vapidPublicKey: '',
        protocol: CLIENT_PROTOCOL,
        minClientProtocol: CLIENT_PROTOCOL,
      }),
    ).toBeNull()
  })
})
