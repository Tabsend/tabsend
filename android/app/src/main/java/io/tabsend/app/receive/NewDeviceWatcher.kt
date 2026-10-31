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
 * and posts the one system alert.
 *
 * Told once, information only (P-23; owner, 2026-10-30): the alert names the devices
 * that joined, or else, on a fresh pairing, the first list's devices the pairing link did
 * not vouch for, and nothing waits for an answer. The record is stored settled
 * ([NewDevices.settleNotices]), so no device stays pending; a record from before
 * this with notices left in it is settled by the next list.
 *
 * The alert is a security notice, so it is not tied to whether tabs arrive as
 * notifications. Only the operating system's own switch (and this channel's)
 * can silence it.
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

    /** What one accepted list gives the user to know (P-23). */
    data class Told(
        /** Joined since the last list. */
        val joined: List<NewDeviceNotice>,
        /**
         * Only on the list that starts this pairing's record: its other devices the
         * pairing link did not vouch for (the first look, GH6). Empty otherwise.
         */
        val firstList: List<NewDeviceNotice>,
        /** Whether this device is the one that tells ([NewDevices.announcesNewDevices]). */
        val announces: Boolean,
    ) {
        /** True when there is something to post: one alert, for all of them. */
        val tells: Boolean get() = announces && (joined.isNotEmpty() || firstList.isNotEmpty())
    }

    /**
     * Cache a freshly fetched device list and run the rule over it, then post the one
     * alert when there is something to tell (P-23). Returns what the list told.
     *
     * Throws [ListWithoutSelfException] for a list without this phone, which is
     * then neither cached nor judged: callers must not use it either. Any other
     * [IOException] means the list could not be recorded, and is not cached.
     */
    fun record(context: Context, list: List<Endpoint>): Told {
        val told = accept(Store.get(context), list)
        if (told.tells) announce(context, told)
        return told
    }

    /**
     * [record] minus the alert: the gate, the rule, then the cache, in that order.
     * The record is stored settled ([NewDevices.settleNotices], P-23): what this list
     * told is told once, and nothing is left pending for a later list or screen.
     *
     * The watch is written FIRST and the cache only once that worked: the cache is
     * what the rest of the app acts on, so it must never hold a list the rule has
     * not recorded. A watch that could not be saved throws an [IOException] too,
     * and the caller falls back exactly as for a refused list.
     *
     * The first watch of a pairing (no record, or one for another endpoint) takes the
     * tags the pairing link carried ([Store.pairingVouch], P-23); once that record is
     * saved they are cleared, so no later list is judged against them.
     */
    internal fun accept(
        store: Store,
        list: List<Endpoint>,
        now: String = isoMillisOf(System.currentTimeMillis()),
    ): Told {
        // Unpaired: there is no self to look for, so no list can be judged.
        val selfId = store.registration?.endpointId ?: throw ListWithoutSelfException()
        if (!NewDevices.listIncludesSelf(list, selfId)) throw ListWithoutSelfException()
        // One clock for the record and for "seen in the last 30 days" (P-23).
        val nowMillis = parseIsoMillis(now) ?: System.currentTimeMillis()
        var vouchUsed = false
        val told = try {
            store.updateNewDeviceWatch { prev ->
                // The key current now is the one a departure in this list owes a replacement for.
                val currentKey = Keyring.current(store.groupKeys)?.createdAt
                // With no record yet, the list a build from before this rule cached is the
                // baseline (GH6). Read before the cache is overwritten below.
                // A cache that cannot be read is no baseline, not a failed fetch.
                val seed = if (prev == null) runCatching { store.cachedEndpoints }.getOrNull() else null
                // The link's vouch, only for the record this list starts (P-23).
                val vouched = if (prev == null || prev.selfId != selfId) store.pairingVouch else null
                val result = NewDevices.watch(prev, list, selfId, now, currentKey, seed, vouched)
                vouchUsed = vouched != null && result.watch != null
                // P-23: the first look is told once, on the list that starts the record.
                val fresh = prev == null || prev.selfId != selfId
                val out = Told(
                    joined = result.joined,
                    firstList = if (fresh) result.watch?.review.orEmpty() else emptyList(),
                    // Judged against the record read BEFORE this list: a phone that
                    // arrives with the newcomer silences nobody.
                    announces = NewDevices.announcesNewDevices(prev, list, selfId, nowMillis),
                )
                // Told once, so nothing is kept waiting for an answer.
                result.watch?.let(NewDevices::settleNotices) to out
            }
        } catch (e: Exception) {
            throw IOException("Could not record the device list", e)
        }
        // The record is saved, so the vouch has done its one job.
        if (vouchUsed) store.pairingVouch = null
        store.cachedEndpoints = list
        return told
    }

    /** Announced as new, never answered, then gone from the list (GH7). */
    fun vanished(context: Context): List<NewDeviceNotice> = mine(Store.get(context))?.vanished.orEmpty()

    /** The record, only if it belongs to the pairing this phone is in. */
    fun mine(store: Store): NewDeviceWatch? =
        store.newDeviceWatch?.takeIf { it.selfId == store.registration?.endpointId }

    // --- held tabs whose device is gone (P-15 item 3, SECURITY_REVIEW L3) ------
    //
    // The flush and the home screen judge a held tab by the same three answers,
    // all read from this phone's watch rather than from the relay's list as it
    // stands: the relay decides when a tab asks for a new device, so the list it
    // serves must not also decide what is offered, or what is said about it.

    /**
     * The ids a held tab's device must be among to be posted to: the cached list
     * as the watch accepts it ([NewDevices.endpointsKnownTo]), not the list itself,
     * so a device this phone removed that the relay still lists counts as gone
     * (X13). Empty with no watch of this pairing, which flags nothing new.
     */
    fun acceptedIds(store: Store): Set<String> =
        NewDevices.endpointsKnownTo(mine(store), store.cachedEndpoints).mapTo(HashSet()) { it.id }

    /** The devices a held tab whose device is gone may be moved to, in list order. */
    fun heldTabChoices(store: Store): List<Endpoint> {
        val selfId = store.registration?.endpointId ?: return emptyList()
        return NewDevices.heldTabChoices(mine(store), store.cachedEndpoints, selfId)
    }

    /** The ids THIS phone removed (X13): only a tab for one of these may say "was removed". */
    fun removedHere(store: Store): Set<String> = mine(store)?.removed.orEmpty().toSet()

    /**
     * The tags a pairing link this phone shows carries (P-23): the devices the watch
     * has accepted in the cached list, which is the last list the watch passed.
     * Empty when unpaired or with no watch of this pairing; the link then vouches for
     * nothing and the new device asks about everything, as before.
     */
    fun vouchTags(store: Store): List<String> {
        val selfId = store.registration?.endpointId ?: return emptyList()
        return NewDevices.vouchTags(mine(store), store.cachedEndpoints, selfId)
    }

    /** Dismiss one "joined, then disappeared" notice on this phone. */
    fun dismissVanished(context: Context, id: String) {
        Store.get(context).updateNewDeviceWatch { prev ->
            (prev?.let { NewDevices.dismissVanished(it, id) }) to Unit
        }
    }

    /**
     * Remove another device from the group: the relay's DELETE ([delete], given the
     * id), then the removal written into the watch. The device row's Remove comes
     * here (since P-23 the only one); the Android mirror of iOS's
     * `NewDevices.removeFromGroup`. A relay that answers "not found" has already
     * done it, and `ApiClient.deleteEndpoint` returns normally then. Anything
     * else [delete] throws is thrown on, with nothing recorded: the device may
     * still be in the group, and the caller says so. Never this phone, which
     * leaves with Unpair: nothing is sent for it.
     */
    internal fun removeFromGroup(
        store: Store,
        id: String,
        now: String = isoMillisOf(System.currentTimeMillis()),
        delete: (String) -> Unit,
    ) {
        if (id == store.registration?.endpointId) return
        delete(id)
        removed(store, id, now)
    }

    /**
     * A device this phone removed and the relay accepted: out of the cached list
     * and out of the pending notices at once, and written into the watch (X13).
     * "Remove it" is only a request, and a relay that answers it and keeps listing
     * the device would otherwise trigger no departure and no rotation. The watch
     * owes a rotation now, leaves the device out of key handoff for good, and
     * announces it if a later list shows it again.
     */
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

    /**
     * The one alert for a list (P-23), the same words on every client: the devices that
     * joined, or else, on a fresh pairing, the first list's devices the link did not vouch
     * for. When one list has both (a first run that took an older build's cache as its
     * baseline), only the joined are told, as the extension does.
     */
    private fun announce(context: Context, told: Told) {
        if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return
        ensureChannel(context)
        val joined = told.joined.isNotEmpty()
        val devices = if (joined) told.joined else told.firstList
        val (title, body) = alertText(context, devices, joined)

        // Keyed by the first device, so a later join gets an alert of its own
        // instead of silently replacing one the user has not read.
        val id = devices.first().id.hashCode()
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
            // Permission revoked in between: nothing else to do, the device list shows it.
        }
    }

    /**
     * The alert's title and body (P-23) for [devices], never empty: devices that [joined],
     * or the first list's devices the pairing link did not vouch for.
     */
    private fun alertText(
        context: Context,
        devices: List<NewDeviceNotice>,
        joined: Boolean,
    ): Pair<String, String> {
        val res = context.resources
        val labels = listOfLabels(context, devices.map { it.label })
        return when {
            !joined && devices.size == 1 ->
                context.getString(R.string.in_group_title, devices[0].label) to
                    context.getString(R.string.in_group_body)
            !joined ->
                res.getQuantityString(R.plurals.in_group_several_title, devices.size, devices.size) to
                    context.getString(R.string.in_group_several_body, labels)
            devices.size == 1 -> {
                val time = whenText(devices[0].createdAt)
                context.getString(R.string.new_device_title, devices[0].label) to
                    if (time != null) {
                        context.getString(R.string.new_device_alert_body, time)
                    } else {
                        context.getString(R.string.new_device_alert_body_no_time)
                    }
            }
            else ->
                res.getQuantityString(R.plurals.new_devices_alert_title, devices.size, devices.size) to
                    context.getString(R.string.new_devices_alert_body, labels)
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
