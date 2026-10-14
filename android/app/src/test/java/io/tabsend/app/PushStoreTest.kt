package io.tabsend.app

import io.tabsend.app.push.RelayRef
import io.tabsend.app.push.Retirement
import io.tabsend.app.receive.StreamService
import io.tabsend.app.store.Registration
import io.tabsend.app.store.Store
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * What survives an unpair, and what an unpair can race [2026-10-02, SECURITY_REVIEW G5,
 * G9, G11], against the real Store over an in-memory SharedPreferences.
 */
class PushStoreTest {

    private val registration = Registration(
        endpointId = "ep-1",
        groupId = "g-1",
        deviceToken = "device-token-1",
        relayUrl = "https://relay.example",
        label = "Phone",
    )
    private val target = "ep-1@https://relay.example"

    private fun pairedStore(): Store = Store.over(MemoryPrefs()).apply {
        registration = this@PushStoreTest.registration
    }

    @Test
    fun `unpairing keeps Don't use Google, so the next pairing does not enrol with Google`() {
        val store = pairedStore()
        store.avoidGoogle = true

        store.clear()

        assertFalse(store.isRegistered)
        assertTrue(store.avoidGoogle)
    }

    @Test
    fun `unpairing queues the wake token for retirement, read in the same step as the wipe`() {
        val store = pairedStore()
        assertTrue(store.commitEnrolment(target, "wake-1", "push-1", enrolledAt = 5, resetWatch = true))

        store.leavePairing()

        assertFalse(store.isRegistered)
        assertNull(store.wakeToken)
        assertEquals(
            listOf(
                Retirement(
                    "wake-1",
                    RelayRef("https://relay.example", "ep-1", "device-token-1"),
                    relayMustAccept = false,
                ),
            ),
            store.retirements,
        )
        // And a later unpair keeps what is still owed.
        store.clear()
        assertEquals(1, store.retirements.size)
    }

    @Test
    fun `an enrolment that lands after an unpair is refused`() {
        val store = pairedStore()
        store.leavePairing()
        assertFalse(store.commitEnrolment(target, "wake-2", "push-1", enrolledAt = 9, resetWatch = true))
        assertNull(store.wakeToken)
    }

    @Test
    fun `an enrolment for a relay the phone has since left is refused`() {
        val store = pairedStore()
        assertFalse(store.commitEnrolment("ep-1@https://old.example", "wake-1", "push-1", enrolledAt = 1, resetWatch = true))
        assertNull(store.wakeToken)
    }

    @Test
    fun `a new enrolment starts a new watch for missed wakes`() {
        val store = pairedStore()
        assertTrue(store.commitEnrolment(target, "wake-1", "push-1", enrolledAt = 5, resetWatch = true))
        store.recordWakeVerdict("wake-1", strikeAt = 10, missedAt = 20)
        assertEquals(20L, store.wakesMissedAt)

        assertTrue(store.commitEnrolment(target, "wake-2", "push-1", enrolledAt = 30, resetWatch = true))

        assertNull(store.wakeStrikeAt)
        assertNull(store.wakesMissedAt)
        assertEquals(30L, store.enrolledAt)
    }

    @Test
    fun `a verdict about an enrolment that has since been replaced is dropped`() {
        val store = pairedStore()
        store.commitEnrolment(target, "wake-2", "push-1", enrolledAt = 5, resetWatch = true)
        store.recordWakeVerdict("wake-1", strikeAt = null, missedAt = 20)
        assertNull(store.wakesMissedAt)
    }

    @Test
    fun `a wake clears a strike`() {
        val store = pairedStore()
        store.commitEnrolment(target, "wake-1", "push-1", enrolledAt = 5, resetWatch = true)
        store.recordWakeVerdict("wake-1", strikeAt = 10, missedAt = null)
        store.noteWakeArrived(15)
        assertNull(store.wakeStrikeAt)
        assertEquals(15L, store.lastWakeAt)
    }

    /** StreamService's rule [G10]: a doorbell that stopped ringing is no reason to go without. */
    @Test
    fun `the own connection runs again when wakes stopped arriving, and not while they arrive`() {
        val store = pairedStore()
        assertTrue(StreamService.shouldRun(store)) // no enrolment: own connection

        store.commitEnrolment(target, "wake-1", "push-1", enrolledAt = 5, resetWatch = true)
        assertFalse(StreamService.shouldRun(store)) // Google push carries it

        store.recordWakeVerdict("wake-1", strikeAt = null, missedAt = 20)
        assertTrue(StreamService.shouldRun(store))

        store.instantDelivery = false
        assertFalse(StreamService.shouldRun(store))
    }

    // --- found by the 2026-10-02 verification pass ---------------------------------------

    @Test
    fun `a wake clears a verdict, and says it did so the connection it started can stop`() {
        val store = pairedStore()
        store.commitEnrolment(target, "wake-1", "push-1", enrolledAt = 5, resetWatch = true)
        store.recordWakeVerdict("wake-1", strikeAt = null, missedAt = 20)
        assertTrue(StreamService.shouldRun(store))

        assertTrue(store.noteWakeArrived(30))
        assertNull(store.wakesMissedAt)
        assertFalse(StreamService.shouldRun(store))
        // A second wake has nothing left to clear.
        assertFalse(store.noteWakeArrived(40))
    }

    @Test
    fun `a token Google rotated keeps what was decided about wakes`() {
        val store = pairedStore()
        store.commitEnrolment(target, "wake-1", "push-1", enrolledAt = 5, resetWatch = true)
        store.recordWakeVerdict("wake-1", strikeAt = 10, missedAt = 20)

        assertTrue(store.commitEnrolment(target, "wake-2", "push-2", enrolledAt = 30, resetWatch = false))

        assertEquals(10L, store.wakeStrikeAt)
        assertEquals(20L, store.wakesMissedAt)
    }

    @Test
    fun `leaving a pairing stops waiting on its relay for anything already queued`() {
        val store = pairedStore()
        val relay = RelayRef("https://relay.example", "ep-1", "device-token-1")
        // A none that failed offline, still waiting for this relay to accept it.
        store.updateRetirements { listOf(Retirement("wake-0", relay, relayMustAccept = true)) }

        store.leavePairing()

        assertEquals(listOf(Retirement("wake-0", relay, relayMustAccept = false)), store.retirements)
    }

    @Test
    fun `a new relay address carries a none still owed to that relay`() {
        val store = pairedStore()
        val old = RelayRef("https://relay.example", "ep-1", "device-token-1")
        val elsewhere = RelayRef("https://other.example", "ep-9", "device-token-9")
        store.updateRetirements {
            listOf(
                Retirement("wake-0", old, relayMustAccept = true),
                Retirement("wake-x", elsewhere, relayMustAccept = false),
            )
        }

        store.updateRelay("https://relay.example.org/")

        assertEquals(
            listOf(
                Retirement("wake-0", old.copy(relayUrl = "https://relay.example.org"), relayMustAccept = true),
                Retirement("wake-x", elsewhere, relayMustAccept = false),
            ),
            store.retirements,
        )
    }
}
