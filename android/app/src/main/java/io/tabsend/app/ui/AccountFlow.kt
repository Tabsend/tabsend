package io.tabsend.app.ui

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.view.View
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.browser.customtabs.CustomTabColorSchemeParams
import androidx.browser.customtabs.CustomTabsIntent
import androidx.core.widget.doAfterTextChanged
import com.google.android.material.button.MaterialButton
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import io.tabsend.app.BuildConfig
import io.tabsend.app.R
import io.tabsend.app.databinding.ActivityMainBinding
import io.tabsend.app.logic.AccountArrival
import io.tabsend.app.logic.AccountLink
import io.tabsend.app.logic.AccountSetup
import io.tabsend.app.logic.AccountSite
import io.tabsend.app.logic.GroupService
import io.tabsend.app.logic.Pairing
import io.tabsend.app.logic.ServicePlan
import io.tabsend.app.logic.uiLocale
import io.tabsend.app.store.Store

/**
 * The account door and everything behind it [PLANS.md P-19]: "Set up an account" on the first
 * screen, the sign-up sheet, the link the account site emails, "Name this phone", the trial
 * line and notice, and the Account group in Settings. The iPhone's twin is spread over
 * `JoinView`, `NamePhoneView`, `SettingsView` and `AppModel`; the words are the same.
 *
 * Which of it shows is one rule, [AccountSetup.allowsAccountSetup] (in the Play build, Google's
 * answer from [PlayLinkOut]), and what the relay says about the plan ([GroupService]). The
 * trial line, the trial-ended card and the notice read the relay's words only: nothing is
 * guessed from a date or a tap.
 */
class AccountFlow(
    private val activity: AppCompatActivity,
    private val binding: ActivityMainBinding,
    private val store: Store,
    private val model: AccountModel,
    /** Pair with this setup link and this name; the screen's own button and status line show the rest. */
    private val pair: (link: String, name: String, button: MaterialButton, status: TextView) -> Unit,
    /** The phone's own name, offered on "Name this phone". */
    private val defaultName: () -> String,
    /** Redraw whichever screen is showing. */
    private val render: () -> Unit,
) {
    /**
     * Google's link-out for the Play build (null in a debug build, which opens the pages
     * itself). The door shows when Google says the link-out is available; the sign-up and
     * account pages open through Google's call, which hands back the token the account site
     * reports a purchase with.
     */
    private val linkOut: PlayLinkOut? =
        if (BuildConfig.DEBUG) null else PlayLinkOut(activity) { if (!activity.isFinishing) render() }

    /**
     * Debug builds only: act as the Play build where Google says yes (true) or no (false), to
     * look at the screens as Google Play's build shows them. Null: the real rule.
     */
    private var debugPlay: Boolean? = null

    /** The one rule for the door, the sheet and the Account group. */
    private fun doorAllowed(): Boolean {
        val override = debugPlay
        if (BuildConfig.DEBUG && override != null) {
            return AccountSetup.allowsAccountSetup(debugBuild = false, linkOutAvailable = override)
        }
        return AccountSetup.allowsAccountSetup(debugBuild = BuildConfig.DEBUG, linkOutAvailable = linkOut?.available == true)
    }

    init {
        binding.accountSetupButton.setOnClickListener { startSignup() }
        binding.accountManageButton.setOnClickListener { openSheet(AccountSetup.Page.ACCOUNT) }
        binding.accountDeleteButton.setOnClickListener { confirmDelete() }
        binding.arrivalPairButton.setOnClickListener {
            val arrival = model.arrival ?: return@setOnClickListener
            pair(
                arrival.link,
                binding.arrivalNameInput.text?.toString()?.trim().orEmpty().ifEmpty(defaultName),
                binding.arrivalPairButton,
                binding.arrivalStatus,
            )
        }
        // A link in hand (scanned, copied, or typed) is pairing, not signing up.
        binding.pairingLinkInput.doAfterTextChanged { renderJoin() }
    }

    // --- screen lifetime -------------------------------------------------------

    /** A screen is in front: hear about an arrival or a failure that happens now. */
    fun attach() {
        linkOut?.check()
        model.onChange = { if (!activity.isFinishing) render() }
        // One that happened while no screen was in front shows now.
        if (!store.isRegistered && (model.arrival != null || model.banner != null)) render()
    }

    fun detach() {
        model.onChange = null
    }

    /** The screen is going away: let go of the connection to Google Play. */
    fun close() {
        linkOut?.close()
    }

    /** Debug builds only: a launch extra points the sheets at a local account site, or acts as the Play build. */
    fun applyDebugExtras(intent: Intent?) {
        if (!BuildConfig.DEBUG || intent == null) return
        intent.getStringExtra(EXTRA_DEBUG_ACCOUNT_SITE)?.let {
            AccountSite.override = it.takeIf { site -> site.isNotBlank() && AccountSite.isLocalSite(site) }
        }
        if (intent.hasExtra(EXTRA_DEBUG_ACCOUNT_PLAY)) {
            // "yes" or "no": the Play build, where Google says so; anything else: the real rule.
            debugPlay = when (intent.getStringExtra(EXTRA_DEBUG_ACCOUNT_PLAY)?.trim()?.lowercase()) {
                "yes" -> true
                "no" -> false
                else -> null
            }
        }
    }

    // --- links that open the app ----------------------------------------------

    /**
     * A link the system handed the app: one from the account site's email, which this takes.
     * Returns true when it did. `/app-start`: the sign-up finishes here (the account site's
     * answer holds the group's first setup link). `/app-signin`: the sign-in page opens in the
     * sheet and signs in there. A paired phone has its group already, so a second one is not made.
     */
    fun handle(intent: Intent?): Boolean {
        val data = intent?.takeIf { it.action == Intent.ACTION_VIEW }?.data?.toString() ?: return false
        return when (val link = AccountLink.parse(data, AccountSite.base)) {
            is AccountLink.NewAccount -> {
                // Only a phone that asked for a sign-up takes the link: one that arrives cold, from
                // someone else's email, would put this phone in a stranger's group (review AL1).
                if (!store.isRegistered && AccountSetup.isPending(store.accountStartedAt, System.currentTimeMillis())) {
                    model.redeem(link.token)
                }
                true
            }
            is AccountLink.SignIn -> {
                openUrl(AccountLink.signInPage(link, AccountSite.base))
                true
            }
            null -> false
        }
    }

    /**
     * A pairing link that opened the app while a sign-up this phone began is waiting for its
     * link (within a day): it is that account's, so the person is asked for a name instead of
     * being shown the raw link. Returns true when it took the link.
     */
    fun takeSetupLink(link: String): Boolean {
        if (store.isRegistered || !AccountSetup.isPending(store.accountStartedAt, System.currentTimeMillis())) return false
        if (Pairing.parse(link) == null) return false
        model.arrival = AccountArrival(link, created = false, trialEndsAt = null)
        render()
        return true
    }

    /** This phone paired: nothing is waiting for a sign-up link any more. */
    fun pairingDone() {
        model.arrival = null
        store.accountStartedAt = null
    }

    // --- first screen and "Name this phone" -------------------------------------

    /** True while "Name this phone" replaces the first screen. */
    fun showsName(): Boolean = model.arrival != null

    /** The door under the two pairing buttons, and a line from a failed link. */
    fun renderJoin() {
        val hasLink = !binding.pairingLinkInput.text.isNullOrBlank()
        binding.accountDoor.visibility = if (doorAllowed() && !hasLink) View.VISIBLE else View.GONE
        model.banner?.let {
            binding.joinStatus.text = activity.getString(it)
            model.banner = null
        }
    }

    fun renderName() {
        val arrival = model.arrival ?: return
        val notice = binding.accountStartedNotice
        notice.visibility = if (arrival.created) View.VISIBLE else View.GONE
        if (arrival.created) {
            binding.accountStartedText.text = arrival.trialEndsAt
                ?.let { activity.getString(R.string.account_started_notice, GroupService.shortDay(it, locale = activity.uiLocale())) }
                ?: activity.getString(R.string.account_started_notice_no_date)
        }
        if (binding.arrivalNameInput.text.isNullOrBlank()) binding.arrivalNameInput.setText(defaultName())
    }

    // --- paired: the plan the relay reported ------------------------------------

    /** The trial line, the trial-ended card and the Account group, from the relay's words. */
    fun renderPaired() {
        val plan = GroupService.plan(store.groupService)
        binding.trialEndedCard.visibility = if (plan == ServicePlan.TrialEnded) View.VISIBLE else View.GONE

        val trial = plan as? ServicePlan.Trial
        binding.serviceGroup.visibility = if (trial != null) View.VISIBLE else View.GONE
        binding.serviceTrialValue.text = trial?.endsAt
            ?.let { activity.getString(R.string.service_trial_until, GroupService.shortDay(it, locale = activity.uiLocale())) }
            .orEmpty()

        // The Account group needs the rule and a plan word: a self-hosted relay says nothing, so
        // a self-hoster never sees it, and a phone paired from a link made on a computer does.
        binding.accountGroup.visibility = if (doorAllowed() && plan != null) View.VISIBLE else View.GONE
    }

    // --- the sheets ---------------------------------------------------------------

    private fun startSignup() {
        // A setup link that arrives soon is this account's own, once the page is open.
        openSheet(AccountSetup.Page.START) { store.accountStartedAt = System.currentTimeMillis() }
    }

    private fun confirmDelete() {
        // One question, then the website finishes the deletion (Google Play, like Apple, wants
        // the app to start it; the last step may be on the website the app links straight to).
        MaterialAlertDialogBuilder(activity)
            .setTitle(R.string.account_delete_title)
            .setMessage(R.string.account_delete_body)
            .setPositiveButton(R.string.account_delete_continue) { _, _ -> openSheet(AccountSetup.Page.DELETE) }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    /**
     * Open an account site page. In the Play build, the sign-up and account pages (the ones
     * that lead to an offer) open through Google's link-out call, which shows Google's notice
     * and adds its token to the address; the delete page leads to no offer and opens plainly.
     * A debug build opens every page plainly. [then] runs once the page is opening.
     */
    private fun openSheet(page: AccountSetup.Page, then: () -> Unit = {}) {
        val url = AccountSetup.url(page, AccountSite.base)
        val linkOut = linkOut
        if (linkOut == null || page == AccountSetup.Page.DELETE) {
            openUrl(url)
            then()
            return
        }
        linkOut.open(
            activity,
            url,
            opened = { link ->
                openUrl(link)
                then()
            },
            failed = { Toast.makeText(activity, R.string.account_page_failed, Toast.LENGTH_LONG).show() },
        )
    }

    /**
     * Open an account site page in a Custom Tab: a sheet over the app, in the person's own
     * browser (Chrome opens it as a bottom sheet; a browser without that opens it full screen),
     * not a trip to the browser app. Close returns to the app.
     */
    private fun openUrl(url: String) {
        val height = (activity.resources.displayMetrics.heightPixels * SHEET_HEIGHT).toInt()
        val ground = activity.getColor(R.color.ts_phone_ground)
        val tab = CustomTabsIntent.Builder()
            .setShowTitle(true)
            .setShareState(CustomTabsIntent.SHARE_STATE_OFF)
            .setColorScheme(CustomTabsIntent.COLOR_SCHEME_SYSTEM)
            .setDefaultColorSchemeParams(CustomTabColorSchemeParams.Builder().setToolbarColor(ground).build())
            .setInitialActivityHeightPx(height, CustomTabsIntent.ACTIVITY_HEIGHT_ADJUSTABLE)
            .setToolbarCornerRadiusDp(SHEET_CORNER_DP)
            .build()
        try {
            tab.launchUrl(activity, Uri.parse(url))
        } catch (_: ActivityNotFoundException) {
            Toast.makeText(activity, R.string.account_page_failed, Toast.LENGTH_LONG).show()
        }
    }

    companion object {
        /** Debug builds only: the account site's address, such as `http://10.0.2.2:8790`. */
        const val EXTRA_DEBUG_ACCOUNT_SITE = "io.tabsend.app.DEBUG_ACCOUNT_SITE"

        /**
         * Debug builds only: act as the Play build where Google says the link-out is available
         * (`yes`) or not (`no`); empty is the real rule. The pages still open plainly, with no
         * token, because a debug build has no Google Play behind it.
         */
        const val EXTRA_DEBUG_ACCOUNT_PLAY = "io.tabsend.app.DEBUG_ACCOUNT_PLAY"

        /** The sheet's height, as a share of the screen (frame a2 draws it at about 85 percent). */
        private const val SHEET_HEIGHT = 0.85

        /** The most the Custom Tabs library accepts (0 to 16); a larger value crashes. */
        private const val SHEET_CORNER_DP = 16
    }
}
