package io.tabsend.app.logic

import com.android.billingclient.api.BillingClient.BillingResponseCode
import java.net.URLEncoder

/**
 * The pure parts of Google Play's "External content links" program [PLANS.md P-19]: what a
 * response from Google's library means, and how the token Google hands out travels to the
 * account site. The calls themselves are in `ui/PlayLinkOut.kt`.
 *
 * The program is US only and Google decides who is eligible, so the door in the Play build
 * shows exactly when Google says the link-out is available. Nothing here is about buying
 * anything inside the app.
 */
object LinkOut {

    /** The query parameter that carries Google's external transaction token to the account site. */
    const val TOKEN_PARAM: String = "gpt"

    /**
     * [url] with Google's [token] added as the `gpt` query parameter, ahead of any fragment.
     * The account site keeps it with the sign-up or the checkout, and reports the purchase to
     * Google with it. The token is opaque and carries no personal data.
     */
    fun withToken(url: String, token: String): String {
        val hash = url.indexOf('#')
        val base = if (hash >= 0) url.substring(0, hash) else url
        val fragment = if (hash >= 0) url.substring(hash) else ""
        val joiner = if (base.contains('?')) "&" else "?"
        return base + joiner + TOKEN_PARAM + "=" + URLEncoder.encode(token, "UTF-8") + fragment
    }

    /** What to do after one of Google's link-out calls answers with [responseCode]. */
    enum class Step {
        /** Go on to the next call, or open the page. */
        Proceed,

        /** The person closed Google's notice: do nothing, and say nothing. */
        Cancelled,

        /** Something went wrong: tell the person the page could not be opened. */
        Failed,
    }

    fun stepAfter(responseCode: Int): Step = when (responseCode) {
        BillingResponseCode.OK -> Step.Proceed
        BillingResponseCode.USER_CANCELED -> Step.Cancelled
        else -> Step.Failed
    }

    /** True when Google says the link-out is available to this person (US, and the app is enrolled). */
    fun isAvailable(responseCode: Int): Boolean = responseCode == BillingResponseCode.OK

    /**
     * True for an answer that says "try again later" rather than "no": the connection to Play
     * dropped, Play was busy, or the network failed. The door is checked again
     * the next time the screen comes back. A plain "no" (not in the US, not enrolled, no Play
     * Store, a build Play does not know) is kept for the rest of the run.
     */
    fun isRetryable(responseCode: Int): Boolean = when (responseCode) {
        BillingResponseCode.SERVICE_DISCONNECTED,
        BillingResponseCode.SERVICE_UNAVAILABLE,
        BillingResponseCode.NETWORK_ERROR,
        BillingResponseCode.ERROR,
        -> true
        else -> false
    }
}
