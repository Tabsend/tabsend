package io.tabsend.app.work

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import io.tabsend.app.store.Store

/**
 * One tick of the ~5-minute poll chain [0015]: heartbeat + flush + drain, then
 * re-arm the next alarm. `setAndAllowWhileIdle` fires close to on-time while the
 * phone is awake; in deep Doze the OS throttles ALL apps to roughly one tick per
 * 9–15 min — that's the platform floor without push. The 15-min WorkManager
 * periodic stays as the backstop (it survives odd alarm loss).
 */
class PollReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (!Store.get(context).isRegistered) return
        Scheduling.enqueueHeartbeat(context) // heartbeat + flush outbound + drain
        Scheduling.armPoll(context)          // chain the next tick
    }
}
