import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify'
import type { Kysely } from 'kysely'
import type { RateLimitConfig } from './config'
import type { Database } from './db/schema'
import { AppError } from './errors'
import { hitQuota } from './quota'

/**
 * A fixed-window rate limiter for the UNauthenticated write route (register — the only
 * route anyone can hit without a device token, and the one worth protecting from
 * registration spam and pairing-code guessing).
 *
 * SHARED-STORE since [0030] (HOSTED_PLAN §4.4). It used to be a `Map` in this process,
 * documented under ADR-0012 as per-instance ON PURPOSE because the relay is a
 * single-instance deployment. That reasoning still holds for the WebSocket hub, which
 * loses nothing but latency when split; it did not hold for a LIMIT. Two relay
 * processes over one database would each hand out the full `RATE_LIMIT_MAX`, the
 * effective limit would silently be double what the operator configured, and nothing
 * would report it. The counters now live in `quota_counters`, so the budget is one row
 * both processes contend for (see quota.ts for the atomicity argument).
 *
 * What did NOT change: the key is still the client IP (respecting TRUST_PROXY via
 * Fastify's `request.ip`), `RATE_LIMIT_MAX=0` still disables it entirely, and it still
 * fails SAFE in the sense ADR-0012 meant — two clients sharing one bucket (a proxy
 * without TRUST_PROXY) over-limit rather than under-limit. `RATE_LIMIT_WINDOW_SECONDS=0`
 * disables it too, for the same reason and with the same effect (quota.ts): a window of
 * no length cannot count anything, so it counts nothing.
 *
 * What is NEW in the failure model: the store can be unreachable. A database error
 * propagates and register answers 500 — fail CLOSED. That is the right direction here
 * and costs nothing in practice, because register cannot complete without the database
 * either way.
 */
export class RateLimiter {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly config: RateLimitConfig,
    private readonly now: () => Date,
  ) {}

  /**
   * Record a hit for `key`. Returns whether it's allowed and, when not, the ms until
   * the window resets (for a `Retry-After`-style hint). One database statement, which
   * both counts and decides — never a read followed by a decision here.
   */
  async hit(key: string): Promise<{ ok: boolean; retryAfterMs: number }> {
    return hitQuota(this.db, {
      scope: 'register_ip',
      key,
      max: this.config.max,
      windowMs: this.config.windowMs,
      now: this.now(),
    })
  }
}

/**
 * A Fastify preHandler that rate-limits by client IP (respecting TRUST_PROXY via
 * Fastify's `request.ip`). On breach it throws the contract's `rate_limited` (429) and
 * sets a `Retry-After` header in whole seconds.
 */
export function makeRateLimit(limiter: RateLimiter): preHandlerHookHandler {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const { ok, retryAfterMs } = await limiter.hit(request.ip)
    if (!ok) {
      reply.header('retry-after', String(Math.ceil(retryAfterMs / 1000)))
      throw new AppError('rate_limited', 'Too many requests. Please slow down and retry later.')
    }
  }
}
