import { DEFAULT_MESSAGE_TTL_DAYS } from '@tabsend/shared'

/**
 * What bounds the source-side outbound queue.
 *
 * An item leaves that queue only on a DEFINITE answer from the relay — accepted,
 * or refused in a way retrying cannot change (ADR-0008, INTERACTION_FLOWS §4e).
 * Silence, a 429 and any 5xx all keep it, deliberately: dropping a tab because a
 * reverse proxy answered HTML 502 for the few seconds a relay container takes to
 * restart was silent data loss, and in one drain it was the WHOLE queue.
 *
 * That rule is unchanged here. What it left open is the other side: nothing ever
 * ended a wait. A relay that permanently 5xxes one particular envelope retried it
 * on every drain and heartbeat forever, and sharing through a long outage grew
 * the queue without bound. This module is the two bounds, and both are stated as
 * a plan the caller then carries out, so the rule is testable without a relay,
 * without storage and without a browser.
 *
 * Hand-mirrored by `logic/OutboundQueue.kt` and `TabsendKit/OutboundQueue.swift`.
 * The three must agree, because a tab that dies on the phone at seven days and
 * lives on the laptop for a month is two different products.
 */

/**
 * How long a tab may wait before Tabsend gives up on it, in days.
 *
 * Pinned to the relay's own message TTL rather than picked: past that horizon the
 * relay would have deleted the message anyway, so the two sides agree about when
 * a send is dead instead of each holding a different opinion. The extension can
 * import the constant; Kotlin and Swift hand-mirror it with a comment naming
 * `shared/src/types.ts` as the source, the same way the copy tables do.
 *
 * An age cap and NOT a consecutive-5xx counter, which the roadmap also offered:
 * a counter would kill tabs during a legitimately long proxy outage, which is
 * precisely the failure the recoverable/final split exists to prevent. Age has no
 * false-kill mode — a relay that comes back inside the week keeps every tab — and
 * it bounds the poison-envelope case too, because that envelope also ages out.
 */
export const OUTBOUND_MAX_AGE_DAYS = DEFAULT_MESSAGE_TTL_DAYS
export const OUTBOUND_MAX_AGE_MS = OUTBOUND_MAX_AGE_DAYS * 24 * 60 * 60 * 1000

/**
 * How many held tabs the queue keeps.
 *
 * Age alone does not bound a burst: one multi-tab send is N items in a single
 * click, and a week is a long time to keep clicking. The number is a compromise
 * between "nobody sending normally ever meets it" and what the storage actually
 * costs — on Android and iOS the whole queue is one blob rewritten on every
 * change (SharedPreferences / App Group UserDefaults), so a queue of thousands is
 * paid for on every single send.
 *
 * Counted over the tabs the USER sent. Console history copies [ADR-0010] ride
 * along with the item they copy and are not counted, because they are not tabs
 * anybody sent anywhere and a user reading "200" would not include them. The real
 * storage bound is therefore 200 × (1 + consoles in the group), which for the one
 * console a group typically has is the same order of magnitude.
 */
export const OUTBOUND_MAX_ITEMS = 200

/** The little a queue rule needs to know about the thing it is holding. */
export interface HeldItem {
  id: string
  /** ISO — when the user hit send. Age is measured from here, never from a retry. */
  createdAt: string
  /** A console history copy [ADR-0010], not a tab the user sent. */
  history?: boolean
  /** For a history copy, the id of the real send it copies. */
  copyOf?: string
}

/**
 * What to do with a queue, decided before anything is written or POSTed.
 *
 * [expired] and [evicted] are kept apart because they are told to the user
 * differently: one waited too long, the other was pushed out by newer sends, and
 * a single sentence covering both would be false about half the time.
 */
export interface OutboundPlan<T> {
  /** The queue as it should now be stored, in its original order. */
  keep: T[]
  /** Given up on: older than the relay's own message TTL. */
  expired: T[]
  /** Given up on: the oldest tabs, pushed out by the size cap. */
  evicted: T[]
}

/**
 * Age out, then cap. Pure: the caller stores `keep` and announces the rest.
 *
 * Run at BOTH ends — when something is enqueued, and at the top of a drain. The
 * drain is the half that matters for the poison envelope, which nothing else
 * would ever dislodge: it is not competing with new sends for the cap, so only
 * its own age ends it.
 *
 * A `createdAt` that will not parse is treated as brand new rather than as
 * infinitely old. Guessing the other way would let a formatting bug delete the
 * user's tabs, and the size cap still bounds the queue either way.
 */
export function planOutbound<T extends HeldItem>(queue: T[], nowMs: number): OutboundPlan<T> {
  const expired: T[] = []
  const survived: T[] = []
  for (const item of queue) {
    if (nowMs - createdAtMs(item, nowMs) >= OUTBOUND_MAX_AGE_MS) expired.push(item)
    else survived.push(item)
  }

  // The cap counts tabs, not envelopes: a history copy is dropped only because
  // the send it copies was, never on its own account (see withoutOrphanedCopies).
  const real = survived.filter((item) => !item.history)
  const excess = real.length - OUTBOUND_MAX_ITEMS
  const evicted: T[] = []
  if (excess > 0) {
    // Oldest first, by the timestamp rather than by position in the array: an
    // item's place in the queue says when it was last written, and the newest
    // item is the one the user just asked for. Ties (and unparseable stamps,
    // which read as "now") fall back to position, so the order is total.
    const doomed = new Set(
      real
        .map((item, index) => ({ item, index, at: createdAtMs(item, nowMs) }))
        .sort((a, b) => a.at - b.at || a.index - b.index)
        .slice(0, excess)
        .map((entry) => entry.item.id),
    )
    for (const item of survived) if (doomed.has(item.id)) evicted.push(item)
  }

  const removed = new Set([...expired, ...evicted].map((item) => item.id))
  const keep = withoutOrphanedCopies(
    survived.filter((item) => !removed.has(item.id)),
    removed,
  )
  return { keep, expired, evicted }
}

/**
 * Cancel one held tab: a pure local delete, and NOTHING is transmitted.
 *
 * Same principle as the quick-send undo window (`background/quicksend.ts`) —
 * there is no retraction message to build because there is nothing to retract.
 * Be honest about the limit that follows from that, though: this can only forget
 * something nobody else has yet. An item whose POST is in flight at this instant
 * may still be accepted by the relay and delivered, and a tab the relay has
 * already taken is gone from here anyway. Cancelling is "stop trying", not
 * "unsend"; the product has never had an unsend and this does not add one.
 */
export function cancelOutbound<T extends HeldItem>(queue: T[], id: string): T[] {
  const removed = new Set([id])
  return withoutOrphanedCopies(
    queue.filter((item) => item.id !== id),
    removed,
  )
}

/**
 * Drop the console history copies of sends that have just left the queue.
 *
 * A copy is a second envelope of the same tab, sealed to the console's key
 * [ADR-0010 §2]. It rides in the queue beside the real item, and left behind when
 * the real item is cancelled or given up on it would deliver console history for
 * a tab that was never sent anywhere — a record of something that did not happen,
 * which is worse than the missing row that "best-effort" already permits.
 *
 * Extension-only, because only the extension makes these copies; Android and iOS
 * queues hold nothing but real sends.
 *
 * The `copyOf !== undefined` test is a MIGRATION decision, not a null check, and
 * it deliberately errs the other way from everything above it. A copy written by
 * a build older than `copyOf` cannot name its parent, so this cannot tell whether
 * that parent has just left — and it keeps the copy rather than guessing. The
 * cost is the exact false row this function exists to prevent, in one narrow
 * case: a queue that straddles the upgrade, on a profile with a console paired,
 * whose owner then CANCELS a held tab. Expiry cannot reach it (a copy carries its
 * parent's `createdAt`, so both age out in the same sweep) and eviction needs 200
 * real tabs, so cancel is the only live path, and it closes on its own once every
 * pre-upgrade item has aged out.
 *
 * Dropping such copies outright would be defensible — ADR-0010 accepts history
 * GAPS ("a console offline past the TTL has history gaps ... accepted") and
 * accepts no false rows at all. It is not done because it would discard every
 * legitimate pending copy belonging to anyone mid-outage when the upgrade lands,
 * to prevent a row recording a send the user really did make and then retracted.
 * Losing certain data to prevent an unlikely wrong record is the worse trade, and
 * this layer has no migration machinery to scope it to one run.
 */
function withoutOrphanedCopies<T extends HeldItem>(queue: T[], removedIds: Set<string>): T[] {
  if (removedIds.size === 0) return queue
  return queue.filter(
    (item) => !(item.history && item.copyOf !== undefined && removedIds.has(item.copyOf)),
  )
}

/** When the send was made, in epoch ms; `now` when the stamp will not parse. */
function createdAtMs(item: HeldItem, nowMs: number): number {
  const at = Date.parse(item.createdAt)
  return Number.isNaN(at) ? nowMs : at
}

/** The tabs a user would count in a queue — never the history copies. */
export function heldTabsOnly<T extends HeldItem>(queue: T[]): T[] {
  return queue.filter((item) => !item.history)
}

/*
 * A held tab whose device has left the group (PLANS.md P-15 item 3).
 *
 * Before this, a tab held for a device that was then removed sat in "Waiting on
 * this browser" for as long as the relay was out of reach, and the first drain
 * that did reach it was answered `unknown_target` and dropped the tab with an
 * error: the user had to find the page again and resend it by hand. Now such a
 * tab is FLAGGED instead. The drain stops posting it, the list says the device
 * is no longer in the group, and the user picks another device for it (or
 * discards it).
 *
 * "In the group" means accepted by this device's watch (`endpointsKnownTo`), not
 * merely listed: a device this one removed is gone even while a relay keeps it
 * on the list (SECURITY_REVIEW L3).
 *
 * Hand-mirrored by `logic/OutboundQueue.kt` and `TabsendKit/OutboundQueue.swift`.
 */

/** The slice of a held item the "is its device gone?" rule needs. */
export interface TargetedItem extends HeldItem {
  targetEndpointId: string
  /**
   * Set once the device is known to be gone. Set by the relay's refusal it is
   * sticky; set by a list (`goneFromList`) it clears once the device is accepted
   * again.
   */
  targetGone?: boolean
  /**
   * The flag came from a device list that no longer had the device, not from the
   * relay refusing the tab. A list can be wrong for a moment, or wrong on purpose
   * (L3), so a device that comes back takes its tab back.
   */
  goneFromList?: boolean
}

/**
 * Whether this held tab is waiting for a device that is no longer in the group.
 *
 * `acceptedIds` is the group as this device last accepted it. The relay's refusal
 * outweighs any list: the list a drain reads can be older than the refusal, and
 * trusting it would post the tab to a device the relay has already said is gone.
 * An empty list proves nothing (a fresh install, a cache that has not loaded), so
 * it changes nothing either way. History copies are never flagged themselves;
 * they follow the tab they copy (`heldForNewTarget`).
 */
export function isTargetGone(item: TargetedItem, acceptedIds: ReadonlySet<string>): boolean {
  if (item.history) return false
  if (item.targetGone && !item.goneFromList) return true
  if (acceptedIds.size === 0) return item.targetGone === true
  return !acceptedIds.has(item.targetEndpointId)
}

/**
 * Flag every held tab whose device has left the group, and lift a list's flag
 * from a tab whose device is accepted again. Pure: items that are unchanged come
 * back as the same objects.
 */
export function markGoneTargets<T extends TargetedItem>(
  queue: T[],
  acceptedIds: ReadonlySet<string>,
): T[] {
  return queue.map((item) => {
    const gone = isTargetGone(item, acceptedIds)
    if (gone && !item.targetGone) return { ...item, targetGone: true, goneFromList: true }
    if (!gone && item.targetGone) {
      const { targetGone: _gone, goneFromList: _fromList, ...rest } = item
      return rest as T
    }
    return item
  })
}

/**
 * Apply a drain's outcome to the queue as it is now (SECURITY_REVIEW L4). `seen`
 * is every id the drain read; `kept` the ones it keeps, as it leaves them. An id
 * it read and did not keep leaves; one it never read (a send made meanwhile)
 * stays as it is; and one that left meanwhile (cancelled, moved to another
 * device, wiped by an unpair) is not put back. Writing back the whole queue the
 * drain read did all three wrong: it lost new sends, restored a moved tab beside
 * its replacement, and brought back tabs an unpair had wiped.
 */
export function applyDrain<T extends HeldItem>(
  latest: T[],
  seen: ReadonlySet<string>,
  kept: ReadonlyMap<string, T>,
): T[] {
  return latest.flatMap((item) => {
    if (!seen.has(item.id)) return [item]
    const next = kept.get(item.id)
    return next ? [next] : []
  })
}

/**
 * The ids a drain must NOT post: every flagged tab, and every console history
 * copy of one. A copy names the old device inside its ciphertext, so sending it
 * would give the console a history row for a send that never happened.
 */
export function heldForNewTarget<T extends TargetedItem>(queue: T[]): Set<string> {
  const held = new Set(queue.filter((item) => !item.history && item.targetGone).map((i) => i.id))
  for (const item of queue) {
    if (item.history && item.copyOf !== undefined && held.has(item.copyOf)) held.add(item.id)
  }
  return held
}

/**
 * Point a held tab at another device: the old item and its console copies leave
 * the queue, and `replacement` (the tab sealed afresh for the new device, then
 * its new copies) takes their place, so it keeps its turn in the drain.
 *
 * Pure, and it seals nothing: the caller builds `replacement` from the tab's
 * plaintext, because an envelope sealed to one device's key must never be sent
 * to another. An id that is no longer queued (cancelled, or drained meanwhile)
 * leaves the queue unchanged.
 */
export function retargetOutbound<T extends HeldItem>(
  queue: T[],
  id: string,
  replacement: T[],
): T[] {
  const at = queue.findIndex((item) => item.id === id)
  if (at < 0) return queue
  const out: T[] = []
  queue.forEach((item, index) => {
    if (index === at) out.push(...replacement)
    else if (!(item.history && item.copyOf === id)) out.push(item)
  })
  return out
}
