import { ext } from './ext'

export interface LinkPreview {
  title?: string
  description?: string
  image?: string
  imageSource?: string
}
const cache = new Map<string, Promise<LinkPreview>>()
let active = 0
const waiting: (() => void)[] = []
async function acquire(): Promise<void> {
  if (active >= 3) await new Promise<void>((resolve) => waiting.push(resolve))
  else active++
}
function release(): void {
  const next = waiting.shift()
  if (next) next()
  else active--
}

/** HTTPS website names only (no literal IPs or local-only names). Never send history URLs to a relay or a preview service. */
export function previewUrl(raw: string): URL | undefined {
  try {
    const url = new URL(raw)
    const host = url.hostname.toLowerCase()
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      !host.includes('.') ||
      /(^|\.)(localhost|local|internal|test|invalid)$/.test(host) ||
      /^[\d.]+$/.test(host) ||
      host.includes(':')
    )
      return undefined
    return url
  } catch {
    return undefined
  }
}

export function parsePreview(html: string, base: string): LinkPreview {
  const entities: Record<string, string> = {
    amp: '&',
    quot: '"',
    apos: "'",
    lt: '<',
    gt: '>',
    nbsp: ' ',
  }
  const decode = (value: string) =>
    value.replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (all, key: string) => {
      if (!key.startsWith('#')) return entities[key.toLowerCase()] ?? all
      const code =
        key[1]?.toLowerCase() === 'x' ? Number.parseInt(key.slice(2), 16) : Number(key.slice(1))
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all
    })
  const values = new Map<string, string>()
  for (const tag of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = new Map<string, string>()
    for (const attr of tag[0].matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
      attrs.set((attr[1] ?? '').toLowerCase(), attr[2] ?? attr[3] ?? attr[4] ?? '')
    }
    const key = (attrs.get('property') ?? attrs.get('name'))?.toLowerCase()
    const value = attrs.get('content')
    if (key && value && !values.has(key)) values.set(key, decode(value).trim().slice(0, 500))
  }
  const result: LinkPreview = {}
  const title =
    values.get('og:title') ||
    decode(html.match(/<title\b[^>]*>([^<]*)<\/title>/i)?.[1] ?? '')
      .trim()
      .slice(0, 500)
  const description = values.get('og:description') || values.get('description')
  if (title) result.title = title
  if (description) result.description = description
  try {
    const image = values.get('og:image')
    if (image) {
      const resolved = previewUrl(new URL(image, base).href)
      if (resolved) result.image = resolved.href
    }
  } catch {
    /* Invalid image leaves the text preview intact. */
  }
  return result
}

export async function hasPreviewPermission(url: URL): Promise<boolean> {
  return ext.permissions.contains({ origins: [`${url.origin}/*`] })
}

async function boundedFetch(url: string, image: boolean): Promise<Blob> {
  const response = await fetch(url, {
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    redirect: 'error',
    signal: AbortSignal.timeout(8000),
    cache: 'no-store',
  })
  const type = response.headers.get('content-type') ?? ''
  if (!response.ok || !(image ? /^image\/(png|jpeg|webp|gif)/i : /text\/html/i).test(type))
    throw Error('Unsupported preview')
  const reader = response.body?.getReader()
  if (!reader) throw Error('Empty preview')
  const chunks: Uint8Array<ArrayBuffer>[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > (image ? 2_000_000 : 512_000)) {
        if (image) throw Error('Preview too large')
        break
      }
      chunks.push(value as Uint8Array<ArrayBuffer>)
      if (!image && /<\/head\s*>/i.test(new TextDecoder().decode(value))) break
    }
  } finally {
    await reader.cancel()
  }
  return new Blob(chunks, { type })
}

export function loadPreview(raw: string): Promise<LinkPreview> {
  const existing = cache.get(raw)
  if (existing) return existing
  const pending = (async () => {
    const url = previewUrl(raw)
    if (!url || !(await hasPreviewPermission(url))) return {}
    await acquire()
    try {
      const result = parsePreview(await (await boundedFetch(url.href, false)).text(), url.href)
      const image = result.image && previewUrl(result.image)
      delete result.image
      if (image) result.imageSource = image.href
      if (image && (await hasPreviewPermission(image))) {
        try {
          result.image = URL.createObjectURL(await boundedFetch(image.href, true))
        } catch {
          /* Text remains usable. */
        }
      }
      return result
    } finally {
      release()
    }
  })().catch(() => ({}))
  if (cache.size >= 100) {
    // Cached blob URLs live only for this history page; release on eviction.
    const first = cache.keys().next().value
    if (first) {
      void cache.get(first)?.then((p) => {
        if (p.image) URL.revokeObjectURL(p.image)
      })
      cache.delete(first)
    }
  }
  cache.set(raw, pending)
  return pending
}

/** An image on a separate host gets its own explicit site permission. */
export async function loadPreviewImage(raw: string): Promise<string | undefined> {
  const url = previewUrl(raw)
  if (!url || !(await hasPreviewPermission(url))) return undefined
  await acquire()
  try {
    return URL.createObjectURL(await boundedFetch(url.href, true))
  } catch {
    return undefined
  } finally {
    release()
  }
}
