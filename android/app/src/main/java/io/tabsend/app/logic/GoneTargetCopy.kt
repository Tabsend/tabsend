package io.tabsend.app.logic

import io.tabsend.app.R

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
 *
 * Every sentence is whole, with the device's name as a placeholder, and there is one for each
 * case (named or not, one tab or several) instead of a sentence assembled from pieces, so a
 * translation can put the words in the order its language needs (docs/L10N.md, rules 3 and 13).
 */
object GoneTargetCopy {
    /** The line under the held tab, in place of "to <device>". */
    fun removedLine(text: TextSource, targetLabel: String?, removedHere: Boolean): String {
        val name = targetLabel?.takeIf { it.isNotBlank() }
        return when {
            name != null && removedHere -> text.string(R.string.gone_target_removed, name)
            name != null -> text.string(R.string.gone_target_left, name)
            removedHere -> text.string(R.string.gone_target_removed_unnamed)
            else -> text.string(R.string.gone_target_left_unnamed)
        }
    }

    /** The button that opens the list of devices left. */
    fun sendToMenu(text: TextSource): String = text.string(R.string.gone_target_send_to)

    /** No other device the tab can go to: this one, or devices still waiting for an answer. */
    fun noOtherDevice(text: TextSource): String = text.string(R.string.gone_target_no_other_device)

    /**
     * The flush found the device gone. The tab was promised to send itself, and
     * now it will not, so this is said once, out loud, like any withdrawn promise.
     * [removedHere] is judged on the first tab, the one the banner names.
     */
    fun banner(
        text: TextSource,
        count: Int,
        firstTitle: String?,
        targetLabel: String?,
        removedHere: Boolean,
    ): SendBanner {
        // One tab with a known title is named; any other count, or no title, is counted by the platform.
        // l10n-ignore: names one tab or counts several, not grammar
        val named = count == 1 && !firstTitle.isNullOrBlank()
        val headline = if (named) {
            text.string(R.string.gone_target_headline_titled, firstTitle.orEmpty())
        } else {
            text.plural(R.plurals.gone_target_headline, count, count)
        }
        val name = targetLabel?.takeIf { it.isNotBlank() }
        val detail = when {
            name != null && removedHere -> text.plural(R.plurals.gone_target_banner_removed, count, count, name)
            name != null -> text.plural(R.plurals.gone_target_banner_left, count, count, name)
            removedHere -> text.plural(R.plurals.gone_target_banner_removed_unnamed, count)
            else -> text.plural(R.plurals.gone_target_banner_left_unnamed, count)
        }
        return SendBanner(tone = SendTone.PENDING, headline = headline, title = null, detail = detail)
    }
}
