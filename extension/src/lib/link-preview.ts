/**
 * The picture beside a history row (docs/HISTORY_PREVIEWS_PLAN.md).
 *
 * An extension page needs host access to READ another site, which is a prompt per site
 * or a warning about all of them. It needs none to SHOW an image. So the device that
 * sent the tab finds the picture and passes its address inside the sealed payload, and
 * this page only ever shows it. Nothing here reads a page: the history page only
 * shows images (the picture, or the site's icon when there is none).
 */

const MAX_IMAGE_ADDRESS = 2048

/** HTTPS website names only (no literal IPs or local-only names). */
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

/**
 * The address a payload may carry or a row may show, or undefined. Applied by the
 * sender and again by the viewer: `image` comes from a sealed blob any key holder can
 * write, so it is checked like any other address from outside.
 */
export function pictureAddress(raw: unknown, base?: string): string | undefined {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_IMAGE_ADDRESS)
    return undefined
  try {
    const href = previewUrl(new URL(raw, base).href)?.href
    return href && href.length <= MAX_IMAGE_ADDRESS ? href : undefined
  } catch {
    return undefined
  }
}

/**
 * Where the site's own icon may be, best first, for a row with no picture (or one whose
 * picture fails). Most pages a person sends offer no preview picture to a visitor who is
 * not signed in, and a tile of letters made the pictures look broken (owner, 2026-11-06).
 * The tab's favicon as the sender saw it, then the two places nearly every site keeps
 * one. Only the link's own site and the favicon's host are ever asked, and only while
 * Website images is on; the caller tries the next one when an address fails.
 */
export function siteIconAddresses(pageUrl: string | undefined, favicon?: unknown): string[] {
  const page = pageUrl ? previewUrl(pageUrl) : undefined
  if (!page) return []
  const found = [
    pictureAddress(favicon),
    `${page.origin}/apple-touch-icon.png`,
    `${page.origin}/favicon.ico`,
  ].filter((address): address is string => address !== undefined)
  return [...new Set(found)]
}

/** The tile's stand-in for a row with no picture: the site's first letter. */
export function siteLetter(url: string | undefined): string {
  if (!url) return '?'
  try {
    const host = new URL(url).hostname.replace(/^www\./i, '')
    return (host[0] ?? '?').toUpperCase()
  } catch {
    return '?'
  }
}
