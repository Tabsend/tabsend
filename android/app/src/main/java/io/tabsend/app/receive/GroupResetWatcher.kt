package io.tabsend.app.receive

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import io.tabsend.app.R
import io.tabsend.app.logic.GroupResets
import io.tabsend.app.net.ApiClient
import io.tabsend.app.store.Registration
import io.tabsend.app.store.Store
import io.tabsend.app.ui.MainActivity
import io.tabsend.app.wire.GroupResetState
import java.time.ZoneId

/**
 * The reset that waits, on Android [PLANS.md P-18 item 12].
 *
 * Someone who lost every device can ask on the account page for the group to be
 * replaced by an empty one, 72 hours later. Every paired device must see that and be
 * able to stop it: that is the safeguard against someone who took over the owner's
 * email. This asks the relay, keeps what it said ([GroupResets] decides), posts the
 * one alert per reset, and stops a reset on the user's say.
 *
 * Asked wherever the new-device watch fetches the device list (every drain, so every
 * wake and poll; the home screen; History; the share sheet), and on the stream's
 * `group_updated`. Like the new-device alert, a security notice: not tied to whether
 * tabs arrive as notifications, and the home screen's card covers a phone where
 * notifications are off.
 */
object GroupResetWatcher {
    const val CHANNEL_RESET = "group_reset"
    private const val TAG = "group-reset"
    private const val LOG_TAG = "Tabsend"

    /** Told after a check or a change, from any thread, so an open home screen can redraw. */
    @Volatile
    var onChange: (() -> Unit)? = null

    /**
     * Ask the relay whether a reset waits, record the answer, and alert once per reset.
     * Blocking: call off the main thread. Best effort: a relay that cannot be reached
     * leaves the last answer standing (a card stays up rather than vanish offline).
     */
    fun check(context: Context, api: ApiClient, reg: Registration) {
        val reset = try {
            api.getGroupReset(reg.deviceToken)
        } catch (e: Exception) {
            // Unreachable, refused, or an answer that does not parse: nothing learned.
            Log.d(LOG_TAG, "group state not checked: ${e.message}")
            return
        }
        val store = Store.get(context)
        val before = store.groupReset?.reset
        val notify = record(store, reg.endpointId, reset)
        // One that is no longer pending takes its alert with it.
        if (before != null && before.requestedAt != reset?.requestedAt) cancelAlert(context, before)
        if (notify != null) announce(context, notify)
        onChange?.invoke()
    }

    /** [check] for a caller with no client to hand (the stream). Blocking. */
    fun checkNow(context: Context) {
        val reg = Store.get(context).registration ?: return
        check(context, ApiClient.forRegistration(reg), reg)
    }

    /** Write the relay's answer into the record. Returns the reset to alert about, if any. */
    internal fun record(store: Store, selfId: String, reset: GroupResetState?): GroupResetState? =
        store.updateGroupReset { prev ->
            val observed = GroupResets.observe(prev, selfId, reset)
            observed.record to observed.notify
        }

    /** The reset the home screen shows, or null. */
    fun pending(context: Context): GroupResetState? = pending(Store.get(context))

    internal fun pending(store: Store): GroupResetState? =
        GroupResets.toShow(store.groupReset, store.registration?.endpointId)

    /** "It was me": hide this reset on this phone only. */
    fun dismiss(context: Context, reset: GroupResetState) {
        dismiss(Store.get(context), reset.requestedAt)
        cancelAlert(context, reset)
    }

    internal fun dismiss(store: Store, requestedAt: String) {
        store.updateGroupReset { prev ->
            (prev?.let { GroupResets.dismiss(it, requestedAt) }) to Unit
        }
    }

    /**
     * "Stop the reset": the relay's POST ([stop]), then the record cleared. Anything
     * [stop] throws is thrown on with nothing recorded: the reset may still be pending,
     * and the card must stay.
     */
    internal fun stop(store: Store, stop: () -> Unit) {
        stop()
        store.updateGroupReset { prev -> (prev?.let { GroupResets.stopped(it) }) to Unit }
    }

    /** The alert's words: when it was asked for, in the phone's time zone. */
    fun alertBody(context: Context, reset: GroupResetState, zone: ZoneId = ZoneId.systemDefault()): String {
        val asked = GroupResets.day(reset.requestedAt, zone)
        return if (asked != null) {
            context.getString(R.string.reset_alert_body, asked)
        } else {
            context.getString(R.string.reset_alert_body_no_time)
        }
    }

    private fun ensureChannel(context: Context) {
        val mgr = context.getSystemService(NotificationManager::class.java) ?: return
        if (mgr.getNotificationChannel(CHANNEL_RESET) != null) return
        mgr.createNotificationChannel(
            NotificationChannel(
                CHANNEL_RESET,
                context.getString(R.string.channel_reset_name),
                NotificationManager.IMPORTANCE_HIGH,
            ).apply { description = context.getString(R.string.channel_reset_desc) },
        )
    }

    private fun alertId(reset: GroupResetState): Int = reset.requestedAt.hashCode()

    private fun announce(context: Context, reset: GroupResetState) {
        if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return
        ensureChannel(context)
        val body = alertBody(context, reset)
        val id = alertId(reset)
        val open = PendingIntent.getActivity(
            context,
            id,
            Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = NotificationCompat.Builder(context, CHANNEL_RESET)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(context.getString(R.string.reset_alert_title))
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setContentIntent(open)
            .setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .build()
        try {
            NotificationManagerCompat.from(context).notify(TAG, id, notification)
        } catch (_: SecurityException) {
            // Permission revoked in between: the card still shows it.
        }
    }

    /** Take down the alert for [reset], if it is still up. */
    fun cancelAlert(context: Context, reset: GroupResetState) {
        NotificationManagerCompat.from(context).cancel(TAG, alertId(reset))
    }
}
