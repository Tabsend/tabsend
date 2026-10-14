package io.tabsend.app.work

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import io.tabsend.app.net.Registrar
import io.tabsend.app.push.PushSetup
import io.tabsend.app.receive.Deliverer
import io.tabsend.app.send.SendNotifications
import io.tabsend.app.send.Sender

/**
 * Pull pending + deliver, and flush any source-side outbound queue. Enqueued on a
 * push tickle, on boot, and on app open. Carries a CONNECTED constraint.
 */
class DrainWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        flushAndReport(applicationContext)
        val summary = Deliverer.drain(applicationContext)
        return if (summary.offline) Result.retry() else Result.success()
    }
}

/**
 * Heartbeat (presence), flush outbound, then drain. Also settles Google push when
 * something is still owed: a wake token to retire, a Google registration to delete, an
 * enrolment that failed offline [2026-10-02, SECURITY_REVIEW G8]. Those used to wait for
 * the next app start, so an offline moment could leave a relay ringing for days.
 */
class HeartbeatWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        Registrar.heartbeat(applicationContext)
        flushAndReport(applicationContext)
        Deliverer.drain(applicationContext)
        // Last, so a slow or failing push step never holds up the poll's own delivery.
        if (PushSetup.hasPendingWork(applicationContext)) PushSetup.sync(applicationContext)
        return Result.success()
    }
}

/**
 * Retry the outbound queue and say what came of it.
 *
 * Shared with [io.tabsend.app.net.StreamManager]'s reconnect handler, which has
 * the earliest evidence there is that the relay is back — so the two must not
 * differ on what a flush owes the user afterwards.
 */
suspend fun flushAndReport(context: Context) {
    SendNotifications.announceFlush(context, Sender.flushOutbound(context))
}
