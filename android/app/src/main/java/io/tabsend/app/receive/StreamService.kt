package io.tabsend.app.receive

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import io.tabsend.app.R
import io.tabsend.app.net.StreamManager
import io.tabsend.app.store.Store
import io.tabsend.app.ui.MainActivity

/**
 * Instant delivery, the no-Google way: a foreground service that keeps the relay
 * WebSocket alive while the app is in the background, so a sent tab pops a
 * notification within a second — no distributor app, no Google. Android
 * mandates the persistent notification for any long-lived service; the channel
 * is IMPORTANCE_MIN so it stays collapsed and silent.
 *
 * This runs when instant delivery is on AND Google push is not carrying it [P-11]. With a
 * wake token in the store the relay rings the forwarder instead, which needs no service and
 * so shows no notification — that is the whole point of the Google path, and running both
 * would reintroduce the notification it exists to remove. The exception is a phone whose
 * wakes stopped arriving [2026-10-02, SECURITY_REVIEW G10]: it keeps the enrolment and runs
 * this as well, because a doorbell that never rings is no reason to go without delivery.
 *
 * The alarm/WorkManager polling stays armed regardless of either, so a killed service or a
 * dropped push degrades to polling, never to loss.
 */
class StreamService : Service() {

    override fun onCreate() {
        super.onCreate()
        ensureChannel(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Foreground first, always: a service started with startForegroundService that stops
        // without ever calling startForeground is treated by Android as a crash, and the
        // store can change between the start and this point (an enrolment saved, say).
        startForeground(NOTIFICATION_ID, buildNotification(this))
        // Toggled off or unpaired since the start was requested → don't linger.
        if (!shouldRun(Store.get(this))) {
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }
        StreamManager.onServiceActive(this, true)
        return START_STICKY
    }

    override fun onDestroy() {
        StreamManager.onServiceActive(this, false)
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        private const val CHANNEL_CONNECTION = "connection"
        private const val NOTIFICATION_ID = 1

        /**
         * Registered, instant delivery on, and no working Google push enrolment carrying it
         * already: none at all, or one whose wakes stopped arriving [G10].
         */
        internal fun shouldRun(store: Store): Boolean =
            store.isRegistered &&
                store.instantDelivery &&
                (store.wakeToken == null || store.wakesMissedAt != null)

        /** Start or stop the service to match the store. */
        fun sync(context: Context) {
            val store = Store.get(context)
            val intent = Intent(context, StreamService::class.java)
            if (shouldRun(store)) {
                try {
                    ContextCompat.startForegroundService(context, intent)
                } catch (_: Exception) {
                    // Background-start restriction (e.g. boot on newer Android):
                    // polling still delivers; the next app-open starts the service.
                }
            } else {
                context.stopService(intent)
            }
        }

        private fun ensureChannel(context: Context) {
            val mgr = context.getSystemService(NotificationManager::class.java) ?: return
            if (mgr.getNotificationChannel(CHANNEL_CONNECTION) != null) return
            val channel = NotificationChannel(
                CHANNEL_CONNECTION,
                context.getString(R.string.channel_connection_name),
                NotificationManager.IMPORTANCE_MIN,
            ).apply {
                description = context.getString(R.string.channel_connection_desc)
                setShowBadge(false)
            }
            mgr.createNotificationChannel(channel)
        }

        private fun buildNotification(context: Context): Notification {
            val open = PendingIntent.getActivity(
                context,
                0,
                Intent(context, MainActivity::class.java),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            return NotificationCompat.Builder(context, CHANNEL_CONNECTION)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(context.getString(R.string.instant_notification_title))
                .setContentText(context.getString(R.string.instant_notification_text))
                .setContentIntent(open)
                .setOngoing(true)
                .setPriority(NotificationCompat.PRIORITY_MIN)
                .setCategory(NotificationCompat.CATEGORY_SERVICE)
                .build()
        }
    }
}
