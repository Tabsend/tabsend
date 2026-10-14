/**
 * The two halves of pairing that aren't a network call: parsing what the user
 * pastes into the "join" field, and working out why a mint failed.
 *
 * Parse accepts a complete pairing link (`https://relay/pair#c=SECRET`, from
 * PAIRING_LINK in @tabsend/shared). The one-time secret rides in the URL
 * fragment so it never hits a server log [ADR-0009]. The relay address and
 * optional TLS pin remain inseparable from it on every user-facing surface.
 */

import { ApiClientError } from './api'
import type { PairingFailure } from './strings'

export interface ParsedPairing {
  /** Internal one-time secret extracted from the link for the register request. */
  code: string
  /** Relay origin carried by the complete link. */
  relayUrl: string
  /**
   * The relay's TLS cert fingerprint (`&fp=` in the fragment), when the link
   * carried one. Parsed but unused here: an extension has no say over TLS
   * validation, so it cannot pin — this field documents the link contract and
   * keeps the code intact when `fp` is present. Native clients do pin with it.
   */
  certFingerprint?: string
}

/**
 * Returns the link contents or null if the input is not a complete pairing link.
 * Accepts:
 *  - a full link: "https://relay.example/pair#c=ABC12345"
 *  - a link with a cert fingerprint: "https://192.168.1.20:8787/pair#c=ABC12345&fp=BASE64URL"
 *  - a link with a self-host base path: "https://host/tabsend/pair#c=ABC12345"
 * Unknown fragment params are ignored.
 */
export function parsePairingInput(input: string): ParsedPairing | null {
  const trimmed = input.trim()
  if (trimmed === '') return null

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const params = new URLSearchParams(url.hash.slice(1))
  const code = (params.get('c') ?? '').trim()
  if (code === '') return null
  const path = url.pathname.replace(/\/pair\/?$/, '').replace(/\/+$/, '')
  const fp = (params.get('fp') ?? '').trim()
  const browserRoute = parseRouteHint(params.get('browser'))
  const parsed: ParsedPairing = {
    code: code.toUpperCase(),
    relayUrl: browserRoute ?? legacyBrowserRoute(`${url.origin}${path}`, fp),
  }
  if (fp !== '') parsed.certFingerprint = fp
  return parsed
}

/** The route visibly presented by a link, before client-specific correction. */
export function pairingLinkRelayUrl(input: string): string | null {
  try {
    const url = new URL(input.trim())
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    const code = new URLSearchParams(url.hash.slice(1)).get('c')
    if (!code?.trim()) return null
    const path = url.pathname.replace(/\/pair\/?$/, '').replace(/\/+$/, '')
    return `${url.origin}${path}`
  } catch {
    return null
  }
}

/** Accept only a complete HTTP(S) base URL from a route hint. */
function parseRouteHint(raw: string | null): string | undefined {
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

/**
 * Compatibility with relays that predate explicit route hints. The fingerprint
 * identifies the self-signed setup, and only its documented default port pair
 * is rewritten. Hosted HTTPS and custom ports are left untouched.
 */
function legacyBrowserRoute(relayUrl: string, fingerprint: string): string {
  if (fingerprint === '') return relayUrl
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
 * Hostnames that only ever resolve back to the machine doing the resolving.
 * `0.0.0.0` isn't loopback strictly speaking, but a relay that describes itself
 * that way is an unconfigured dev relay — equally useless to a second device.
 */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0'])

/**
 * True when a relay URL can only be reached from this same machine.
 *
 * A pairing link carries the relay's own idea of its address, so an
 * unconfigured dev relay mints links that literally say `http://localhost:8787`.
 * The phone scans that, looks for a relay on the handset, and dead-ends with
 * nothing to explain why (dogfood 2026-07-27) — so the minting surface says it.
 *
 * Matches on the parsed HOSTNAME, never a substring of the whole URL:
 * `https://localhost.example.com` is a perfectly real public relay, and a
 * substring test would wrongly condemn it. Unparseable input is not our problem
 * to diagnose here, so it returns false.
 */
export function isLoopbackRelayUrl(relayUrl: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(relayUrl).hostname.toLowerCase())
  } catch {
    return false
  }
}

/**
 * Split a failed pairing mint into the cases the user can act on. A raw fetch
 * rejection (TypeError) means the relay never answered — by far the common one
 * when self-hosting, and the only one worth naming the URL for. Pair with
 * `pairingErrorLine` to turn the result into copy.
 */
export function classifyMintFailure(err: unknown, relayUrl: string): PairingFailure {
  if (!(err instanceof ApiClientError)) return { kind: 'unreachable', relayUrl }
  if (err.status === 401) return { kind: 'unauthorized' }
  return { kind: 'relay', detail: err.message }
}
