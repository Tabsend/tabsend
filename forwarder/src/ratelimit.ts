import type { RateLimitConfig } from './config'

/**
 * A fixed-window rate limiter, in memory, per process.
 *
 * Invariant: in-memory ON PURPOSE, and the contract that makes it honest is the
 * forwarder's own. This is a documented single-instance deployment (PROTOCOL.md §6), and
 * there is no shared store here to lean on: the one SQLite file it owns sits on the same
 * machine as the process, so a second instance would arrive with its own copy and moving
 * counters into it would buy a slower `Map`, not a shared budget. Two instances would
 * simply halve the effective limits, and the honest fix at that point is a store both can
 * reach, not a comment pretending this one is enough. Fails SAFE: two callers sharing a
 * bucket (a proxy without TRUST_PROXY) over-limit rather than under-limit.
 *
 * A wake is a doorbell. More than a few rings a minute is abuse, not traffic
 * (PROTOCOL.md §6).
 */

/**
 * How many hits pass between full sweeps of closed windows.
 *
 * A sweep, rather than pruning only the key just looked at: the wake limiter is keyed by
 * the hash of whatever token the caller presented, and it is charged BEFORE the store
 * lookup on purpose (PROTOCOL.md §4), so a prober mints a brand-new key on every request
 * and never returns to it. Pruning on access alone would leave every one of those buckets
 * in the Map for the life of the process, which is exactly the growth a prober would aim
 * for. Sweeping keeps the Map bounded by the keys of one open window plus at most this
 * many since the last pass.
 */
export const SWEEP_EVERY_HITS = 512

/**
 * The rate-limit key for a caller's address: an IPv6 address counts by its /64, every
 * other address as itself [2026-10-20, SECURITY_REVIEW G16].
 *
 * A /64 is what one subscriber, or one server, is normally given, and every address in it
 * is that one party's to use: keyed per address, one connection had 2^64 registration
 * allowances. An IPv4-mapped IPv6 address (`::ffff:0:0/96`, in any spelling) is its IPv4
 * address. Used for registrations, the route that adds rows. The per-caller wake limit
 * keeps the whole address: some hosts put several customers' servers, and so several
 * relays, in one /64, and a wake writes nothing.
 *
 * Parsed by the WHATWG URL parser, which Node already has and which writes IPv6 in one
 * canonical form (RFC 5952: hex, lowercase, the longest zero run as `::`), so every
 * spelling of one address gives one key [2026-10-20 review: a hand-rolled split keyed
 * `::ffff:c000:201` and its dotted spellings to one /64 bucket for every IPv4 caller, and
 * threw on more than eight groups]. Anything it cannot read is keyed as written.
 */
export function addressKey(ip: string): string {
  if (!ip.includes(':')) return ip
  let canonical: string
  try {
    // A zone (`fe80::1%eth0`) names an interface on this machine, not a party.
    canonical = new URL(`http://[${ip.split('%')[0]}]`).hostname.slice(1, -1)
  } catch {
    return ip
  }
  const [head = '', tail] = canonical.split('::')
  const front = head === '' ? [] : head.split(':')
  const back = tail === undefined || tail === '' ? [] : tail.split(':')
  const groups =
    tail === undefined
      ? front
      : [...front, ...Array<string>(8 - front.length - back.length).fill('0'), ...back]
  if (groups.length !== 8) return ip
  if (groups.slice(0, 5).every((group) => group === '0') && groups[5] === 'ffff') {
    const high = Number.parseInt(groups[6] as string, 16)
    const low = Number.parseInt(groups[7] as string, 16)
    return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.')
  }
  return `${groups.slice(0, 4).join(':')}::/64`
}

/** One fixed-window limiter over one keyspace. Three of them exist; see `app.ts`. */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>()
  /** Hits since the last sweep. Drives the interval, nothing else. */
  private sinceSweep = 0
  /**
   * A sweep once a window as well, so a caller's address goes within two windows of its
   * last call even when nobody else calls [2026-10-02 verification pass]. Sweeping by
   * hits alone left a quiet forwarder holding its last callers' addresses for days, where
   * PROTOCOL.md §8 says a window. Does not hold the process open.
   */
  private readonly sweepTimer: NodeJS.Timeout | undefined

  constructor(
    private readonly config: RateLimitConfig,
    private readonly now: () => number = () => Date.now(),
  ) {
    if (!this.disabled) {
      this.sweepTimer = setInterval(() => this.sweep(this.now()), config.windowMs)
      this.sweepTimer.unref()
    }
  }

  /** Stop the timed sweep. */
  close(): void {
    clearInterval(this.sweepTimer)
  }

  /** True when this limiter is off (max <= 0). */
  get disabled(): boolean {
    return this.config.max <= 0
  }

  /** Buckets currently held. Exposed so the bound claimed above is testable. */
  get size(): number {
    return this.hits.size
  }

  /**
   * Record a hit for `key`. Returns whether it is allowed and, when not, the ms until
   * the window resets.
   */
  hit(key: string): { ok: boolean; retryAfterMs: number } {
    if (this.disabled) return { ok: true, retryAfterMs: 0 }
    const now = this.now()
    this.sinceSweep += 1
    if (this.sinceSweep >= SWEEP_EVERY_HITS) this.sweep(now)
    const entry = this.hits.get(key)
    if (!entry || now >= entry.resetAt) {
      this.hits.set(key, { count: 1, resetAt: now + this.config.windowMs })
      return { ok: true, retryAfterMs: 0 }
    }
    if (entry.count >= this.config.max) {
      return { ok: false, retryAfterMs: entry.resetAt - now }
    }
    entry.count += 1
    return { ok: true, retryAfterMs: 0 }
  }

  /** Drop every window that has closed, including keys nobody will present again. */
  private sweep(now: number): void {
    this.sinceSweep = 0
    for (const [key, entry] of this.hits) {
      if (now >= entry.resetAt) this.hits.delete(key)
    }
  }
}
