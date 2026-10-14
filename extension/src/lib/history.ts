import type { Endpoint, HistoryEntry, HistoryRecord, SendPayload } from '@tabsend/shared'
import type { HistoryRow, InboxItem } from './model'

/**
 * The group history model [ADR-0026, absorbing P-7].
 *
 * P-7 kept a device-local list of tabs this browser RECEIVED, because the relay
 * deletes a payload on ack and the tab we opened was the only copy left. That
 * closed the wrong half of the problem: a tab that is sent and never arrives is
 * held by nobody, because `send.ts` drops its copy the moment the relay accepts.
 *
 * ADR-0026 seals one extra blob per send under a key the whole group holds, and
 * the relay keeps it for the retention window alongside the routing facts it has
 * always had. So this module now projects TWO sources into one timeline:
 *
 *  - `HistoryEntry` rows from the relay — the authoritative list, group-wide,
 *    including transfers this browser was neither end of.
 *  - the P-7 local record of received tabs — still written on delivery, and
 *    still the only thing that answers "what arrived here" when the relay
 *    predates ADR-0026, has `HISTORY_RETENTION_DAYS=0`, or is simply unreachable.
 *
 * Both are keyed by the relay message id, so a row present in both is one row:
 * the local copy fills in content for a relay row we cannot decrypt, which is
 * how the TARGET of a tab always knows what it was, key or no key.
 *
 * The grouping shape mirrors console/src/lib/view.ts (`groupHistory`,
 * `batchHeading`) deliberately — the console settled it during multi-tab send
 * and a second shape for the same idea would be a parity bug, not a choice.
 */

/**
 * How many rows a client keeps LOCALLY. Stated in the UI verbatim.
 *
 * Retention is a COUNT, not an age (owner decision 2026-08-05): a count bounds
 * storage absolutely. It caps the local cache only — the relay's own window
 * (`HISTORY_RETENTION_DAYS`) is what actually decides how far back the list
 * goes, and this browser is reading a cache of it.
 */
export const HISTORY_MAX = 50

/** One rendered block: a single transfer, or every tab of one multi-tab send. */
export interface HistoryGroup {
  /** The batch id, when this block is a multi-tab send. Absent for a single send. */
  batchId?: string
  /** How many tabs the SENDER put in the batch (may exceed `rows.length`). */
  sentCount?: number
  rows: HistoryRow[]
}

/**
 * Project a decrypted payload into the device-local received record [P-7]. Pure.
 * The sender label is snapshotted at receipt so the row still reads correctly
 * after a later rename or after that device leaves the group — the same reason
 * `HistoryRecord` snapshots both labels at send.
 */
export function projectItem(
  messageId: string,
  payload: SendPayload,
  sourceLabel: string,
  receivedAt: number,
): InboxItem {
  const item: InboxItem = {
    id: messageId,
    url: payload.url,
    sourceLabel,
    sentAt: payload.sentAt,
    receivedAt,
  }
  if (payload.title !== undefined) item.title = payload.title
  if (payload.favicon !== undefined) item.favicon = payload.favicon
  if (payload.batch !== undefined) item.batch = payload.batch
  return item
}

/**
 * Add one received tab, newest first, and drop anything past the cap.
 *
 * Recording is idempotent on the message id: the deliver loop is already deduped
 * by the seen-set, but a re-record must never double a row if that changes.
 *
 * There is no opened/unopened distinction here, unlike the mobile clients: this
 * browser opens every tab it receives, so a row that exists was opened.
 */
export function recordItem(items: InboxItem[], item: InboxItem, max = HISTORY_MAX): InboxItem[] {
  const existing = items.findIndex((i) => i.id === item.id)
  if (existing !== -1) {
    // Keep the ORIGINAL record; a re-delivery is not a new arrival.
    return items
  }
  return [item, ...items].slice(0, max)
}

/**
 * What became of a sent tab, from metadata the relay has held all along.
 *
 * The honest reading of "never arrived" is not "the relay lost it" but "its TTL
 * ran out with nobody acking it" — which is what a misconfigured or crashed
 * target actually produces, and the case ADR-0026 exists to make visible.
 */
export function deriveState(
  entry: { ackedAt: string | null; expiresAt: string },
  now: number,
): HistoryRow['state'] {
  if (entry.ackedAt !== null) return 'arrived'
  return Date.parse(entry.expiresAt) <= now ? 'never-arrived' : 'waiting'
}

/**
 * Which end of a transfer this browser was on — the thing the row's mail glyph
 * says [ADR-0026 §9]. `other` is a real and common case on a group of three or
 * more devices, and it is the one that has to name BOTH ends, because there is
 * no preposition ("from"/"to") for a transfer you were not part of.
 */
export function directionOf(
  sourceEndpointId: string,
  targetEndpointId: string,
  selfEndpointId: string,
): HistoryRow['direction'] {
  if (sourceEndpointId === selfEndpointId) return 'sent'
  if (targetEndpointId === selfEndpointId) return 'received'
  return 'other'
}

/**
 * A label for an endpoint id we have no snapshot for.
 *
 * Reached on a metadata-only row (we hold no key for its blob) naming a device
 * that has since left the group, or that this browser has never listed. Saying
 * "unknown device" is the honest answer; guessing from the id would print a UUID
 * at somebody.
 */
const UNKNOWN_DEVICE = 'Unknown device'

/**
 * Project one relay row into the timeline. `record` is the decrypted blob, or
 * undefined when we hold no key for `entry.blob.keyId`.
 *
 * A row we cannot read is kept, deliberately: it is still a TRUE record that a
 * transfer happened between two named devices at a known time, with a known
 * outcome. Dropping it would make history quietly incomplete on exactly the
 * device that just joined and has not been handed a key yet.
 */
export function projectRow(
  entry: HistoryEntry,
  record: HistoryRecord | undefined,
  selfEndpointId: string,
  labelOf: (endpointId: string) => string | undefined,
  now: number,
): HistoryRow {
  const row: HistoryRow = {
    id: entry.id,
    direction: directionOf(entry.sourceEndpointId, entry.targetEndpointId, selfEndpointId),
    state: deriveState(entry, now),
    sourceEndpointId: entry.sourceEndpointId,
    targetEndpointId: entry.targetEndpointId,
    // Labels come from the blob first: those were snapshotted at send and stay
    // right after a rename. The live list is the fallback for a row we cannot
    // read, and the fixed string the fallback for a device that has left.
    sourceLabel: record?.sourceLabelAtSend ?? labelOf(entry.sourceEndpointId) ?? UNKNOWN_DEVICE,
    targetLabel: record?.targetLabelAtSend ?? labelOf(entry.targetEndpointId) ?? UNKNOWN_DEVICE,
    // The sender's own stamp when we can read it, so a row reads the same age on
    // every device; the relay's otherwise, which is the only clock we have left.
    sentAt: record?.payload.sentAt ?? entry.createdAt,
    // Order by the RELAY's clock, never the sender's: two devices with skewed
    // clocks would otherwise interleave their sends differently on every screen.
    sortAt: entry.createdAt,
  }
  const payload = record?.payload
  if (payload) {
    row.url = payload.url
    if (payload.title !== undefined) row.title = payload.title
    if (payload.favicon !== undefined) row.favicon = payload.favicon
    if (payload.batch !== undefined) row.batch = payload.batch
  }
  return row
}

/**
 * Fold the device-local received record into the relay's list.
 *
 * Two jobs, both of which the relay alone cannot do:
 *
 *  1. **Fill a row we cannot read.** Same message id, and this browser was the
 *     target, so it decrypted the tab itself on the way in. A missing group key
 *     never hides a tab from the device it was sent to.
 *  2. **Carry rows the relay has no history for at all.** A sender that predates
 *     ADR-0026 attaches no blob; a relay set to `HISTORY_RETENTION_DAYS=0`
 *     serves none; an unreachable relay serves nothing. In all three the tab
 *     still arrived here, and P-7's promise ("closing it by accident does not
 *     lose it") has to keep holding.
 *
 * Newest first by the relay's clock where there is one. Locally-only rows are
 * ordered by the sender's stamp, which is all they have.
 */
export function mergeHistory(
  rows: readonly HistoryRow[],
  received: readonly InboxItem[],
  selfLabel: string,
  selfEndpointId: string,
  max = HISTORY_MAX,
): HistoryRow[] {
  const byId = new Map(rows.map((r) => [r.id, { ...r }]))
  for (const item of received) {
    const known = byId.get(item.id)
    if (known) {
      if (known.url === undefined) fillFrom(known, item)
      continue
    }
    byId.set(item.id, {
      id: item.id,
      direction: 'received',
      // We hold it because we opened it and acked it. There is no other way an
      // InboxItem comes to exist.
      state: 'arrived',
      sourceEndpointId: '',
      targetEndpointId: selfEndpointId,
      sourceLabel: item.sourceLabel,
      targetLabel: selfLabel,
      sentAt: item.sentAt,
      sortAt: item.sentAt,
      url: item.url,
      ...(item.title !== undefined ? { title: item.title } : {}),
      ...(item.favicon !== undefined ? { favicon: item.favicon } : {}),
      ...(item.batch !== undefined ? { batch: item.batch } : {}),
    })
  }
  return [...byId.values()]
    .sort((a, b) => (a.sortAt === b.sortAt ? (a.id < b.id ? 1 : -1) : a.sortAt < b.sortAt ? 1 : -1))
    .slice(0, max)
}

/** Copy the plaintext this browser already holds onto a row it could not open. */
function fillFrom(row: HistoryRow, item: InboxItem): void {
  row.url = item.url
  if (item.title !== undefined) row.title = item.title
  if (item.favicon !== undefined) row.favicon = item.favicon
  if (item.batch !== undefined) row.batch = item.batch
}

/**
 * Group so one multi-tab send reads as one send instead of N unrelated rows.
 * Grouping is by batch id across the WHOLE list, not just adjacent rows: a batch
 * can straddle a later single send once the relay's ordering and the local cache
 * are merged.
 *
 * A group takes the position of its FIRST row, so the list stays newest-first.
 * Rows within a group are reversed, which restores the order the sender picked
 * them in: the list is newest-first, so the last tab of a batch leads it.
 *
 * A batch is only ever grouped WITHIN one direction and one target. The same
 * three tabs sent to two devices are two sends, and the payloads carry the same
 * batch id — merging them would claim "3 tabs" over six rows.
 */
export function groupHistory(rows: readonly HistoryRow[]): HistoryGroup[] {
  const groups: HistoryGroup[] = []
  const byBatch = new Map<string, HistoryGroup>()
  for (const row of rows) {
    const batch = row.batch
    if (!batch) {
      groups.push({ rows: [row] })
      continue
    }
    const key = `${batch.id} ${row.targetEndpointId}`
    const existing = byBatch.get(key)
    if (existing) {
      existing.rows.push(row)
      // Trust the largest count seen: every tab of the batch carries it.
      existing.sentCount = Math.max(existing.sentCount ?? 0, batch.count)
      continue
    }
    const group: HistoryGroup = { batchId: batch.id, sentCount: batch.count, rows: [row] }
    byBatch.set(key, group)
    groups.push(group)
  }
  for (const group of groups) {
    if (group.batchId !== undefined) group.rows.reverse()
  }
  return groups
}

/**
 * The heading for a batch block: "3 tabs" when all of them are here, "2 of 3
 * tabs" when they are not. A gap is a real outcome, not a bug — a tab can still
 * be queued at the relay, or have been pushed off the end of the cap — so the
 * heading names it instead of quietly showing a shorter list.
 */
export function batchHeading(group: HistoryGroup): string {
  const here = group.rows.length
  const sent = Math.max(group.sentCount ?? here, here)
  return here === sent ? `${sent} tabs` : `${here} of ${sent} tabs`
}

/**
 * The one state a whole batch block is in, for the heading beside the count.
 *
 * The worst outcome wins. A block that says "3 tabs · arrived" while one of them
 * expired unacked would be the exact lie ADR-0026 exists to remove, and a person
 * scanning the list reads the heading, not three sub-rows.
 */
export function groupState(group: HistoryGroup): HistoryRow['state'] {
  if (group.rows.some((r) => r.state === 'never-arrived')) return 'never-arrived'
  if (group.rows.some((r) => r.state === 'waiting')) return 'waiting'
  return 'arrived'
}

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

/**
 * Compact, calm relative time ("just now", "3m ago", "5d ago"). Wording is kept
 * identical to console/src/lib/time.ts `relativeTime` on purpose: every client
 * now shows the SAME group history, and two vocabularies for one age would read
 * as two different facts about the same send.
 */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return 'unknown'
  const delta = now - then
  if (delta < MIN) return 'just now'
  if (delta < HOUR) return `${Math.floor(delta / MIN)}m ago`
  if (delta < DAY) return `${Math.floor(delta / HOUR)}h ago`
  const days = Math.floor(delta / DAY)
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo ago`
  return `${Math.floor(months / 12)}y ago`
}

/** A safe hostname for the row's secondary line; the raw string if it won't parse. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** Look an endpoint label up by id, for rows whose blob we cannot read. */
export function labelIndex(endpoints: readonly Endpoint[]): (id: string) => string | undefined {
  const byId = new Map(endpoints.map((e) => [e.id as string, e.label]))
  return (id) => byId.get(id)
}
