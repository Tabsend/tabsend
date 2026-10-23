import { describe, expect, it } from 'vitest'
import {
  applyDrain,
  cancelOutbound,
  type HeldItem,
  heldForNewTarget,
  heldTabsOnly,
  isTargetGone,
  markGoneTargets,
  OUTBOUND_MAX_AGE_DAYS,
  OUTBOUND_MAX_AGE_MS,
  OUTBOUND_MAX_ITEMS,
  planOutbound,
  retargetOutbound,
  type TargetedItem,
} from './outbound'

/**
 * What bounds the outbound queue.
 *
 * The bug these pin: an item leaves the queue only on a definite answer from the
 * relay, which is right, but nothing ever ended a wait — so a relay that
 * permanently 5xxes one envelope retried it forever and an outage grew the queue
 * without limit. Mirrored by OutboundQueueTest.kt and OutboundQueueTests.swift.
 */

const NOW = Date.parse('2026-08-18T12:00:00.000Z')

function at(msAgo: number): string {
  return new Date(NOW - msAgo).toISOString()
}

function item(id: string, msAgo = 0, extra: Partial<HeldItem> = {}): HeldItem {
  return { id, createdAt: at(msAgo), ...extra }
}

const DAY = 24 * 60 * 60 * 1000

describe('planOutbound — the age cap', () => {
  it('agrees with the relay about when a send is dead', () => {
    // Not a number of our own choosing: past this the relay would have deleted
    // the message anyway, so client and relay hold one opinion instead of two.
    expect(OUTBOUND_MAX_AGE_DAYS).toBe(7)
    expect(OUTBOUND_MAX_AGE_MS).toBe(7 * DAY)
  })

  it('keeps a tab that is still inside the window', () => {
    const plan = planOutbound([item('a', 6 * DAY)], NOW)
    expect(plan.keep.map((i) => i.id)).toEqual(['a'])
    expect(plan.expired).toEqual([])
  })

  /**
   * THE failure this exists for. A relay that answers 5xx to one particular
   * envelope keeps it queued by design — silence and "not now" must never cost a
   * tab — so nothing but its own age can ever end the retrying.
   */
  it('gives up on a tab the relay never took, after the TTL', () => {
    const plan = planOutbound([item('poison', 7 * DAY), item('fresh', 60_000)], NOW)
    expect(plan.expired.map((i) => i.id)).toEqual(['poison'])
    expect(plan.keep.map((i) => i.id)).toEqual(['fresh'])
  })

  /** Age is measured from the send, not from the last retry: a queue that kept
   *  restamping its items on every failed drain would never expire anything. */
  it('measures from when the user hit send', () => {
    const old = { id: 'a', createdAt: at(8 * DAY) }
    expect(planOutbound([old], NOW).expired).toHaveLength(1)
    expect(planOutbound([old], NOW - 2 * DAY).expired).toHaveLength(0)
  })

  /** A timestamp that will not parse is a formatting bug, and a formatting bug
   *  must not be allowed to delete somebody's tabs. */
  it('treats an unreadable timestamp as new rather than as ancient', () => {
    const plan = planOutbound([{ id: 'a', createdAt: 'not a date' }], NOW)
    expect(plan.expired).toEqual([])
    expect(plan.keep.map((i) => i.id)).toEqual(['a'])
  })
})

describe('planOutbound — the size cap', () => {
  it('does nothing at all until the cap is reached', () => {
    const queue = Array.from({ length: OUTBOUND_MAX_ITEMS }, (_, n) => item(`i${n}`, n * 1000))
    const plan = planOutbound(queue, NOW)
    expect(plan.evicted).toEqual([])
    expect(plan.keep).toHaveLength(OUTBOUND_MAX_ITEMS)
  })

  /**
   * Oldest-first, always: the newest item is the one the user just clicked for,
   * and dropping THAT to make room would be the single worst choice available.
   */
  it('evicts the oldest, never the send that was just made', () => {
    const queue = [item('oldest', 5 * DAY), item('middle', DAY), item('newest', 1000)]
    const filler = Array.from({ length: OUTBOUND_MAX_ITEMS - 2 }, (_, n) => item(`f${n}`, 2 * DAY))
    const plan = planOutbound([...queue, ...filler], NOW)
    expect(plan.evicted.map((i) => i.id)).toEqual(['oldest'])
    expect(plan.keep.map((i) => i.id)).toContain('newest')
  })

  it('evicts as many as it takes to get back under the cap', () => {
    const queue = Array.from({ length: OUTBOUND_MAX_ITEMS + 5 }, (_, n) =>
      item(`i${n}`, (OUTBOUND_MAX_ITEMS + 5 - n) * 1000),
    )
    const plan = planOutbound(queue, NOW)
    expect(plan.evicted.map((i) => i.id)).toEqual(['i0', 'i1', 'i2', 'i3', 'i4'])
    expect(plan.keep).toHaveLength(OUTBOUND_MAX_ITEMS)
  })

  /** `keep` is what gets stored, so it has to come back in the order it went in;
   *  the eviction ranking is a separate question from the queue's order. */
  it('leaves the survivors in their original order', () => {
    const queue = Array.from({ length: OUTBOUND_MAX_ITEMS + 1 }, (_, n) => item(`i${n}`, n * 1000))
    const plan = planOutbound(queue, NOW)
    // i0 is the newest here (0ms ago) and the LAST one listed is the oldest.
    expect(plan.evicted.map((i) => i.id)).toEqual([`i${OUTBOUND_MAX_ITEMS}`])
    expect(plan.keep.map((i) => i.id)).toEqual(queue.slice(0, OUTBOUND_MAX_ITEMS).map((i) => i.id))
  })

  /** Expiry runs first, so a queue that is only over the cap because of tabs
   *  that were already dead does not evict a live one to make room. */
  it('ages out before it evicts', () => {
    const dead = Array.from({ length: 5 }, (_, n) => item(`d${n}`, 8 * DAY))
    const live = Array.from({ length: OUTBOUND_MAX_ITEMS }, (_, n) => item(`l${n}`, 1000))
    const plan = planOutbound([...dead, ...live], NOW)
    expect(plan.expired).toHaveLength(5)
    expect(plan.evicted).toEqual([])
    expect(plan.keep).toHaveLength(OUTBOUND_MAX_ITEMS)
  })
})

/**
 * Console history copies [ADR-0010]. They are not tabs anybody sent, so they may
 * never appear in a count the user reads — and they must never outlive the send
 * they copy, or the console grows a history row for a tab that never went.
 */
describe('planOutbound — console history copies', () => {
  it('does not count copies towards the cap', () => {
    const real = Array.from({ length: OUTBOUND_MAX_ITEMS }, (_, n) => item(`r${n}`, 1000))
    const copies = real.map((r) => item(`c-${r.id}`, 1000, { history: true, copyOf: r.id }))
    const plan = planOutbound([...real, ...copies], NOW)
    expect(plan.evicted).toEqual([])
    expect(plan.keep).toHaveLength(2 * OUTBOUND_MAX_ITEMS)
  })

  it('takes a copy with the send it copies when that send is evicted', () => {
    const doomed = item('oldest', 5 * DAY)
    const copy = item('copy', 5 * DAY, { history: true, copyOf: 'oldest' })
    const filler = Array.from({ length: OUTBOUND_MAX_ITEMS }, (_, n) => item(`f${n}`, 1000))
    const plan = planOutbound([doomed, copy, ...filler], NOW)
    expect(plan.evicted.map((i) => i.id)).toEqual(['oldest'])
    expect(plan.keep.map((i) => i.id)).not.toContain('copy')
  })

  it('takes a copy with the send it copies when that send expires', () => {
    const plan = planOutbound(
      [item('a', 8 * DAY), item('copy', 8 * DAY, { history: true, copyOf: 'a' })],
      NOW,
    )
    expect(plan.keep).toEqual([])
  })

  /** A copy of a send that is staying is staying too — being a copy is not on
   *  its own a reason to drop anything. */
  it('leaves a copy alone while its send is still queued', () => {
    const plan = planOutbound(
      [item('a', 1000), item('copy', 1000, { history: true, copyOf: 'a' })],
      NOW,
    )
    expect(plan.keep.map((i) => i.id)).toEqual(['a', 'copy'])
  })

  it('never lets a copy into a count the user reads', () => {
    const queue = [item('a'), item('copy', 0, { history: true, copyOf: 'a' })]
    expect(heldTabsOnly(queue).map((i) => i.id)).toEqual(['a'])
  })
})

describe('cancelOutbound', () => {
  it('forgets exactly the one tab, and nothing else', () => {
    const queue = [item('a'), item('b'), item('c')]
    expect(cancelOutbound(queue, 'b').map((i) => i.id)).toEqual(['a', 'c'])
  })

  it('takes the cancelled tab’s console copies with it', () => {
    const queue = [
      item('a'),
      item('copy-a', 0, { history: true, copyOf: 'a' }),
      item('b'),
      item('copy-b', 0, { history: true, copyOf: 'b' }),
    ]
    expect(cancelOutbound(queue, 'a').map((i) => i.id)).toEqual(['b', 'copy-b'])
  })

  /** Two clicks on the same row, or a cancel racing a drain that already settled
   *  the item: neither may throw, and neither may take anything else with it. */
  it('is a no-op for an id that has already gone', () => {
    const queue = [item('a'), item('b')]
    expect(cancelOutbound(queue, 'gone').map((i) => i.id)).toEqual(['a', 'b'])
  })
})

/**
 * A held tab whose device left the group (PLANS.md P-15 item 3). Mirrored by
 * OutboundQueueTest.kt and OutboundQueueTests.swift.
 */
describe('a held tab whose device was removed', () => {
  const sent = (id: string, to: string, extra: Partial<TargetedItem> = {}): TargetedItem => ({
    id,
    createdAt: at(0),
    targetEndpointId: to,
    ...extra,
  })
  const group = new Set(['self', 'phone', 'laptop'])

  it('leaves a tab alone while its device is in the group', () => {
    const queue = [sent('a', 'phone')]
    expect(isTargetGone(queue[0]!, group)).toBe(false)
    const marked = markGoneTargets(queue, group)
    expect(marked[0]).toBe(queue[0]) // the same object: nothing to store
    expect(marked[0]?.targetGone).toBeUndefined()
  })

  it('flags a tab whose device is no longer in the group, as a list flag', () => {
    const marked = markGoneTargets([sent('a', 'removed'), sent('b', 'phone')], group)
    expect(marked.map((i) => Boolean(i.targetGone))).toEqual([true, false])
    expect(marked[0]?.goneFromList).toBe(true)
  })

  it('changes nothing against an empty list, which proves nothing either way', () => {
    expect(isTargetGone(sent('a', 'removed'), new Set())).toBe(false)
    const flagged = sent('a', 'phone', { targetGone: true, goneFromList: true })
    expect(isTargetGone(flagged, new Set())).toBe(true)
    expect(markGoneTargets([flagged], new Set())[0]).toBe(flagged)
  })

  it("keeps the relay's flag even when a list still shows the device", () => {
    const refused = sent('a', 'phone', { targetGone: true })
    expect(isTargetGone(refused, group)).toBe(true)
    expect(markGoneTargets([refused], group)[0]).toBe(refused)
  })

  it("lifts a list's flag once the device is accepted again (L3)", () => {
    const fromList = sent('a', 'phone', { targetGone: true, goneFromList: true })
    expect(isTargetGone(fromList, group)).toBe(false)
    const [back] = markGoneTargets([fromList], group)
    expect(back?.targetGone).toBeUndefined()
    expect(back?.goneFromList).toBeUndefined()
    // Still out of the list: the flag stays as it is.
    const stillOut = sent('a', 'removed', { targetGone: true, goneFromList: true })
    expect(markGoneTargets([stillOut], group)[0]).toBe(stillOut)
  })

  it('never flags a console history copy on its own account', () => {
    expect(isTargetGone(sent('c', 'removed-console', { history: true }), group)).toBe(false)
  })

  it('holds a flagged tab and its console copies back from the drain', () => {
    const queue = [
      sent('a', 'removed', { targetGone: true }),
      sent('copy-a', 'console', { history: true, copyOf: 'a' }),
      sent('b', 'phone'),
      sent('copy-b', 'console', { history: true, copyOf: 'b' }),
    ]
    expect([...heldForNewTarget(queue)].sort()).toEqual(['a', 'copy-a'])
  })

  it('moves a tab to a new device in its old place, taking its old copies out', () => {
    const queue = [
      sent('a', 'removed', { targetGone: true }),
      sent('copy-a', 'console', { history: true, copyOf: 'a' }),
      sent('b', 'phone'),
    ]
    const moved = retargetOutbound(queue, 'a', [
      sent('a2', 'laptop'),
      sent('copy-a2', 'console', { history: true, copyOf: 'a2' }),
    ])
    expect(moved.map((i) => `${i.id}>${i.targetEndpointId}`)).toEqual([
      'a2>laptop',
      'copy-a2>console',
      'b>phone',
    ])
    // Still queued, and no longer flagged: the drain will post it.
    expect(heldForNewTarget(moved).size).toBe(0)
  })

  it('moves nothing when the tab has already left the queue', () => {
    const queue = [sent('b', 'phone')]
    expect(retargetOutbound(queue, 'gone', [sent('x', 'laptop')])).toBe(queue)
  })
})

/** A drain's outcome, applied by id to the queue as it is when the drain ends (L4). */
describe('applyDrain', () => {
  const item = (id: string, attempts = 0) => ({ id, createdAt: at(0), attempts })

  it('drops what the drain settled and keeps what it kept, as it left them', () => {
    const latest = [item('sent'), item('kept')]
    const out = applyDrain(latest, new Set(['sent', 'kept']), new Map([['kept', item('kept', 1)]]))
    expect(out).toEqual([item('kept', 1)])
  })

  it('leaves alone what the drain never read, and puts back nothing that left meanwhile', () => {
    // The drain read a, b and c. Since then b was cancelled, c moved (to c2), and d was sent.
    const latest = [item('a'), item('c2'), item('d')]
    const kept = new Map([
      ['a', item('a', 1)],
      ['b', item('b', 1)],
      ['c', item('c', 1)],
    ])
    expect(applyDrain(latest, new Set(['a', 'b', 'c']), kept)).toEqual([
      item('a', 1),
      item('c2'),
      item('d'),
    ])
  })

  it('writes nothing back into a queue an unpair emptied', () => {
    expect(applyDrain([], new Set(['a']), new Map([['a', item('a', 1)]]))).toEqual([])
  })
})
