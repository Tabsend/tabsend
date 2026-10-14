package io.tabsend.app

import io.tabsend.app.logic.WakeWatch
import io.tabsend.app.logic.WakeWatch.Verdict
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * When a phone on Google push decides its wakes stopped arriving [2026-10-02,
 * SECURITY_REVIEW G10]. The case that matters is PLANS.md P-9 (the relay rings a different
 * wake-up service, which rings nobody); the cases that must NOT trip it are a phone that
 * was simply offline, and a burst the wake-up service rate-limited.
 */
class WakeWatchTest {

    private val minute = 60_000L
    private val enrolledAt = 1_000_000_000L

    /** The rule, with the phone last in touch with its relay five minutes before [now]. */
    private fun judge(
        enrolledAt: Long,
        lastWakeAt: Long?,
        strikeAt: Long?,
        delivered: List<Long>,
        now: Long,
        previousContactAt: Long? = now - 5 * minute,
    ) = WakeWatch.judge(enrolledAt, lastWakeAt, strikeAt, previousContactAt, delivered, now)

    @Test
    fun `P-9, no wake ever arrives - one strike, then the second unannounced tab decides it`() {
        val first = enrolledAt + 60 * minute
        val foundAt = first + 5 * minute
        assertEquals(Verdict.STRIKE, judge(enrolledAt, null, null, listOf(first), foundAt))

        val second = foundAt + 30 * minute
        assertEquals(
            Verdict.MISSED,
            judge(enrolledAt, null, foundAt, listOf(second), second + 5 * minute),
        )
    }

    @Test
    fun `an offline spell is one strike, and the next wake clears it`() {
        // Sent while the phone was in a tunnel: Google dropped the wake after five minutes.
        val sent = enrolledAt + 60 * minute
        val back = sent + 40 * minute
        assertEquals(Verdict.STRIKE, judge(enrolledAt, null, null, listOf(sent), back))

        // Back online, the next tab's wake arrives: the doorbell works.
        val wake = back + 10 * minute
        val later = wake + 60 * minute
        assertEquals(
            Verdict.STRIKE,
            judge(enrolledAt, wake, back, listOf(later), later + 5 * minute),
        )
    }

    @Test
    fun `tabs from the same spell are one strike, however many there are`() {
        val strike = enrolledAt + 100 * minute
        val sameSpell = listOf(strike - 20 * minute, strike - 10 * minute, strike - minute)
        assertEquals(Verdict.FINE, judge(enrolledAt, null, strike, sameSpell, strike + minute))
    }

    @Test
    fun `a burst the wake-up service rate-limited rides on its earlier wake`() {
        val wake = enrolledAt + 60 * minute
        val burst = listOf(wake + 10_000, wake + 30_000, wake + 50_000)
        assertEquals(Verdict.FINE, judge(enrolledAt, wake, null, burst, wake + 10 * minute))
    }

    @Test
    fun `a tab whose wake may still be on its way is not judged`() {
        val sent = enrolledAt + 60 * minute
        assertEquals(Verdict.FINE, judge(enrolledAt, null, null, listOf(sent), sent + minute))
    }

    @Test
    fun `a tab sent before the relay had the wake token is not judged`() {
        val sent = enrolledAt + 30_000
        assertEquals(Verdict.FINE, judge(enrolledAt, null, null, listOf(sent), sent + 30 * minute))
    }

    @Test
    fun `a tab announced by a wake is fine, and so is a drain with nothing new`() {
        val sent = enrolledAt + 60 * minute
        assertEquals(Verdict.FINE, judge(enrolledAt, sent + 2_000, null, listOf(sent), sent + 10 * minute))
        assertEquals(Verdict.FINE, judge(enrolledAt, null, null, emptyList(), sent))
    }

    /**
     * Found by the 2026-10-02 verification pass: two nights in airplane mode, a tab sent each
     * night and none by day, read as a doorbell that stopped ringing. Each morning's first
     * check-in follows a long gap in contact, so neither night's tab is judged.
     */
    @Test
    fun `tabs found after a long gap in contact are not judged`() {
        val night = enrolledAt + 24 * 60 * minute
        val morning = night + 7 * 60 * minute
        assertEquals(
            Verdict.FINE,
            judge(enrolledAt, null, null, listOf(night), morning, previousContactAt = night - 60 * minute),
        )
        assertEquals(
            Verdict.FINE,
            judge(enrolledAt, null, null, listOf(night), morning, previousContactAt = null),
        )
        // In touch the whole time, the same tab is evidence.
        assertEquals(Verdict.STRIKE, judge(enrolledAt, null, null, listOf(night), night + 10 * minute))
    }
}
