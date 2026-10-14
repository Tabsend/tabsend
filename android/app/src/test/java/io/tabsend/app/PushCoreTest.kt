package io.tabsend.app

import io.tabsend.app.push.DeliveryMode
import io.tabsend.app.push.DeliveryReason
import io.tabsend.app.push.Enrolment
import io.tabsend.app.push.ForwarderPort
import io.tabsend.app.push.GooglePort
import io.tabsend.app.push.PushCore
import io.tabsend.app.push.PushState
import io.tabsend.app.push.RelayAnswer
import io.tabsend.app.push.RelayForwarder
import io.tabsend.app.push.RelayPort
import io.tabsend.app.push.RelayRef
import io.tabsend.app.push.Retirement
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Android's Google push lifecycle, end to end against fakes [2026-10-02, SECURITY_REVIEW
 * G3, G4, G8, G9, G10, G11, G24]. Until these, no unit test touched the app's push code.
 *
 * Every fake records what it was asked, in order, in one shared log, so a test can say what
 * must and must not have happened and in what order.
 */
class PushCoreTest {

    private val relayA = RelayRef("https://relay.example", "ep-1", "device-token-1")
    private val relayB = RelayRef("https://other.example", "ep-9", "device-token-9")

    private val calls = mutableListOf<String>()
    private var clock = 1_000_000L

    private inner class FakeState : PushState {
        override var paired: RelayRef? = relayA
        override var instantDelivery = true
        override var avoidGoogle = false
        override var enrolment: Enrolment? = null
        override var wakesMissedAt: Long? = null
        override var retirements: List<Retirement> = emptyList()
        override var relayForwarderKnown: Boolean? = null
        override var lastWakeAt: Long? = null
        override var wakeStrikeAt: Long? = null
        override var previousContactAt: Long? = null
        override var relayClockOffsetMs: Long = 0L

        override fun commitEnrolment(expectedTarget: String, enrolment: Enrolment, resetWatch: Boolean): Boolean {
            val current = paired ?: return false
            if (PushCore.target(current) != expectedTarget) return false
            this.enrolment = enrolment
            if (resetWatch) {
                wakesMissedAt = null
                wakeStrikeAt = null
            }
            return true
        }

        override fun recordWakeVerdict(judgedWakeToken: String, strikeAt: Long?, missedAt: Long?) {
            if (enrolment?.wakeToken != judgedWakeToken) return
            if (strikeAt != null) wakeStrikeAt = strikeAt
            if (missedAt != null) wakesMissedAt = missedAt
        }

        override fun retireEnrolment(retirement: Retirement) {
            enrolment = null
            wakesMissedAt = null
            wakeStrikeAt = null
            retirements = retirements + retirement
        }

        override fun updateRetirements(transform: (List<Retirement>) -> List<Retirement>) {
            retirements = transform(retirements)
        }
    }

    private inner class FakeRelay : RelayPort {
        var forwarder = RelayForwarder.YES
        var answer = RelayAnswer.ACCEPTED
        /** When set, the answer to a `none` only: a relay that refuses one call and takes the next. */
        var noneAnswer: RelayAnswer? = null
        /** The endpoint's one subscription slot, as the relay keeps it. */
        val slot = mutableMapOf<String, String?>()

        override fun forwarderAdvertised(relay: RelayRef): RelayForwarder {
            calls += "config ${relay.endpointId}"
            return forwarder
        }

        override fun setSubscription(relay: RelayRef, wakeToken: String?): RelayAnswer {
            calls += "relay ${relay.endpointId} ${wakeToken ?: "none"}"
            val reply = if (wakeToken == null) noneAnswer ?: answer else answer
            if (reply == RelayAnswer.ACCEPTED) slot[relay.endpointId] = wakeToken
            return reply
        }
    }

    private inner class FakeForwarder : ForwarderPort {
        var reachable = true
        private var minted = 0
        override fun register(pushToken: String): String? {
            if (!reachable) return null
            minted += 1
            calls += "register $pushToken -> wake-$minted"
            return "wake-$minted"
        }

        override fun revoke(wakeToken: String): Boolean {
            calls += "revoke $wakeToken${if (reachable) "" else " (unreachable)"}"
            return reachable
        }
    }

    private inner class FakeGoogle : GooglePort {
        override var configured = true
        var hasPlayServices: Boolean? = true
        var inUseFlag = false
        var pushToken: String? = "push-1"
        var reachable = true
        /** When set, `token()` waits for it: lets a test hold a sync mid-enrolment. */
        var gate: CompletableDeferred<Unit>? = null

        override fun available(): Boolean? = hasPlayServices
        override fun inUse(): Boolean = inUseFlag

        override suspend fun token(): String? {
            calls += "google token"
            inUseFlag = true
            gate?.await()
            return pushToken
        }

        override suspend fun forget(): Boolean {
            calls += "google forget${if (reachable) "" else " (unreachable)"}"
            if (!reachable) return false
            inUseFlag = false
            return true
        }
    }

    private val state = FakeState()
    private val relay = FakeRelay()
    private val forwarder = FakeForwarder()
    private val google = FakeGoogle()

    private fun core(withForwarder: Boolean = true) =
        PushCore(state, relay, if (withForwarder) forwarder else null, google, now = { clock })

    private fun enrolled(): Enrolment {
        runBlocking { core().sync() }
        calls.clear()
        return requireNotNull(state.enrolment)
    }

    // --- the happy path, so the rest have something to break -------------------------

    @Test
    fun `enrols, tells the relay before saving, and then reports Google push`() = runBlocking {
        val settled = core().sync()

        assertEquals(
            listOf("config ep-1", "google token", "register push-1 -> wake-1", "relay ep-1 wake-1"),
            calls,
        )
        assertEquals(Enrolment("wake-1", "push-1", "ep-1@https://relay.example", clock), state.enrolment)
        assertEquals(DeliveryMode.GOOGLE, settled.mode)
    }

    @Test
    fun `a steady enrolment costs one question to the relay and nothing else`() = runBlocking {
        enrolled()
        core().sync()
        assertEquals(listOf("config ep-1", "google token"), calls)
    }

    // --- G8: offline is "no change", and retirements are kept until they land ----------

    @Test
    fun `an unreachable relay changes nothing, so a working enrolment is kept`() = runBlocking {
        val before = enrolled()
        relay.forwarder = RelayForwarder.UNKNOWN

        val settled = core().sync()

        assertEquals(before, state.enrolment)
        assertTrue(state.retirements.isEmpty())
        assertEquals(listOf("config ep-1"), calls)
        assertEquals(DeliveryMode.GOOGLE, settled.mode)
    }

    @Test
    fun `an unreachable relay does not start an enrolment either`() = runBlocking {
        relay.forwarder = RelayForwarder.UNKNOWN
        core().sync()
        assertEquals(listOf("config ep-1"), calls)
        assertNull(state.enrolment)
        assertFalse(google.inUseFlag)
    }

    @Test
    fun `don't use Google, tapped offline, keeps the token until the relay accepts none`() = runBlocking {
        enrolled()
        state.avoidGoogle = true
        relay.answer = RelayAnswer.UNREACHABLE

        val offline = core().sync()

        // The phone stops relying on Google at once: its own connection takes over...
        assertNull(state.enrolment)
        assertEquals(DeliveryMode.OWN_CONNECTION, offline.mode)
        // ...but the token is not forgotten, and the forwarder is not told, while the relay
        // still holds it: a relay ringing a revoked token rings nobody.
        assertEquals(listOf(Retirement("wake-1", relayA, relayMustAccept = true)), state.retirements)
        assertFalse(calls.any { it.startsWith("revoke") })

        calls.clear()
        relay.answer = RelayAnswer.ACCEPTED
        core().sync()

        assertEquals(listOf("relay ep-1 none", "revoke wake-1"), calls.filter { !it.startsWith("google") })
        assertTrue(state.retirements.isEmpty())
    }

    @Test
    fun `a retirement the forwarder cannot hear yet is tried again`() = runBlocking {
        enrolled()
        state.instantDelivery = false
        forwarder.reachable = false

        core().sync()
        assertEquals(1, state.retirements.size)
        assertNull(state.retirements.single().relay) // the relay step is done and kept done

        forwarder.reachable = true
        calls.clear()
        core().sync()
        assertEquals(listOf("revoke wake-1"), calls.filter { it.startsWith("revoke") || it.startsWith("relay") })
        assertTrue(state.retirements.isEmpty())
    }

    @Test
    fun `a relay that says it has no wake-up service retires the enrolment, and the screen says why`() =
        runBlocking {
            enrolled()
            relay.forwarder = RelayForwarder.NO

            val settled = core().sync()

            assertNull(state.enrolment)
            assertTrue(calls.containsAll(listOf("relay ep-1 none", "revoke wake-1")))
            assertEquals(DeliveryReason.NO_FORWARDER, settled.reason)
        }

    // --- G3: Google is forgotten whenever it is not wanted -------------------------------

    @Test
    fun `retiring Google push deletes the push token and installation, retried until it works`() =
        runBlocking {
            enrolled()
            state.avoidGoogle = true
            google.reachable = false

            core().sync()
            assertTrue(calls.contains("google forget (unreachable)"))
            assertTrue(google.inUseFlag)

            google.reachable = true
            calls.clear()
            core().sync()
            assertTrue(calls.contains("google forget"))
            assertFalse(google.inUseFlag)
        }

    @Test
    fun `an enrolment that never completed still leaves nothing at Google once refused`() = runBlocking {
        // The forwarder was down, so the phone got a push token and nothing more.
        forwarder.reachable = false
        core().sync()
        assertTrue(google.inUseFlag)
        assertNull(state.enrolment)

        state.avoidGoogle = true
        calls.clear()
        core().sync()
        assertEquals(listOf("google forget"), calls)
        assertFalse(google.inUseFlag)
    }

    @Test
    fun `a phone that never used Google is not asked to forget anything`() = runBlocking {
        state.avoidGoogle = true
        core().sync()
        assertTrue(calls.isEmpty())
    }

    // --- G4: no Play Services means no enrolment, and nothing sent to Google -------------

    @Test
    fun `a phone without Play Services is never asked for a token`() = runBlocking {
        google.hasPlayServices = false
        val settled = core().sync()
        assertTrue(calls.isEmpty())
        assertFalse(google.inUseFlag)
        assertEquals(DeliveryReason.GOOGLE_UNAVAILABLE, settled.reason)
    }

    // --- G9: leaving (unpair or Start fresh) retires through the queue -------------------

    @Test
    fun `a left pairing tells its old relay once, and the forwarder until it hears`() = runBlocking {
        enrolled()
        // What Store.leavePairing leaves behind: no pairing, the token queued.
        state.paired = null
        state.enrolment = null
        state.retirements = listOf(Retirement("wake-1", relayA, relayMustAccept = false))
        relay.answer = RelayAnswer.UNREACHABLE
        forwarder.reachable = false

        core().sync()
        // The old relay may be gone for good, so it is told once and not waited for.
        assertEquals(listOf(Retirement("wake-1", null, relayMustAccept = false)), state.retirements)
        assertTrue(calls.contains("google forget"))

        forwarder.reachable = true
        calls.clear()
        core().sync()
        assertEquals(listOf("revoke wake-1"), calls)
        assertTrue(state.retirements.isEmpty())
    }

    // --- G11: one lock, and no enrolment saved after an unpair ---------------------------

    @Test
    fun `an enrolment that finishes after an unpair is retired, not saved`() = runBlocking {
        val gate = CompletableDeferred<Unit>()
        google.gate = gate
        val enrolling = async { core().sync() }
        while (!calls.contains("google token")) yield()

        // The user unpairs while Google is still answering.
        state.paired = null
        gate.complete(Unit)
        enrolling.await()

        assertNull(state.enrolment)
        assertTrue(calls.contains("relay ep-1 wake-1"))
        assertTrue(calls.contains("relay ep-1 none"))
        assertTrue(calls.contains("revoke wake-1"))
        assertTrue(state.retirements.isEmpty())
    }

    @Test
    fun `two syncs never interleave`() = runBlocking {
        val gate = CompletableDeferred<Unit>()
        google.gate = gate
        val first = async { core().sync() }
        while (!calls.contains("google token")) yield()
        val second = async { core().sync() }
        repeat(50) { yield() }

        // The second has not even asked the relay while the first is mid-enrolment.
        assertEquals(listOf("config ep-1", "google token"), calls)

        google.gate = null
        gate.complete(Unit)
        first.await()
        second.await()
        // One enrolment, one wake token: the second found the first's and left it alone.
        assertEquals(1, calls.count { it.startsWith("register") })
        assertEquals("wake-1", state.enrolment?.wakeToken)
    }

    // --- G10: wakes that stopped arriving -------------------------------------------------

    @Test
    fun `a phone whose wakes stopped arriving says so and keeps its own connection`() {
        enrolled()
        state.wakesMissedAt = clock
        val shown = core().delivery()
        assertEquals(DeliveryMode.OWN_CONNECTION, shown.mode)
        assertEquals(DeliveryReason.GOOGLE_NOT_ARRIVING, shown.reason)
    }

    @Test
    fun `trying Google push again mints a fresh wake token and starts a fresh watch`() = runBlocking {
        enrolled()
        state.wakesMissedAt = clock
        clock += 60_000

        val settled = core().retryGoogle()

        assertEquals(listOf("config ep-1", "google token", "register push-1 -> wake-2", "relay ep-1 wake-2"), calls)
        assertEquals("wake-2", state.enrolment?.wakeToken)
        assertEquals(clock, state.enrolment?.enrolledAt)
        assertNull(state.wakesMissedAt)
        assertEquals(DeliveryMode.GOOGLE, settled.mode)
    }

    @Test
    fun `a retry the relay never hears does not leave a dead token claimed`() = runBlocking {
        enrolled()
        state.wakesMissedAt = clock
        relay.answer = RelayAnswer.UNREACHABLE

        val settled = core().retryGoogle()

        // Re-registering the same push token replaced wake-1 at the forwarder, so neither
        // wake-1 nor wake-2 rings anything now. Claiming either would be the silence G10 is
        // about.
        assertNull(state.enrolment)
        assertTrue(calls.contains("revoke wake-2"))
        assertNotNull(state.retirements.singleOrNull { it.wakeToken == "wake-1" })
        assertEquals(DeliveryMode.OWN_CONNECTION, settled.mode)
    }

    // --- relay switch (ADR-0013), unchanged ---------------------------------------------

    @Test
    fun `a relay switch re-announces the same wake token rather than minting another`() = runBlocking {
        enrolled()
        state.wakesMissedAt = clock // about the old relay, which may ring another service
        state.paired = relayB
        clock += 5_000
        core().sync()
        assertEquals(listOf("config ep-9", "google token", "relay ep-9 wake-1"), calls)
        assertEquals("ep-9@https://other.example", state.enrolment?.announcedTo)
        assertEquals(clock, state.enrolment?.enrolledAt)
        assertNull(state.wakesMissedAt)
    }

    // --- found by the verification pass ---------------------------------------------------

    /**
     * A `none` that failed offline, then Google push turned back on while the relay refused
     * the `none` once more but took the new token. The queued `none` must never reach the
     * relay after that: it would overwrite the live enrolment in the endpoint's one slot,
     * and the phone would believe it was on Google push while nothing rang it.
     */
    @Test
    fun `a queued none never overwrites an enrolment the relay took after it`() = runBlocking {
        enrolled()
        state.avoidGoogle = true
        relay.answer = RelayAnswer.UNREACHABLE
        core().sync() // the none fails; wake-1 waits in the queue

        state.avoidGoogle = false
        relay.answer = RelayAnswer.ACCEPTED
        relay.noneAnswer = RelayAnswer.REFUSED
        core().sync() // the none is refused again, the new enrolment goes through
        assertEquals("wake-2", state.enrolment?.wakeToken)
        assertEquals("wake-2", relay.slot["ep-1"])

        relay.noneAnswer = null
        calls.clear()
        core().sync()
        assertFalse(calls.contains("relay ep-1 none"))
        assertEquals("wake-2", relay.slot["ep-1"])
        assertTrue(calls.contains("revoke wake-1")) // the forwarder step still happens
        assertTrue(state.retirements.isEmpty())
    }

    @Test
    fun `a re-announced token also clears a none still queued for that endpoint`() = runBlocking {
        enrolled()
        // An older token is still owed a none at this endpoint, and the relay has a new address.
        state.retirements = listOf(Retirement("wake-0", relayA, relayMustAccept = true))
        state.paired = relayA.copy(relayUrl = "https://relay.example.org")
        relay.noneAnswer = RelayAnswer.REFUSED
        core().sync()
        assertEquals("wake-1", relay.slot["ep-1"])

        relay.noneAnswer = null
        calls.clear()
        core().sync()
        assertFalse(calls.any { it.endsWith(" none") })
        assertEquals("wake-1", relay.slot["ep-1"])
        assertTrue(state.retirements.isEmpty())
    }

    @Test
    fun `Play Services in the middle of an update changes nothing`() = runBlocking {
        val before = enrolled()
        google.hasPlayServices = null
        core().sync()
        assertEquals(before, state.enrolment)
        assertTrue(calls.isEmpty())
        assertTrue(google.inUseFlag)
    }

    @Test
    fun `the same relay at a new address keeps what was decided about wakes`() = runBlocking {
        enrolled()
        state.wakesMissedAt = clock
        state.paired = relayA.copy(relayUrl = "https://relay.example.org")
        core().sync()
        assertEquals("ep-1@https://relay.example.org", state.enrolment?.announcedTo)
        assertEquals(clock, state.wakesMissedAt)
    }

    @Test
    fun `a token Google rotated keeps what was decided about wakes`() = runBlocking {
        enrolled()
        state.wakesMissedAt = clock
        google.pushToken = "push-2"
        core().sync()
        assertEquals("wake-2", state.enrolment?.wakeToken)
        assertEquals(clock, state.wakesMissedAt)
    }

    // --- judging a drain no wake started [G10] -------------------------------------------

    private val minute = 60_000L

    @Test
    fun `two unannounced tabs while in touch with the relay make a verdict`() {
        enrolled()
        val enrolledAt = requireNotNull(state.enrolment).enrolledAt
        var now = enrolledAt + 60 * minute
        state.previousContactAt = now - 5 * minute
        assertFalse(core().judgeDrain(listOf(now - 4 * minute), now))
        assertEquals(now, state.wakeStrikeAt)
        assertNull(state.wakesMissedAt)

        now += 30 * minute
        state.previousContactAt = now - 5 * minute
        assertTrue(core().judgeDrain(listOf(now - 4 * minute), now))
        assertEquals(now, state.wakesMissedAt)
    }

    @Test
    fun `a drain after a long gap in contact is not judged`() {
        enrolled()
        val now = requireNotNull(state.enrolment).enrolledAt + 600 * minute
        state.previousContactAt = now - 8 * 60 * minute // offline overnight
        assertFalse(core().judgeDrain(listOf(now - 7 * 60 * minute), now))
        assertNull(state.wakeStrikeAt)
    }

    @Test
    fun `tab times are put on this phone's clock before they are judged`() {
        enrolled()
        val now = requireNotNull(state.enrolment).enrolledAt + 60 * minute
        state.previousContactAt = now - 5 * minute
        // The relay's clock runs five minutes behind: a tab sent thirty seconds ago reads as
        // five and a half minutes old, old enough to judge. Corrected, it is too new to judge.
        state.relayClockOffsetMs = -5 * minute
        assertFalse(core().judgeDrain(listOf(now - 5 * minute - 30_000), now))
        assertNull(state.wakeStrikeAt)
    }

    @Test
    fun `nothing is judged without an enrolment, or once a verdict stands`() {
        val now = clock + 60 * minute
        state.previousContactAt = now - 5 * minute
        assertFalse(core().judgeDrain(listOf(now - 4 * minute), now))
        enrolled()
        state.wakesMissedAt = clock
        state.wakeStrikeAt = null
        assertFalse(core().judgeDrain(listOf(now - 4 * minute), now))
        assertNull(state.wakeStrikeAt)
    }
}
