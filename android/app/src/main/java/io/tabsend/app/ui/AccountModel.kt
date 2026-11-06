package io.tabsend.app.ui

import androidx.annotation.StringRes
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import io.tabsend.app.R
import io.tabsend.app.logic.AccountArrival
import io.tabsend.app.logic.RedeemOutcome
import io.tabsend.app.net.AccountSiteClient
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * What the first-run screens hold between the emailed link and the pairing [PLANS.md P-19].
 * A view model, so that turning the phone while the account site is being asked does not lose
 * the answer: the link is single use, so a lost answer would be a lost sign-up. Memory only,
 * and the setup link in it is never shown.
 */
class AccountModel : ViewModel() {

    /** The setup link handed back, while "Name this phone" is showing. */
    var arrival: AccountArrival? = null

    /** True while the account site is being asked. */
    var redeeming = false
        private set

    /** One line for the first screen, not yet shown. The screen takes it and clears it. */
    @StringRes
    var banner: Int? = null

    /** Told when [arrival] or [banner] changed, from the main thread; set while a screen is in front. */
    var onChange: (() -> Unit)? = null

    /** Use a `/app-start` token: the account site hands back the group's first setup link. */
    fun redeem(token: String, client: AccountSiteClient = AccountSiteClient()) {
        if (redeeming) return
        redeeming = true
        banner = null
        viewModelScope.launch {
            val outcome = withContext(Dispatchers.IO) { RedeemOutcome.of { client.redeem(token) } }
            redeeming = false
            when (outcome) {
                is RedeemOutcome.Arrived -> arrival = outcome.arrival
                is RedeemOutcome.Failed -> banner = when (outcome.reason) {
                    RedeemOutcome.Reason.EXPIRED -> R.string.account_link_expired
                    RedeemOutcome.Reason.HAS_DEVICE -> R.string.account_link_has_device
                    RedeemOutcome.Reason.UNREACHABLE -> R.string.account_unreachable
                    RedeemOutcome.Reason.UNEXPECTED -> R.string.account_unexpected
                }
            }
            onChange?.invoke()
        }
    }
}
