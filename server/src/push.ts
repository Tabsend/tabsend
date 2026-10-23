import type { Agent } from 'node:https'
import { request as httpsRequest } from 'node:https'
import type { PushSubscription } from '@tabsend/shared'
import type { RequestDetails, RequestOptions } from 'web-push'
import webpush from 'web-push'
import type { VapidConfig } from './config'
import { createPublicPushAgent, validatePushEndpoint } from './push-egress'

/**
 * The wake channel behind a tiny interface so tests inject a fake and never hit
 * a real push service. The payload is a WAKE TICKLE (empty) — the deliverer
 * pulls pending on wake (spike report: pull-on-wake, belt-and-braces). The relay
 * never puts ciphertext in the push body; the push layer relays nothing but a nudge.
 */
export interface PushSender {
  wake(subscription: PushSubscription): Promise<void>
  /**
   * Retire a subscription the relay has just deleted, where the channel has a way to.
   * Only the wake-up forwarder has one ({@link ForwarderWakeSender.revoke}); a Web Push
   * subscription belongs to the browser, and nothing the relay holds can end it.
   */
  revoke?(subscription: PushSubscription): Promise<void>
}

/**
 * A 404 or 410 from a push service means the subscription is GONE (the browser/OS
 * dropped it). The relay counts these toward the dead-subscription threshold so it
 * stops wasting wakes on it; the client re-establishes a fresh subscription via its
 * heartbeat, which resets the counter. Other errors (timeouts, 5xx, 429) are transient
 * and do NOT count — the message is queued and drains on the next pull anyway.
 */
export function isDeadSubscriptionError(err: unknown): boolean {
  // A forwarder wake can never prove a subscription dead [0032]. Checked explicitly
  // rather than left to the field naming below, because "this error happens not to
  // carry a statusCode" is the kind of accident a later edit undoes without noticing.
  if (err instanceof ForwarderWakeError) return false
  const status = (err as { statusCode?: number } | null)?.statusCode
  return status === 404 || status === 410
}

/** Build an error shaped like web-push's WebPushError (for tests + internal use). */
export class DeadSubscriptionError extends Error {
  constructor(readonly statusCode: number) {
    super(`push service returned ${statusCode} (subscription gone)`)
    this.name = 'DeadSubscriptionError'
  }
}

/**
 * A push service answered something other than 2xx. Carries `statusCode` exactly as
 * web-push's own error did, so {@link isDeadSubscriptionError} reads a 404 or 410 from
 * it the same way, and every other status stays transient.
 */
export class PushServiceError extends Error {
  constructor(readonly statusCode: number) {
    super(`push service returned ${statusCode}`)
    this.name = 'PushServiceError'
  }
}

/**
 * How long one Web Push wake may take from start to finish, in ms. A DEADLINE, which is
 * what web-push's own `timeout` never was: that one is a socket-idle timer, so a push
 * endpoint dripping a byte every few seconds held a wake open indefinitely.
 */
const WEB_PUSH_DEADLINE_MS = 10_000

/**
 * The most of a push service's reply the relay will read, in bytes. Real ones answer
 * with an empty body or a line of JSON; nothing the relay does depends on it.
 */
const WEB_PUSH_MAX_RESPONSE_BYTES = 64 * 1024

/**
 * Send one prepared Web Push request, bounded in time and in bytes read
 * [2026-10-01 follow-up review, R12].
 *
 * web-push builds the request (VAPID headers, TTL, urgency) and this sends it, because
 * web-push's own sender reads the ENTIRE reply into one string with no limit. A push
 * endpoint is client-supplied: on a hosted relay any tenant can point one at a server
 * of their own, and a reply past V8's longest string (about 512 MB) threw inside a
 * stream handler where nothing could catch it, which ended the relay process for every
 * tenant on it. The egress guard (push-egress.ts) decides where a push may GO; this
 * decides how much may come BACK.
 *
 * Settles on the status line, which is all the relay ever acts on. The body is read
 * and thrown away in the background so the connection can be reused, and abandoned if
 * it runs past {@link WEB_PUSH_MAX_RESPONSE_BYTES} or the deadline.
 */
export function sendPushRequest(
  details: RequestDetails,
  options: { agent?: Agent; deadlineMs?: number; maxResponseBytes?: number } = {},
): Promise<void> {
  const deadlineMs = options.deadlineMs ?? WEB_PUSH_DEADLINE_MS
  const maxResponseBytes = options.maxResponseBytes ?? WEB_PUSH_MAX_RESPONSE_BYTES
  return new Promise<void>((resolve, reject) => {
    let settled = false
    const settle = (err?: Error) => {
      if (settled) return
      settled = true
      if (err) reject(err)
      else resolve()
    }
    const req = httpsRequest(
      new URL(details.endpoint),
      {
        method: details.method,
        headers: details.headers,
        ...(options.agent ? { agent: options.agent } : {}),
        signal: AbortSignal.timeout(deadlineMs),
      },
      (res) => {
        const status = res.statusCode ?? 0
        const ok = status >= 200 && status <= 299
        settle(ok ? undefined : new PushServiceError(status))
        // Late errors (the deadline firing mid-body, a reset) arrive after the answer
        // was already given. Listened for anyway: an unheard 'error' is a thrown one.
        res.on('error', () => {})
        // A refusal's body is worth nothing to the relay, so it is not read at all,
        // and its connection goes rather than staying open for whatever trickles in.
        if (!ok) {
          res.destroy()
          return
        }
        // A success's body is read and thrown away, up to the cap, so the connection
        // can carry the next wake.
        let received = 0
        res.on('data', (chunk: Buffer) => {
          received += chunk.length
          if (received > maxResponseBytes) res.destroy()
        })
        res.resume()
      },
    )
    req.on('error', (err) => settle(err))
    // Closed without a response or an error. A `101 Switching Protocols` with
    // `Connection: upgrade` does exactly this: Node hands it to an 'upgrade' listener
    // that is not there, destroys the socket and removes the deadline with it, so
    // without this line the wake would wait for ever. After an answer, a no-op.
    req.on('close', () => settle(new Error('push service closed the connection without answering')))
    if (details.body) req.write(details.body)
    req.end()
  })
}

/**
 * A wake-forwarder call that did not come back 202 [0032].
 *
 * Raised for ANY status other than 202, including a 2xx one: the forwarder has exactly
 * one success answer, so a 200 or a 204 is a URL pointing at something that is not a
 * forwarder, not a wake that worked (see {@link ForwarderWakeSender.wake}).
 *
 * Carries `status`, NOT `statusCode`, and that is deliberate: it must never be
 * mistaken for a dead-subscription error. The forwarder answers 202 for a live token,
 * a revoked one and an invented one alike (forwarder `PROTOCOL.md` §4 — a 404 there
 * would turn the wake route into a token-validity oracle), so NOTHING it answers is
 * evidence about this endpoint. A 404 from that URL means the URL is wrong, which is
 * the operator's problem and not the phone's.
 */
export class ForwarderWakeError extends Error {
  constructor(readonly status: number) {
    super(`wake forwarder returned ${status}`)
    this.name = 'ForwarderWakeError'
  }
}

/**
 * A revoke call that did not come back 200 [2026-10-20]. Like {@link ForwarderWakeError},
 * it says the forwarder is unhappy or the URL is wrong, never anything about the token:
 * the forwarder answers 200 to a live token, a revoked one and an invented one alike.
 */
export class ForwarderRevokeError extends Error {
  constructor(readonly status: number) {
    super(`wake forwarder returned ${status} to a revoke`)
    this.name = 'ForwarderRevokeError'
  }
}

/** No push configured (no VAPID keys). Wakes are no-ops; queue+poll still deliver. */
export class NoopPushSender implements PushSender {
  async wake(): Promise<void> {
    // Intentionally empty. Correctness never depends on push (ADR-0001).
  }
}

/** Records wake calls for assertions. Never touches the network. */
export class FakePushSender implements PushSender {
  readonly calls: PushSubscription[] = []
  /** When set, `wake` rejects — exercises the "push fails, send still succeeds" path. */
  failNext = false
  /** When set, the NEXT wake throws a DeadSubscriptionError with this status (404/410). */
  failDeadNextStatus: number | null = null

  async wake(subscription: PushSubscription): Promise<void> {
    if (this.failDeadNextStatus !== null) {
      const status = this.failDeadNextStatus
      this.failDeadNextStatus = null
      throw new DeadSubscriptionError(status)
    }
    if (this.failNext) {
      this.failNext = false
      throw new Error('simulated push failure')
    }
    this.calls.push(subscription)
  }
}

/** Real VAPID Web Push sender (ADR-0006). Sends an empty, high-urgency tickle. */
export class WebPushSender implements PushSender {
  private readonly agent

  constructor(
    vapid: VapidConfig,
    private readonly allowPrivateEndpoints = false,
    /** Injected in tests to see exactly what would be sent, and through which agent. */
    private readonly send: typeof sendPushRequest = sendPushRequest,
  ) {
    webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey)
    this.agent = allowPrivateEndpoints ? undefined : createPublicPushAgent()
  }

  async wake(subscription: PushSubscription): Promise<void> {
    const options: RequestOptions = { TTL: 60, urgency: 'high' }
    switch (subscription.transport) {
      case 'webpush':
      case 'unifiedpush': {
        validatePushEndpoint(subscription.endpoint, this.allowPrivateEndpoints)
        // UnifiedPush 3.0 endpoints ARE Web Push endpoints — same sender (spike §4).
        const keys = 'keys' in subscription ? subscription.keys : { p256dh: '', auth: '' }
        // Built by web-push, SENT by the relay: see sendPushRequest for why web-push's
        // own sender is not safe against a push endpoint somebody else controls. The
        // public-only agent rides along, so the egress guard still decides where the
        // connection goes.
        const details = webpush.generateRequestDetails(
          { endpoint: subscription.endpoint, keys },
          null,
          options,
        )
        await this.send(details, this.agent ? { agent: this.agent } : {})
        return
      }
      case 'fcm':
        // FCM fallback needs the Firebase SDK/credentials — out of scope for the
        // relay MVP. Skipped (logged by the caller); queue+poll still deliver.
        return
      case 'none':
        // Endpoint opted out of push entirely [0015] — WS fast path + polling deliver.
        return
      case 'forwarder':
        // Rung by ForwarderWakeSender, which wraps this one when the operator set
        // WAKE_FORWARDER_URL [0032]. Reaching HERE means a stored forwarder
        // subscription outlived the setting that let it register: the operator
        // removed the forwarder afterwards. Dropped rather than thrown, because it
        // is a configuration change and not a delivery failure, and drain-on-open is
        // exactly what the forwarder's own degradation contract promises anyway.
        return
    }
  }
}

/**
 * How long the relay waits on one doorbell before giving up, in ms.
 *
 * Well under Web Push's 10 s, and the reason is a rule about the REMOTE END that holds
 * whatever the forwarder is doing: the relay never trusts a service it does not run to
 * be fast. The forwarder's contract says it answers 202 without waiting for Apple or Google, but
 * a contract is not a guarantee — the process can be swapped, overloaded, behind a
 * proxy that queues, or simply not the forwarder the operator thinks it is. So the wait
 * is bounded here (3 s, aborted), and `routes/messages.ts` does not wait on it at all:
 * a forwarder wake is fired and left to finish on its own, so no send response can be
 * held open by a doorbell nobody answers.
 */
const FORWARDER_WAKE_TIMEOUT_MS = 3_000

/**
 * Ring the wake-up forwarder for the `forwarder` transport, and hand every other
 * transport to the sender underneath [0032] (HOSTED_PLAN §6, forwarder `PROTOCOL.md`
 * §3.2). Wrapping rather than replacing, because the two halves are independent: a
 * relay may ring phones and serve no browser push at all, or both, or neither.
 *
 * `POST {WAKE_FORWARDER_URL}/v1/wake`, the wake token in `Authorization: Bearer`,
 * empty JSON body. The token NEVER rides the URL (forwarder `PROTOCOL.md` §6, and
 * ADR-0009 §3 for the same instinct about the pairing secret): URLs end up in proxy
 * logs and shell history, headers do not.
 *
 * BEST EFFORT, ALWAYS. The caller in `routes/messages.ts` already treats a wake as
 * something that may fail, and does not wait for this one at all; what this class owes
 * it is a bounded wait for the detached call, so a hung forwarder cannot accumulate
 * outstanding requests instead of failing.
 */
export class ForwarderWakeSender implements PushSender {
  private readonly wakeUrl: string
  private readonly revokeUrl: string

  constructor(
    forwarderUrl: string,
    private readonly inner: PushSender,
    /** Injected in tests so the suite rings nothing and needs no network. */
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = FORWARDER_WAKE_TIMEOUT_MS,
  ) {
    // The route is the forwarder's protocol, not the operator's to spell. config.ts
    // has already stripped any trailing slash; belt and braces, since a double slash
    // would 404 against a service that answers 202 to everything else.
    this.wakeUrl = `${forwarderUrl.replace(/\/+$/, '')}/v1/wake`
    this.revokeUrl = `${forwarderUrl.replace(/\/+$/, '')}/v1/revoke`
  }

  async wake(subscription: PushSubscription): Promise<void> {
    if (subscription.transport !== 'forwarder') return this.inner.wake(subscription)

    // The URL is this relay's OPERATOR configuration, never the subscription's — the
    // `forwarder` variant has no url field precisely so that a register body can
    // never choose where the relay makes an outbound request (see shared §2). That is
    // also why `push-egress.ts`, which guards client-supplied Web Push endpoints,
    // deliberately does not run here.
    const response = await this.fetchImpl(this.wakeUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${subscription.wakeToken}`,
        'content-type': 'application/json',
      },
      body: '{}',
      signal: AbortSignal.timeout(this.timeoutMs),
      // A redirect is an answer, not a detour [2026-10-01]. Followed, a 3xx led to
      // whatever answered at the other end, and a 202 from there counted as a wake
      // although the forwarder never rang anything (fetch also drops the token on a
      // cross-origin hop, so the far end could not have rung it either). Taken as
      // given, it is a status that is not 202, which is exactly what it means.
      redirect: 'manual',
    })
    // EXACTLY 202, not any 2xx. The forwarder's contract has one success answer
    // (`PROTOCOL.md` §3.2, §4), and every other status — including the friendly-looking
    // ones — means the relay is not talking to a wake forwarder. A misconfigured
    // `WAKE_FORWARDER_URL` pointing at a load balancer's health page, a static site or
    // an unrelated API answers 200 or 204 all day; accepting those made the relay log a
    // delivered wake, leave `push_failures` at zero, and report a perfectly healthy
    // doorbell while no phone ever rang. That silence is the one failure mode ADR-0032
    // set out to avoid, so a wrong endpoint has to be loud.
    //
    // A live token, a revoked one and an invented one all answer 202 here, so this
    // still says nothing about the phone; it says the forwarder is unhappy or the URL
    // is wrong. Thrown so the caller logs it once — never counted against the endpoint.
    if (response.status !== 202) throw new ForwarderWakeError(response.status)
  }

  /**
   * Retire a deleted device's wake token at the forwarder [2026-10-20, PLANS P-17].
   *
   * The forwarder drops a phone's record when the phone itself unpairs, re-registers, or
   * Apple or Google say the app is gone. A device removed by another one, or deleted
   * with its whole group, does none of those: nobody rings it again, so the last never
   * fires either, and its record (the push address and the token's hash) stayed at the
   * forwarder for good. So the relay, which is the one that deleted it, says so.
   *
   * Same shape as a wake: `POST /v1/revoke`, the token in `Authorization: Bearer`, an
   * empty JSON body, bounded, no redirect followed, and exactly one success answer
   * (200). Anyone holding a wake token can already revoke it, so a device that
   * registered somebody else's token gains nothing by being removed.
   */
  async revoke(subscription: PushSubscription): Promise<void> {
    if (subscription.transport !== 'forwarder') return
    const response = await this.fetchImpl(this.revokeUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${subscription.wakeToken}`,
        'content-type': 'application/json',
      },
      body: '{}',
      signal: AbortSignal.timeout(this.timeoutMs),
      redirect: 'manual',
    })
    if (response.status !== 200) throw new ForwarderRevokeError(response.status)
  }
}

/** Where {@link revokeDeleted} writes its one line per failure. */
interface RevokeLog {
  warn(fields: object, message: string): void
}

/**
 * Retire the wake tokens of devices the relay has just deleted, AFTER the deletion has
 * committed [2026-10-20, PLANS P-17]. Detached and best effort, on the wake contract:
 * nothing waits for it, a failure is one warn line (its status, never the token) and is
 * not retried, and a deletion has already succeeded whatever the forwarder does. One
 * call at a time, so a group of thirty phones is thirty short calls in a row rather
 * than thirty at once against a per-caller limit every tenant shares.
 */
export function revokeDeleted(
  push: PushSender,
  deleted: { endpointId: string; pushSubscription: string }[],
  log: RevokeLog,
): void {
  const revoke = push.revoke?.bind(push)
  if (!revoke) return
  const owed: { endpointId: string; subscription: PushSubscription }[] = []
  for (const row of deleted) {
    let subscription: PushSubscription
    try {
      subscription = JSON.parse(row.pushSubscription)
    } catch {
      // Unreadable is relay-side corruption; there is no token to retire.
      continue
    }
    if (subscription.transport === 'forwarder')
      owed.push({ endpointId: row.endpointId, subscription })
  }
  if (owed.length === 0) return
  void (async () => {
    for (const { endpointId, subscription } of owed) {
      try {
        await revoke(subscription)
      } catch (err) {
        log.warn({ err, endpointId }, 'wake token revoke failed; not retried')
      }
    }
  })()
}

/**
 * Pick a sender from config: real Web Push when VAPID is present, else Noop, with the
 * wake-up forwarder layered over either when the operator configured one [0032].
 */
export function createPushSender(
  vapid: VapidConfig | undefined,
  allowPrivateEndpoints = false,
  wakeForwarderUrl?: string,
): PushSender {
  const base = vapid ? new WebPushSender(vapid, allowPrivateEndpoints) : new NoopPushSender()
  return wakeForwarderUrl ? new ForwarderWakeSender(wakeForwarderUrl, base) : base
}
