package io.tabsend.app.receive

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import io.tabsend.app.R
import io.tabsend.app.logic.Keyring
import io.tabsend.app.logic.NewDeviceNotice
import io.tabsend.app.logic.NewDeviceWatch
import io.tabsend.app.logic.NewDevices
import io.tabsend.app.logic.isoMillisOf
import io.tabsend.app.logic.parseIsoMillis
import io.tabsend.app.logic.relativeTime
import io.tabsend.app.store.Store
import io.tabsend.app.ui.MainActivity
import io.tabsend.app.wire.Endpoint
import java.io.IOException

/**
 * The "new device joined" notice on Android (PLANS.md P-10).
 *
 * Every place that fetches the device list hands it to [record] instead of
 * writing `Store.cachedEndpoints` itself, so no fetch can skip the rule, and a
 * list the rule would ignore never reaches the cache, the sender checks or group
 * history. The rule ([NewDevices]) decides what joined; this saves the record
 * and posts the one system alert. The home screen's banner reads the same record.
 *
 * The alert is a security notice, so it is not tied to whether tabs arrive as
 * notifications. Only the operating system's own switch (and this channel's)
 * can silence it, and the banner covers the phone where they are off.
 */
object NewDeviceWatcher {
    const val CHANNEL_DEVICES = "devices"
    private const val TAG = "new-device"

    /**
     * A device list that does not contain this phone. The rule ignores such a
     * list, so nothing in it is announced; it must therefore not be used for
     * anything else either. Before 2026-10-13 it was cached anyway and handed to
     * group history: a relay could serve one list with a device of its own in it
     * and this phone missing, and get the group key sealed to that device (and
     * its key copies trusted) with no notice at all.
     *
     * An [IOException], so every caller already treats it as a failed fetch and
     * falls back to the last list that was accepted.
     */
    class ListWithoutSelfException : IOException("The relay returned a device list without this device")

    /**
     * Cache a freshly fetched device list and run the rule over it. Returns the
     * devices that joined since the last fetch (already announced).
     *
     * Throws [ListWithoutSelfException] for a list without this phone, which is
     * then neither cached nor judged: callers must not use it either. Any other
     * [IOException] means the list could not be recorded, and is not cached.
     */
    fun record(context: Context, list: List<Endpoint>): List<NewDeviceNotice> {
        val joined = accept(Store.get(context), list)
        if (joined.isNotEmpty()) announce(context, joined)
        return joined
    }

    /**
     * [record] minus the alert: the gate, the rule, then the cache, in that order.
     *
     * The watch is written FIRST and the cache only once that worked: the cache is
     * what the rest of the app acts on, so it must never hold a list the rule has
     * not recorded. A watch that could not be saved throws an [IOException] too,
     * and the caller falls back exactly as for a refused list.
     */
    internal fun accept(
        store: Store,
        list: List<Endpoint>,
        now: String = isoMillisOf(System.currentTimeMillis()),
    ): List<NewDeviceNotice> {
        // Unpaired: there is no self to look for, so no list can be judged.
        val selfId = store.registration?.endpointId ?: throw ListWithoutSelfException()
        if (!NewDevices.listIncludesSelf(list, selfId)) throw ListWithoutSelfException()
        val joined = try {
            store.updateNewDeviceWatch { prev ->
                // The key current now is the one a departure in this list owes a replacement for.
                val currentKey = Keyring.current(store.groupKeys)?.createdAt
                // With no record yet, the list a build from before this rule cached is the
                // baseline (GH6). Read before the cache is overwritten below.
                // A cache that cannot be read is no baseline, not a failed fetch.
                val seed = if (prev == null) runCatching { store.cachedEndpoints }.getOrNull() else null
                val result = NewDevices.watch(prev, list, selfId, now, currentKey, seed)
                result.watch to result.joined
            }
        } catch (e: Exception) {
            throw IOException("Could not record the device list", e)
        }
        store.cachedEndpoints = list
        return joined
    }

    /** Devices that joined and have not been answered on this phone, oldest first. */
    fun pending(context: Context): List<NewDeviceNotice> =
        Store.get(context).newDeviceWatch?.unconfirmed ?: emptyList()

    /** The first look: the other devices in the first list, waiting for one answer (GH6). */
    fun review(context: Context): List<NewDeviceNotice> = mine(Store.get(context))?.review.orEmpty()

    /** Announced as new, never answered, then gone from the list (GH7). */
    fun vanished(context: Context): List<NewDeviceNotice> = mine(Store.get(context))?.vanished.orEmpty()

    /** The record, only if it belongs to the pairing this phone is in. */
    private fun mine(store: Store): NewDeviceWatch? =
        store.newDeviceWatch?.takeIf { it.selfId == store.registration?.endpointId }

    /** "All of these are mine": the first look is answered on this phone only. */
    fun confirmReview(context: Context) {
        Store.get(context).updateNewDeviceWatch { prev ->
            (prev?.let { NewDevices.confirmReview(it) }) to Unit
        }
    }

    /** Dismiss one "joined, then disappeared" notice on this phone. */
    fun dismissVanished(context: Context, id: String) {
        Store.get(context).updateNewDeviceWatch { prev ->
            (prev?.let { NewDevices.dismissVanished(it, id) }) to Unit
        }
    }

    /** "Yes, it's mine": drop the notice on this phone only. */
    fun confirm(context: Context, id: String) {
        Store.get(context).updateNewDeviceWatch { prev ->
            (prev?.let { NewDevices.confirm(it, id) }) to Unit
        }
    }

    /**
     * A device this phone removed and the relay accepted: out of the cached list
     * and out of the pending notices at once, and written into the watch (X13).
     * "Remove it" is only a request, and a relay that answers it and keeps listing
     * the device would otherwise trigger no departure and no rotation. The watch
     * owes a rotation now, leaves the device out of key handoff for good, and
     * announces it if a later list shows it again.
     */
    fun removed(context: Context, id: String) = removed(Store.get(context), id)

    internal fun removed(
        store: Store,
        id: String,
        now: String = isoMillisOf(System.currentTimeMillis()),
    ) {
        recordRemoval(store, id, now)
        store.dropCachedEndpoint(id)
    }

    private fun recordRemoval(
        store: Store,
        id: String,
        now: String = isoMillisOf(System.currentTimeMillis()),
    ) {
        store.updateNewDeviceWatch { prev ->
            // A record from another pairing is not this phone's to change.
            val mine = prev?.takeIf { it.selfId == store.registration?.endpointId }
            val currentKey = Keyring.current(store.groupKeys)?.createdAt
            (mine?.let { NewDevices.removeDevice(it, id, now, currentKey) } ?: prev) to Unit
        }
    }

    /**
     * "Joined your Tabsend devices 5m ago" reads naturally with every output of
     * relativeTime except an unparseable time, which drops the {when} instead
     * of saying "unknown".
     */
    fun whenText(createdAt: String): String? =
        if (parseIsoMillis(createdAt) == null) null else relativeTime(createdAt)

    private fun ensureChannel(context: Context) {
        val mgr = context.getSystemService(NotificationManager::class.java) ?: return
        if (mgr.getNotificationChannel(CHANNEL_DEVICES) != null) return
        mgr.createNotificationChannel(
            NotificationChannel(
                CHANNEL_DEVICES,
                context.getString(R.string.channel_devices_name),
                NotificationManager.IMPORTANCE_HIGH,
            ).apply { description = context.getString(R.string.channel_devices_desc) },
        )
    }

    private fun announce(context: Context, joined: List<NewDeviceNotice>) {
        if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return
        ensureChannel(context)
        val res = context.resources
        val (title, body) = if (joined.size == 1) {
            val device = joined.first()
            val time = whenText(device.createdAt)
            context.getString(R.string.new_device_title, device.label) to
                if (time != null) {
                    context.getString(R.string.new_device_alert_body, time)
                } else {
                    context.getString(R.string.new_device_alert_body_no_time)
                }
        } else {
            res.getQuantityString(R.plurals.new_devices_alert_title, joined.size, joined.size) to
                context.getString(R.string.new_devices_alert_body, listOfLabels(context, joined.map { it.label }))
        }

        // Keyed by the first device, so a later join gets an alert of its own
        // instead of silently replacing one the user has not read.
        val id = joined.first().id.hashCode()
        val open = PendingIntent.getActivity(
            context,
            id,
            Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = NotificationCompat.Builder(context, CHANNEL_DEVICES)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
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
            // Permission revoked in between: the banner still shows it.
        }
    }

    /** "A and B", "A, B and C". */
    private fun listOfLabels(context: Context, labels: List<String>): String = when (labels.size) {
        0 -> ""
        1 -> labels[0]
        else -> context.getString(
            R.string.new_devices_list_and,
            labels.dropLast(1).joinToString(", "),
            labels.last(),
        )
    }
}
