/**
 * Is this relay on a home-network address (PLANS.md P-15 item 4)?
 *
 * "Can't reach your relay at http://192.168.1.20:8786" was true, but read as a
 * refresh bug: the laptop was simply away from home, where that address means
 * nothing. When the address can only work on the network it lives on, the
 * relay-down notice adds `HOME_NETWORK_HINT`, which says why and what to do.
 *
 * Counted as home network:
 *   - IPv4 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16 (RFC 1918)
 *   - IPv4 link-local 169.254.0.0/16
 *   - IPv6 unique-local fc00::/7 and link-local fe80::/10
 *   - names under .local (mDNS), .lan, .home.arpa (RFC 8375) and .internal
 *
 * Never counted:
 *   - localhost and 127.0.0.0/8, ::1: the relay is on this same machine, so
 *     being away from home is not the reason it is silent.
 *   - 100.64.0.0/10 (Tailscale and carrier-grade NAT) and Tailscale's IPv6 range
 *     fd7a:115c:a1e0::/48, though the latter sits inside fc00::/7: a Tailscale
 *     address works from anywhere while Tailscale is on, so "only works on your
 *     home network" would be false. On a carrier network it is not a home LAN
 *     either.
 *   - a single-label name such as "minipc": with Tailscale's MagicDNS it works
 *     everywhere, and a hint that might be wrong is worse than none.
 *   - every public address and name, the hosted relay included.
 *
 * Pure, and mirrored by `HomeNetwork.kt` (Android) and `HomeNetwork.swift` (iOS).
 * All three run `shared/vectors/home-network.json`, so they cannot drift apart.
 */

/** The line added after the relay-down notice when `isHomeNetworkRelay` is true. */
export const HOME_NETWORK_HINT =
  'This address only works on your home network. Away from home or on mobile data? Connect to your home Wi-Fi or turn on your VPN.'

const HOME_SUFFIXES = ['.local', '.lan', '.home.arpa', '.internal']

/**
 * The host of an http(s) URL, lowercased, IPv6 without brackets. Read by hand,
 * like the Kotlin and Swift ports, so all three agree on odd input.
 */
function hostOf(url: string): string | undefined {
  const scheme = url.indexOf('://')
  if (scheme < 0) return undefined
  const rest = url.slice(scheme + 3)
  let authority = rest.split(/[/?#]/, 1)[0] ?? ''
  const at = authority.lastIndexOf('@')
  if (at >= 0) authority = authority.slice(at + 1)
  let host: string
  if (authority.startsWith('[')) {
    const end = authority.indexOf(']')
    if (end < 0) return undefined
    host = authority.slice(1, end)
  } else {
    const colon = authority.indexOf(':')
    host = colon >= 0 ? authority.slice(0, colon) : authority
  }
  host = host.toLowerCase().replace(/\.$/, '')
  return host === '' ? undefined : host
}

function ipv4Octets(host: string): number[] | undefined {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return undefined
  const octets = host.split('.').map(Number)
  return octets.every((o) => o <= 255) ? octets : undefined
}

function isHomeIpv4([a, b]: number[]): boolean {
  if (a === 10) return true
  if (a === 172 && b !== undefined && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 169 && b === 254) return true
  return false
}

/** The first three 16-bit groups of an IPv6 address, or undefined if it is not one. */
function ipv6Head(host: string): number[] | undefined {
  const bare = host.split('%', 1)[0] ?? ''
  if (!bare.includes(':') || !/^[0-9a-f:.]+$/.test(bare)) return undefined
  const halves = bare.split('::')
  if (halves.length > 2) return undefined
  const left = (halves[0] ?? '').split(':').filter((g) => g !== '')
  // With "::", the group straight after the left half is always zero.
  const groups = halves.length === 2 ? [...left, '0', '0', '0'] : left
  const head = groups.slice(0, 3).map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? Number.parseInt(g, 16) : Number.NaN))
  return head.length === 3 && head.every((g) => !Number.isNaN(g)) ? head : undefined
}

function isHomeIpv6([g0, g1, g2]: number[]): boolean {
  if (g0 === undefined) return false
  // Tailscale's own range, inside fc00::/7 but reachable from anywhere.
  if (g0 === 0xfd7a && g1 === 0x115c && g2 === 0xa1e0) return false
  if ((g0 & 0xfe00) === 0xfc00) return true // unique-local fc00::/7
  if ((g0 & 0xffc0) === 0xfe80) return true // link-local fe80::/10
  return false
}

/** True when `relayUrl` points at an address that only works on its own local network. */
export function isHomeNetworkRelay(relayUrl: string): boolean {
  const host = hostOf(relayUrl.trim())
  if (host === undefined) return false
  const v4 = ipv4Octets(host)
  if (v4) return isHomeIpv4(v4)
  const v6 = ipv6Head(host)
  if (v6) return isHomeIpv6(v6)
  if (host.includes(':')) return false
  return HOME_SUFFIXES.some((s) => host.endsWith(s) && host.length > s.length)
}
