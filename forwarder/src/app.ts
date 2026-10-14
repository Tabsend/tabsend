import { randomInt } from 'node:crypto'
import Fastify, {
  type FastifyInstance,
  type FastifyRequest,
  type FastifyServerOptions,
  LogController,
} from 'fastify'
import { type ApnsSender, createApnsSender, isBadDeviceToken } from './apns'
import type { ApnsEnvironment, Config, DevicePlatform } from './config'
import { ForwarderError, fail } from './errors'
import { createFcmSender, type FcmSender, isWrongProject } from './fcm'
import { RateLimiter } from './ratelimit'
import type { DeviceRecord, DeviceStore } from './store'
import { hashWakeToken, isWellFormedWakeToken, newWakeToken, tokenRef } from './tokens'
import { FORWARDER_VERSION } from './version'

/**
 * The forwarder assembled as a Fastify instance. Pure factory — no listening, no env
 * reads — so tests build it against a temp SQLite file and a fake APNs sender and drive
 * it over real HTTP. `server.ts` wires the production instance.
 *
 * Two invariants live in this file and nowhere else, so they are stated here:
 *
 * 1. **No wake token reaches a URL.** Every route takes its token from the
 *    `Authorization` header. No route has a path parameter, which is what makes the rule
 *    structural rather than a habit (PROTOCOL.md §6).
 * 2. **No response varies on whether a token exists.** Wake and revoke answer
 *    identically for a live token, a revoked one, and one that never existed; the
 *    rate-limit buckets are consumed in the same order either way, and the per-device
 *    one never answers differently at all; and on both routes every reply is written
 *    before ANY work that depends on which kind of token it was, so a live token is not
 *    slower to answer than a dead one either. The reasoning, and the cost, are
 *    PROTOCOL.md §4.
 * 3. **No log line carries a caller's address** [2026-10-02, SECURITY_REVIEW G7]. Fastify's
 *    own request log wrote every caller's address under the same request id as the
 *    `tokenRef` lines, which made the log a history of rings by relay and phone address.
 *    It is off, and the serializers below drop addresses even if something asks for a
 *    request object (PROTOCOL.md §8).
 */

export interface BuildAppOptions {
  config: Config
  store: DeviceStore
  /** Injected in tests (FakeApnsSender). Defaults to a sender chosen from config. */
  apns?: ApnsSender
  /**
   * Injected in tests (FakeFcmSender). Defaults to a sender chosen from config, which is
   * `undefined` when no Google credentials are configured — and `undefined` is meaningful:
   * `/v1/register` then refuses Android registrations instead of accepting ones it could
   * never ring.
   */
  fcm?: FcmSender
  /** Injected in tests to control rate-limit windows. Defaults to the wall clock. */
  now?: () => number
  /**
   * How long after a reply its token-dependent work starts, in ms. Defaults to
   * `randomRingDelayMs`; tests pass a fixed value, mostly 0.
   */
  ringDelayMs?: () => number
  logger?: FastifyServerOptions['logger']
}

/**
 * The upper bound of the pause between a wake's reply and the work it causes
 * [2026-10-02, SECURITY_REVIEW G14].
 *
 * Writing the reply first (§4) keeps a live token from being slower to answer, but the
 * work still ran straight after it, so a caller who probed the forwarder at that moment
 * (`/healthz`, say) found it busy after a live token and idle after a dead one. Starting
 * the work at a random point in the next half second leaves a prober searching a window
 * a thousand times longer than the work itself, among everyone else's traffic. Half a
 * second is nothing to a doorbell: delivery through Apple or Google takes longer.
 */
export const RING_DELAY_MAX_MS = 500

/** A fresh delay for one wake or revoke, uniform over [0, RING_DELAY_MAX_MS]. */
export function randomRingDelayMs(): number {
  return randomInt(RING_DELAY_MAX_MS + 1)
}

/**
 * Serializers that never write a caller's address or a query string [2026-10-02,
 * SECURITY_REVIEW G7]. Fastify's defaults put `remoteAddress` and `remotePort` on every
 * request object they log; request logging is off as well, so these are the second lock
 * on the same door. Errors are reduced to name, message, code and stack: an error object
 * can carry far more than that (a parse error carries the raw bytes of the request it
 * could not read, headers included).
 */
const SAFE_SERIALIZERS = {
  req: (req: { method?: string; url?: string }) => ({
    method: req.method,
    url: typeof req.url === 'string' ? req.url.split('?')[0] : undefined,
  }),
  res: (res: { statusCode?: number }) => ({ statusCode: res.statusCode }),
  err: (err: Error & { code?: unknown }) => ({
    type: err.name,
    message: err.message,
    ...(typeof err.code === 'string' || typeof err.code === 'number' ? { code: err.code } : {}),
    stack: err.stack ?? '',
  }),
}

/** Logger options with `SAFE_SERIALIZERS` in force. Exported for its own test. */
export function withSafeSerializers(
  logger: FastifyServerOptions['logger'],
): FastifyServerOptions['logger'] {
  if (logger === undefined || logger === false) return false
  if (logger === true) return { serializers: SAFE_SERIALIZERS }
  return { ...logger, serializers: SAFE_SERIALIZERS }
}

/** APNs device tokens are hex. Length has grown before, so the bound is generous. */
const APNS_TOKEN_PATTERN = /^[0-9a-f]{64,200}$/

/**
 * FCM registration tokens are an opaque Google string: base64url alphabet plus the `:`
 * that separates the instance id from the rest, and historically both dots and hyphens.
 * Google documents no length, so this checks the alphabet and leaves the bound generous —
 * the only job here is to reject something that is obviously not a token before it reaches
 * the database, not to validate Google's format for it.
 */
const FCM_TOKEN_PATTERN = /^[A-Za-z0-9_:.-]{32,1024}$/

/** Read the wake token out of `Authorization: Bearer …`. Never out of a URL. */
function bearerToken(request: FastifyRequest): string {
  const header = request.headers.authorization
  if (typeof header !== 'string' || !header.toLowerCase().startsWith('bearer ')) {
    fail(
      'invalid_request',
      'Send the wake token as an Authorization header, in the form "Bearer <token>". It is deliberately not accepted in the URL, because URLs get written to proxy logs and shell history.',
    )
  }
  const token = header.slice('bearer '.length).trim()
  if (!isWellFormedWakeToken(token)) {
    fail(
      'invalid_request',
      'That is not the shape of a wake token. A wake token is the 43-character string this service returned from /v1/register, and the app should re-register to get a fresh one if it no longer has it.',
    )
  }
  return token
}

function asObject(body: unknown): Record<string, unknown> {
  if (body === undefined || body === null) return {}
  if (typeof body !== 'object' || Array.isArray(body)) {
    fail('invalid_request', 'The request body must be a JSON object.')
  }
  return body as Record<string, unknown>
}

/**
 * Which provider is being registered, and the address to ring. One field per platform
 * rather than a `platform` discriminator beside a generic `token`, for two reasons: the
 * iOS app's existing `{ apnsToken }` body keeps working untouched, and a field name that
 * says which provider it belongs to cannot be sent with the wrong platform beside it.
 */
function readDeviceAddress(body: Record<string, unknown>): {
  platform: DevicePlatform
  deviceToken: string
} {
  const apnsRaw = body.apnsToken
  const fcmRaw = body.fcmToken
  const hasApns = typeof apnsRaw === 'string' && apnsRaw.trim() !== ''
  const hasFcm = typeof fcmRaw === 'string' && fcmRaw.trim() !== ''

  if (hasApns && hasFcm) {
    fail(
      'invalid_request',
      'Send apnsToken or fcmToken, not both. One registration is one device on one provider, and a row that claimed both would be ambiguous about which one to ring.',
    )
  }
  if (!hasApns && !hasFcm) {
    fail(
      'invalid_request',
      'A device address is required: apnsToken for an iPhone (the token iOS hands the app in didRegisterForRemoteNotificationsWithDeviceToken, as lowercase hex), or fcmToken for an Android phone (the token FirebaseMessaging.getToken() returns). It is the only address this service can ring.',
    )
  }

  if (hasApns) {
    const token = (apnsRaw as string).trim().toLowerCase()
    if (!APNS_TOKEN_PATTERN.test(token)) {
      fail(
        'invalid_request',
        'apnsToken must be hexadecimal. Send the raw bytes iOS gave you encoded as hex, not the Data description or a base64 string.',
      )
    }
    return { platform: 'ios', deviceToken: token }
  }

  const token = (fcmRaw as string).trim()
  if (!FCM_TOKEN_PATTERN.test(token)) {
    fail(
      'invalid_request',
      'fcmToken does not look like an FCM registration token. Send the string FirebaseMessaging.getToken() returned, unaltered.',
    )
  }
  return { platform: 'android', deviceToken: token }
}

function readEnvironment(
  body: Record<string, unknown>,
  fallback: ApnsEnvironment,
): ApnsEnvironment {
  const raw = body.environment
  if (raw === undefined) return fallback
  if (raw !== 'production' && raw !== 'sandbox') {
    fail(
      'invalid_request',
      'environment must be "production" or "sandbox". Apple keeps two separate sets of device tokens, so a sandbox token sent to the production service rings nothing. Omit the field to use this forwarder default.',
    )
  }
  return raw
}

export function buildApp(options: BuildAppOptions): FastifyInstance {
  const { config, store } = options
  const now = options.now ?? (() => Date.now())
  const ringDelayMs = options.ringDelayMs ?? randomRingDelayMs
  const startedAt = now()

  // Three separate limiters, three separate keyspaces. See PROTOCOL.md §6.
  const wakeLimiter = new RateLimiter(config.wakeRateLimit, now)
  const callerLimiter = new RateLimiter(config.callerRateLimit, now)
  const registerLimiter = new RateLimiter(config.registerRateLimit, now)

  const app = Fastify({
    logger: withSafeSerializers(options.logger),
    // No "incoming request" / "request completed" lines: they carried the caller's
    // address. See invariant 3 at the top of this file.
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: config.bodyLimitBytes,
    trustProxy: config.trustProxy,
  })

  const apns = options.apns ?? createApnsSender(config)
  const fcm =
    options.fcm ??
    createFcmSender(config, {
      onTokenRefreshError: (err) => {
        // Google's own words about the forwarder's credential; never about a device.
        app.log.warn(
          { reason: err.message },
          'Could not refresh the Google access token ahead of time. Android rings will try again as they happen, and this retries on its own with back-off. If it keeps failing, check the service account in FCM_SERVICE_ACCOUNT_PATH or FCM_SERVICE_ACCOUNT_JSON.',
        )
      },
    })

  app.setErrorHandler((err, request, reply) => {
    if (err instanceof ForwarderError) {
      if (err.retryAfterSeconds !== undefined) {
        reply.header('retry-after', String(err.retryAfterSeconds))
      }
      reply.code(err.statusCode).send(err.toBody())
      return
    }
    const e = err as { statusCode?: number; message?: string }
    if (typeof e.statusCode === 'number' && e.statusCode >= 400 && e.statusCode < 500) {
      // Fastify's own client errors: malformed JSON, body too large.
      reply
        .code(e.statusCode)
        .send({ error: { code: 'invalid_request', message: e.message ?? 'Bad request.' } })
      return
    }
    request.log.error({ err }, 'Unhandled error')
    reply.code(500).send({ error: { code: 'internal', message: 'Internal server error.' } })
  })

  app.setNotFoundHandler((_request, reply) => {
    reply.code(404).send({ error: { code: 'not_found', message: 'Route not found.' } })
  })

  /** Charge a limiter, or refuse with a Retry-After. */
  function charge(limiter: RateLimiter, key: string, message: string): void {
    const { ok, retryAfterMs } = limiter.hit(key)
    if (!ok) fail('rate_limited', message, Math.ceil(retryAfterMs / 1000))
  }

  /**
   * Rings still in flight. The wake route answers before Apple does, so a shutdown would
   * otherwise cut a ring off part-way and close the store under a handler that still
   * means to write to it. The `onClose` hook waits for this to drain.
   */
  const inFlight = new Set<Promise<void>>()

  /**
   * Run `work` once the reply is on the wire, and keep the shutdown drain aware of it.
   *
   * A macrotask rather than a bare call: the handler that schedules this returns to
   * Fastify inside the same synchronous stretch, so the response is written to the
   * socket before anything queued here runs. That is the whole mechanism behind §4's
   * clock corollary — see the wake route. On top of that, the work waits a random
   * `ringDelayMs()` (see `RING_DELAY_MAX_MS` for why); `setImmediate` is what a delay of
   * zero falls back to.
   */
  function afterReply(request: FastifyRequest, work: () => void): void {
    const delay = ringDelayMs()
    const pending: Promise<void> = new Promise<void>((resolve) => {
      if (delay > 0) setTimeout(resolve, delay)
      else setImmediate(resolve)
    })
      .then(work)
      .catch((err: unknown) => {
        request.log.error({ err }, 'Post-reply work threw')
      })
      .finally(() => {
        inFlight.delete(pending)
      })
    inFlight.add(pending)
  }

  /**
   * Ring one device, then log what its provider said. Called WITHOUT `await` from the wake
   * route; the reasoning for that is at the call site.
   *
   * Nothing in here can fail a request, because there is no request left to fail: by the
   * time this resolves the caller has its 202. Everything it learns goes to the operator
   * in the log, which is the only audience for a provider outcome (PROTOCOL.md §4).
   *
   * The two providers differ in exactly one interesting way, and it is handled identically
   * for both: each has an answer that looks like "this device is gone" but is really "your
   * credentials do not match this token" — Apple's `BadDeviceToken` across its two
   * environments, Google's `INVALID_ARGUMENT` across two Firebase projects. Both KEEP the
   * row and tell the operator the fix, because deleting on that answer unregisters working
   * phones silently.
   */
  function ring(
    request: FastifyRequest,
    ref: string,
    wakeTokenHash: string,
    device: DeviceRecord,
  ): void {
    const pending: Promise<void> = (async () => {
      if (device.platform === 'android' && !fcm) {
        // Reachable only if Google credentials were removed after a phone registered.
        // Said plainly, because the symptom at the user's end is a phone that simply
        // stops ringing.
        request.log.error(
          { tokenRef: ref, platform: device.platform },
          'An Android device is registered but this forwarder has no Google credentials, so it cannot be rung. Set FCM_SERVICE_ACCOUNT_PATH (or FCM_SERVICE_ACCOUNT_JSON) and restart. The registration is kept; the phone still drains on open.',
        )
        return
      }
      const result =
        device.platform === 'android'
          ? // Checked above; narrowing a closure variable is what the assertion is for.
            await (fcm as FcmSender).wake({ fcmToken: device.deviceToken })
          : await apns.wake({
              apnsToken: device.deviceToken,
              environment: device.environment,
            })

      if (result.ok) {
        request.log.info(
          { tokenRef: ref, platform: device.platform, environment: device.environment },
          'Rang a device',
        )
      } else if (result.deviceGone) {
        // The provider is authoritative about its own tokens. A doorbell address that
        // rings nothing is not worth keeping, and the phone re-registers when it returns.
        store.delete(wakeTokenHash)
        request.log.info(
          {
            tokenRef: ref,
            platform: device.platform,
            status: result.status,
            reason: result.reason,
          },
          'Dropped a device its provider reports as gone',
        )
      } else if (device.platform === 'ios' && isBadDeviceToken(result)) {
        // The row is KEPT; see this function's doc comment.
        request.log.warn(
          {
            tokenRef: ref,
            environment: device.environment,
            status: result.status,
            reason: result.reason,
          },
          'Apple rejected this device token. The usual cause is an environment mismatch: Apple issues separate device tokens for sandbox and production, and a build signed for one gets a token the other refuses. Check that the app registers with the environment it was built for, and that APNS_DEFAULT_ENVIRONMENT matches. The registration is kept, because this answer is not proof the phone is gone.',
        )
      } else if (device.platform === 'android' && isWrongProject(result)) {
        // The row is KEPT; see this function's doc comment.
        request.log.warn(
          { tokenRef: ref, status: result.status, reason: result.reason },
          "Google rejected this registration token. The usual cause is a project mismatch: a token belongs to one Firebase project, and the service account configured here belongs to another. Check that FCM_SERVICE_ACCOUNT_PATH and the app's google-services.json come from the same project. The registration is kept, because this answer is not proof the phone is gone.",
        )
      } else {
        // Never surfaced to the caller: an outage that changed the response for live
        // tokens only would be the oracle of §4 wearing a hat.
        request.log.warn(
          {
            tokenRef: ref,
            platform: device.platform,
            status: result.status,
            reason: result.reason,
          },
          // Named rather than generic: an operator reading this needs to know whose
          // outage to go and look at.
          device.platform === 'android' ? 'FCM refused a wake' : 'APNs refused a wake',
        )
      }
    })()
      .catch((err: unknown) => {
        // A throw here is a bug or a store closing under a shutdown, never a caller's
        // problem. Swallowed so an unhandled rejection cannot take the process down.
        request.log.error({ err, tokenRef: ref }, 'A detached wake threw')
      })
      .finally(() => {
        inFlight.delete(pending)
      })
    inFlight.add(pending)
  }

  /**
   * POST /v1/register — a phone enrols and gets a wake token.
   *
   * Unauthenticated by design: there is no account to authenticate against, and P-5
   * wants this to be invisible plumbing rather than a signup. What keeps it from being
   * an open faucet is the per-IP limit, and the fact that a registration can only ring a
   * phone whose push address the caller already holds. That is a smaller fence than it
   * sounds [corrected 2026-10-02, SECURITY_REVIEW G15]: whoever holds a phone's address
   * can register it here, which retires that phone's real wake token and hands them one
   * that rings it. The addresses are therefore kept encrypted under a key held outside
   * the database (`token-box.ts`), so a copy of the database is not a list of them.
   * Apple and Google know them too, and so does the phone itself; nothing here can
   * change that.
   */
  app.post('/v1/register', async (request, reply) => {
    charge(
      registerLimiter,
      request.ip,
      'Too many registrations from this address. Registering happens once per pairing, so a burst of them usually means a retry loop. Wait for the window to pass and try again.',
    )
    const body = asObject(request.body)
    const { platform, deviceToken } = readDeviceAddress(body)

    // Refused rather than accepted-and-never-rung. A registration this forwarder cannot
    // ring is the failure mode PROTOCOL.md §10 exists to prevent, and the client can act
    // on a refusal: the app falls back to its own foreground connection and says so.
    if (platform === 'android' && !fcm) {
      fail(
        'unsupported',
        "This forwarder has no Google credentials, so it cannot ring Android devices. Register with a forwarder that has them, or use the app without it — delivery then works over the app's own connection or by polling.",
      )
    }
    if (platform === 'ios' && !config.apns && !config.apnsDryRun) {
      fail(
        'unsupported',
        'This forwarder has no Apple credentials, so it cannot ring iPhones. Register with a forwarder that has them.',
      )
    }

    const environment = readEnvironment(body, config.apns?.defaultEnvironment ?? 'production')

    const wakeToken = newWakeToken()
    const wakeTokenHash = hashWakeToken(wakeToken)
    const { replaced } = store.register({
      wakeTokenHash,
      platform,
      deviceToken,
      environment,
      now: now(),
    })

    // `tokenRef` is the ONLY token-derived value allowed in a log line (PROTOCOL.md §8).
    request.log.info(
      { tokenRef: tokenRef(wakeTokenHash), platform, environment, replaced },
      replaced ? 'Replaced a wake token' : 'Registered a device',
    )
    return reply.code(200).send({ wakeToken })
  })

  /**
   * POST /v1/wake — a relay rings one phone.
   *
   * Answers 202 for every well-formed request, whatever the token turns out to be, and
   * whatever Apple says — without waiting to hear it. That uniformity is the point; see
   * PROTOCOL.md §4.
   */
  app.post('/v1/wake', async (request, reply) => {
    charge(
      callerLimiter,
      request.ip,
      'Too many wakes from this address. A wake is a doorbell, so a relay should ring at most a few times a minute per device. Slow down and retry later; nothing is lost, because the phone fetches from your relay when it next opens.',
    )
    const token = bearerToken(request)
    const wakeTokenHash = hashWakeToken(token)
    const ref = tokenRef(wakeTokenHash)
    // Charged BEFORE the lookup, so a live and a dead token cost the same. And SILENT
    // when spent [2026-10-01]: over its limit, a token is still answered 202 and simply
    // not rung. This bucket is shared with the relay that legitimately rings the phone,
    // so a 429 here, and its Retry-After above all, told whoever held a leaked token
    // that it was live, in use, and roughly when its relay had last rung it, which is
    // precisely what §4 says nothing here may reveal. Refusing loudly bought the caller
    // nothing it could act on anyway: the phone is not rung either way, and its tabs
    // reach it when it next opens. The per-caller limit above stays a 429, because
    // that bucket is the caller's own.
    const withinDeviceLimit = wakeLimiter.hit(wakeTokenHash).ok

    // EVERYTHING THAT VARIES WITH THE TOKEN HAPPENS AFTER THE REPLY. §4 asks for "the
    // same work done before the reply", and detaching the APNs call was only half of
    // it: a live token still paid, before its 202, for a `recordWake` write and for
    // whatever `apns.wake` does synchronously before its first await — opening an HTTP/2
    // session, signing an ES256 JWT, building the request — while an unknown token
    // returned from the store lookup having done none of it. That is a difference a
    // prober with a stopwatch can read, and it is the same distinction the rest of §4
    // spends its length denying. Since 2026-10-02 the lookup itself is after the reply
    // too, because reading a live row now also decrypts its address (`store.ts`): before
    // the 202, every wake does exactly the same thing, whatever its token.
    //
    // The log line for an unknown token moves with it. It is for the operator, who is
    // the one audience §4 does not deny anything to, and writing it before the reply
    // would put the asymmetry straight back.
    afterReply(request, () => {
      if (!withinDeviceLimit) {
        request.log.info({ tokenRef: ref }, 'Wake dropped: this token is over its per-device limit')
        return
      }
      let device: DeviceRecord | undefined
      try {
        device = store.find(wakeTokenHash)
      } catch {
        // The start-up key check makes this a damaged row rather than a wrong key. Said
        // with the token reference, because the symptom is one phone that never rings.
        request.log.error(
          { tokenRef: ref },
          "A registered phone's address cannot be decrypted, so it cannot be rung. The row is kept; that phone rings again once it signs up again, which replaces the row.",
        )
        return
      }
      if (!device) {
        request.log.info({ tokenRef: ref }, 'Wake for an unknown or revoked token')
        return
      }
      // In memory; written out once a minute (`store.ts`), so a ring touches no disk.
      store.recordWake(wakeTokenHash, now())
      // Still detached from Apple on top of that: nothing Apple says reaches the caller,
      // so there is nothing to wait for. The outcome reaches the operator in the log.
      ring(request, ref, wakeTokenHash, device)
    })
    return reply.code(202).send({ status: 'accepted' })
  })

  /**
   * POST /v1/revoke — the app retires its own wake token on unpair.
   *
   * Authenticated by the token itself, which is the only credential in this system.
   * Uniform 200, same as wake, same reason — and, like wake, the work that depends on
   * the token runs after the reply [2026-10-01]. Deleting a live token's row took
   * measurably longer than finding none, and the log line differed too. Deferring costs
   * nothing real: nothing waits on the delete (an iPhone revokes once; an Android phone
   * asks again until it gets a 2xx, which every well-formed token gets, `PROTOCOL.md`
   * §3.3), and a revoke cut off by a crash leaves a token that rings a phone with nothing
   * to fetch, exactly as a forwarder that was down would.
   */
  app.post('/v1/revoke', async (request, reply) => {
    charge(
      callerLimiter,
      request.ip,
      'Too many requests from this address. Wait for the window to pass and try again.',
    )
    const token = bearerToken(request)
    const wakeTokenHash = hashWakeToken(token)
    afterReply(request, () => {
      const removed = store.delete(wakeTokenHash)
      request.log.info(
        { tokenRef: tokenRef(wakeTokenHash), removed },
        removed ? 'Revoked a wake token' : 'Revoke for an unknown or already-revoked token',
      )
    })
    return reply.code(200).send({ status: 'ok' })
  })

  /**
   * GET /healthz — liveness, and nothing more.
   *
   * No device count and no wake tallies: a public counter of registered devices is
   * metadata about the user base that no caller needs (PROTOCOL.md §3.4). Operator
   * numbers are in the log.
   */
  app.get('/healthz', async (_request, reply) => {
    return reply.code(200).send({
      status: 'ok',
      ...(FORWARDER_VERSION ? { version: FORWARDER_VERSION } : {}),
      uptimeSeconds: Math.floor((now() - startedAt) / 1000),
    })
  })

  app.addHook('onClose', async () => {
    // Drain first: a detached ring still holds the store and the provider's session.
    //
    // A LOOP, because the set grows while it is being drained: post-reply work is what
    // starts a ring, so waiting on one snapshot would close the store under a ring that
    // had not been scheduled when the snapshot was taken. Each pass can only enqueue
    // work that was already committed to, so this terminates.
    while (inFlight.size > 0) {
      await Promise.allSettled([...inFlight])
    }
    await Promise.allSettled([apns.close(), ...(fcm ? [fcm.close()] : [])])
    for (const limiter of [wakeLimiter, callerLimiter, registerLimiter]) limiter.close()
  })

  return app
}
