import { beforeEach, describe, expect, it, vi } from 'vitest'
import { findPagePicture, forgetPagePictures, mayReadPage, pictureFromHtml } from './page-picture'

const page = (html: string, init: { url?: string; type?: string; status?: number } = {}) => {
  const response = new Response(html, {
    status: init.status ?? 200,
    headers: { 'content-type': init.type ?? 'text/html; charset=utf-8' },
  })
  Object.defineProperty(response, 'url', { value: init.url ?? '' })
  return response
}

describe('page pictures from this browser', () => {
  beforeEach(() => forgetPagePictures())

  it('never asks a page with a query string or fragment, or one that is not a website', () => {
    expect(mayReadPage('https://example.com/article')).toBe(true)
    for (const url of [
      'https://example.com/confirm?token=abc',
      'https://example.com/a#b',
      'http://example.com/a',
      'https://localhost/a',
      'https://192.168.1.2/a',
      undefined,
    ])
      expect(mayReadPage(url)).toBe(false)
  })

  it('reads og:image, then twitter:image, in any attribute order', () => {
    expect(
      pictureFromHtml(
        `<meta content='/cover.jpg?a=1&amp;b=2' property=og:image><meta name="twitter:image" content="https://x.com/t.png">`,
        'https://example.com/a/b',
      ),
    ).toBe('https://example.com/cover.jpg?a=1&b=2')
    expect(
      pictureFromHtml('<meta name="twitter:image" content="https://x.com/t.png">', 'https://e.com'),
    ).toBe('https://x.com/t.png')
    expect(
      pictureFromHtml('<meta property="og:image" content="http://e.com/a.png">', 'https://e.com'),
    ).toBe(undefined)
  })

  it('asks without cookies, once per page, and gives up quietly', async () => {
    const request = vi.fn(async (_url: string, _init?: RequestInit) =>
      page('<head><meta property="og:image" content="/p.png"></head>'),
    )
    const url = 'https://example.com/story'
    expect(await findPagePicture(url, request as typeof fetch)).toBe('https://example.com/p.png')
    expect(await findPagePicture(url, request as typeof fetch)).toBe('https://example.com/p.png')
    expect(request).toHaveBeenCalledTimes(1)
    expect(request.mock.calls[0]?.[1]).toMatchObject({ credentials: 'omit' })

    const failing = vi.fn(async () => {
      throw new Error('offline')
    })
    expect(await findPagePicture('https://example.org/', failing as typeof fetch)).toBeUndefined()
    const notHtml = vi.fn(async () => page('{}', { type: 'application/json' }))
    expect(await findPagePicture('https://example.net/', notHtml as typeof fetch)).toBeUndefined()
    const toLocal = vi.fn(async () =>
      page('<meta property="og:image" content="/p.png">', { url: 'https://printer.local/' }),
    )
    expect(await findPagePicture('https://example.info/', toLocal as typeof fetch)).toBeUndefined()
  })

  it('makes no request for a page it may not ask', async () => {
    const request = vi.fn()
    expect(
      await findPagePicture('https://example.com/a?token=1', request as typeof fetch),
    ).toBeUndefined()
    expect(request).not.toHaveBeenCalled()
  })
})
