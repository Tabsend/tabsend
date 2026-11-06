import { describe, expect, it } from 'vitest'
import { pictureAddress, previewUrl, siteLetter } from './link-preview'

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
})
