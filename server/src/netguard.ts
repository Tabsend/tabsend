/**
 * Is this client address on a private network? (Guard for the cleartext listener.)
 *
 * The cleartext HTTP_PORT listener carries device tokens in the clear, so it is only
 * ever meant for a LAN. Nothing about the listener enforces that on its own: it binds
 * every interface, exactly like the https one, and would serve the open internet
 * perfectly happily if a router forwarded it. The realistic accident is forwarding a
 * RANGE of ports for the phone's https port and dragging this one along — silently,
 * since everything keeps working. Leaked tokens cannot be un-leaked, so the listener
 * refuses public clients rather than trusting the router to be configured correctly.
 *
 * This narrows an accident; it is NOT encryption. Anyone already on the LAN can still
 * read a token off the wire. The domain deployment (docs/DEPLOY.md) is the real answer.
 */

/** Strip a zone index and normalise case, the shape both guards below want. */
function normalise(address: string): string {
  const addr = address.trim().toLowerCase()
  const zone = addr.indexOf('%')
  return zone === -1 ? addr : addr.slice(0, zone)
}

/** Parse a dotted-quad into four octets, or undefined if it isn't one. */
function ipv4Octets(address: string): [number, number, number, number] | undefined {
  const parts = address.split('.')
  if (parts.length !== 4) return undefined
  const octets: number[] = []
  for (const part of parts) {
    // Reject empty, non-numeric, and out-of-range; also reject "01"-style padding so
    // an address can't be smuggled past in an unusual spelling.
    if (!/^\d{1,3}$/.test(part)) return undefined
    if (part.length > 1 && part.startsWith('0')) return undefined
    const n = Number(part)
    if (n > 255) return undefined
    octets.push(n)
  }
  return octets as [number, number, number, number]
}

function isPrivateIPv4(address: string): boolean {
  const octets = ipv4Octets(address)
  if (!octets) return false
  const [a, b] = octets
  if (a === 127) return true // loopback        127.0.0.0/8
  if (a === 10) return true // RFC1918          10.0.0.0/8
  if (a === 192 && b === 168) return true // RFC1918  192.168.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return true // RFC1918  172.16.0.0/12
  if (a === 169 && b === 254) return true // link-local  169.254.0.0/16
  // 100.64.0.0/10 — "carrier-grade NAT" space, which is also what mesh VPNs such as
  // Tailscale hand out. Not RFC1918, but never routable on the public internet, and
  // omitting it would block a legitimate VPN client (see docs/DEPLOY.md).
  if (a === 100 && b >= 64 && b <= 127) return true
  return false
}

/**
 * True when `address` is a private/local client the cleartext port may serve.
 *
 * IPv6 note: a home network can hand every device a GLOBALLY ROUTABLE address, so a
 * laptop sitting beside the relay may legitimately look "public" here and be refused.
 * That is the intended trade — the alternative is a guard that lets the internet in —
 * but it is why HTTP_ALLOW_PUBLIC exists as an escape hatch. Pairing against a literal
 * `192.168.x.x` URL (what the docs tell you to do) keeps the connection on IPv4 and
 * sidesteps this entirely.
 */
export function isPrivateAddress(address: string | undefined): boolean {
  if (!address) return false // unknown peer: refuse, don't guess
  const addr = normalise(address)
  if (addr === '') return false

  // Node reports IPv4 peers on a dual-stack socket as ::ffff:192.168.1.5. Unwrap to
  // the IPv4 address so those are judged by the IPv4 rules, not the IPv6 ones.
  if (addr.startsWith('::ffff:')) {
    const mapped = addr.slice('::ffff:'.length)
    if (ipv4Octets(mapped)) return isPrivateIPv4(mapped)
  }

  if (ipv4Octets(addr)) return isPrivateIPv4(addr)

  if (addr === '::1') return true // IPv6 loopback
  // fe80::/10 link-local. The /10 covers the fe80–febf prefixes.
  if (/^fe[89ab][0-9a-f]:/.test(addr)) return true
  // fc00::/7 unique local (the IPv6 counterpart of RFC1918): fc00–fdff.
  if (/^f[cd][0-9a-f]{2}:/.test(addr)) return true

  return false
}

/**
 * True only for the machine talking to ITSELF — 127.0.0.0/8 or ::1.
 *
 * Deliberately much narrower than {@link isPrivateAddress}: this is the gate on the
 * ops status route (routes/status.ts), whose body names paired devices and their
 * activity. "Private network" would hand that to anyone on the wifi, including a
 * guest. Loopback means a process already running on the relay's own host, which is
 * a caller that could read the database directly anyway — so the route grants nothing
 * it did not already have.
 *
 * Under `network_mode: host` (docker-compose.lan.yml) the container shares the host's
 * network namespace, so a `docker exec` call to 127.0.0.1 lands here. Under bridge
 * networking a call from the HOST arrives from the bridge gateway (172.x) and is
 * refused — which is why scripts/relay-doctor.sh always asks from inside the
 * container rather than from the host.
 */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false
  const addr = normalise(address)
  if (addr === '') return false

  if (addr === '::1') return true

  const mapped = addr.startsWith('::ffff:') ? addr.slice('::ffff:'.length) : addr
  const octets = ipv4Octets(mapped)
  return octets !== undefined && octets[0] === 127
}

/**
 * Headers that prove a request was relayed by something rather than dialled directly.
 * Any one of them means the socket peer is a proxy, not the original caller — so a
 * loopback peer stops being evidence that the caller is on this host.
 */
const FORWARDING_HEADERS = [
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
  'forwarded',
] as const

/**
 * True only for a request dialled straight at this process from this machine — the
 * locality rule behind every `/admin/*` surface (routes/status.ts, and since [0031]
 * routes/provisioning.ts, which requires a bearer credential ON TOP of this).
 *
 * ONE implementation on purpose. Two copies of this test would be two chances to fix
 * one and forget the other, on the guard that decides whether an operator-only route
 * is reachable from the internet.
 *
 * The proxy half is not belt-and-braces, it is load-bearing. docs/DEPLOY.md recommends
 * running the relay bare-metal on 127.0.0.1 with Caddy in front ON THE SAME HOST; every
 * proxied request then arrives with socket peer 127.0.0.1, so a loopback check alone
 * would publish these routes to the internet. `trustProxy` cannot be the signal either:
 * it is on in exactly those deploys, but also in the domain compose file, where the
 * diagnostics must keep working. A forwarding header is the honest evidence — every
 * reverse proxy sets one, and a direct `docker exec` call sets none.
 */
export function isDirectLocalCall(request: {
  socket: { remoteAddress?: string | undefined }
  headers: Record<string, unknown>
}): boolean {
  // The SOCKET peer, never `request.ip`: with trustProxy on, request.ip is read from
  // the X-Forwarded-For header, which the client writes. A guard reading that could be
  // walked through by anyone claiming to be 127.0.0.1.
  if (!isLoopbackAddress(request.socket.remoteAddress)) return false
  return !FORWARDING_HEADERS.some((header) => request.headers[header] !== undefined)
}
