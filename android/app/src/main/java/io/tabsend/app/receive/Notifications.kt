package io.tabsend.app.receive

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import io.tabsend.app.R
import io.tabsend.app.wire.BatchInfo
import io.tabsend.app.wire.SendPayload

/**
 * Incoming-link notifications. A received tab becomes a notification whose tap
 * opens the URL in the OS default browser (PRD §6.4) — Tabsend never intercepts
 * or reroutes, the user taps to open.
 */
object Notifications {
    const val CHANNEL_LINKS = "links"

    fun ensureChannel(context: Context) {
        val mgr = context.getSystemService(NotificationManager::class.java) ?: return
        if (mgr.getNotificationChannel(CHANNEL_LINKS) != null) return
        val channel = NotificationChannel(
            CHANNEL_LINKS,
            context.getString(R.string.channel_links_name),
            NotificationManager.IMPORTANCE_HIGH,
        ).apply {
            description = context.getString(R.string.channel_links_desc)
        }
        mgr.createNotificationChannel(channel)
    }

    /** Whether we're allowed to post — on API 33+ this needs the runtime permission. */
    fun enabled(context: Context): Boolean =
        NotificationManagerCompat.from(context).areNotificationsEnabled()

    /**
     * Post a link notification. Returns true if it was posted (delivery is only
     * acked to the relay when this succeeds, so a link is never silently dropped).
     */
    fun postLink(context: Context, messageId: String, payload: SendPayload): Boolean {
        if (!enabled(context)) return false
        if (!LinkPolicy.isOpenableWebUrl(payload.url)) return false
        ensureChannel(context)

        // Through our own one-shot activity rather than a direct VIEW intent, so
        // the tap can be recorded: Android tells an app nothing when a
        // notification opens a URL itself, and the inbox needs to know which
        // tabs the user actually opened [P-7]. The trampoline opens the link
        // first and records second, so this costs the link nothing.
        val view = Intent(context, OpenLinksActivity::class.java).apply {
            putStringArrayListExtra(OpenLinksActivity.EXTRA_URLS, arrayListOf(payload.url))
            putStringArrayListExtra(OpenLinksActivity.EXTRA_MESSAGE_IDS, arrayListOf(messageId))
        }
        val pending = PendingIntent.getActivity(
            context,
            messageId.hashCode(),
            view,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val notification = NotificationCompat.Builder(context, CHANNEL_LINKS)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(displayTitle(payload))
            .setContentText(payload.url)
            .setStyle(NotificationCompat.BigTextStyle().bigText(payload.url))
            .setContentIntent(pending)
            .setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .apply {
                // Batch member: stack under the batch id and let ONLY the summary
                // make noise, so a 10-tab batch alerts once instead of 10 times.
                // Tap behavior is untouched; each tab still opens on its own.
                payload.batch?.let { batch ->
                    setGroup(batch.id)
                    setGroupAlertBehavior(NotificationCompat.GROUP_ALERT_SUMMARY)
                }
            }
            .build()

        return try {
            NotificationManagerCompat.from(context).notify(messageId.hashCode(), notification)
            true
        } catch (_: SecurityException) {
            false
        }
    }

    /**
     * Post (or update) the one summary notification of a multi-tab batch. Batch
     * items can arrive across separate polls, so this is called again on every
     * drain that delivers a piece of the batch: the id is derived from the batch
     * id, and re-posting under the same id replaces the previous summary. State
     * stays minimal on purpose: the list shows the tabs of the CURRENT drain,
     * the count comes from the payload, and an "arrived so far" line is honest
     * about the difference. No store, no debris.
     */
    fun postBatchSummary(
        context: Context,
        batch: BatchInfo,
        senderLabel: String?,
        items: List<SendPayload>,
        /** Relay ids matching [items], so "Open all" can mark them opened [P-7]. */
        messageIds: List<String>,
    ) {
        if (!enabled(context) || items.isEmpty()) return
        ensureChannel(context)

        // The sender can't lie the count DOWN below what actually arrived.
        val count = maxOf(batch.count, items.size)
        val res = context.resources
        val title = if (senderLabel != null) {
            res.getQuantityString(R.plurals.batch_summary_title_from, count, count, senderLabel)
        } else {
            res.getQuantityString(R.plurals.batch_summary_title, count, count)
        }

        val style = NotificationCompat.InboxStyle()
        for (item in items) style.addLine(displayTitle(item))

        // "Open all" goes through our own invisible activity (OpenLinksActivity):
        // an activity PendingIntent is the one launch path notifications are
        // still allowed on modern Android (broadcast/service trampolines that
        // start activities are banned since 12). It opens the URLs of the
        // current drain, i.e. exactly the tabs listed above.
        val openAll = Intent(context, OpenLinksActivity::class.java).apply {
            putStringArrayListExtra(OpenLinksActivity.EXTRA_URLS, ArrayList(items.map { it.url }))
            putStringArrayListExtra(OpenLinksActivity.EXTRA_MESSAGE_IDS, ArrayList(messageIds))
        }
        val openAllPending = PendingIntent.getActivity(
            context,
            "open-all:${batch.id}".hashCode(),
            openAll,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val summary = NotificationCompat.Builder(context, CHANNEL_LINKS)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setStyle(style)
            .setGroup(batch.id)
            .setGroupSummary(true)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .addAction(0, context.getString(R.string.batch_open_all), openAllPending)
            .apply {
                if (items.size < count) {
                    setContentText(res.getString(R.string.batch_summary_partial, items.size, count))
                }
            }
            .build()

        try {
            NotificationManagerCompat.from(context).notify("batch:${batch.id}".hashCode(), summary)
        } catch (_: SecurityException) {
            // The members already posted (and were acked); losing only the
            // summary leaves them visible ungrouped, which is still correct.
        }
    }

    private fun displayTitle(payload: SendPayload): String =
        payload.title?.takeIf { it.isNotBlank() } ?: hostOf(payload.url)

    private fun hostOf(url: String): String = try {
        Uri.parse(url).host ?: url
    } catch (_: Exception) {
        url
    }
}
