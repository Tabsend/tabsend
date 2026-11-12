import { describe, expect, it } from 'vitest'
import { pictureAddress, previewUrl, siteIconAddresses, siteLetter } from './link-preview'

describe('history pictures', () => {
  it.each([
    'http://example.com',
    'https://127.0.0.1',
    'https://[::1]',
    'https://localhost',
    'https://printer.local',
    'https://user:pass@example.com',
    'file:///tmp/a',
    'https://example.com:8443',
  ])('refuses %s', (raw) => {
    expect(previewUrl(raw)).toBeUndefined()
    expect(pictureAddress(raw)).toBeUndefined()
  })

  it('resolves a relative address against the page it came from', () => {
    expect(pictureAddress('/cover.jpg', 'https://example.com/article')).toBe(
      'https://example.com/cover.jpg',
    )
  })

  it('refuses a data address, a non-string and an oversized address', () => {
    expect(pictureAddress('data:image/png;base64,AAAA')).toBeUndefined()
    expect(pictureAddress(42)).toBeUndefined()
    expect(pictureAddress(`https://example.com/${'a'.repeat(2048)}`)).toBeUndefined()
  })

  it('gives the first letter of the site, without www', () => {
    expect(siteLetter('https://www.github.com/a')).toBe('G')
    expect(siteLetter(undefined)).toBe('?')
  })

  it('offers the site icon when there is no picture: the favicon, then the usual places', () => {
    expect(siteIconAddresses('https://www.3sat.de/a?b=1', 'https://cdn.3sat.de/f.png')).toEqual([
      'https://cdn.3sat.de/f.png',
      'https://www.3sat.de/apple-touch-icon.png',
      'https://www.3sat.de/favicon.ico',
    ])
    // No query string or path of the page is ever sent: only its site.
    expect(siteIconAddresses('https://openrouter.ai/activity?token=x')).toEqual([
      'https://openrouter.ai/apple-touch-icon.png',
      'https://openrouter.ai/favicon.ico',
    ])
  })

  it('offers no icon for a page or favicon it may not ask', () => {
    expect(siteIconAddresses('https://localhost/a')).toEqual([])
    expect(siteIconAddresses(undefined)).toEqual([])
    expect(siteIconAddresses('https://example.com', 'data:image/png;base64,AA')).toEqual([
      'https://example.com/apple-touch-icon.png',
      'https://example.com/favicon.ico',
    ])
    expect(
      siteIconAddresses('https://example.com', 'https://example.com/favicon.ico'),
    ).toHaveLength(2)
  })
})
