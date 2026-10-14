package io.tabsend.app.work

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import io.tabsend.app.receive.StreamService
import io.tabsend.app.store.Store

/**
 * On device boot, drain the queue, re-arm the heartbeat + poll chain, and (when
 * instant delivery is on) restart the stream service. Delivery never depends on
 * anything having arrived while the device was off — the queue held everything,
 * and boot pulls it (PRD §6.1).
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        if (!Store.get(context).isRegistered) return
        Scheduling.ensurePeriodicHeartbeat(context)
        Scheduling.enqueueDrain(context)
        Scheduling.armPoll(context)
        StreamService.sync(context)
    }
}
