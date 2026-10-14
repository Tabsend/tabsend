package io.tabsend.app.logic

/**
 * Which "Waiting to send" notices are still true.
 *
 * A pending notice is a PROMISE about a tab that is still sitting in the
 * outbound queue: "the tab is held here and sends itself once the relay answers
 * again". Nothing was ever withdrawing that promise. The relay came back, the
 * queue drained, a separate "Sent the tab that was waiting" notice appeared for
 * two seconds and cleared itself — and the original "Waiting to send" notice
 * stayed in the shade indefinitely, still claiming an outage that had ended
 * (dogfood 2026-08-16).
 *
 * So the queue, not the notice, is the truth: a pending notice is legitimate
 * exactly while its message is still queued. Reconciling against the queue —
 * rather than cancelling ids the flush happens to have settled — also cleans up
 * after the paths that empty the queue without flushing anything (unpair, "start
 * fresh" on another relay) and after a process death mid-outage.
 *
 * Pure so the rule is testable without a NotificationManager.
 */

/** The notification id of one message's notice. Paired with a tag, so a link
 *  notification keying on the same hash cannot collide with it. */
fun noticeIdOf(messageId: String): Int = messageId.hashCode()

/**
 * Of the pending notices currently on screen ([posted], as notification ids),
 * those whose message is no longer in [held] and must therefore come down.
 *
 * Works in ids rather than message ids because that is all the OS gives back
 * about a posted notification; [held] is mapped through [noticeIdOf] to meet it.
 */
fun stalePendingNoticeIds(posted: Collection<Int>, held: Collection<String>): List<Int> {
    val keep = held.mapTo(HashSet()) { noticeIdOf(it) }
    return posted.filterNot { it in keep }
}
