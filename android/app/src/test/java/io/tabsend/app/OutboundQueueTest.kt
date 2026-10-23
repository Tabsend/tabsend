package io.tabsend.app

import io.tabsend.app.logic.HeldItem
import io.tabsend.app.logic.OutboundQueue
import io.tabsend.app.logic.TargetedItem
import io.tabsend.app.logic.isoOf
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * What bounds the source-side outbound queue.
 *
 * The bug these pin: an item leaves the queue only on a definite answer from the
 * relay, which is right and stays — but nothing ever ENDED a wait, so a relay
 * that permanently 5xxes one envelope retried it on every drain and every
 * heartbeat forever, and sharing through a long outage grew the queue without
 * bound. Mirrored by extension/src/lib/outbound.test.ts and by
 * OutboundQueueTests.swift.
 *
 * Pure, so this is real evidence on a machine with no Android SDK.
 */
class OutboundQueueTest {

    private val now = 1_776_000_000_000L
    private val day = 24L * 60 * 60 * 1000

    private data class Item(
        override val id: String,
        override val createdAt: String,
    ) : HeldItem

    private fun item(id: String, msAgo: Long = 0): Item = Item(id, isoOf(now - msAgo))

    // --- the age cap --------------------------------------------------------

    /**
     * Not a number of our own choosing: past this horizon the relay would have
     * deleted the message anyway, so both sides hold one opinion about when a
     * send is dead. Mirrors DEFAULT_MESSAGE_TTL_DAYS in shared/src/types.ts.
     */
    @Test
    fun `the age cap agrees with the relay's own message TTL`() {
        assertEquals(7, OutboundQueue.MAX_AGE_DAYS)
        assertEquals(7 * day, OutboundQueue.MAX_AGE_MS)
    }

    @Test
    fun `a tab still inside the window is kept`() {
        val plan = OutboundQueue.plan(listOf(item("a", 6 * day)), now)
        assertEquals(listOf("a"), plan.keep.map { it.id })
        assertTrue(plan.expired.isEmpty())
    }

    /**
     * THE failure this exists for. A relay that answers 5xx to one particular
     * envelope keeps it queued by design — silence and "not now" must never cost
     * a tab — so nothing but its own age can ever end the retrying.
     */
    @Test
    fun `a tab the relay never took is given up on after the TTL`() {
        val plan = OutboundQueue.plan(listOf(item("poison", 7 * day), item("fresh", 60_000)), now)
        assertEquals(listOf("poison"), plan.expired.map { it.id })
        assertEquals(listOf("fresh"), plan.keep.map { it.id })
    }

    /**
     * Age is measured from the send, never from the last retry. A queue that
     * restamped its items on every failed flush would expire nothing at all.
     */
    @Test
    fun `age is measured from when the user hit send`() {
        val old = listOf(item("a", 8 * day))
        assertEquals(1, OutboundQueue.plan(old, now).expired.size)
        assertEquals(0, OutboundQueue.plan(old, now - 2 * day).expired.size)
    }

    /** A formatting bug must not be allowed to delete somebody's tabs. */
    @Test
    fun `an unreadable timestamp reads as new, not as ancient`() {
        val plan = OutboundQueue.plan(listOf(Item("a", "not a date")), now)
        assertTrue(plan.expired.isEmpty())
        assertEquals(listOf("a"), plan.keep.map { it.id })
    }

    // --- the size cap -------------------------------------------------------

    @Test
    fun `nothing is evicted until the cap is reached`() {
        val queue = (0 until OutboundQueue.MAX_ITEMS).map { item("i$it", it * 1000L) }
        val plan = OutboundQueue.plan(queue, now)
        assertTrue(plan.evicted.isEmpty())
        assertEquals(OutboundQueue.MAX_ITEMS, plan.keep.size)
    }

    /**
     * Oldest-first, always: the newest item is the one the user just shared, and
     * dropping THAT to make room would be the single worst choice available.
     */
    @Test
    fun `the oldest goes, never the send that was just made`() {
        val queue = listOf(item("oldest", 5 * day), item("newest", 1000)) +
            (0 until OutboundQueue.MAX_ITEMS - 1).map { item("f$it", 2 * day) }
        val plan = OutboundQueue.plan(queue, now)
        assertEquals(listOf("oldest"), plan.evicted.map { it.id })
        assertTrue(plan.keep.any { it.id == "newest" })
    }

    @Test
    fun `it evicts as many as it takes to get back under the cap`() {
        val total = OutboundQueue.MAX_ITEMS + 5
        // i0 is the oldest here, so the first five are what should go.
        val queue = (0 until total).map { item("i$it", (total - it) * 1000L) }
        val plan = OutboundQueue.plan(queue, now)
        assertEquals(listOf("i0", "i1", "i2", "i3", "i4"), plan.evicted.map { it.id })
        assertEquals(OutboundQueue.MAX_ITEMS, plan.keep.size)
    }

    /** `keep` is what gets stored, so it has to come back in the order it went
     *  in; the eviction ranking is a separate question from the queue's order. */
    @Test
    fun `the survivors keep their original order`() {
        val queue = (0..OutboundQueue.MAX_ITEMS).map { item("i$it", it * 1000L) }
        val plan = OutboundQueue.plan(queue, now)
        assertEquals(listOf("i${OutboundQueue.MAX_ITEMS}"), plan.evicted.map { it.id })
        assertEquals(queue.take(OutboundQueue.MAX_ITEMS).map { it.id }, plan.keep.map { it.id })
    }

    /** Expiry runs first, so a queue that is only over the cap because of tabs
     *  that were already dead does not evict a live one to make room. */
    @Test
    fun `it ages out before it evicts`() {
        val dead = (0 until 5).map { item("d$it", 8 * day) }
        val live = (0 until OutboundQueue.MAX_ITEMS).map { item("l$it", 1000) }
        val plan = OutboundQueue.plan(dead + live, now)
        assertEquals(5, plan.expired.size)
        assertTrue(plan.evicted.isEmpty())
        assertEquals(OutboundQueue.MAX_ITEMS, plan.keep.size)
    }

    /** Identical in all three clients on purpose: a tab that dies on the phone
     *  at a different point than on the laptop is two different products. */
    @Test
    fun `the size cap is the number the other clients use`() {
        assertEquals(200, OutboundQueue.MAX_ITEMS)
    }

    // --- cancel -------------------------------------------------------------

    @Test
    fun `cancel forgets exactly the one tab`() {
        val queue = listOf(item("a"), item("b"), item("c"))
        assertEquals(listOf("a", "c"), OutboundQueue.cancel(queue, "b").map { it.id })
    }

    /**
     * Two taps on the same row, or a cancel racing a flush that already settled
     * the item: neither may throw, and neither may take anything else with it.
     */
    @Test
    fun `cancelling something already gone is a no-op`() {
        val queue = listOf(item("a"), item("b"))
        assertEquals(listOf("a", "b"), OutboundQueue.cancel(queue, "gone").map { it.id })
    }

    // --- a held tab whose device is gone (PLANS.md P-15 item 3) -------------
    // Mirrored by extension/src/lib/outbound.test.ts and OutboundQueueTests.swift.

    private data class Sent(
        override val id: String,
        override val targetEndpointId: String,
        override val targetGone: Boolean = false,
        override val goneFromList: Boolean = false,
        override val createdAt: String = isoOf(1_776_000_000_000L),
    ) : TargetedItem

    private val group = setOf("self", "phone", "laptop")
    private val setFromList: (Sent, Boolean) -> Sent = { it, gone -> it.copy(targetGone = gone, goneFromList = gone) }

    // The four branches of isTargetGone, each on its own.

    @Test
    fun `a relay's flag is gone whatever the list says`() {
        val relayFlag = Sent("a", "phone", targetGone = true)
        assertTrue(OutboundQueue.isTargetGone(relayFlag, group))
        assertTrue(OutboundQueue.isTargetGone(relayFlag, emptySet()))
    }

    @Test
    fun `an empty list proves nothing, so it keeps whatever flag there is`() {
        assertFalse(OutboundQueue.isTargetGone(Sent("a", "removed"), emptySet()))
        assertTrue(OutboundQueue.isTargetGone(Sent("a", "phone", targetGone = true, goneFromList = true), emptySet()))
    }

    @Test
    fun `otherwise a tab is gone exactly when its device is not accepted`() {
        assertFalse(OutboundQueue.isTargetGone(Sent("a", "phone"), group))
        assertTrue(OutboundQueue.isTargetGone(Sent("a", "removed"), group))
    }

    @Test
    fun `a list's flag is judged again by the next list`() {
        val listFlag = Sent("a", "phone", targetGone = true, goneFromList = true)
        assertFalse(OutboundQueue.isTargetGone(listFlag, group))
        assertTrue(OutboundQueue.isTargetGone(listFlag, setOf("self", "laptop")))
    }

    // markGoneTargets: what it writes.

    @Test
    fun `a tab whose device is in the group is left alone`() {
        val queue = listOf(Sent("a", "phone"))
        assertSame(queue[0], OutboundQueue.markGoneTargets(queue, group, setFromList)[0])
    }

    @Test
    fun `a tab whose device left the group is flagged, as the list's flag`() {
        val marked = OutboundQueue.markGoneTargets(listOf(Sent("a", "removed"), Sent("b", "phone")), group, setFromList)
        assertEquals(listOf(true, false), marked.map { it.targetGone })
        assertEquals(listOf(true, false), marked.map { it.goneFromList })
    }

    @Test
    fun `a list's flag lifts once the device is accepted again`() {
        val queue = listOf(Sent("a", "phone", targetGone = true, goneFromList = true))
        val marked = OutboundQueue.markGoneTargets(queue, group, setFromList)
        assertEquals(Sent("a", "phone"), marked[0])
    }

    @Test
    fun `a list's flag stays while the device is still not accepted`() {
        val queue = listOf(Sent("a", "removed", targetGone = true, goneFromList = true))
        assertSame(queue[0], OutboundQueue.markGoneTargets(queue, group, setFromList)[0])
    }

    @Test
    fun `a relay's flag is never lifted by a list that shows the device`() {
        val queue = listOf(Sent("a", "phone", targetGone = true))
        assertSame(queue[0], OutboundQueue.markGoneTargets(queue, group, setFromList)[0])
    }

    @Test
    fun `retargeting replaces the tab in its place and it stays queued`() {
        val queue = listOf(Sent("a", "removed", targetGone = true), Sent("b", "phone"))
        val moved = OutboundQueue.retarget(queue, "a", Sent("a2", "laptop"))
        assertEquals(listOf("a2>laptop", "b>phone"), moved.map { "${it.id}>${it.targetEndpointId}" })
        assertFalse(moved.any { OutboundQueue.isTargetGone(it, group) })
    }

    @Test
    fun `retargeting a tab that already left the queue changes nothing`() {
        val queue = listOf(Sent("b", "phone"))
        assertEquals(queue, OutboundQueue.retarget(queue, "gone", Sent("x", "laptop")))
    }
}
