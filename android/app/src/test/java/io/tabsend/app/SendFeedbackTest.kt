package io.tabsend.app

import io.tabsend.app.logic.ALL_API_ERROR_CODES
import io.tabsend.app.logic.ALL_GROUP_LIMITS
import io.tabsend.app.logic.ALL_REJECTION_REASONS
import io.tabsend.app.logic.Feedback
import io.tabsend.app.logic.GaveUpReason
import io.tabsend.app.logic.OUTAGE_GRACE_MS
import io.tabsend.app.logic.OutboundQueue
import io.tabsend.app.logic.RelayHealth
import io.tabsend.app.logic.SendFailure
import io.tabsend.app.logic.SendOutcomeView
import io.tabsend.app.logic.SendTone
import io.tabsend.app.logic.foldRelayContact
import io.tabsend.app.logic.isRelayDown
import io.tabsend.app.logic.minutesSinceLastOk
import io.tabsend.app.logic.parseIsoMillis
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The copy rules from ADR-0008's 2026-07-29 amendment, mirroring
 * extension/src/lib/strings.test.ts. These are the tests that make the
 * hand-mirrored copy safe: `shared/` is TypeScript, so nothing else stops the
 * Kotlin and Swift tables drifting from it or from each other.
 */
class SendFeedbackTest {

    private val label = "Arc · Mac mini"
    private val title = "Setting up a LAN relay"

    // --- what a surface is allowed to claim ---------------------------------

    @Test
    fun `says Sent only when the relay actually took it`() {
        val banner = Feedback.banner(SendOutcomeView(ok = true, queued = false, targetLabel = label, title = title))
        assertEquals(SendTone.SUCCESS, banner.tone)
        assertEquals("Sent to Arc · Mac mini", banner.headline)
        assertEquals(title, banner.title)
        assertNull(banner.detail)
    }

    @Test
    fun `an asleep target is still a success - the relay has it`() {
        val banner = Feedback.banner(SendOutcomeView(ok = true, queued = true, targetLabel = label))
        assertEquals(SendTone.SUCCESS, banner.tone)
        assertEquals("Opens when it wakes", banner.detail)
    }

    /** THE regression: a dead relay used to return ok=true and render as "Sent". */
    @Test
    fun `a tab merely held on this phone is pending, never Sent`() {
        val banner = Feedback.banner(
            SendOutcomeView(
                ok = true, queued = false, targetLabel = label, title = title,
                failure = SendFailure.RelayUnreachable("http://192.168.1.50:8787"),
            ),
        )
        assertEquals(SendTone.PENDING, banner.tone)
        assertEquals("Waiting to send to Arc · Mac mini", banner.headline)
        assertFalse(banner.headline.startsWith("Sent"))
        assertTrue(banner.detail!!.contains("http://192.168.1.50:8787"))
    }

    @Test
    fun `a refusal needs the user, so it reads as an error`() {
        val banner = Feedback.banner(
            SendOutcomeView(
                ok = false, queued = false, targetLabel = label,
                failure = SendFailure.RelayRejected("unknown_target"),
            ),
        )
        assertEquals(SendTone.ERROR, banner.tone)
        assertEquals("Couldn't send to Arc · Mac mini", banner.headline)
        // The device name reaches the status line, not just the headline.
        assertTrue(banner.detail!!.contains(label))
    }

    @Test
    fun `carries the tab title so the user knows WHICH tab it means`() {
        assertEquals(title, Feedback.banner(SendOutcomeView(true, false, label, title)).title)
        assertNull(Feedback.banner(SendOutcomeView(true, false, label)).title)
    }

    // --- the diagnosis ------------------------------------------------------

    @Test
    fun `names the relay address a self-hoster has to go and fix`() {
        val line = Feedback.failureLine(SendFailure.RelayUnreachable("http://192.168.1.50:8787"))
        assertTrue(line.contains("http://192.168.1.50:8787"))
    }

    @Test
    fun `never blames the connection for a relay outage`() {
        val line = Feedback.failureLine(SendFailure.RelayUnreachable("http://mini-pc:8787"))
        assertFalse(line, Regex("(?i)you'?re offline|no connection").containsMatchIn(line))
    }

    /**
     * Every member of BOTH closed wire sets gets a sentence. A relay newer than
     * this app will send codes we have no copy for, so the fallback is checked
     * too — an unrecognised code must fold to the generic line, never render
     * nothing and never leak.
     */
    @Test
    fun `every member of both wire sets produces a line`() {
        val cases = ALL_API_ERROR_CODES.map { SendFailure.RelayError(it) } +
            ALL_REJECTION_REASONS.map { SendFailure.RelayRejected(it) } +
            ALL_GROUP_LIMITS.map { SendFailure.RelayRejected("limit_reached", it) } +
            listOf(
                SendFailure.PhoneOffline,
                SendFailure.RelayUnreachable("http://x"),
                SendFailure.RelayBusy,
                SendFailure.RelayUnauthorized,
                // Tabsend's own two verdicts. Not wire codes, and the only
                // failures the client decides by itself, but a person still has
                // to be told about them in words.
                SendFailure.GaveUp(GaveUpReason.TOO_OLD),
                SendFailure.GaveUp(GaveUpReason.QUEUE_FULL),
                SendFailure.NothingToSend,
                // A relay a version ahead of this app.
                SendFailure.RelayError("some_code_from_the_future"),
                SendFailure.RelayRejected("some_reason_from_the_future"),
                SendFailure.RelayRejected("limit_reached", "a_cap_from_the_future"),
            )
        for (failure in cases) {
            assertTrue("$failure produced no line", Feedback.failureLine(failure, label).isNotEmpty())
        }
    }

    /**
     * No user-facing line may contain a wire code. "Your relay refused the send:
     * Unknown target." was the bug, and the port carried the raw enum instead.
     */
    @Test
    fun `never leaks a machine code into user-facing copy`() {
        val wireCodes = (ALL_API_ERROR_CODES + ALL_REJECTION_REASONS + ALL_GROUP_LIMITS).toSet()
        val cases = ALL_API_ERROR_CODES.map { SendFailure.RelayError(it) } +
            ALL_REJECTION_REASONS.map { SendFailure.RelayRejected(it) } +
            ALL_GROUP_LIMITS.map { SendFailure.RelayRejected("limit_reached", it) } +
            listOf(SendFailure.RelayError("nonsense_code"), SendFailure.RelayRejected("nonsense_reason"))
        for (failure in cases) {
            val line = Feedback.failureLine(failure, label)
            for (code in wireCodes + setOf("nonsense_code", "nonsense_reason")) {
                assertFalse("$failure leaked $code: $line", line.contains(code))
            }
        }
    }

    /**
     * The no-label fallback ("that device") is not a proper noun, so no line may
     * open with it — that reads as a lowercase sentence. This test caught a real
     * bug in the extension.
     */
    @Test
    fun `never opens a sentence with the device name`() {
        val cases = ALL_API_ERROR_CODES.map { SendFailure.RelayError(it) } +
            ALL_REJECTION_REASONS.map { SendFailure.RelayRejected(it) } +
            ALL_GROUP_LIMITS.map { SendFailure.RelayRejected("limit_reached", it) } +
            listOf(
                SendFailure.PhoneOffline,
                SendFailure.RelayBusy,
                SendFailure.RelayUnauthorized,
                SendFailure.GaveUp(GaveUpReason.TOO_OLD),
                SendFailure.GaveUp(GaveUpReason.QUEUE_FULL),
                SendFailure.NothingToSend,
            )
        for (failure in cases) {
            val line = Feedback.failureLine(failure) // no label → the fallback
            assertFalse("$failure opened with the fallback: $line", line.startsWith(Feedback.THAT_DEVICE))
            assertTrue("$failure did not start with a capital: $line", line.first().isUpperCase())
        }
    }

    @Test
    fun `names the device rather than the code it was rejected with`() {
        assertEquals(
            "Your relay doesn't know Arc any more. Pair it again, then send this tab a second time.",
            Feedback.failureLine(SendFailure.RelayRejected("unknown_target"), "Arc"),
        )
    }

    /** Owner preference: no em dashes in the copy added since the locked §4 table. */
    @Test
    fun `uses no em dashes in the newer failure copy`() {
        val cases = ALL_API_ERROR_CODES.map { SendFailure.RelayError(it) } +
            ALL_REJECTION_REASONS.map { SendFailure.RelayRejected(it) } +
            ALL_GROUP_LIMITS.map { SendFailure.RelayRejected("limit_reached", it) } +
            listOf(
                SendFailure.PhoneOffline,
                SendFailure.RelayUnreachable("http://x"),
                SendFailure.RelayBusy,
                SendFailure.RelayUnauthorized,
                SendFailure.GaveUp(GaveUpReason.TOO_OLD),
                SendFailure.GaveUp(GaveUpReason.QUEUE_FULL),
            )
        for (failure in cases) assertFalse(Feedback.failureLine(failure, "Arc").contains("—"))
        assertFalse(Feedback.relayDownLine("http://x", 12).contains("—"))
        assertFalse(Feedback.heldTabsHeading(3).contains("—"))
        assertFalse(Feedback.recoveredLine(2).contains("—"))
    }

    @Test
    fun `only the retry-themselves cases are recoverable`() {
        assertTrue(Feedback.isRecoverable(SendFailure.PhoneOffline))
        assertTrue(Feedback.isRecoverable(SendFailure.RelayUnreachable("http://x")))
        // A 429 or a 5xx is "not now", not "no". Treating it as a refusal
        // DISCARDED the tab, and in a flush discarded the whole queue.
        assertTrue(Feedback.isRecoverable(SendFailure.RelayBusy))
        assertFalse(Feedback.isRecoverable(SendFailure.RelayRejected("unknown_target")))
        // A per-group cap [0030] is the same shape of answer as a 429: it clears
        // itself, so the tab stays queued instead of being thrown away over a
        // wait of about a minute.
        assertTrue(Feedback.isRecoverable(SendFailure.RelayRejected("limit_reached")))
        for (limit in ALL_GROUP_LIMITS) {
            assertTrue(limit, Feedback.isRecoverable(SendFailure.RelayRejected("limit_reached", limit)))
        }
        assertFalse(Feedback.isRecoverable(SendFailure.RelayError("internal")))
        assertFalse(Feedback.isRecoverable(SendFailure.RelayUnauthorized))
        assertFalse(Feedback.isRecoverable(SendFailure.NothingToSend))
        // Giving up is what ENDS the retrying. Reading it as "will retry itself"
        // would put the tab back in the pending tone and re-make the promise the
        // queue has just stopped keeping.
        assertFalse(Feedback.isRecoverable(SendFailure.GaveUp(GaveUpReason.TOO_OLD)))
        assertFalse(Feedback.isRecoverable(SendFailure.GaveUp(GaveUpReason.QUEUE_FULL)))
    }

    /**
     * The one failure Tabsend decides by itself (INTERACTION_FLOWS §4f).
     * Everything else in this set is the relay's verdict or the network's; this
     * is the client saying it has stopped holding a tab, so the sentence carries
     * the number that decided it — "seven days" is the only part of the line a
     * self-hoster can act on.
     */
    @Test
    fun `giving up says how long it waited, or what the cap is`() {
        val tooOld = Feedback.failureLine(SendFailure.GaveUp(GaveUpReason.TOO_OLD), label)
        assertTrue(tooOld.contains("${OutboundQueue.MAX_AGE_DAYS} days"))
        assertTrue(tooOld.contains("Send it again"))

        val full = Feedback.failureLine(SendFailure.GaveUp(GaveUpReason.QUEUE_FULL), label)
        assertTrue(full.contains("${OutboundQueue.MAX_ITEMS}"))
        assertTrue(full.contains("oldest"))
    }

    /** A given-up tab is finished, so it must never read as one still on its way. */
    @Test
    fun `giving up reads as an error, not as a tab still on its way`() {
        val banner = Feedback.banner(
            SendOutcomeView(
                ok = false, queued = false, targetLabel = label, title = title,
                failure = SendFailure.GaveUp(GaveUpReason.TOO_OLD),
            ),
        )
        assertEquals(SendTone.ERROR, banner.tone)
    }

    /**
     * A per-group cap [0030] refuses one item at a time, inside a 200. Every one
     * of those caps clears itself, so the refusal is a WAIT and the copy has to
     * say so — the app is already holding the tab and retrying it. Before this,
     * every cap refusal rendered "Something went wrong inside your relay", which
     * named no cause and asked for the wrong action.
     *
     * Mirrors strings.test.ts / SendFeedbackTests.swift.
     */
    @Test
    fun `a cap refusal names the wait rather than blaming the relay`() {
        assertEquals(
            "Your relay is pacing sends for your group right now. This tab is queued and " +
                "will send itself shortly.",
            Feedback.failureLine(SendFailure.RelayRejected("limit_reached", "sends_per_window"), label),
        )
        for (limit in listOf("queued_messages", "queued_bytes")) {
            assertEquals(
                "Your relay is holding as much as your group's limit allows. This tab is queued " +
                    "and will send once the receiving device catches up.",
                Feedback.failureLine(SendFailure.RelayRejected("limit_reached", limit), label),
            )
        }
        // A relay that names no cap, or names a fifth one this build has never
        // heard of, still gets a true sentence and not the internal-error line.
        val general = "Your relay has reached a limit for your group. This tab is queued and " +
            "will send itself once there is room."
        assertEquals(general, Feedback.failureLine(SendFailure.RelayRejected("limit_reached"), label))
        assertEquals(
            general,
            Feedback.failureLine(SendFailure.RelayRejected("limit_reached", "a_fifth_cap"), label),
        )
    }

    /** A cap-held tab is still on its way, so it must not read as a failure. */
    @Test
    fun `a cap refusal reads as pending and promises the retry`() {
        val banner = Feedback.banner(
            SendOutcomeView(
                ok = true, queued = false, targetLabel = label, title = title,
                failure = SendFailure.RelayRejected("limit_reached", "sends_per_window"),
            ),
        )
        assertEquals(SendTone.PENDING, banner.tone)
        assertEquals("Waiting to send to Arc · Mac mini", banner.headline)
        assertFalse(banner.headline.startsWith("Sent"))
        assertTrue(banner.detail!!.contains("will send itself shortly"))
    }

    /**
     * The OTHER half of [0030], and the opposite kind of answer: the endpoint
     * cap refuses a whole register call, and a group that is full stays full
     * until a person removes a device. So this line asks for an action where the
     * cap lines above promise a retry, and it must never fold to the
     * internal-error line — a relay enforcing its own cap is not a fault.
     *
     * Word-for-word the same sentence in `strings.ts` and `SendFeedback.swift`.
     */
    @Test
    fun `the device cap names the action rather than blaming the relay`() {
        val line = Feedback.failureLine(SendFailure.RelayError("limit_reached"), label)
        assertEquals(
            "Your relay has reached its device limit for your group. Remove a device you are " +
                "not using, then pair this one again.",
            line,
        )
        assertEquals(Feedback.DEVICE_LIMIT_LINE, line)
        assertFalse(line.contains("went wrong"))
        // A join is not a send: nothing was queued, so nothing may read as pending.
        assertFalse(Feedback.isRecoverable(SendFailure.RelayError("limit_reached")))
    }

    /** A held tab is pending, and its line must promise the retry it will make. */
    @Test
    fun `a busy relay reads as pending and promises the retry`() {
        val banner = Feedback.banner(
            SendOutcomeView(
                ok = true, queued = false, targetLabel = label, title = title,
                failure = SendFailure.RelayBusy,
            ),
        )
        assertEquals(SendTone.PENDING, banner.tone)
        assertEquals("Waiting to send to Arc · Mac mini", banner.headline)
        assertTrue(banner.detail!!.contains("sends itself"))
    }

    // --- the held-tab list --------------------------------------------------

    @Test
    fun `held tab prefers the page title, falls back to the site`() {
        assertEquals("An article", Feedback.heldTabLabel("An article", "https://example.com/a"))
        // A bare path tells nobody anything; the site at least places the tab.
        assertEquals(
            "developer.mozilla.org",
            Feedback.heldTabLabel(null, "https://developer.mozilla.org/en-US/docs/Web"),
        )
        assertEquals("example.com", Feedback.heldTabLabel("   ", "https://example.com/x"))
        assertEquals("example.com", Feedback.heldTabLabel(null, "https://example.com:8443/x?a=1"))
        assertEquals("not a url", Feedback.heldTabLabel(null, "not a url"))
        assertEquals("Untitled tab", Feedback.heldTabLabel(null, null))
    }

    @Test
    fun `held heading counts, and reads naturally at one`() {
        assertEquals("Waiting on this phone", Feedback.heldTabsHeading(1))
        assertEquals("3 tabs waiting on this phone", Feedback.heldTabsHeading(3))
    }

    @Test
    fun `names the tab when exactly one drained`() {
        assertEquals("Sent “An article”", Feedback.recoveredLine(1, "An article"))
        assertEquals("Sent the tab that was waiting", Feedback.recoveredLine(1))
        assertEquals("Sent 4 tabs that were waiting", Feedback.recoveredLine(4))
    }

    @Test
    fun `relay down line names the address and how long it has been quiet`() {
        val line = Feedback.relayDownLine("http://192.168.1.50:8787", 12)
        assertTrue(line.contains("http://192.168.1.50:8787"))
        assertTrue(line.contains("12m ago"))
        assertTrue(Feedback.relayDownLine("http://x", 125).contains("2h ago"))
        assertTrue(Feedback.relayDownLine("http://x", 0).contains("just now"))
    }

    // --- relay health -------------------------------------------------------

    @Test
    fun `an outage is only announced after the grace period`() {
        val now = parseIsoMillis("2026-07-29T12:00:00Z")!!
        val health = RelayHealth("http://x", reachable = false, since = "2026-07-29T11:59:45Z")
        // 15s in: a container restart, not a fact worth telling anyone.
        assertFalse(isRelayDown(health, now))
        assertTrue(isRelayDown(health, now + OUTAGE_GRACE_MS))
        assertFalse(isRelayDown(health.copy(reachable = true), now + OUTAGE_GRACE_MS))
        assertFalse(isRelayDown(null, now))
    }

    /**
     * `since` must survive a same-state refresh. If each report reset it, an
     * outage would perpetually read as "started just now" and never clear the
     * grace period that gates the warning — the warning would never appear.
     */
    @Test
    fun `same-state refresh keeps when the state began`() {
        val t0 = parseIsoMillis("2026-07-29T12:00:00Z")!!
        val first = foldRelayContact(null, "http://x", reachable = false, nowMs = t0, lastWriteMs = 0)
        assertNotNull(first)
        assertEquals("2026-07-29T12:00:00Z", first!!.since)

        // Within the throttle: nothing to write at all.
        assertNull(foldRelayContact(first, "http://x", false, t0 + 5_000, t0))
        // Past it: written, but `since` still points at when the outage began.
        val refreshed = foldRelayContact(first, "http://x", false, t0 + 30_000, t0)
        assertEquals(first.since, refreshed!!.since)
        assertTrue(isRelayDown(refreshed, t0 + 30_000))

        // A transition always writes, and restamps.
        val back = foldRelayContact(refreshed, "http://x", true, t0 + 31_000, t0 + 30_000)
        assertTrue(back!!.reachable)
        assertEquals(isoLike(t0 + 31_000), back.since)
        assertEquals(back.since, back.lastOkAt)
    }

    @Test
    fun `an unreachable verdict remembers when the relay last answered`() {
        val t0 = parseIsoMillis("2026-07-29T12:00:00Z")!!
        val ok = foldRelayContact(null, "http://x", true, t0, 0)!!
        val down = foldRelayContact(ok, "http://x", false, t0 + 60_000, t0)!!
        assertEquals(ok.lastOkAt, down.lastOkAt)
        assertEquals(1, minutesSinceLastOk(down, t0 + 60_000))
        assertEquals(75, minutesSinceLastOk(down, t0 + 75 * 60_000))
    }

    private fun isoLike(ms: Long): String = io.tabsend.app.logic.isoOf(ms)
}
