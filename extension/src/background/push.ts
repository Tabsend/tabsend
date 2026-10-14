import type { PushSubscription, WebPushSubscription } from '@tabsend/shared'
import { getConfig } from '../lib/api'
import { base64UrlToBytes } from '../lib/base64'
import {
  getPushSubscription,
  getPushVapidKey,
  setPushSubscription,
  setPushVapidKey,
} from '../lib/storage'
import { pollPending } from './receive'
import { currentSession } from './session'

/**
 * Real Web Push wake (ADR-0006, spike §2/§6). The extension subscribes from the
 * ACTIVE service worker using the relay's VAPID public key (GET /v1/config) as
 * the applicationServerKey, with `userVisibleOnly: false` (silent data push,
 * Chrome 121+) and a `true` fallback if a build rejects it. Backoff covers the
 * spike's traps: subscribe needs an active SW, and the first attempt can fail
 * transiently while GCM checks in.
 *
 * The wake is an empty tickle — the push handler just PULLS pending and runs the
 * one idempotent deliver path (verify → open → ack via the seen-set). Correctness
 * never depends on push: the poll/queue path delivers the same messages, so on
 * Chromium (no push service) every call here degrades to a no-op.
 */

// The SW globals we touch aren't in this package's DOM-only lib; narrow shims.
interface PushSubscriptionLike {
  endpoint: string
  /** The applicationServerKey this subscription is bound to (Chrome exposes it). */
  options?: { applicationServerKey?: ArrayBuffer | null }
  toJSON(): { endpoint?: string; keys?: { p256dh?: string; auth?: string } }
  unsubscribe(): Promise<boolean>
}
interface PushManagerLike {
  getSubscription(): Promise<PushSubscriptionLike | null>
  subscribe(opts: {
    userVisibleOnly: boolean
    applicationServerKey: Uint8Array | string
  }): Promise<PushSubscriptionLike>
}
interface SwRegistrationLike {
  pushManager?: PushManagerLike
  active: unknown | null
}
interface ExtendableEventLike {
  waitUntil(promise: Promise<unknown>): void
}
interface SwGlobalLike {
  registration?: SwRegistrationLike
  addEventListener(type: string, listener: (event: ExtendableEventLike) => void): void
}

const sw = self as unknown as SwGlobalLike

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Push subscription JSON → our wire shape, or null if incomplete. */
function toWire(sub: PushSubscriptionLike): WebPushSubscription | null {
  const json = sub.toJSON()
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) return null
  return {
    transport: 'webpush',
    endpoint: json.endpoint,
    keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
  }
}

/** True when an existing browser subscription is bound to `expectedKey`. */
function boundToKey(sub: PushSubscriptionLike, expectedKey: Uint8Array): boolean {
  const raw = sub.options?.applicationServerKey
  if (!raw) return false // can't verify — treat as mismatched (resubscribe is cheap)
  const actual = new Uint8Array(raw)
  if (actual.length !== expectedKey.length) return false
  return actual.every((byte, i) => byte === expectedKey[i])
}

async function subscribeWithBackoff(appServerKey: Uint8Array): Promise<WebPushSubscription | null> {
  const reg = sw.registration
  const pushManager = reg?.pushManager
  if (!reg || !pushManager) return null // no Push API (e.g. Firefox / Chromium test shell)

  // An existing browser subscription is bound to the applicationServerKey it was
  // created with. Reuse it only when it matches the relay's CURRENT key;
  // otherwise it is DEAD (pushes 403) and must be unsubscribed before a fresh
  // subscribe — Chrome throws InvalidStateError on a key change anyway.
  try {
    const current = await pushManager.getSubscription()
    if (current) {
      if (boundToKey(current, appServerKey)) {
        const wire = toWire(current)
        if (wire) return wire
      }
      await current.unsubscribe().catch(() => undefined)
    }
  } catch {
    // fall through to a fresh subscribe
  }

  const delays = [0, 500, 1500, 4000]
  for (const delay of delays) {
    if (delay) await sleep(delay)
    if (!reg.active) continue // subscribe throws without an active SW — wait
    try {
      const sub = await pushManager.subscribe({
        userVisibleOnly: false,
        applicationServerKey: appServerKey,
      })
      return toWire(sub)
    } catch {
      // Some builds reject userVisibleOnly:false — fall back to a visible sub.
      try {
        const sub = await pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: appServerKey,
        })
        return toWire(sub)
      } catch {
        // transient (GCM check-in) — retry after the next backoff step
      }
    }
  }
  return null
}

/**
 * Ensure this install holds a real Web Push subscription that matches the
 * relay's CURRENT VAPID key, subscribing (or RE-subscribing after a key
 * rotation) as needed. Returns the subscription, or null when push is
 * unavailable (relay has no VAPID, or the browser has no Push API).
 *
 * The key check matters for reliability: a stored subscription created against
 * a previous VAPID key looks healthy but every push to it is rejected (403) —
 * the classic silent-wake-loss. Comparing the stored key against /v1/config on
 * each SW boot catches a self-hoster's key rotation automatically.
 */
export async function ensurePushSubscription(): Promise<PushSubscription | null> {
  const session = await currentSession()
  if (!session) return null

  let vapidPublicKey: string
  try {
    ;({ vapidPublicKey } = await getConfig(session.registration.relayUrl))
  } catch {
    // Relay unreachable — keep whatever we have; try again on the next boot.
    return (await getPushSubscription()) ?? null
  }
  if (!vapidPublicKey) return null // relay push disabled

  const existing = await getPushSubscription()
  const existingKey = await getPushVapidKey()
  if (existing && existingKey === vapidPublicKey) return existing

  // No stored sub, or the relay's key rotated: (re)subscribe. The browser-level
  // subscription is verified against the key too (boundToKey), covering the
  // cleared-storage-but-surviving-browser-sub case.
  const sub = await subscribeWithBackoff(base64UrlToBytes(vapidPublicKey))
  if (sub) {
    await setPushSubscription(sub)
    await setPushVapidKey(vapidPublicKey)
  }
  return sub
}

/**
 * Register the SW `push` listener. Must run synchronously at top-level SW eval
 * (MV3 re-delivers events only to first-turn listeners). The tickle is empty; we
 * pull pending and deliver through the same idempotent path as polling.
 */
export function registerPushListener(): void {
  sw.addEventListener('push', (event) => {
    event.waitUntil(pollPending())
  })
}
