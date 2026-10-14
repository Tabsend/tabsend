import { AUTH_SCHEME } from '@tabsend/shared'
import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify'
import type { Kysely } from 'kysely'
import type { Config } from './config'
import type { Database, EndpointRow } from './db/schema'
import { AppError } from './errors'
import type { Hub } from './hub'
import { hashToken } from './ids'
import { iso } from './time'

/** Everything the routes need, assembled once in buildApp. */
export interface AppContext {
  db: Kysely<Database>
  push: import('./push').PushSender
  hub: Hub
  config: Config
  /** Rate limiter for the unauthenticated write route (register). */
  rateLimiter: import('./ratelimit').RateLimiter
  /** Boot time + since-boot counters behind GET /admin/status. Shared across listeners. */
  stats: import('./stats').RelayStats
  /** Per-group in-process queue for group-scoped writes. Shared across listeners. */
  groupWrites: import('./group-queue').GroupWriteQueue
  /** Stable relay identity (P-4): minted on first boot, surfaced via GET /v1/config. */
  relayId: string
  /** SPKI pin of the served self-signed cert (P-3). Present only in TLS_SELF_SIGNED
   *  mode; rides in every pairing payload so joining devices can pin it. */
  certFingerprint?: string
  /** Injectable clock — tests advance it to exercise TTL/presence. */
  now: () => Date
}

// Attach the authenticated endpoint to the request for handlers to read.
declare module 'fastify' {
  interface FastifyRequest {
    endpoint?: EndpointRow
  }
}

/**
 * Resolve a device token to its endpoint and refresh presence. Any authenticated
 * call counts as a heartbeat (bumps last_seen_at) — that's the "any authenticated
 * call" arm of the presence rule.
 */
export async function authenticateToken(ctx: AppContext, token: string): Promise<EndpointRow> {
  const row = await ctx.db
    .selectFrom('endpoints')
    .selectAll()
    .where('device_token_hash', '=', hashToken(token))
    .executeTakeFirst()

  if (!row) return refuseUnknownToken(ctx, token)

  const seenAt = iso(ctx.now())
  const touched = await ctx.db
    .updateTable('endpoints')
    .set({ last_seen_at: seenAt })
    .where('id', '=', row.id)
    .executeTakeFirst()
  // Gone between the read and this write: removed, or deleted with its whole group
  // [2026-10-01]. The row in hand is a snapshot of a device that no longer exists, and
  // handing it on is how a WebSocket hello that straddled a group deletion used to
  // register a socket for a tenancy the control plane had just been told was gone.
  if (Number(touched.numUpdatedRows ?? 0n) === 0) return refuseUnknownToken(ctx, token)

  return { ...row, last_seen_at: seenAt }
}

/**
 * Answer a token that matches no endpoint, and never return.
 *
 * Two very different worlds look identical here, so check the tombstones before
 * answering: a matching one proves this endpoint was removed from its group (the client
 * should unpair), while no match means we simply do not recognise the token — which is
 * equally what a relay says after being restarted on an empty db or restored from a
 * backup. Only the first is safe to act on destructively.
 */
async function refuseUnknownToken(ctx: AppContext, token: string): Promise<never> {
  const tombstone = await ctx.db
    .selectFrom('removed_endpoints')
    .selectAll()
    .where('device_token_hash', '=', hashToken(token))
    .executeTakeFirst()
  if (tombstone) {
    throw new AppError('endpoint_removed', 'This endpoint was removed from its group.')
  }
  throw new AppError('unauthorized', 'Unknown or invalid device token.')
}

/** Extract `Authorization: Bearer <token>` and authenticate it. */
export async function authenticate(ctx: AppContext, request: FastifyRequest): Promise<EndpointRow> {
  const header = request.headers.authorization
  if (!header) throw new AppError('unauthorized', 'Missing Authorization header.')
  const [scheme, token] = header.split(' ')
  if (scheme !== AUTH_SCHEME || !token) {
    throw new AppError('unauthorized', `Expected "${AUTH_SCHEME} <deviceToken>" authorization.`)
  }
  return authenticateToken(ctx, token)
}

/** Fastify preHandler that authenticates and stashes the endpoint on the request. */
export function makeRequireAuth(ctx: AppContext): preHandlerHookHandler {
  return async (request: FastifyRequest, _reply: FastifyReply) => {
    request.endpoint = await authenticate(ctx, request)
  }
}

/** Read the endpoint set by makeRequireAuth (throws if the route wasn't guarded). */
export function callerOf(request: FastifyRequest): EndpointRow {
  if (!request.endpoint) throw new AppError('unauthorized', 'Not authenticated.')
  return request.endpoint
}
