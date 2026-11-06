package io.tabsend.app.ui

import android.app.Activity
import android.content.Context
import android.net.Uri
import com.android.billingclient.api.BillingClient
import com.android.billingclient.api.BillingClient.BillingProgram
import com.android.billingclient.api.BillingClientStateListener
import com.android.billingclient.api.BillingProgramReportingDetailsParams
import com.android.billingclient.api.BillingResult
import com.android.billingclient.api.EnableBillingProgramParams
import com.android.billingclient.api.LaunchExternalLinkParams
import io.tabsend.app.logic.LinkOut

/**
 * Google Play's link-out for the Play build [PLANS.md P-19]: asks Google whether this person
 * may be linked out to the account site (the "External content links" program: the US, and
 * only once Google has approved the app), and opens the sign-up and account pages through
 * Google's own call, which shows Google's notice first and hands back a token. The account
 * site reports a purchase made after the tap to Google with that token.
 *
 * Only a release build makes one of these; a debug build (the GitHub test APK) opens the pages
 * itself and shows the door everywhere. The library is used for nothing else: no product, no
 * purchase, no purchases listener. Every failure ends in "no door" or "couldn't open the page";
 * none can crash the app. Google's answers arrive on the main thread.
 */
class PlayLinkOut(
    context: Context,
    /** The door may have changed: redraw. */
    private val changed: () -> Unit,
) {
    private enum class State { Unknown, Checking, Available, Unavailable }

    private val appContext = context.applicationContext
    private var state = State.Unknown
    private var client: BillingClient? = null

    /** True once Google has said the link-out is available to this person. */
    val available: Boolean get() = state == State.Available

    /** Ask Google, once per run (again only after an answer that said "try later"). */
    fun check() {
        if (state != State.Unknown) return
        state = State.Checking
        val billing = try {
            client ?: BillingClient.newBuilder(appContext)
                .enableBillingProgram(
                    EnableBillingProgramParams.newBuilder()
                        .setBillingProgram(BillingProgram.EXTERNAL_CONTENT_LINK)
                        .build(),
                )
                // Google's own reconnect, so a tap after Play restarted still works.
                .enableAutoServiceReconnection()
                .build()
        } catch (_: Exception) {
            // A library that will not start is a phone that cannot be linked out.
            finish(Result.No)
            return
        }
        client = billing
        try {
            billing.startConnection(
                object : BillingClientStateListener {
                    override fun onBillingSetupFinished(result: BillingResult) {
                        if (result.responseCode != BillingClient.BillingResponseCode.OK) {
                            finish(Result.of(result.responseCode))
                            return
                        }
                        billing.isBillingProgramAvailableAsync(BillingProgram.EXTERNAL_CONTENT_LINK) { answer, _ ->
                            finish(Result.of(answer.responseCode))
                        }
                    }

                    override fun onBillingServiceDisconnected() {
                        // Play went away before it answered: ask again when the screen returns.
                        if (state == State.Checking) finish(Result.Later)
                    }
                },
            )
        } catch (_: Exception) {
            finish(Result.No)
        }
    }

    /**
     * Open [url] the way the program asks: a fresh token from Google, the token added to the
     * address, then Google's call, which shows its notice. [opened] gets the address to open
     * (the caller opens it, in its own sheet); [failed] means it could not be done. If the
     * person closes Google's notice, neither is called.
     */
    fun open(activity: Activity, url: String, opened: (String) -> Unit, failed: () -> Unit) {
        val billing = client
        if (billing == null || !available) {
            failed()
            return
        }
        try {
            billing.createBillingProgramReportingDetailsAsync(
                BillingProgramReportingDetailsParams.newBuilder()
                    .setBillingProgram(BillingProgram.EXTERNAL_CONTENT_LINK)
                    .build(),
            ) { made, details ->
                val token = details?.externalTransactionToken
                if (made.responseCode != BillingClient.BillingResponseCode.OK || token.isNullOrEmpty()) {
                    failed()
                    return@createBillingProgramReportingDetailsAsync
                }
                val link = LinkOut.withToken(url, token)
                val params = LaunchExternalLinkParams.newBuilder()
                    .setBillingProgram(BillingProgram.EXTERNAL_CONTENT_LINK)
                    .setLinkUri(Uri.parse(link))
                    .setLinkType(LaunchExternalLinkParams.LinkType.LINK_TO_DIGITAL_CONTENT_OFFER)
                    // Google shows its notice, then this app opens the page in its own sheet.
                    .setLaunchMode(LaunchExternalLinkParams.LaunchMode.CALLER_WILL_LAUNCH_LINK)
                    .build()
                billing.launchExternalLink(activity, params) { launched ->
                    when (LinkOut.stepAfter(launched.responseCode)) {
                        LinkOut.Step.Proceed -> opened(link)
                        LinkOut.Step.Cancelled -> Unit
                        LinkOut.Step.Failed -> failed()
                    }
                }
            }
        } catch (_: Exception) {
            failed()
        }
    }

    /** The screen is going away: let go of the connection to Play. */
    fun close() {
        try {
            client?.endConnection()
        } catch (_: Exception) {
            // Nothing to do: it is going away anyway.
        }
        client = null
        state = State.Unknown
    }

    private enum class Result {
        Yes, No, Later;

        companion object {
            fun of(responseCode: Int): Result = when {
                LinkOut.isAvailable(responseCode) -> Yes
                LinkOut.isRetryable(responseCode) -> Later
                else -> No
            }
        }
    }

    private fun finish(result: Result) {
        val before = available
        state = when (result) {
            Result.Yes -> State.Available
            Result.No -> State.Unavailable
            Result.Later -> State.Unknown
        }
        if (result == Result.Later) {
            // A connection that failed is dropped, so the next check starts clean.
            try {
                client?.endConnection()
            } catch (_: Exception) {
            }
            client = null
        }
        if (available != before) changed()
    }
}
