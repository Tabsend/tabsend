import websocketPlugin from '@fastify/websocket'
import type { ApiErrorCode } from '@tabsend/shared'
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify'
import type { Kysely } from 'kysely'
import type { Config } from './config'
import type { AppContext } from './context'
import type { Database } from './db/schema'
import { AppError, NOT_FOUND_BODY } from './errors'
import { GroupWriteQueue } from './group-queue'
import { Hub } from './hub'
import { isPrivateAddress } from './netguard'
import { createPushSender, type PushSender } from './push'
import { RateLimiter } from './ratelimit'
import { registerConfigRoute } from './routes/config'
import { registerEndpointRoutes } from './routes/endpoints'
import { registerGroupRoutes } from './routes/group'
import { registerGroupKeyRoutes } from './routes/group-keys'
import { registerMessageRoutes } from './routes/messages'
import { registerPairPageRoute } from './routes/pair-page'
import { registerPairingRoutes } from './routes/pairing'
import { registerProvisioningRoutes } from './routes/provisioning'
import { registerStatusRoute } from './routes/status'
import { registerStreamRoute } from './routes/stream'
import { type RefusalCounts, RelayStats } from './stats'

/**
 * Contract error codes worth a since-boot counter on GET /admin/status. Only the ones
 * that diagnose something: a burst of `unauthorized` means clients holding tokens this
 * relay does not know (restored from a backup? wrong relay?), and `endpoint_removed`
 * means a device that should have unpaired is still knocking. The validation codes
 * (invalid_request, invalid_pairing_code, …) are left out — they are ordinary traffic.
 */
const REFUSAL_BY_CODE: Partial<Record<ApiErrorCode, keyof RefusalCounts>> = {
  rate_limited: 'rateLimited',
  unauthorized: 'unauthorized',
  endpoint_removed: 'endpointRemoved',
}

export interface BuildAppOptions {
  db: Kysely<Database>
  config: Config
  /** Stable relay identity (P-4). Boot resolves it via ensureRelayId(db) — passed in
   *  (not read here) so buildApp stays a pure factory. */
  relayId: string
  /** TLS key/cert to serve https (P-3 self-signed mode). Absent ⇒ plain HTTP. */
  https?: { key: string; cert: string }
  /** SPKI pin of the served cert; carried in pairing payloads. Set with `https`. */
  certFingerprint?: string
  /** Injected in tests (FakePushSender). Defaults to a sender chosen from config. */
  push?: PushSender
  /** WebSocket fast-path registry. Defaults to a fresh Hub. Pass one explicitly to
   *  SHARE it across instances: in dual-listen mode (an http and an https listener
   *  on one relay) a per-instance hub would leave a browser on one listener unable
   *  to wake a phone's socket on the other — delivery would silently fall back to
   *  polling. Still in-process, and still the one piece that is [0012]. */
  hub?: Hub
  /** Rate limiter for the unauthenticated write routes. Defaults to a fresh one.
   *  Sharing the OBJECT no longer decides anything since [0030]: its counters live
   *  in the database, so two limiters over one db enforce one budget. Kept because
   *  dual-listen builds it once anyway, and a test may want an injected clock. */
  rateLimiter?: RateLimiter
  /** Since-boot counters for GET /admin/status. Same sharing rule as `hub`: in
   *  dual-listen mode both doors are one relay, so a refusal on either must land in
   *  one tally. Defaults to a fresh one started now. */
  stats?: RelayStats
  /** Per-group write queue (group-queue.ts). Same sharing rule as `hub`: both doors of
   *  one relay must queue a group's writes in ONE line, or each door could park its
   *  own connection on the same group row. Defaults to a fresh one. */
  groupWrites?: GroupWriteQueue
  /** Refuse clients that are not on a private network. Set ONLY on the cleartext
   *  listener, whose traffic is unencrypted and LAN-only by intent — the https
   *  listener is safe to expose and stays unrestricted. See netguard.ts. */
  restrictToPrivateClients?: boolean
  /** Injected in tests to control TTL/presence. Defaults to the wall clock. */
  now?: () => Date
  logger?: FastifyServerOptions['logger']
}

/**
 * Assemble the relay as a Fastify instance. Pure factory — no listening, no env
 * reads — so tests build it against a temp DB + fake push and drive it over real
 * HTTP. `server.ts` wires the production instance.
 */
export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const now = options.now ?? (() => new Date())
  const ctx: AppContext = {
    db: options.db,
    config: options.config,
    push:
      options.push ??
      createPushSender(
        options.config.vapid,
        options.config.pushAllowPrivateEndpoints,
        options.config.wakeForwarderUrl,
      ),
    hub: options.hub ?? new Hub(),
    rateLimiter: options.rateLimiter ?? new RateLimiter(options.db, options.config.rateLimit, now),
    stats: options.stats ?? new RelayStats(now()),
    groupWrites: options.groupWrites ?? new GroupWriteQueue(),
    relayId: options.relayId,
    certFingerprint: options.certFingerprint,
    now,
  }

  const app = Fastify({
    logger: options.logger ?? false,
    // Self-signed TLS (P-3): serve https when boot resolved cert material. The WS
    // hub needs nothing extra — @fastify/websocket upgrades on this same server.
    ...(options.https ? { https: options.https } : {}),
    // Request size cap: reject oversized bodies before they're parsed (abuse guard).
    bodyLimit: options.config.bodyLimitBytes,
    // Behind a reverse proxy (the recommended HTTPS deploy), trust X-Forwarded-For so
    // rate limits key on the real client IP. Off by default (direct-exposure safe).
    trustProxy: options.config.trustProxy,
  })

  // Every non-2xx JSON response uses the one error envelope (@tabsend/shared §10b).
  // It is also the one place every refusal passes through, so the status counters are
  // tallied here rather than scattered across the routes that throw.
  app.setErrorHandler((err, request, reply) => {
    if (err instanceof AppError) {
      const counted = REFUSAL_BY_CODE[err.code]
      if (counted) ctx.stats.countRefusal(counted)
      reply.code(err.statusCode).send(err.toBody())
      return
    }
    const e = err as { statusCode?: number; message?: string }
    if (typeof e.statusCode === 'number' && e.statusCode >= 400 && e.statusCode < 500) {
      // Fastify client errors (e.g. malformed JSON body).
      reply.code(e.statusCode).send({
        error: { code: 'invalid_request', message: e.message ?? 'Bad request.' },
      })
      return
    }
    // A 500 is a defect. Count it and keep the message, so /admin/status can say so
    // without the reader having to find the matching line in the container log.
    ctx.stats.countRefusal('internalError')
    ctx.stats.recordError(err, now())
    request.log.error(err as Error)
    reply.code(500).send({ error: { code: 'internal', message: 'Internal server error.' } })
  })

  app.setNotFoundHandler((_request, reply) => {
    reply.code(404).send(NOT_FOUND_BODY)
  })

  if (options.restrictToPrivateClients) {
    // onRequest: the earliest hook, so a public client is turned away before any
    // body is read, any route matched, or any WebSocket upgrade completes.
    //
    // `request.socket.remoteAddress` deliberately, NOT `request.ip`: with trustProxy
    // on, request.ip comes from the X-Forwarded-For HEADER, which the client writes.
    // A guard reading that could be walked straight through by anyone claiming to be
    // 192.168.1.5. The socket address is the actual TCP peer and cannot be forged.
    app.addHook('onRequest', async (request, reply) => {
      const peer = request.socket.remoteAddress
      if (isPrivateAddress(peer)) return
      // Sent, not thrown, so it bypasses the error handler's tally — count it here.
      ctx.stats.countRefusal('nonPrivateClient')
      request.log.warn(
        { peer, url: request.url },
        'Refused a non-private client on the cleartext listener',
      )
      await reply.code(403).send({
        error: {
          code: 'forbidden',
          message:
            'This relay port serves private networks only. Reach the relay over https, or see HTTP_ALLOW_PUBLIC.',
        },
      })
    })
  }

  await app.register(websocketPlugin, {
    // Stream frames are only hello/ping JSON. Bounding this at the parser keeps a
    // hostile peer from allocating the HTTP body limit on every live socket.
    options: { maxPayload: options.config.streamMaxFrameBytes },
  })

  registerConfigRoute(app, ctx)
  registerStatusRoute(app, ctx)
  // The provisioning API [0031] exists only where a credential is configured. Not
  // "registered and refusing": a self-hosted relay that never sets one is the relay it
  // was before the API, and `/admin/provisioning/...` there is a 404 because nothing is
  // there. `PROVISIONING_TOKEN_FILE` is resolved in boot code (server.ts), so a path
  // that was never read means boot skipped a step rather than that the operator
  // declined the feature — which must not fall through to "no routes, no explanation".
  if (options.config.provisioningTokenFile && !options.config.provisioningToken) {
    throw new Error(
      'PROVISIONING_TOKEN_FILE is configured but its contents were never loaded. buildApp expects boot to have read the file into config.provisioningToken (see server.ts).',
    )
  }
  if (options.config.provisioningToken) registerProvisioningRoutes(app, ctx)
  registerPairPageRoute(app)
  registerEndpointRoutes(app, ctx)
  registerPairingRoutes(app, ctx)
  registerMessageRoutes(app, ctx)
  registerGroupKeyRoutes(app, ctx)
  registerGroupRoutes(app, ctx)
  registerStreamRoute(app, ctx)

  return app
}
