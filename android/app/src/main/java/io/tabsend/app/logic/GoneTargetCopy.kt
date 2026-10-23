package io.tabsend.app.logic

/**
 * A held tab whose device is gone from the group (PLANS.md P-15 item 3).
 * Said word for word as the extension's `goneTargetCopy` (lib/strings.ts) and
 * iOS's `GoneTargetCopy` (SendFeedback.swift).
 *
 * The tab is not lost: it is still held here, and the user picks where it goes
 * next. So the words say what happened and what to do, never "failed".
 *
 * "Was removed" only when THIS phone removed the device (`removedHere`: the id is
 * on the watch's `removed`). Otherwise all the phone knows is that the device is
 * not in the group it accepts, and a relay can arrange that by leaving it out of
 * one list or refusing one tab (SECURITY_REVIEW L3), so the words claim no more.
 */
object GoneTargetCopy {
    /** The line under the held tab, in place of "to <device>". */
    fun removedLine(targetLabel: String?, removedHere: Boolean): String {
        val who = targetLabel?.takeIf { it.isNotBlank() } ?: "The device it was for"
        return "$who ${goneVerb(removedHere)} your group."
    }

    /** The button that opens the list of devices left. */
    const val SEND_TO_MENU = "Send to…"

    /** No other device the tab can go to: this one, or devices still waiting for an answer. */
    const val NO_OTHER_DEVICE = "No other device to send it to."

    /**
     * The flush found the device gone. The tab was promised to send itself, and
     * now it will not, so this is said once, out loud, like any withdrawn promise.
     * [removedHere] is judged on the first tab, the one the banner names.
     */
    fun banner(count: Int, firstTitle: String?, targetLabel: String?, removedHere: Boolean): SendBanner {
        val headline = when {
            count > 1 -> "$count tabs are waiting for a new device"
            !firstTitle.isNullOrBlank() -> "“$firstTitle” is waiting for a new device"
            else -> "A tab is waiting for a new device"
        }
        val who = targetLabel?.takeIf { it.isNotBlank() }
            ?: if (count > 1) "The device they were for" else "The device it was for"
        val them = if (count > 1) "them" else "it"
        return SendBanner(
            tone = SendTone.PENDING,
            headline = headline,
            title = null,
            detail = "$who ${goneVerb(removedHere)} your group. Open Tabsend to send $them to another device.",
        )
    }

    private fun goneVerb(removedHere: Boolean): String =
        if (removedHere) "was removed from" else "is no longer in"
}
