import { afterEach, describe, expect, it, vi } from 'vitest'

const permission = vi.hoisted(() => vi.fn(async () => true))
vi.mock('./ext', () => ({ ext: { permissions: { contains: permission } } }))

import { loadPreview, parsePreview, previewUrl } from './link-preview'

describe('website previews', () => {
  it.each([
    'http://example.com',
    'https://127.0.0.1',
    'https://[::1]',
    'https://localhost',
    'https://printer.local',
    'https://user:pass@example.com',
    'file:///tmp/a',
    'https://example.com:8443',
  ])('does not automatically fetch %s', (raw) => {
    expect(previewUrl(raw)).toBeUndefined()
  })
  it('parses OG attributes in either order without executing page markup', () => {
    expect(
      parsePreview(
        `<script>alert(1)</script><meta content='A &amp; B' property='og:title'><meta name="description" content="Details"><meta property=og:image content="/cover.jpg">`,
        'https://example.com/article',
      ),
    ).toEqual({ title: 'A & B', description: 'Details', image: 'https://example.com/cover.jpg' })
  })
  it('keeps the text when the image URL is unsafe', () => {
    expect(
      parsePreview(
        '<title>Fallback</title><meta property="og:image" content="data:image/svg+xml,anything">',
        'https://example.com',
      ),
    ).toEqual({ title: 'Fallback' })
  })
  it('handles empty and malformed pages without a preview', () => {
    expect(parsePreview('<meta content="" property="og:title">', 'https://example.com')).toEqual({})
  })
  it('bounds website text and decodes numeric entities', () => {
    expect(
      parsePreview('<meta property="og:title" content="&#65; &#x42;">', 'https://example.com')
        .title,
    ).toBe('A B')
    expect(
      parsePreview(
        `<meta property="og:title" content="${'a'.repeat(2000)}">`,
        'https://example.com',
      ).title,
    ).toHaveLength(500)
  })
})

describe('preview requests', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    permission.mockResolvedValue(true)
  })
  it('omits credentials and referrers, and refuses implicit redirects', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response('<meta property="og:title" content="Website title">', {
          headers: { 'content-type': 'text/html' },
        }),
    )
    vi.stubGlobal('fetch', fetcher)
    expect(await loadPreview('https://example.com/request-policy')).toEqual({
      title: 'Website title',
    })
    expect(fetcher).toHaveBeenCalledWith(
      'https://example.com/request-policy',
      expect.objectContaining({
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        redirect: 'error',
      }),
    )
  })
  it('does not fetch a site without permission', async () => {
    permission.mockResolvedValue(false)
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    expect(await loadPreview('https://example.com/no-permission')).toEqual({})
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('keeps metadata when an image request fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('.png')) throw new Error('Offline image')
        return new Response(
          '<meta property="og:title" content="Still readable"><meta property="og:image" content="/broken.png">',
          { headers: { 'content-type': 'text/html' } },
        )
      }),
    )
    const result = await loadPreview('https://example.com/broken-image')
    expect(result.title).toBe('Still readable')
    expect(result.image).toBeUndefined()
  })
  it('rejects non-HTML responses without breaking the history page', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('secret data', { headers: { 'content-type': 'application/json' } }),
      ),
    )
    expect(await loadPreview('https://example.com/wrong-type')).toEqual({})
  })
})
