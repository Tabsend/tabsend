package io.tabsend.app.logic

/**
 * The two gentle asks inside the app [PLANS.md P-22]: the share box on Home and the review
 * pop-up. Pure rules, no clock of their own (the caller passes `now`), so every date below is
 * tested. The iPhone's twin is `InAppAsks.swift`; the numbers and the order are the same.
 */
object InAppAsks {
    private const val DAY_MS: Long = 24L * 60 * 60 * 1000

    /** Hidden for a year after a dismissal or a tap on Share, then it may return. */
    const val SHARE_HIDDEN_DAYS: Int = 365

    /** A self-hosted group is asked only this long after this phone first showed the paired Home. */
    const val SHARE_SELF_HOSTED_AFTER_DAYS: Int = 30

    /** The share box and a review ask keep this far apart, in both directions. */
    const val GAP_BETWEEN_ASKS_DAYS: Int = 14

    /** A review ask waits this long after this phone first showed the paired Home. */
    const val REVIEW_AFTER_DAYS: Int = 7

    /** At least this long between two review asks. */
    const val REVIEW_MIN_SPACING_DAYS: Int = 120

    /** At most [REVIEW_MAX_PER_YEAR] review asks in any rolling 365 days. */
    const val REVIEW_MAX_PER_YEAR: Int = 3

    /** Both asks need a group of at least this many devices (this phone counts). */
    const val MIN_DEVICES: Int = 2

    /** Which words the share box and the Share rows use. */
    enum class ShareVariant {
        /** "$5 off your next payment when a friend subscribes": Share opens the account site's Share page. */
        Credit,

        /** A plain "would you share it": Share opens the system share sheet. */
        Plain,
    }

    /**
     * The variant for this phone. Credit needs the account door ([accountDoorAllowed], the same
     * rule as "Manage account") and a group on Tabsend's service with an account; anything else
     * is plain.
     */
    fun shareVariant(accountDoorAllowed: Boolean, plan: ServicePlan?): ShareVariant =
        if (accountDoorAllowed && plan == ServicePlan.Account) ShareVariant.Credit else ShareVariant.Plain

    /** Tabsend's own relays. The extension and console use the same two names. */
    private val HOSTED_HOSTS = setOf("app.tabsend.org", "demo.tabsend.org")

    /** True when [relayUrl] is Tabsend's own service, whatever plan the relay has reported so far. */
    fun isHostedRelay(relayUrl: String): Boolean {
        val host = Regex("^[a-z][a-z0-9+.-]*://(?:[^/?#@]*@)?([^/?#:]+)", RegexOption.IGNORE_CASE)
            .find(relayUrl.trim())?.groupValues?.get(1) ?: return false
        return host.lowercase() in HOSTED_HOSTS
    }

    /**
     * What the share box on the paired Home shows, or null for no box.
     *
     * - A trial or an ended trial never shows it (the Settings row still works).
     * - An account shows it, credit or plain by [shareVariant].
     * - A hosted group whose plan is not known yet ([relayIsHosted]) gets no box: it could be a
     *   trial, and asking it to share would be wrong. It is not treated as self-hosted.
     * - A self-hosted group (no plan known) gets the plain box, and only once this phone first
     *   showed the paired Home 30 days ago and the group has 2 or more devices.
     * - Hidden for a year after [dismissedAt]; a review ask in this session, or within 14 days
     *   either way, keeps it away.
     */
    fun shareBox(
        now: Long,
        plan: ServicePlan?,
        accountDoorAllowed: Boolean,
        firstHomeAt: Long?,
        deviceCount: Int,
        dismissedAt: Long?,
        lastReviewAskAt: Long?,
        reviewAskedThisSession: Boolean,
        relayIsHosted: Boolean = false,
    ): ShareVariant? {
        if (reviewAskedThisSession) return null
        if (within(now, dismissedAt, SHARE_HIDDEN_DAYS)) return null
        if (within(now, lastReviewAskAt, GAP_BETWEEN_ASKS_DAYS)) return null
        return when (plan) {
            ServicePlan.Account -> shareVariant(accountDoorAllowed, plan)
            is ServicePlan.Trial, ServicePlan.TrialEnded -> null
            null -> if (relayIsHosted) null else {
                val aged = firstHomeAt != null && now - firstHomeAt >= SHARE_SELF_HOSTED_AFTER_DAYS * DAY_MS
                if (aged && deviceCount >= MIN_DEVICES) ShareVariant.Plain else null
            }
        }
    }

    /**
     * Whether Google's review card may be asked for now. Called after a successful send, never
     * at launch. [askTimes] holds every earlier ask. No pre-question is shown before the card.
     */
    fun mayAskForReview(
        now: Long,
        firstHomeAt: Long?,
        deviceCount: Int,
        askTimes: List<Long>,
        shareDismissedAt: Long?,
        shareBoxShownThisSession: Boolean,
        lastSendSucceeded: Boolean,
        errorShowing: Boolean,
    ): Boolean {
        if (!lastSendSucceeded || errorShowing) return false
        if (shareBoxShownThisSession) return false
        if (firstHomeAt == null || now - firstHomeAt < REVIEW_AFTER_DAYS * DAY_MS) return false
        if (deviceCount < MIN_DEVICES) return false
        val last = askTimes.maxOrNull()
        if (last != null && now - last < REVIEW_MIN_SPACING_DAYS * DAY_MS) return false
        if (askTimes.count { now - it < 365 * DAY_MS } >= REVIEW_MAX_PER_YEAR) return false
        if (within(now, shareDismissedAt, GAP_BETWEEN_ASKS_DAYS)) return false
        return true
    }

    private fun within(now: Long, then: Long?, days: Int): Boolean =
        then != null && now - then < days * DAY_MS
}

/**
 * The places the "Help Tabsend" section points at. Change a value here and every screen follows.
 */
object HelpTabsend {
    /**
     * Where "Rate Tabsend" goes: the app's page in the store. Empty until the owner sets it, and
     * while it is empty the row is hidden. Google's review card needs no address.
     */
    const val REVIEW_URL: String = ""

    /** "Something not working? Tell me" opens this mail address with [FEEDBACK_SUBJECT]. */
    const val FEEDBACK_ADDRESS: String = "contact@tabsend.org"
    // l10n-ignore: a mail subject the maker reads, always English
    const val FEEDBACK_SUBJECT: String = "Tabsend feedback"

    /** The address the plain share sends along with its sentence. */
    const val SHARE_SITE: String = "https://tabsend.org"

    val showsRateRow: Boolean get() = REVIEW_URL.isNotBlank()
}
