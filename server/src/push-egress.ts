import type { LookupAddress, LookupOptions } from 'node:dns'
import { lookup } from 'node:dns'
import { Agent } from 'node:https'
import { BlockList, isIP } from 'node:net'
import { AppError } from './errors'

/** Addresses that must never be reachable through a client-supplied push URL. */
// Keep families separate: Node's BlockList deliberately checks IPv4 values as
// IPv4-mapped IPv6 too, so putting ::ffff:0:0/96 in one combined list would make
// every ordinary IPv4 address appear blocked.
const nonPublicV4 = new BlockList()
const nonPublicV6 = new BlockList()

for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  nonPublicV4.addSubnet(network, prefix, 'ipv4')
}

for (const [network, prefix] of [
  ['::', 96],
  ['::1', 128],
  ['::ffff:0:0', 96],
  // IPv6 transition/translation prefixes can encode an IPv4 destination. A
  // literal such as 64:ff9b::a9fe:a9fe could otherwise reach 169.254.169.254
  // through a NAT64 gateway even though the IPv6 spelling looks public here.
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 32],
  ['2001:2::', 48],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  nonPublicV6.addSubnet(network, prefix, 'ipv6')
}

/** True only for globally routable unicast addresses suitable for hosted egress. */
export function isPublicPushAddress(address: string): boolean {
  const normalized = address.toLowerCase().split('%', 1)[0] ?? ''
  const family = isIP(normalized)
  if (family === 4) return !nonPublicV4.check(normalized, 'ipv4')
  if (family !== 6) return false

  // IPv4-mapped/compatible IPv6 is denied as a class above. Normal DNS returns
  // IPv4 answers as family 4; accepting alternate literal spellings only creates
  // parser-differential risk.
  return !nonPublicV6.check(normalized, 'ipv6')
}

/** Syntactic policy at registration; DNS is re-checked at connection time below. */
export function validatePushEndpoint(endpoint: string, allowPrivateEndpoints = false): URL {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    throw new AppError('invalid_request', 'Push endpoint must be a valid absolute URL.')
  }
  if (url.protocol !== 'https:') {
    throw new AppError('invalid_request', 'Push endpoint must use https.')
  }
  if (url.username || url.password) {
    throw new AppError('invalid_request', 'Push endpoint must not contain credentials.')
  }
  if (url.hash) {
    throw new AppError('invalid_request', 'Push endpoint must not contain a fragment.')
  }

  if (!allowPrivateEndpoints) {
    const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
    if (
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname.endsWith('.local') ||
      hostname.endsWith('.internal') ||
      hostname.endsWith('.home.arpa')
    ) {
      throw new AppError('invalid_request', 'Push endpoint must use a public destination.')
    }
    if (isIP(hostname) !== 0 && !isPublicPushAddress(hostname)) {
      throw new AppError('invalid_request', 'Push endpoint must use a public destination.')
    }
  }
  return url
}

function blockedResolutionError(): NodeJS.ErrnoException {
  const error = new Error('Push endpoint resolved to a non-public address') as NodeJS.ErrnoException
  error.code = 'EHOSTUNREACH'
  return error
}

/**
 * Resolve all answers at the exact moment the TLS socket connects and reject the
 * whole destination if any answer is private/reserved. Passing this to the HTTPS
 * agent closes the validation/connection DNS-rebinding gap.
 */
export function publicOnlyLookup(
  hostname: string,
  options: LookupOptions,
  callback: (
    err: NodeJS.ErrnoException | null,
    address: string | LookupAddress[],
    family?: number,
  ) => void,
): void {
  lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
    if (error) {
      callback(error, '')
      return
    }
    if (addresses.length === 0 || addresses.some((entry) => !isPublicPushAddress(entry.address))) {
      callback(blockedResolutionError(), '')
      return
    }

    const requestedFamily = options.family === 4 || options.family === 6 ? options.family : 0
    const eligible = requestedFamily
      ? addresses.filter((entry) => entry.family === requestedFamily)
      : addresses
    if (eligible.length === 0) {
      callback(blockedResolutionError(), '')
      return
    }
    if (options.all) {
      callback(null, eligible)
      return
    }
    const first = eligible[0]
    if (!first) {
      callback(blockedResolutionError(), '')
      return
    }
    callback(null, first.address, first.family)
  })
}

/** A connection-time public-only resolver plus ordinary TLS hostname verification. */
export function createPublicPushAgent(): Agent {
  return new Agent({ keepAlive: true, lookup: publicOnlyLookup })
}
