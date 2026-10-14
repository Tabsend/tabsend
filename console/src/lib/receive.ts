import type { Endpoint, Message, SendPayload } from '@tabsend/shared'
import { keyId, open } from './crypto'
import type { ConsoleSession, HistoryEntry } from './model'
import type { HistoryStore } from './persist'

/**
 * Per-console history copies [ADR-0010] — the console's answer to the extension's
 * deliver loop (extension/src/background/receive.ts), but it records instead of
 * opening tabs.
 *
 * For each pending message the relay holds for this console:
 *   dedupe (already recorded?) → verify the sender key (blocks relay injection,
 *   ADR-0009) → open the envelope with this console's private key → project to a
 *   HistoryEntry → persist client-side → ack (the relay deletes the payload).
 *
 * **This is no longer where the panel gets its content.** ADR-0028 supersedes the
 * CONTENT mechanism of ADR-0010: the console now reads the group's shared history
 * (lib/history.ts), which covers every send in the group, carries delivery state,
 * and reaches back before this console was paired. None of that is possible from
 * copies. What copies still are is the ONLY thing that works against a sender or
 * a relay that predates ADR-0028, and a sender out there is still minting them,
 * so this path stays exactly as it was: it opens the copies, acks them so the
 * relay can drop the payload, and lib/history.ts `mergeTimeline` folds them into
 * the same list, letting the group row win wherever both describe one send.
 *
 * The sources are injected so this is unit-testable with real crypto and an
 * in-memory store, no HTTP. The controller wires them to the REST client.
 */
export interface ConsumeSources {
  listEndpoints(): Promise<Endpoint[]>
  getPending(): Promise<Message[]>
  ack(id: string): Promise<void>
}

export interface ConsumeDeps {
  sources: ConsumeSources
  session: ConsoleSession
  store: HistoryStore
  now?: () => number
  /** Called for each newly-recorded entry (lets the UI prepend without a full reload). */
  onEntry?: (entry: HistoryEntry) => void
}

export interface ConsumeSummary {
  recorded: number
  acked: number
  skipped: number
  pending: number
}

const EMPTY: ConsumeSummary = { recorded: 0, acked: 0, skipped: 0, pending: 0 }

/** keyId → published pubkey, for verifying an envelope's `senderKeyId`. */
export async function buildSenderIndex(endpoints: Endpoint[]): Promise<Map<string, string>> {
  const index = new Map<string, string>()
  await Promise.all(
    endpoints.map(async (e) => {
      index.set(await keyId(e.e2ePubkey), e.e2ePubkey)
    }),
  )
  return index
}

/**
 * Project a decrypted copy into a stored history entry. Pure. The REAL send's
 * target comes from `payload.historyOf` (ADR-0010); a direct message to the console
 * (no historyOf — not expected, since the console is excluded from choosers) falls
 * back to the console itself as the target. Label snapshots are captured now so the
 * entry still renders after a later rename or removal.
 */
export function projectEntry(
  message: Message,
  payload: SendPayload,
  endpoints: Endpoint[],
  session: ConsoleSession,
  now: number,
): HistoryEntry {
  const byId = new Map(endpoints.map((e) => [e.id as string, e]))
  const targetEndpointId = payload.historyOf?.targetEndpointId ?? session.endpointId
  const sourceLabel = byId.get(message.sourceEndpointId)?.label ?? 'Unknown device'
  const targetLabel =
    targetEndpointId === session.endpointId
      ? session.label
      : (byId.get(targetEndpointId)?.label ?? 'Unknown device')

  const entry: HistoryEntry = {
    id: message.id,
    sourceEndpointId: message.sourceEndpointId,
    targetEndpointId,
    url: payload.url,
    sentAt: payload.sentAt,
    recordedAt: new Date(now).toISOString(),
    sourceLabelAtSend: sourceLabel,
    targetLabelAtSend: targetLabel,
  }
  if (payload.title !== undefined) entry.title = payload.title
  if (payload.favicon !== undefined) entry.favicon = payload.favicon
  if (payload.batch !== undefined) entry.batch = payload.batch
  return entry
}

/**
 * Pull the console's pending copies and record them. Returns a summary; never
 * throws for a single bad message (it's skipped and left queued for a later pull).
 * A total relay outage (both fetches fail) is swallowed to EMPTY — the caller's
 * poll/WS loop simply retries.
 */
export async function consumePending(deps: ConsumeDeps): Promise<ConsumeSummary> {
  const now = deps.now ?? Date.now
  let endpoints: Endpoint[]
  let pending: Message[]
  try {
    endpoints = await deps.sources.listEndpoints()
    pending = await deps.sources.getPending()
  } catch {
    return EMPTY
  }
  if (pending.length === 0) return { ...EMPTY }

  let senders = await buildSenderIndex(endpoints)
  // If a copy names a sender we don't know yet (a brand-new endpoint), refresh once
  // so verification never falsely refuses a legitimate copy on the fast path.
  if (pending.some((m) => !senders.has(m.envelope.senderKeyId))) {
    try {
      endpoints = await deps.sources.listEndpoints()
      senders = await buildSenderIndex(endpoints)
    } catch {
      // keep the cached index; unknown senders are skipped (left queued)
    }
  }

  const summary: ConsumeSummary = { recorded: 0, acked: 0, skipped: 0, pending: pending.length }

  for (const message of pending) {
    // Idempotency: the id is the store key. A re-poll or WS+poll overlap hands us
    // the same copy until it's acked — record once, then just (re)ack.
    if (await deps.store.has(message.id)) {
      try {
        await deps.sources.ack(message.id)
        summary.acked += 1
      } catch {
        // leave it; a later pull retries the ack
      }
      summary.skipped += 1
      continue
    }

    const senderPubkey = senders.get(message.envelope.senderKeyId)
    if (!senderPubkey) {
      summary.skipped += 1
      continue // unknown sender — refuse, leave queued
    }

    let payload: SendPayload
    try {
      const json = await open(
        { nonce: message.envelope.nonce, ciphertext: message.envelope.ciphertext },
        senderPubkey,
        deps.session.privateKey,
      )
      payload = JSON.parse(json) as SendPayload
    } catch {
      summary.skipped += 1
      continue // forged/corrupt/wrong-key — drop, leave queued
    }

    // Persist BEFORE ack so a crash between the two can't lose the copy (the relay
    // still holds it until we ack; on restart we re-pull and record).
    const entry = projectEntry(message, payload, endpoints, deps.session, now())
    await deps.store.put(entry)
    summary.recorded += 1
    deps.onEntry?.(entry)

    try {
      await deps.sources.ack(message.id)
      summary.acked += 1
    } catch {
      // recorded locally; the ack lands on a later pull (the relay dedupes it)
    }
  }

  return summary
}

/** History newest-first by send time — the render order. */
export function sortHistory(entries: HistoryEntry[]): HistoryEntry[] {
  return [...entries].sort((a, b) => Date.parse(b.sentAt) - Date.parse(a.sentAt))
}
