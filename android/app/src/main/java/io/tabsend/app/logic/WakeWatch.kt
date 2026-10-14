package io.tabsend.app.logic

/**
 * Has the doorbell stopped ringing? [2026-10-02, SECURITY_REVIEW G10]
 *
 * A phone on Google push closes its own connection on the strength of its enrolment, and
 * nothing then checks that wakes arrive. When they do not, the phone drops to polling every
 * few minutes and the screen goes on saying all is well. The main way it happens is
 * PLANS.md P-9: the relay rings a different wake-up service from the one built into this
 * app, which answers 202 to everyone and rings nobody. A revoked token, an outage or a
 * cleaned-up row look the same from here.
 *
 * The evidence is a tab that arrived some other way (a poll, opening the app) with no wake
 * anywhere near it. One such tab is not enough on its own: a phone that was offline when a
 * tab was sent never gets that tab's wake (Google keeps it five minutes), and then finds the
 * tab exactly the same way. Three things keep that from counting:
 *
 * - A drain is judged only if this phone last reached its relay within [GAP_MS] before it.
 *   A longer gap means it may have been offline the whole time (a flight, a night in
 *   airplane mode, deep Doze), and its tabs prove nothing about the doorbell.
 * - The first unannounced tab is a strike, and any wake clears it. Only a second one, sent
 *   after the first was noticed and so while the phone was back online, is a verdict.
 * - Any wake that arrives clears a verdict too (`Store.noteWakeArrived`): the doorbell
 *   rang, so it works.
 *
 * Times: the caller puts `createdAt` (the relay's clock) on this phone's clock first, with
 * the offset the relay's heartbeat answer reports. The margins below absorb what is left.
 */
object WakeWatch {

    /** A tab younger than this is not judged: its wake may still be on its way. */
    const val SETTLE_MS = 3 * 60 * 1000L

    /**
     * A drain is judged only if the one before it reached the relay within this long. The
     * ~5-minute poll keeps an awake, online phone well inside it; Doze stretches the poll
     * to 9 to 15 minutes, still inside; a longer gap means the phone may have been offline.
     */
    const val GAP_MS = 20 * 60 * 1000L

    /**
     * A wake this close before a tab still counts for it. The wake-up service rings a phone
     * at most six times a minute, so the later tabs of a burst ride on an earlier wake.
     */
    const val COVER_MS = 2 * 60 * 1000L

    enum class Verdict {
        /** Nothing to note. */
        FINE,

        /** One unannounced tab: a strike, not yet a verdict. */
        STRIKE,

        /** A second one: wakes are not arriving. Go back to the app's own connection. */
        MISSED,
    }

    /**
     * Judge the tabs one drain delivered. Only call for a drain a wake did NOT start: a
     * drain a wake started is itself proof that wakes arrive.
     *
     * @param enrolledAt when the relay was handed the current wake token.
     * @param lastWakeAt when a wake last arrived, or null.
     * @param strikeAt when the current strike was recorded, or null.
     * @param previousContactAt when the drain before this one reached the relay, or null.
     * @param delivered when each tab this drain delivered was sent, on this phone's clock.
     */
    fun judge(
        enrolledAt: Long,
        lastWakeAt: Long?,
        strikeAt: Long?,
        previousContactAt: Long?,
        delivered: List<Long>,
        now: Long,
    ): Verdict {
        if (previousContactAt == null || now - previousContactAt > GAP_MS) return Verdict.FINE
        val unannounced = delivered.filter { createdAt ->
            createdAt >= enrolledAt + COVER_MS &&
                now - createdAt >= SETTLE_MS &&
                (lastWakeAt == null || lastWakeAt < createdAt - COVER_MS)
        }
        if (unannounced.isEmpty()) return Verdict.FINE
        // A wake since the strike means the doorbell rang after all.
        val strike = strikeAt?.takeIf { lastWakeAt == null || lastWakeAt < it }
            ?: return Verdict.STRIKE
        return if (unannounced.any { it >= strike + COVER_MS }) Verdict.MISSED else Verdict.FINE
    }
}
