/**
 * Finding a page's picture from this browser, for a History row that arrived without one
 * (owner, 2026-11-09). Only after the person turned it on: the History card or Settings
 * asks the browser for page access, and Website images must be on.
 *
 * The same rules the phones keep (docs/HISTORY_PREVIEWS_PLAN.md): an HTTPS website name,
 * never a page with a query string or a fragment (HP3: one-time tokens live there), no
 * cookies or credentials, bounded in size and time, three at a time, and the page's text
 * is only searched for its picture address, never run or shown.
 */

import { pictureAddress, previewUrl } from './link-preview'

const MAX_PAGE_BYTES = 512_000
const WAIT_MS = 8_000
const AT_ONCE = 3

/** Whether this browser may ask the page itself. */
export function mayReadPage(raw: string | undefined): boolean {
  if (!raw || raw.includes('?') || raw.includes('#')) return false
  return previewUrl(raw) !== undefined
}

/**
 * The picture address a page names (`og:image`, then `twitter:image`), resolved against
 * the page and checked like any other. Attribute order and quotes vary between sites.
 */
export function pictureFromHtml(html: string, pageUrl: string): string | undefined {
  const head = html.slice(0, MAX_PAGE_BYTES)
  const found: Record<string, string> = {}
  for (const tag of head.match(/<meta\b[^>]{0,4000}>/gi) ?? []) {
    const attrs: Record<string, string> = {}
    for (const m of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
      const name = m[1]?.toLowerCase()
      if (name) attrs[name] = m[2] ?? m[3] ?? m[4] ?? ''
    }
    const key = (attrs.property ?? attrs.name)?.toLowerCase()
    if (key && attrs.content && !(key in found)) found[key] = decode(attrs.content)
  }
  for (const key of ['og:image', 'twitter:image']) {
    const address = pictureAddress(found[key]?.trim(), pageUrl)
    if (address) return address
  }
  return undefined
}

function decode(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}

/** Reads the start of a page: up to the end of its head, or the size cap. */
async function readHead(response: Response): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ''
  const decoder = new TextDecoder()
  let text = ''
  try {
    while (text.length < MAX_PAGE_BYTES) {
      const { done, value } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
      if (/<\/head>/i.test(text.slice(-20_000))) break
    }
  } finally {
    void reader.cancel().catch(() => undefined)
  }
  return text
}

const found = new Map<string, Promise<string | undefined>>()
let running = 0
const waiting: (() => void)[] = []

async function slot<T>(work: () => Promise<T>): Promise<T> {
  if (running >= AT_ONCE) await new Promise<void>((go) => waiting.push(go))
  running += 1
  try {
    return await work()
  } finally {
    running -= 1
    waiting.shift()?.()
  }
}

/**
 * The page's picture address, or undefined. Never throws; asks each page once per
 * History page load. `request` is `fetch`, swappable for tests.
 */
export function findPagePicture(
  pageUrl: string,
  request: typeof fetch = fetch,
): Promise<string | undefined> {
  if (!mayReadPage(pageUrl)) return Promise.resolve(undefined)
  const known = found.get(pageUrl)
  if (known) return known
  const lookup = slot(async () => {
    const stop = new AbortController()
    const timer = setTimeout(() => stop.abort(), WAIT_MS)
    try {
      const response = await request(pageUrl, {
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        cache: 'force-cache',
        headers: { Accept: 'text/html' },
        signal: stop.signal,
      })
      const type = response.headers.get('content-type') ?? ''
      // Redirects are followed by the browser; where they end must still be a website.
      if (!response.ok || !type.startsWith('text/html') || !previewUrl(response.url || pageUrl))
        return undefined
      return pictureFromHtml(await readHead(response), response.url || pageUrl)
    } catch {
      return undefined
    } finally {
      clearTimeout(timer)
    }
  })
  found.set(pageUrl, lookup)
  return lookup
}

/** Forget what was found (tests). */
export function forgetPagePictures(): void {
  found.clear()
}
