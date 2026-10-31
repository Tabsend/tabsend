import type { EndpointId, PushSubscription } from '@tabsend/shared'
import type { FastifyBaseLogger } from 'fastify'
import type { AppContext } from './context'
import type { EndpointRow } from './db/schema'
import { parsePushSubscription } from './mappers'
import { isDeadSubscriptionError } from './push'

/**
 * Ringing a device's doorbell: the content-free wake that tells a device which is not
 * listening to come and look. A wake carries nothing, so what the device does on
 * waking (drain its queue, re-read its group) is decided by the device, not here.
 *
 * Shared by the two things that ring today: a send (routes/messages.ts), and a reset
 * being scheduled (routes/provisioning.ts, P-18 item 12), which every paired phone must
 * hear about even when nobody has it open. One copy of the rules below, so the two
 * cannot drift apart on dead subscriptions, the forwarder's detached call, or the
 * online check that spares a phone's forwarder budget.
 */

/**
 * How recently a socket must have proved it is alive for the relay to trust it with
 * an event instead of ringing the phone behind it: the clients' 30 s ping, plus room
 * for one to arrive late.
 */
export const FRESH_SOCKET_MS = 45_000

/**
 * Ring one target's push channel and account for what came back. Never throws:
 * a wake failure must not fail the call that rang it — a send is queued and drains on
 * the target's next pull, and a reset is read again on the device's next open.
 */
async function wakeTarget(
  ctx: AppContext,
  log: FastifyBaseLogger,
  target: EndpointRow,
  subscription: PushSubscription,
): Promise<void> {
  try {
    await ctx.push.wake(subscription)
    // A good wake clears any accumulated (transient) failures.
    if (target.push_failures > 0) {
      await ctx.db
        .updateTable('endpoints')
        .set({ push_failures: 0 })
        .where('id', '=', target.id)
        .execute()
    }
  } catch (err) {
    if (isDeadSubscriptionError(err)) {
      const failures = target.push_failures + 1
      await ctx.db
        .updateTable('endpoints')
        .set({ push_failures: failures })
        .where('id', '=', target.id)
        .execute()
      log.warn(
        { endpointId: target.id, failures, threshold: ctx.config.pushDeadThreshold },
        failures >= ctx.config.pushDeadThreshold
          ? 'push subscription dead (404/410) — marking; wakes will skip until re-registered'
          : 'push subscription 404/410 — incrementing failure count',
      )
    } else {
      // Everything else is transient, and a wake-up forwarder failure [0032] is
      // ALWAYS here rather than in the branch above: the forwarder answers 202 to
      // a live token, a revoked one and an invented one alike (its PROTOCOL.md
      // §4), so no answer it gives is evidence that this endpoint is gone. A 404
      // from that URL means the URL is wrong. One warn line, and the tab drains on
      // open — which is exactly the forwarder's own degradation contract.
      //
      // Logged as `err`, whose message carries a status and never the wake token.
      log.warn(
        { err, endpointId: target.id },
        'push wake failed (transient); queued for pull-on-wake',
      )
    }
  }
}

/**
 * Ring one device's doorbell, once. The caller has already handed any live socket
 * its event (`hub.toEndpoint` / `hub.toGroup`); this is for the device that is not
 * listening. Never throws.
 */
export async function ringDoorbell(
  ctx: AppContext,
  log: FastifyBaseLogger,
  target: EndpointRow,
): Promise<void> {
  // Skip the network wake on a subscription already presumed dead (N consecutive
  // 404/410s). The WS event + the target's poll still deliver; the client's
  // heartbeat rotates a fresh subscription, which resets push_failures to 0.
  if (target.push_failures >= ctx.config.pushDeadThreshold) return

  // An unreadable stored subscription is relay-side corruption, not a client
  // error, and it must not fail a call whose work is already durable: there is simply
  // no channel to ring, and the device catches up on its next pull. Guarded
  // here rather than left to `wakeTarget`, because the transport it names is what
  // decides whether the wake is awaited at all.
  let subscription: PushSubscription
  try {
    subscription = parsePushSubscription(target)
  } catch (err) {
    log.warn(
      { err, endpointId: target.id },
      'stored push subscription is unreadable; no wake sent, queued for pull-on-wake',
    )
    return
  }

  if (subscription.transport === 'forwarder') {
    // DETACHED, and only this transport [0032]. A forwarder wake is an outbound
    // call to a service the relay does not run, bounded at 3 s (push.ts) — and a
    // dead forwarder therefore charged every phone target on the send its full
    // timeout, serially, before the sender heard anything back. A doorbell nobody
    // answers must not hold a request open, so nothing about the response waits
    // on it. Nothing is lost by not waiting: no answer the forwarder gives is
    // evidence about the endpoint, so there is no accounting to do with it, only
    // the warn line above — which `wakeTarget` still writes, from here.
    //
    // Web Push stays AWAITED: its 404/410 is real evidence, `push_failures` is
    // written from that answer, and the next send reads the column.
    //
    // The `.catch` is the net under the net: `wakeTarget` handles its own
    // failures, but a detached promise that rejects anyway takes the process down
    // (Node throws on an unhandled rejection), and no doorbell is worth that.
    //
    // And not at all while the phone is ONLINE: its socket was just handed the
    // event, so a ring would spend the phone's forwarder budget (six a
    // minute, PROTOCOL.md §6) on a doorbell nobody needs, and could leave a later,
    // genuinely needed wake rate-limited. This is the check ADR-0032 recorded as the
    // next thing to do on this path. It stops short of Web Push on purpose: there a
    // redundant wake is free, and it is what still reaches a device whose socket
    // died without the relay noticing yet. A phone on this path closes its socket
    // when it goes to the background (the iOS app always, the Android app whenever it
    // relies on Google push), so "online" here means a phone in somebody's hand.
    //
    // "Online" is the strict reading (`hasFreshSocket`): a socket that is OPEN and
    // pinged within the last FRESH_SOCKET_MS. Merely registered is not enough: a
    // socket that is closing, or half-open because the phone lost signal before it
    // went to the background, took nothing and would also go unrung.
    if (ctx.hub.hasFreshSocket(target.id as EndpointId, ctx.now().getTime(), FRESH_SOCKET_MS)) {
      return
    }
    void wakeTarget(ctx, log, target, subscription).catch((err) => {
      log.warn({ err, endpointId: target.id }, 'detached wake handler failed')
    })
    return
  }
  await wakeTarget(ctx, log, target, subscription)
}
