import { checkProtocol, type ServerConfigResponse } from '@tabsend/shared'

/**
 * Parse the complete pairing link pasted into the join field. The one-time
 * secret rides in the URL fragment so it never hits a server access log, while
 * the relay origin and optional trust pin travel with it.
 */

export interface ParsedPairing {
  /** Relay origin carried by the complete link. */
  relayUrl: string
  /** The short join code, normalised to upper-case. */
  code: string
  /**
   * The relay's TLS cert fingerprint (`&fp=` in the fragment), when the link
   * carried one. Parsed but unused: a web page has no say over TLS validation,
   * so it cannot pin — the field documents the link contract and keeps the code
   * intact when `fp` is present. Native clients do pin with it.
   */
  certFingerprint?: string
}

/**
 * Parse a pasted value. Returns null unless it is a complete HTTP(S) pairing link.
 */
export function parsePairingInput(raw: string): ParsedPairing | null {
  const input = raw.trim()
  if (input === '') return null

  if (/^https?:\/\//i.test(input)) {
    let url: URL
    try {
      url = new URL(input)
    } catch {
      return null
    }
    const frag = fragmentParams(url.hash)
    if (!frag) return null
    // Relay base = everything up to (not including) the `/pair` path segment. The
    // pairing link is `${relayUrl}/pair#c=...`, so strip a trailing `/pair`.
    const linkRelayUrl = `${url.origin}${url.pathname.replace(/\/pair\/?$/, '')}`.replace(/\/$/, '')
    const relayUrl =
      routeHint(url.hash, 'browser') ?? legacyBrowserRoute(linkRelayUrl, frag.certFingerprint)
    const parsed: ParsedPairing = {
      relayUrl: relayUrl === '' ? url.origin : relayUrl,
      code: frag.code,
    }
    if (frag.certFingerprint) parsed.certFingerprint = frag.certFingerprint
    return parsed
  }

  return null
}

/** The outer route shown by a link, before browser-specific correction. */
export function pairingLinkRelayUrl(raw: string): string | null {
  try {
    const url = new URL(raw.trim())
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    if (!fragmentParams(url.hash)) return null
    const relayUrl = `${url.origin}${url.pathname.replace(/\/pair\/?$/, '')}`.replace(/\/$/, '')
    return relayUrl === '' ? url.origin : relayUrl
  } catch {
    return null
  }
}

function routeHint(hash: string, name: string): string | undefined {
  const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash)
  const raw = params.get(name)
  if (!raw) return undefined
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    if (url.username || url.password || url.search || url.hash) return undefined
    return raw.replace(/\/$/, '')
  } catch {
    return undefined
  }
}

function legacyBrowserRoute(relayUrl: string, fingerprint?: string): string {
  if (!fingerprint) return relayUrl
  try {
    const url = new URL(relayUrl)
    if (url.protocol !== 'https:' || url.port !== '8787') return relayUrl
    url.protocol = 'http:'
    url.port = '8786'
    return url.toString().replace(/\/$/, '')
  } catch {
    return relayUrl
  }
}

/**
 * The fragment is `&`-separated params: `c` is the code (required), `fp` an
 * optional cert fingerprint; anything else is ignored (forward compatibility).
 */
function fragmentParams(hash: string): { code: string; certFingerprint?: string } | null {
  const frag = hash.startsWith('#') ? hash.slice(1) : hash
  if (frag === '') return null
  const params = new URLSearchParams(frag)
  const c = params.get('c')
  if (!c || c.trim() === '') return null
  const fp = (params.get('fp') ?? '').trim()
  return fp === ''
    ? { code: c.trim().toUpperCase() }
    : { code: c.trim().toUpperCase(), certFingerprint: fp }
}

/**
 * Hostnames that only ever resolve back to the machine doing the resolving.
 * `0.0.0.0` isn't loopback strictly speaking, but a relay describing itself that
 * way is an unconfigured dev relay — equally useless to a second device.
 */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0'])

/**
 * True when a relay URL can only be reached from this same machine.
 *
 * A pairing link carries the relay's own idea of its address, so an unconfigured
 * dev relay mints links that literally say `http://localhost:8787`. The phone
 * scans that, looks for a relay on the handset, and dead-ends with nothing to
 * explain why (dogfood 2026-07-27) — so the minting surface says it up front.
 *
 * Matches on the parsed HOSTNAME, never a substring of the whole URL:
 * `https://localhost.example.com` is a perfectly real public relay, and a
 * substring test would wrongly condemn it. Unparseable input returns false.
 *
 * Mirrors extension/src/lib/pairing.ts.
 */
export function isLoopbackRelayUrl(relayUrl: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(relayUrl).hostname.toLowerCase())
  } catch {
    return false
  }
}

/**
 * Returns user-ready copy when a relay cannot provide the pairing flow this
 * console uses. Keeping this small and pure lets onboarding reject a stale,
 * reachable relay before its register request obscures the actual problem.
 */
export function protocolMismatchMessage(config: ServerConfigResponse): string | null {
  const check = checkProtocol(config)
  if (check.ok) return null
  return check.stale === 'client'
    ? `This version of Tabsend is too old for that relay (console speaks v${check.clientProtocol}, relay needs v${check.relayRequires}). Update the console, then try again.`
    : `That relay is running an older version of Tabsend than this console (relay speaks v${check.relayProtocol}, console needs v${check.clientRequires}). Update the relay, then try again.`
}
