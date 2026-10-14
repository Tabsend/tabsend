package io.tabsend.app.work

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import java.util.concurrent.TimeUnit

/** Central place for the app's background jobs. */
object Scheduling {
    private const val DRAIN = "tabsend.drain"
    private const val HEARTBEAT_ONCE = "tabsend.heartbeat.once"
    private const val HEARTBEAT_PERIODIC = "tabsend.heartbeat.periodic"

    /** ~5-min poll cadence [0015]; Doze throttles it further, and that's expected. */
    private const val POLL_INTERVAL_MS = 5 * 60 * 1000L
    private const val POLL_REQUEST_CODE = 0

    private val onlineConstraint = Constraints.Builder()
        .setRequiredNetworkType(NetworkType.CONNECTED)
        .build()

    /** Pull-and-deliver now (push tickle, boot, app open). Correctness path. */
    fun enqueueDrain(context: Context) {
        val work = OneTimeWorkRequestBuilder<DrainWorker>()
            .setConstraints(onlineConstraint)
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork(DRAIN, ExistingWorkPolicy.REPLACE, work)
    }

    /** Report presence + rotate the push subscription once, soon. */
    fun enqueueHeartbeat(context: Context) {
        val work = OneTimeWorkRequestBuilder<HeartbeatWorker>()
            .setConstraints(onlineConstraint)
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork(HEARTBEAT_ONCE, ExistingWorkPolicy.REPLACE, work)
    }

    /**
     * Keep presence warm while the app isn't in front. 15 min is WorkManager's
     * floor; presence still relies on app-open/boot heartbeats for freshness, and
     * queue+poll covers delivery regardless (push is only latency).
     */
    fun ensurePeriodicHeartbeat(context: Context) {
        val work = PeriodicWorkRequestBuilder<HeartbeatWorker>(15, TimeUnit.MINUTES)
            .setConstraints(onlineConstraint)
            .build()
        WorkManager.getInstance(context)
            .enqueueUniquePeriodicWork(HEARTBEAT_PERIODIC, ExistingPeriodicWorkPolicy.KEEP, work)
    }

    /**
     * (Re-)arm the next ~5-min poll tick [0015]. One-shot, chained by
     * PollReceiver — `setAndAllowWhileIdle` needs no permission and fires even
     * in light idle (deep Doze throttles it to the platform floor, ~9–15 min).
     */
    fun armPoll(context: Context) {
        val am = context.getSystemService(AlarmManager::class.java) ?: return
        am.setAndAllowWhileIdle(
            AlarmManager.RTC_WAKEUP,
            System.currentTimeMillis() + POLL_INTERVAL_MS,
            pollIntent(context),
        )
    }

    private fun cancelPoll(context: Context) {
        context.getSystemService(AlarmManager::class.java)?.cancel(pollIntent(context))
    }

    private fun pollIntent(context: Context): PendingIntent = PendingIntent.getBroadcast(
        context,
        POLL_REQUEST_CODE,
        Intent(context, PollReceiver::class.java),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

    fun cancelAll(context: Context) {
        cancelPoll(context)
        val wm = WorkManager.getInstance(context)
        wm.cancelUniqueWork(DRAIN)
        wm.cancelUniqueWork(HEARTBEAT_ONCE)
        wm.cancelUniqueWork(HEARTBEAT_PERIODIC)
    }
}
