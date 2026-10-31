import type { Endpoint, Message, SendPayload } from '@tabsend/shared'
import { ackMessage, getPending, listEndpoints } from '../lib/api'
import { keyId, open } from '../lib/crypto'
import { ext } from '../lib/ext'
import { projectItem, recordItem } from '../lib/history'
import type { InboxItem, SeenMessage } from '../lib/model'
import { isOpenableWebUrl } from '../lib/policy'
import {
  getCachedEndpoints,
  getInbox,
  getSeen,
  SEEN_RETENTION_MS,
  setInbox,
  setSeen,
} from '../lib/storage'
import { refreshGroupReset } from './groupreset'
import { recordEndpoints } from './newdevices'
import { type ArrivedTab, notifyDelivered } from './notify'
import { currentSession, type Session } from './session'

export interface PollSummary {
  opened: number
  acked: number
  skipped: number
  pending: number
}

const EMPTY: PollSummary = { opened: 0, acked: 0, skipped: 0, pending: 0 }

// Serialize ALL delivery — polls (boot, 30s alarm, popup) AND the WS/push fast
// path — through one chain. One-at-a-time guarantees the seen-set check and the
// tabs.create that follows it can't interleave, so nothing double-opens no matter
// which wake fired (spike §6: pull on every wake; idempotent by message id).
let chain: Promise<PollSummary> = Promise.resolve(EMPTY)

function enqueue(run: () => Promise<PollSummary>): Promise<PollSummary> {
  const next = chain.then(run, run)
  chain = next.catch(() => EMPTY)
  return next
}

/**
 * Poll the relay for pending messages and deliver them. Called on SW boot, the
 * 30s alarm, popup open, and the push tickle.
 */
export function pollPending(opts: { ack?: boolean } = {}): Promise<PollSummary> {
  return enqueue(() => doPollFetch(opts))
}

/**
 * Deliver messages handed to us by the WS fast path (envelope already in hand —
 * no GET round-trip). Runs the SAME idempotent deliver loop as polling, on the
 * same serialization chain, so the socket is pure latency: a message arriving by
 * WS and by poll can never open two tabs.
 */
export function deliverPushed(
  messages: Message[],
  opts: { ack?: boolean } = {},
): Promise<PollSummary> {
  if (messages.length === 0) return Promise.resolve(EMPTY)
  return enqueue(() => doDeliver(messages, opts))
}

/**
 * keyId → the sending endpoint, for verifying `senderKeyId` (blocks relay
 * injection). The whole endpoint rather than just its key, because the received
 * record snapshots the sender's LABEL as it reads right now [P-7].
 */
async function senderKeyIndex(endpoints: Endpoint[]): Promise<Map<string, Endpoint>> {
  const index = new Map<string, Endpoint>()
  await Promise.all(
    endpoints.map(async (e) => {
      index.set(await keyId(e.e2ePubkey), e)
    }),
  )
  return index
}

async function doPollFetch(opts: { ack?: boolean }): Promise<PollSummary> {
  const session = await currentSession()
  if (!session) return EMPTY
  const { registration } = session

  // A reset that waits (P-18 item 12) is read on every poll too, alongside the list:
  // a popup may stay closed for the whole 72 hours, and the alarm is what still runs.
  // Its own failure (or an older relay) never holds up a delivery.
  const groupReset = refreshGroupReset().catch(() => undefined)

  let endpoints: Endpoint[]
  let pending: Message[]
  try {
    endpoints = await listEndpoints(registration.relayUrl, registration.deviceToken)
    await recordEndpoints(endpoints, registration.endpointId)
    pending = await getPending(registration.relayUrl, registration.deviceToken)
  } catch {
    // Relay unreachable — nothing to do; the queue holds everything until we're back.
    await groupReset
    return EMPTY
  }

  const senders = await senderKeyIndex(endpoints)
  const summary = await deliverLoop(pending, session, senders, opts)
  await groupReset
  return summary
}

async function doDeliver(messages: Message[], opts: { ack?: boolean }): Promise<PollSummary> {
  const session = await currentSession()
  if (!session) return EMPTY
  const { registration } = session

  // Build the sender index from cache; refresh once if a sender is unknown (a
  // brand-new endpoint we haven't listed yet), so verification never falsely
  // refuses a legitimate message on the fast path.
  let endpoints = await getCachedEndpoints()
  let senders = await senderKeyIndex(endpoints)
  if (messages.some((m) => !senders.has(m.envelope.senderKeyId))) {
    try {
      endpoints = await listEndpoints(registration.relayUrl, registration.deviceToken)
      await recordEndpoints(endpoints, registration.endpointId)
      senders = await senderKeyIndex(endpoints)
    } catch {
      // stay with the cached index; unknown senders are skipped (left queued)
    }
  }
  return deliverLoop(messages, session, senders, opts)
}

/**
 * The one deliver path: for each message, dedupe on the seen-set, verify the
 * sender, open the envelope, create the tab, then ack. Written so it doesn't
 * matter whether the message arrived by poll, push, or WS.
 */
async function deliverLoop(
  messages: Message[],
  session: Session,
  senders: Map<string, Endpoint>,
  opts: { ack?: boolean },
): Promise<PollSummary> {
  const ack = opts.ack ?? true
  const { registration, identity } = session
  const seen = await getSeen()
  const seenIds = new Set(seen.map((s) => s.id))
  const summary: PollSummary = { opened: 0, acked: 0, skipped: 0, pending: messages.length }
  // Everything this PASS actually opened — the indicator [P-7 addendum] fires
  // once for the batch, not once per message.
  const delivered: InboxItem[] = []
  // The tabs those opened, in the same order, so the notification can say where
  // they landed and take a click there. Presentation only: nothing below reads it.
  const arrived: ArrivedTab[] = []

  for (const message of messages) {
    // Idempotency: never re-open a message we've already handled — a re-poll, a
    // cold SW boot, or a WS+poll overlap hands us the same row until it's acked.
    if (seenIds.has(message.id)) {
      if (ack) {
        try {
          await ackMessage(registration.relayUrl, registration.deviceToken, message.id)
          summary.acked += 1
        } catch {
          // leave it; a later poll retries the ack
        }
      }
      summary.skipped += 1
      continue
    }

    const sender = senders.get(message.envelope.senderKeyId)
    if (!sender) {
      // Unknown sender (not a current group endpoint) — refuse it, leave it queued.
      summary.skipped += 1
      continue
    }

    let payload: SendPayload
    try {
      const json = await open(
        { nonce: message.envelope.nonce, ciphertext: message.envelope.ciphertext },
        sender.e2ePubkey,
        identity.privateKey,
      )
      payload = JSON.parse(json) as SendPayload
    } catch {
      summary.skipped += 1
      continue
    }

    // Console history copies never open a tab (they'd only be sealed to a console
    // endpoint anyway; an extension shouldn't receive one, but guard regardless).
    if (payload.historyOf) {
      await markSeen(message.id)
      seenIds.add(message.id)
      if (ack) {
        try {
          await ackMessage(registration.relayUrl, registration.deviceToken, message.id)
        } catch {
          // retried on a later poll
        }
      }
      summary.skipped += 1
      continue
    }

    // A group member controls the encrypted payload. Refuse schemes that could
    // invoke browser/OS handlers rather than opening an ordinary web page. This
    // is a permanent invalid payload, so consume it instead of retrying forever.
    if (!isOpenableWebUrl(payload.url)) {
      await markSeen(message.id)
      seenIds.add(message.id)
      if (ack) {
        try {
          await ackMessage(registration.relayUrl, registration.deviceToken, message.id)
          summary.acked += 1
        } catch {
          // The seen set prevents opening it; a later poll retries the ack.
        }
      }
      summary.skipped += 1
      continue
    }

    // Persist "seen" BEFORE opening the tab so a crash/reboot can't double-open.
    await markSeen(message.id)
    seenIds.add(message.id)
    let tab: chrome.tabs.Tab | undefined
    try {
      tab = await ext.tabs.create({ url: payload.url, active: false })
      summary.opened += 1
    } catch {
      // Couldn't open (e.g. a blocked URL) — un-see it so a later poll can retry.
      await unmarkSeen(message.id)
      seenIds.delete(message.id)
      summary.skipped += 1
      continue
    }

    // Record it only once the tab actually exists, so history never lists a tab
    // that was never opened. Deliberately OUTSIDE the create try/catch: a throw in
    // there un-sees the message, and un-seeing a tab we already opened would
    // double-open it on the next poll. `recordReceived` swallows its own errors
    // for the same reason — a record is presentation on top of delivery and must
    // never be able to hold up an ack.
    const item = projectItem(message.id, payload, sender.label, Date.now())
    await recordReceived(item)
    delivered.push(item)
    if (typeof tab?.id === 'number' && typeof tab.windowId === 'number') {
      arrived.push({ tabId: tab.id, windowId: tab.windowId })
    }

    if (ack) {
      try {
        await ackMessage(registration.relayUrl, registration.deviceToken, message.id)
        summary.acked += 1
      } catch {
        // The tab is open; the ack will land on a later poll (server dedupes it).
      }
    }
  }

  await pruneSeen()
  if (delivered.length > 0) await notifyDelivered(delivered, arrived)
  return summary
}

/**
 * Add a delivered tab to the device-local received record [P-7]. The extension
 * opens the tab itself, so the row is born opened — the dimming that
 * distinguishes a rescued tab from a read one is a mobile concern, where a
 * notification can go untapped.
 *
 * Still written under ADR-0028, which made the relay's group history the
 * authoritative list: this is what answers "what arrived here" against a relay
 * that predates the ADR, serves no history, or is down, and it fills in the
 * content of a history row whose group key this device does not hold.
 *
 * Never throws: the caller has already opened the tab and acked or is about to,
 * and a storage failure here is worth losing a row over, not a delivery.
 */
async function recordReceived(item: InboxItem): Promise<void> {
  try {
    await setInbox(recordItem(await getInbox(), item))
  } catch {
    // The tab is open; only the record of it is lost.
  }
}

async function markSeen(id: string): Promise<void> {
  const seen = await getSeen()
  if (seen.some((s) => s.id === id)) return
  await setSeen([...seen, { id, ts: Date.now() }])
}

async function unmarkSeen(id: string): Promise<void> {
  const seen = await getSeen()
  await setSeen(seen.filter((s) => s.id !== id))
}

async function pruneSeen(): Promise<void> {
  const cutoff = Date.now() - SEEN_RETENTION_MS
  const seen = await getSeen()
  const kept = seen.filter((s: SeenMessage) => s.ts >= cutoff)
  if (kept.length !== seen.length) await setSeen(kept)
}
