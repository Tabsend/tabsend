import { describe, expect, it } from 'vitest'
import { browserTlsHint, normalizeRelayUrl, RelayUrlError } from './relay-url'

describe('normalizeRelayUrl', () => {
  it('accepts a bare LAN address and supplies HTTP', () => {
    expect(normalizeRelayUrl(' 192.168.68.72:8787/ ')).toBe('http://192.168.68.72:8787')
  })

  it('uses HTTPS for a bare public hostname', () => {
    expect(normalizeRelayUrl('relay.example.com')).toBe('https://relay.example.com')
    expect(normalizeRelayUrl('relay.example.com:8443')).toBe('https://relay.example.com:8443')
  })

  it('keeps explicit HTTPS and a reverse-proxy base path', () => {
    expect(normalizeRelayUrl('https://relay.example.com/tabsend/')).toBe(
      'https://relay.example.com/tabsend',
    )
  })

  it('accepts a pasted pairing-link address', () => {
    expect(normalizeRelayUrl('http://192.168.1.50:8786/pair#c=ABC12345')).toBe(
      'http://192.168.1.50:8786',
    )
  })

  it('rejects unsupported schemes and credentials with useful errors', () => {
    expect(() => normalizeRelayUrl('ftp://relay.example.com')).toThrow(RelayUrlError)
    expect(() => normalizeRelayUrl('https://user:pass@relay.example.com')).toThrow(
      /username or password/,
    )
  })
})

describe('browserTlsHint', () => {
  it('explains why a private self-signed HTTPS address does not work in the extension', () => {
    expect(browserTlsHint('https://192.168.68.72:8787')).toContain(
      'http://the-same-LAN-address:8786',
    )
  })

  it('does not warn for a public HTTPS domain', () => {
    expect(browserTlsHint('https://relay.example.com')).toBeUndefined()
  })
})
