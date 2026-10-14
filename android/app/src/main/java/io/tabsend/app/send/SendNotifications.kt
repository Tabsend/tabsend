package io.tabsend.app.send

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import io.tabsend.app.R
import io.tabsend.app.logic.Feedback
import io.tabsend.app.logic.SendBanner
import io.tabsend.app.logic.SendFailure
import io.tabsend.app.logic.SendTone
import io.tabsend.app.logic.noticeIdOf
import io.tabsend.app.logic.stalePendingNoticeIds
import io.tabsend.app.store.Store
import io.tabsend.app.ui.MainActivity

/**
 * Where a send's outcome lands on Android.
 *
 * The share sheet is a transient activity, so it has nothing like the
 * extension's toolbar badge and a delayed outcome had nowhere to go at all. A
 * send that fails after the sheet closes, or a queued send that drains twenty
 * minutes later, was COMPLETELY silent. Hence notifications for anything that
 * isn't instantaneous.
 *
 * The instant itself belongs to the send toast (ShareActivity, docs/APP_UI.md):
 * while it is on screen it carries the outcome, a success is not notified at
 * all, and anything that stays true afterwards is posted silently so it is
 * recorded without being announced twice. Every later outcome (a held tab
 * going out, being refused, never arriving) is still announced here in full.
 *
 * Two channels instead of the extension's single `showSuccessToast` boolean.
 * That is a genuine improvement, not just a port: the OS settings UI lets the
 * user silence confirmations while keeping failures, per-tone, without us
 * building a preference screen. Failures are never gated behind an app setting.
 */
object SendNotifications {
    /** Confirmations: quiet, and they get out of the way on their own. */
    const val CHANNEL_STATUS = "send_status"

    /** Pending and failed sends: the user has to be able to find out. */
    const val CHANNEL_PROBLEMS = "send_problems"

    /** How long a success notification dwells before the OS clears it. */
    private const val SUCCESS_TIMEOUT_MS = 2_000L

    fun ensureChannels(context: Context) {
        val mgr = context.getSystemService(NotificationManager::class.java) ?: return
        if (mgr.getNotificationChannel(CHANNEL_STATUS) == null) {
            mgr.createNotificationChannel(
                NotificationChannel(
                    CHANNEL_STATUS,
                    context.getString(R.string.channel_send_status_name),
                    NotificationManager.IMPORTANCE_LOW,
                ).apply { description = context.getString(R.string.channel_send_status_desc) },
            )
        }
        if (mgr.getNotificationChannel(CHANNEL_PROBLEMS) == null) {
            mgr.createNotificationChannel(
                NotificationChannel(
                    CHANNEL_PROBLEMS,
                    context.getString(R.string.channel_send_problems_name),
                    NotificationManager.IMPORTANCE_HIGH,
                ).apply { description = context.getString(R.string.channel_send_problems_desc) },
            )
        }
    }

    /** On API 33+ posting needs the runtime permission; without it the in-app list is the only surface. */
    fun enabled(context: Context): Boolean =
        NotificationManagerCompat.from(context).areNotificationsEnabled()

    /**
     * Report one send. [messageId] keys the notification, so two sends in flight
     * never overwrite each other's outcome while a single send's own optimistic
     * state is replaced by its real one.
     *
     * A PENDING banner is filed apart from a settled one, under [TAG_PENDING].
     * It is not a report but a standing promise about a tab still in the queue,
     * and it has to be withdrawable later — by [reconcilePending], from a
     * background worker that has no idea which sends were ever announced. A
     * settled outcome is the opposite: it is the only record of something that
     * has already finished, and nothing may sweep it away.
     *
     * [silent] is for an outcome the share sheet's send toast is showing at this
     * very moment (ShareActivity). The notice still goes up, because it is the
     * record that outlives the toast (and, for a pending one, the promise
     * [reconcilePending] later withdraws), but without sound, vibration or a
     * heads-up banner, so the person is not told the same thing twice at once.
     */
    fun postOutcome(
        context: Context,
        banner: SendBanner,
        messageId: String,
        silent: Boolean = false,
    ): Boolean {
        val id = noticeIdOf(messageId)
        if (banner.tone == SendTone.PENDING) return post(context, banner, TAG_PENDING, id, silent)
        // A verdict supersedes the promise that preceded it. Only reachable when
        // a send is reported twice, but leaving both up would have the same tab
        // reading as waiting and as finished at once.
        cancel(context, TAG_PENDING, id)
        return post(context, banner, TAG_OUTCOME, id, silent)
    }

    /**
     * The queue drained after a real failure. Announced because the tab the user
     * was told was "waiting" has now actually gone, and nothing else would ever
     * say so — they walked away from the share sheet a long time ago.
     */
    fun postRecovered(context: Context, count: Int, firstTitle: String?): Boolean =
        post(
            context,
            SendBanner(
                tone = SendTone.SUCCESS,
                headline = Feedback.recoveredLine(count, firstTitle),
                detail = if (count == 1) null else "Your relay is answering again.",
            ),
            TAG_FLUSH,
            RECOVERED_ID,
        )

    /**
     * A tab that was waiting has now been refused for good, so it left the queue
     * unsent. Told on the problems channel, because the user was promised
     * "waiting to send" and would otherwise never learn it didn't happen.
     */
    fun postDropped(
        context: Context,
        count: Int,
        firstTitle: String?,
        targetLabel: String?,
        failure: SendFailure?,
    ): Boolean =
        post(
            context,
            SendBanner(
                tone = SendTone.ERROR,
                headline = if (count == 1) {
                    "Couldn't send a tab that was waiting"
                } else {
                    "Couldn't send $count tabs that were waiting"
                },
                title = firstTitle,
                // The label was captured when the send was made, so the sentence
                // can name the device rather than fall back to "that device".
                detail = failure?.let { Feedback.failureLine(it, targetLabel) },
            ),
            TAG_FLUSH,
            DROPPED_ID,
        )

    /**
     * A tab this phone sent has passed the relay's expiry without the target ever
     * picking it up [0028]. Told on the problems channel, once per tab: the user
     * was told "Sent" — which under ADR-0008 only ever meant the relay took it —
     * and before group history nothing anywhere could ever contradict that.
     */
    fun postNeverArrived(
        context: Context,
        count: Int,
        firstTitle: String?,
        targetLabel: String?,
    ): Boolean =
        post(
            context,
            SendBanner(
                tone = SendTone.ERROR,
                headline = if (count == 1) {
                    "A tab never reached its device"
                } else {
                    "$count tabs never reached their devices"
                },
                title = firstTitle,
                detail = if (targetLabel != null) {
                    "$targetLabel never picked it up. Open History to send it again."
                } else {
                    "Open History to send it again."
                },
            ),
            TAG_FLUSH,
            NEVER_ARRIVED_ID,
        )

    /**
     * Report what one queue flush did, either way, and reconcile what it leaves
     * on screen. The one place that decides, so every trigger — the poll chain,
     * the heartbeat, a socket that has just reconnected — says the same thing.
     *
     * The person was told "waiting to send" and then walked away from the share
     * sheet, possibly a long time ago. Without this the queue resolves in total
     * silence: no word on whether the promise was kept, no word at all when the
     * relay came back and then refused the tab outright, and — the bug this
     * reconciliation exists for — a "Waiting to send" notice left standing in
     * the shade after the wait had ended.
     */
    fun announceFlush(context: Context, report: FlushReport) {
        if (report.recovered) {
            postRecovered(context, report.sent, report.firstTitle)
        }
        if (report.dropped > 0) {
            postDropped(
                context,
                report.dropped,
                report.firstDroppedTitle,
                report.firstDroppedTargetLabel,
                report.firstDroppedFailure,
            )
        }
        // Unconditional, and after the report: this runs whether or not the flush
        // moved anything, so it is also what clears notices left stranded by an
        // emptied queue or by a process death mid-outage.
        reconcilePending(context, Store.get(context).outbound.map { it.id })
    }

    /**
     * Take down every "Waiting to send" notice whose tab is no longer waiting.
     *
     * [heldMessageIds] is the outbound queue AFTER whatever just happened to it,
     * so this is the one call that closes every way a promise can come due: the
     * relay answered and the tab went, the relay answered and refused it, or the
     * queue was emptied outright by an unpair. Called from the flush workers
     * (which run on the poll chain even with no screen open) and from the home
     * screen, so a notice cannot outlive its tab whether or not the user comes
     * back to the app.
     *
     * Reconciling against the queue rather than cancelling ids the flush settled
     * is deliberate: it also cleans up notices this process never posted, which
     * is the ordinary case — the share sheet that promised is long dead by the
     * time a worker delivers.
     */
    fun reconcilePending(context: Context, heldMessageIds: Collection<String>) {
        val mgr = context.getSystemService(NotificationManager::class.java) ?: return
        // Some OEM builds have been known to throw here; a failed tidy-up must
        // never take down the worker that was actually delivering tabs.
        val active = try {
            mgr.activeNotifications
        } catch (_: Exception) {
            null
        } ?: return
        val posted = active.filter { it.tag == TAG_PENDING }.map { it.id }
        for (id in stalePendingNoticeIds(posted, heldMessageIds)) cancel(context, TAG_PENDING, id)
    }

    /** Everything this object has posted, for a phone that has left the group. */
    fun clearAll(context: Context) {
        reconcilePending(context, emptyList())
        cancel(context, TAG_FLUSH, RECOVERED_ID)
        cancel(context, TAG_FLUSH, DROPPED_ID)
        cancel(context, TAG_FLUSH, NEVER_ARRIVED_ID)
    }

    private fun cancel(context: Context, tag: String, id: Int) {
        NotificationManagerCompat.from(context).cancel(tag, id)
    }

    private fun post(
        context: Context,
        banner: SendBanner,
        tag: String,
        id: Int,
        silent: Boolean = false,
    ): Boolean {

        if (!enabled(context)) return false
        ensureChannels(context)

        val success = banner.tone == SendTone.SUCCESS
        val channel = if (success) CHANNEL_STATUS else CHANNEL_PROBLEMS

        // Tapping any of these goes to the home screen, which is where the
        // waiting list and the relay-outage banner are — the only place a user
        // can do something about a held tab.
        val open = PendingIntent.getActivity(
            context,
            id,
            Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        // The tab's own name goes in the body, never merged into the headline:
        // the headline is the verdict, the title says which tab it is about.
        val body = listOfNotNull(banner.title, banner.detail).joinToString("\n")

        val builder = NotificationCompat.Builder(context, channel)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(banner.headline)
            .setContentIntent(open)
            .setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .setPriority(if (success) NotificationCompat.PRIORITY_LOW else NotificationCompat.PRIORITY_HIGH)
        if (body.isNotEmpty()) {
            builder.setContentText(body).setStyle(NotificationCompat.BigTextStyle().bigText(body))
        }
        // A confirmation the user already watched happen gets out of the way; a
        // problem lingers until it's swiped, because it is the only record.
        if (success) builder.setTimeoutAfter(SUCCESS_TIMEOUT_MS)
        // No sound, vibration or heads-up: the toast already said it (see postOutcome).
        if (silent) builder.setSilent(true)

        return try {
            NotificationManagerCompat.from(context).notify(tag, id, builder.build())
            true
        } catch (_: SecurityException) {
            false
        }
    }

    /**
     * Tags, not an offset id range, separate the three kinds.
     *
     * Ids alone used to do this — a base constant per kind, plus the low bits of
     * the message hash. That kept sends clear of the link notifications only by
     * arithmetic, and it gave [reconcilePending] no way to tell one of its own
     * standing promises from a settled verdict or an arriving tab. A tag is
     * exact: the sweep can only ever see, and only ever cancel, the notices it
     * is responsible for.
     */
    private const val TAG_PENDING = "send.pending"
    private const val TAG_OUTCOME = "send.outcome"
    private const val TAG_FLUSH = "send.flush"

    private const val RECOVERED_ID = 1
    private const val DROPPED_ID = 2
    private const val NEVER_ARRIVED_ID = 3
}
