import type { PairingCodeValue } from '@tabsend/shared'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config'
import { pairingLinks } from '../src/pairing-links'

const code = 'ABC12345' as PairingCodeValue

describe('client-appropriate pairing links', () => {
  it('uses one compact HTTPS link for a hosted relay', () => {
    const config = loadConfig({ PUBLIC_RELAY_URL: 'https://relay.example' })
    expect(pairingLinks(config, code)).toEqual({
      browserLink: 'https://relay.example/pair#c=ABC12345',
      nativeLink: 'https://relay.example/pair#c=ABC12345',
    })
  })

  it('defaults copy to the browser door and QR to pinned HTTPS', () => {
    const config = loadConfig({
      TLS_SELF_SIGNED: '1',
      PORT: '9443',
      HTTP_PORT: '9080',
      PUBLIC_RELAY_URL: 'https://relay.lan:9443/base',
    })
    const links = pairingLinks(config, code, 'PIN')
    expect(links.browserLink).toMatch(/^http:\/\/relay\.lan:9080\/base\/pair#c=ABC12345&fp=PIN/)
    expect(links.browserLink).toContain('native=https%3A%2F%2Frelay.lan%3A9443%2Fbase')
    expect(links.nativeLink).toMatch(/^https:\/\/relay\.lan:9443\/base\/pair#c=ABC12345&fp=PIN/)
    expect(links.nativeLink).toContain('browser=http%3A%2F%2Frelay.lan%3A9080%2Fbase')
  })
})
