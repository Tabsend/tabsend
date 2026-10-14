import { createHash, createPublicKey, X509Certificate } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { type NetworkInterfaceInfo, networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { generate } from 'selfsigned'

/**
 * Self-signed TLS for direct LAN exposure (P-3, opt-in via TLS_SELF_SIGNED).
 *
 * The cert is NOT meant to satisfy normal CA validation — the pairing channel is
 * the out-of-band trust anchor: the QR/link carries the cert's SPKI fingerprint
 * and the joining device pins exactly that key, SSH-fingerprint style. Hence the
 * cert is generated ONCE and reused for 10 years: rotating it would invalidate
 * every pin, i.e. every paired device.
 */

export interface TlsMaterial {
  keyPem: string
  certPem: string
  /**
   * True only on the boot that minted the cert. A reused cert has SANs frozen at
   * whatever the machine looked like that day, so boot re-checks that it still
   * covers the address clients are told to use.
   */
  generated: boolean
}

const TEN_YEARS_MS = 10 * 365 * 24 * 60 * 60 * 1000

const IPV4_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/

const RFC1918_RE = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/
/** 100.64/10 — the CGNAT range mesh VPNs (Tailscale et al.) hand out. */
const CGNAT_RE = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./
const LINK_LOCAL_RE = /^169\.254\./

/**
 * Interfaces created by software rather than plugged into a network. Docker
 * bridges are the ones that actually bite here — a machine running this relay
 * runs Docker by definition, so `docker0` plus a `br-<hash>` per compose project
 * are always present and always carry a routable-looking RFC1918 address that
 * nothing off the machine can reach.
 *
 * Deliberately NOT matching bare `br0`/`bond0`: on a hypervisor host those are
 * usually the real LAN interface. `virbr` (libvirt) and `br-` (docker) are.
 */
const VIRTUAL_IFACE_RE =
  /^(docker|br-|virbr|veth|vmnet|vnet|tun|tap|utun|wg|tailscale|zt|cni|flannel|kube|podman|cali)/i

export interface Ipv4Candidate {
  address: string
  iface: string
  /** Lower is better — see `rankIPv4`. */
  rank: number
}

/**
 * How good an address is as "the one a phone on this network should connect to".
 * Lower wins.
 */
function rankIPv4(iface: string, address: string): number {
  const virtual = VIRTUAL_IFACE_RE.test(iface)
  if (!virtual) {
    if (RFC1918_RE.test(address)) return 0 // a real NIC on a real LAN — what we want
    if (!LINK_LOCAL_RE.test(address)) return 1 // globally routable on a real NIC
    return 2 // 169.254 self-assigned: the NIC never got a lease
  }
  if (CGNAT_RE.test(address)) return 3 // mesh VPN: reachable, but not from the LAN
  return 4 // docker0/virbr0/br-…: unreachable from anywhere but this host
}

/**
 * Every non-internal IPv4 of this host, best serving address first.
 *
 * Sorting is stable within a rank, so same-rank addresses keep the order the OS
 * reported — there is no further signal to prefer one over another, and a stable
 * answer across boots matters more than a clever one.
 */
export function lanIPv4Candidates(
  ifaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
): Ipv4Candidate[] {
  const out: Ipv4Candidate[] = []
  for (const [iface, addrs] of Object.entries(ifaces)) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) {
        out.push({ address: a.address, iface, rank: rankIPv4(iface, a.address) })
      }
    }
  }
  return out.sort((a, b) => a.rank - b.rank)
}

/** Every non-internal IPv4 address of this host (all of them go in the cert's SANs). */
export function externalIPv4s(): string[] {
  return lanIPv4Candidates().map((c) => c.address)
}

/**
 * Does `cert` cover `host`, i.e. would a client told to connect there accept it?
 *
 * IPv6 literals always answer true: the cert prints them in a normalized form
 * that is fiddly to compare, and a false "your cert is wrong" warning is worse
 * than a missed one. Only ever used to warn, never to gate.
 */
export function certCoversHost(certPem: string, host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, '')
  if (bare.includes(':')) return true // IPv6 — see above
  const sans = (new X509Certificate(certPem).subjectAltName ?? '').split(',').map((s) => s.trim())
  const want = IPV4_RE.test(bare) ? `IP Address:${bare}` : `DNS:${bare}`
  return sans.some((san) => san.toLowerCase() === want.toLowerCase())
}

/**
 * Load the key/cert pair from `tlsDir`, generating it on the very first boot.
 * Once both files exist they are reused verbatim — never regenerated, because
 * paired devices pin this exact key (see module doc).
 */
export async function ensureSelfSignedCert(
  tlsDir: string,
  extraSans: string[] = [],
): Promise<TlsMaterial> {
  const keyPath = join(tlsDir, 'key.pem')
  const certPath = join(tlsDir, 'cert.pem')
  if (existsSync(keyPath) && existsSync(certPath)) {
    return {
      keyPem: readFileSync(keyPath, 'utf8'),
      certPem: readFileSync(certPath, 'utf8'),
      generated: false,
    }
  }

  // SANs: loopback + every current LAN IPv4 + operator extras. IPs go in as
  // type 7 (iPAddress), names as type 2 (dNSName).
  const sans = new Set<string>(['localhost', '127.0.0.1', ...externalIPv4s(), ...extraSans])
  const altNames = [...sans].map((san) =>
    IPV4_RE.test(san) ? ({ type: 7, ip: san } as const) : ({ type: 2, value: san } as const),
  )

  const now = new Date()
  const pems = await generate([{ name: 'commonName', value: 'tabsend-relay' }], {
    algorithm: 'sha256',
    keySize: 2048,
    notBeforeDate: now,
    notAfterDate: new Date(now.getTime() + TEN_YEARS_MS),
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames: [...altNames] },
    ],
  })

  mkdirSync(tlsDir, { recursive: true })
  writeFileSync(keyPath, pems.private, { mode: 0o600 }) // private key: owner-only
  writeFileSync(certPath, pems.cert)
  return { keyPem: pems.private, certPem: pems.cert, generated: true }
}

/**
 * The pin clients carry: base64url( SHA-256( SPKI DER ) ) of the cert's public
 * key. Same bytes OkHttp pins (`sha256/<base64>`), just base64url-encoded and
 * unprefixed — link/QR-safe without escaping.
 */
export function spkiFingerprint(certPem: string): string {
  const spkiDer = createPublicKey(certPem).export({ type: 'spki', format: 'der' })
  return createHash('sha256').update(spkiDer).digest('base64url')
}
