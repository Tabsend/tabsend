package io.tabsend.app.logic

import io.tabsend.app.net.AccountHandBack
import io.tabsend.app.net.AccountSiteException

/**
 * The group's first setup link, handed back after a sign-up this phone began, and what the
 * "Name this phone" screen needs to know about it [PLANS.md P-19]. Held in memory only.
 */
data class AccountArrival(
    /** The complete setup link, ready to pair with. Never shown. */
    val link: String,
    /**
     * This sign-up made the account, so "your trial has started" is true. False for a person who
     * already had an account (a new phone), and for a setup link that arrived by itself.
     */
    val created: Boolean,
    /** When the trial ends, in epoch milliseconds, from the account site. For the notice. */
    val trialEndsAt: Long?,
)

/** What came of using a sign-up link: the phone can go on to "Name this phone", or it cannot, and why. */
sealed interface RedeemOutcome {
    data class Arrived(val arrival: AccountArrival) : RedeemOutcome
    data class Failed(val reason: Reason) : RedeemOutcome

    enum class Reason {
        /** The link is old (it lasts 15 minutes) or was already used. */
        EXPIRED,

        /** The account's group already has a device, so there is no first setup link to hand out. */
        HAS_DEVICE,

        /** The account site could not be reached. */
        UNREACHABLE,

        /** The account site's answer could not be used. */
        UNEXPECTED,
    }

    companion object {
        /** Run [redeem] (the call to the account site) and say what it came to. Blocking. */
        fun of(redeem: () -> AccountHandBack): RedeemOutcome = try {
            val back = redeem()
            val link = back.setupLink
            if (link == null) {
                Failed(Reason.HAS_DEVICE)
            } else {
                Arrived(AccountArrival(link, back.created, if (back.created) back.trialEndsAt else null))
            }
        } catch (e: AccountSiteException) {
            Failed(
                when (e.kind) {
                    AccountSiteException.Kind.LINK_EXPIRED -> Reason.EXPIRED
                    AccountSiteException.Kind.UNREACHABLE -> Reason.UNREACHABLE
                    AccountSiteException.Kind.UNEXPECTED -> Reason.UNEXPECTED
                },
            )
        }
    }
}
