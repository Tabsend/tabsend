import { afterEach, describe, expect, it, vi } from 'vitest'

const permissions = {
  contains: vi.fn(async (_: { origins: string[] }) => true),
  request: vi.fn(async (_: { origins: string[] }) => true),
}
vi.mock('./ext', () => ({ ext: { permissions } }))

const { hasRelayAccess, relayAccessPattern, requestRelayAccess } = await import('./relay-access')

afterEach(() => vi.clearAllMocks())

describe('relayAccessPattern', () => {
  it("names the relay's scheme and host, any port, any path", () => {
    expect(relayAccessPattern('https://relay.example.com')).toBe('https://relay.example.com/*')
    expect(relayAccessPattern('http://192.168.1.20:8080/base')).toBe('http://192.168.1.20/*')
    expect(relayAccessPattern('http://[fd00::5]:8080')).toBe('http://[fd00::5]/*')
  })

  it('needs no prompt for the hosted relay: it is in the manifest', async () => {
    const { readFileSync } = await import('node:fs')
    const manifest = JSON.parse(
      readFileSync(new URL('../../public/manifest.json', import.meta.url), 'utf8'),
    ) as { host_permissions: string[]; optional_host_permissions: string[]; permissions: string[] }
    expect(manifest.host_permissions).toEqual([relayAccessPattern('https://app.tabsend.org')])
    // Never every website at install again: that is what sent the item to in-depth review.
    expect(manifest.optional_host_permissions).toEqual(['http://*/*', 'https://*/*'])
    expect(manifest.permissions).toContain('activeTab')
  })
})

describe('requestRelayAccess / hasRelayAccess', () => {
  it('ask for exactly the pattern', async () => {
    await requestRelayAccess('https://relay.example.com:8443')
    expect(permissions.request).toHaveBeenCalledWith({ origins: ['https://relay.example.com/*'] })
    await hasRelayAccess('https://relay.example.com:8443')
    expect(permissions.contains).toHaveBeenCalledWith({ origins: ['https://relay.example.com/*'] })
  })

  it('answer false, never throw, when the browser refuses or the address is bad', async () => {
    permissions.request.mockRejectedValueOnce(new Error('not a user gesture'))
    expect(await requestRelayAccess('https://relay.example.com')).toBe(false)
    expect(await requestRelayAccess('not a url')).toBe(false)
    expect(await hasRelayAccess('not a url')).toBe(false)
  })
})
