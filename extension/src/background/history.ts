import type { GroupKeyRecord, GroupSealed, HistoryEntry, HistoryRecord } from '@tabsend/shared'
import { getHistory as fetchHistory, isHistoryUnsupported } from '../lib/api'
import { openGroup, sealGroup } from '../lib/crypto'
import { HISTORY_MAX, labelIndex, projectRow } from '../lib/history'
import { currentKey, keyById } from '../lib/keyring'
import type { HistoryRow } from '../lib/model'
import {
  getAnnouncedHistory,
  getCachedEndpoints,
  getGroupKeys,
  getHistory,
  setAnnouncedHistory,
  setHistory,
} from '../lib/storage'
import { neverArrivedBanner } from '../lib/strings'
import { showFeedback } from './feedback'
import { historyBackedOff, markHistoryUnsupported, syncGroupKeys } from './groupkeys'
import { currentSession } from './session'

/**
 * Reading the group's shared history [ADR-0028 §8].
 *
 * The relay is authoritative and the local store is a cache of it. That is the
 * inversion the ADR makes: before it, the only record of a send lived on the two
 * devices at either end, so a tab that never arrived was held by nobody. Now the
 * relay keeps an opaque blob beside the routing row it has always had, and any
 * paired device can read the whole group's list from anywhere.
 *
 * Everything here is best-effort. A relay that is down, too old, or configured
 * with `HISTORY_RETENTION_DAYS=0` produces an empty or unchanged list, never an
 * error and never a broken screen.
 */

/** How many announced ids to keep. Bounded by the relay's own retention anyway. */
const ANNOUNCED_MAX = 200

/**
 * Seal the record of one send under the current group key, for
 * `SendItem.history`. Returns undefined when the group has no key yet, which is
 * the ADR's own answer for an upgrading group: omit the field entirely and
 * everything else behaves exactly as it did before.
 *
 * Never throws. A history blob that cannot be built must cost the user nothing
 * but the row it would have written.
 */
export async function sealHistoryBlob(record: HistoryRecord): Promise<GroupSealed | undefined> {
  try {
    const key = currentKey(await getGroupKeys())
    if (!key) return undefined
    const box = await sealGroup(JSON.stringify(record), key.key)
    return {
      alg: 'xsalsa20-poly1305/secretbox',
      keyId: key.keyId,
      nonce: box.nonce,
      ciphertext: box.ciphertext,
    }
  } catch {
    return undefined
  }
}

/**
 * Pull the group's history, decrypt what we hold keys for, and refresh the cache.
 * Returns the rows now cached — the previous ones on any failure, because a list
 * that is a few minutes old is worth far more than an empty screen.
 */
export function refreshHistory(): Promise<HistoryRow[]> {
  if (inFlight) return inFlight
  const run = doRefresh()
  inFlight = run
  const clear = (): void => {
    if (inFlight === run) inFlight = null
  }
  run.then(clear, clear)
  return run
}

/**
 * A refresh already in flight, shared by anything asking in the same moment.
 *
 * A cold boot, an alarm and a popup open all land within a second of each other.
 * Two passes would fetch the same list twice, and — worse — could both find the
 * same expired row un-announced and tell the user about it twice.
 */
let inFlight: Promise<HistoryRow[]> | null = null

async function doRefresh(): Promise<HistoryRow[]> {
  const cached = await getHistory()
  try {
    const session = await currentSession()
    if (!session) return cached
    // Collecting keys first is what lets a device that joined a minute ago read
    // rows written before it existed, on this very pass rather than the next one.
    const ring = await syncGroupKeys()
    if (await historyBackedOff()) return cached
    const { registration } = session

    let entries: HistoryEntry[]
    try {
      entries = await fetchHistory(registration.relayUrl, registration.deviceToken)
    } catch (err) {
      if (isHistoryUnsupported(err)) await markHistoryUnsupported()
      return cached
    }

    const labelOf = labelIndex(await getCachedEndpoints())
    const now = Date.now()
    const rows: HistoryRow[] = []
    for (const entry of entries) {
      const record = await openRecord(entry.blob, ring)
      rows.push(projectRow(entry, record, registration.endpointId, labelOf, now))
    }

    // The relay already orders newest-first and applies its own window; the cap
    // here is only about how much this browser keeps for offline reading.
    const kept = rows.slice(0, HISTORY_MAX)
    await setHistory(kept)
    await announceNeverArrived(kept)
    return kept
  } catch {
    return cached
  }
}

/**
 * Open one blob, or undefined if we hold no key for it.
 *
 * A row we cannot read is kept as metadata rather than dropped: it is still a
 * true record that a transfer happened. This is the ordinary state of a device
 * for the seconds between pairing and being handed the group key, and the
 * permanent state of a row written under a key minted after that device left.
 */
async function openRecord(
  blob: GroupSealed,
  ring: readonly GroupKeyRecord[],
): Promise<HistoryRecord | undefined> {
  const key = keyById(ring, blob.keyId)
  if (!key) return undefined
  try {
    return validRecord(JSON.parse(await openGroup(blob, key.key)))
  } catch {
    // Wrong key or a corrupt blob. Same treatment as not holding the key.
    return undefined
  }
}

/** Shape check, so a malformed blob degrades to metadata instead of a crash. */
function validRecord(parsed: unknown): HistoryRecord | undefined {
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const record = parsed as Partial<HistoryRecord>
  const url = record.payload?.url
  if (typeof url !== 'string') return undefined
  if (typeof record.sourceLabelAtSend !== 'string') return undefined
  if (typeof record.targetLabelAtSend !== 'string') return undefined
  return record as HistoryRecord
}

/**
 * Tell the user, once, about a tab THIS browser sent that never arrived
 * [ADR-0028 §8].
 *
 * This is the failure the whole ADR is built around: the relay accepted the tab,
 * so every surface said "Sent", and then its TTL ran out with nobody acking it.
 * Nothing else in the product can notice that, because noticing needs a record
 * that outlives the send, which is exactly what group history is.
 *
 * Announced ids are persisted because the same expired rows come back on every
 * wake for the rest of the retention window. Told once is help; told hourly is
 * an alarm with no off switch.
 */
async function announceNeverArrived(rows: readonly HistoryRow[]): Promise<void> {
  const announced = await getAnnouncedHistory()
  const seen = new Set(announced)
  const fresh = rows.filter(
    (r) => r.direction === 'sent' && r.state === 'never-arrived' && !seen.has(r.id),
  )
  if (fresh.length === 0) return

  // Persist BEFORE showing. A banner that fails to inject still leaves the badge
  // behind, and re-announcing on the next wake would be worse than the miss.
  const ids = [...new Set([...fresh.map((r) => r.id), ...announced])]
  await setAnnouncedHistory(ids.slice(0, ANNOUNCED_MAX))

  const first = fresh[0]
  if (!first) return
  // `showFeedback` sets the badge itself, which is the part that always lands:
  // this runs from an alarm, so there may be no page willing to host a banner.
  await showFeedback(neverArrivedBanner(fresh.length, first.targetLabel, first.title)).catch(
    () => false,
  )
}
