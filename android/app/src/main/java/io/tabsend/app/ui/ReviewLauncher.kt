package io.tabsend.app.ui

import android.app.Activity

/**
 * Shows Google's in-app review card [PLANS.md P-22]. Only a Play build can: the card comes from
 * Google Play's In-App Review library, and no pre-question is put in front of it. That library is
 * not in this build yet (it cannot be fetched offline, and adding it would put it in the GitHub
 * test APK too), so [NoReviewLauncher] stands in. It reports that nothing was shown, so the app
 * does not count an ask that never happened. Wiring the real one is a change to [reviewLauncher]
 * in `MainActivity` and the Gradle file, nothing else.
 */
interface ReviewLauncher {
    /** Try to show the card. True only when it was asked for. */
    fun launch(activity: Activity): Boolean
}

object NoReviewLauncher : ReviewLauncher {
    override fun launch(activity: Activity): Boolean = false
}
