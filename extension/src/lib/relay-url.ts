import { t } from './i18n'

/**
 * Turn the kinds of relay addresses people naturally paste into one API base
 * URL. The relay itself has no reason to care about a final slash, but the
 * extension must not turn a missing scheme into an opaque fetch failure.
 */

export class RelayUrlError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RelayUrlError'
  }
}

function defaultProtocol(value: string): 'http:' | 'https:' {
  // A bare LAN address is overwhelmingly a local, cleartext relay. A hostname
  // with a public-looking name defaults to HTTPS, which is the safe convention
  // for a domain deployment. Explicit schemes always win.
  const authority = value.split(/[/?#]/, 1)[0]?.toLowerCase() ?? ''
  if (authority.startsWith('[')) return 'http:'
  const host = authority.replace(/:\d+$/, '')
  if (
    host === 'localhost' ||
    /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) ||
    host.endsWith('.local') ||
    !host.includes('.')
  ) {
    return 'http:'
  }
  return 'https:'
}

/**
 * Normalize a relay base address. Accepts a copied address with or without a
 * scheme, a trailing slash, or a `/pair` suffix from a pairing link.
 */
export function normalizeRelayUrl(input: string): string {
  const trimmed = input.trim()
  if (trimmed === '') throw new RelayUrlError(t('errors.relayUrl.empty'))

  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `${defaultProtocol(trimmed)}//${trimmed}`

  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    throw new RelayUrlError(t('errors.relayUrl.invalid'))
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new RelayUrlError(t('errors.relayUrl.scheme'))
  }
  if (parsed.username || parsed.password) {
    throw new RelayUrlError(t('errors.relayUrl.credentials'))
  }
  if (parsed.search) {
    throw new RelayUrlError(t('errors.relayUrl.query'))
  }

  // A full pairing link is also a useful thing to paste. Its fragment is not
  // part of the relay address, and `/pair` is the route the relay exposes on
  // top of its base (including when it is reverse-proxied under a base path).
  const path = parsed.pathname.replace(/\/pair\/?$/, '').replace(/\/+$/, '')
  return `${parsed.protocol}//${parsed.host}${path}`
}

/** A precise, actionable note for the common self-signed LAN relay mismatch. */
export function browserTlsHint(relayUrl: string): string | undefined {
  try {
    const parsed = new URL(relayUrl)
    const host = parsed.hostname.toLowerCase()
    const isPrivateIpv4 = /^(10|127)\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(host)
    if (
      parsed.protocol !== 'https:' ||
      !(isPrivateIpv4 || host === 'localhost' || host.endsWith('.local'))
    )
      return undefined
    return t('errors.relayUrl.selfSigned')
  } catch {
    return undefined
  }
}
