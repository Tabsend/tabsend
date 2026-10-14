package io.tabsend.app.receive

import android.content.Context
import android.util.Log
import io.tabsend.app.crypto.Base64x
import io.tabsend.app.crypto.CryptoBox
import io.tabsend.app.crypto.Sealer
import io.tabsend.app.logic.Inbox
import io.tabsend.app.logic.SeenSet
import io.tabsend.app.net.ApiClient
import io.tabsend.app.net.ApiException
import io.tabsend.app.logic.parseIsoMillis
import io.tabsend.app.net.GroupHistory
import io.tabsend.app.push.PushSetup
import io.tabsend.app.send.ShareShortcuts
import io.tabsend.app.store.Store
import io.tabsend.app.wire.BatchInfo
import io.tabsend.app.wire.Endpoint
import io.tabsend.app.wire.Message
import io.tabsend.app.wire.SendPayload
import io.tabsend.app.wire.WireJson
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.io.IOException

data class DrainSummary(val delivered: Int, val skipped: Int, val pending: Int, val offline: Boolean)

/**
 * The ONE deliver path: pull pending → verify sender → open envelope → notify →
 * ack. Serialized through a mutex and deduped on the seen-set so a push tickle, a
 * boot-drain, and an app-open poll can never open the same URL twice (PRD §6.1).
 * Correctness never depends on push arriving — every wake calls this.
 */
object Deliverer {
    private const val TAG = "Tabsend"
    private val mutex = Mutex()

    /**
     * Pull and deliver. [fromWake] says a Google push wake started this drain; every other
     * drain also asks whether its tabs arrived without one [G10], which is how a phone
     * notices that its wakes stopped arriving.
     */
    suspend fun drain(context: Context, fromWake: Boolean = false): DrainSummary =
        withContext(Dispatchers.IO) {
            mutex.withLock { doDrain(context, fromWake) }
        }

    private fun doDrain(context: Context, fromWake: Boolean): DrainSummary {
        val store = Store.get(context)
        val reg = store.registration ?: return DrainSummary(0, 0, 0, offline = false)
        val identity = store.identity ?: return DrainSummary(0, 0, 0, offline = false)

        // If we can't show a notification, leave everything queued rather than
        // ack-and-drop. It drains once notifications are enabled (prompted on open).
        if (!Notifications.enabled(context)) return DrainSummary(0, 0, 0, offline = false)

        val api = ApiClient.forRegistration(reg)
        val endpoints: List<Endpoint>
        val pending: List<Message>
        try {
            endpoints = api.listEndpoints(reg.deviceToken)
            // Keeps the share chooser usable offline, and runs the new-device rule
            // (P-10) over the list, which may post its alert. A list without this
            // phone throws (an IOException) and lands below as a failed fetch:
            // it must not vouch for a sender or receive the group key.
            NewDeviceWatcher.record(context, endpoints)
            // Same list, so the share sheet's per-device shortcuts track pairings
            // and renames without a refresh job of their own. Cheap: ShareShortcuts
            // skips the write unless the published set actually differs, which
            // matters here because this path runs in the background, where the
            // framework rate-limits shortcut updates.
            ShareShortcuts.sync(context, endpoints)
            pending = api.getPending(reg.deviceToken)
        } catch (e: IOException) {
            // Relay unreachable → queue holds everything until the next wake.
            return DrainSummary(0, 0, 0, offline = true)
        }

        val senderByKeyId = endpoints.associateBy { Base64x.keyId(it.e2ePubkey) }

        var seen = SeenSet.prune(store.seen, System.currentTimeMillis())
        var delivered = 0
        var skipped = 0
        // When each tab delivered here was sent: what [PushSetup.afterDrain] judges.
        val deliveredCreatedAt = mutableListOf<Long>()
        // Multi-tab batches delivered in THIS drain, keyed by batch id. Feeds the
        // per-batch summary notification after the loop; deliberately not
        // persisted (the summary rebuilds from whatever each drain brings, and
        // re-posting under the same id updates it).
        val batches = LinkedHashMap<String, BatchPass>()

        for (message in pending) {
            if (SeenSet.has(seen, message.id)) {
                ackQuietly(api, reg.deviceToken, message.id)
                skipped++
                continue
            }

            val sender = senderByKeyId[message.envelope.senderKeyId]
            if (sender == null) {
                // Unknown sender (not a current group endpoint) — refuse, leave queued.
                skipped++
                continue
            }

            val payload: SendPayload = try {
                val json = Sealer.open(message.envelope, sender.e2ePubkey, identity.privateKey)
                WireJson.decodeFromString(SendPayload.serializer(), json)
            } catch (e: CryptoBox.AuthenticationFailure) {
                skipped++
                continue
            } catch (e: Exception) {
                skipped++
                continue
            }

            // Console history copies never open anything; a mobile endpoint shouldn't
            // receive one, but drain it defensively so it can't wedge the queue.
            if (payload.historyOf != null) {
                seen = SeenSet.add(seen, message.id, System.currentTimeMillis())
                store.seen = seen
                ackQuietly(api, reg.deviceToken, message.id)
                skipped++
                continue
            }

            // Do not pass arbitrary schemes to Android's ACTION_VIEW resolver.
            // Invalid payloads cannot become valid on retry, so consume and ack
            // them instead of wedging the receive queue forever.
            if (!LinkPolicy.isOpenableWebUrl(payload.url)) {
                seen = SeenSet.add(seen, message.id, System.currentTimeMillis())
                store.seen = seen
                ackQuietly(api, reg.deviceToken, message.id)
                skipped++
                continue
            }

            // Mark seen BEFORE notifying so a crash/reboot can't double-post.
            seen = SeenSet.add(seen, message.id, System.currentTimeMillis())
            store.seen = seen

            val posted = Notifications.postLink(context, message.id, payload)
            if (!posted) {
                // Couldn't post (permission revoked mid-drain) — un-see so a later
                // wake retries; don't ack.
                seen = SeenSet.remove(seen, message.id)
                store.seen = seen
                skipped++
                continue
            }
            delivered++
            parseIsoMillis(message.createdAt)?.let { deliveredCreatedAt.add(it) }
            ackQuietly(api, reg.deviceToken, message.id)

            // Keep a copy the notification can't take with it [P-7]. Recorded only
            // after the notification posted and was acked: the inbox is
            // presentation on top of delivery, never part of the ack contract, so
            // a failure to record must cost a row and nothing more.
            try {
                store.updateInbox { list ->
                    Inbox.record(
                        list,
                        Inbox.project(message.id, payload, sender.label, System.currentTimeMillis()),
                    )
                }
            } catch (e: Exception) {
                Log.w(TAG, "could not record ${message.id} in the inbox: ${e.message}")
            }

            // Collect for the batch summary only AFTER the item posted and was
            // acked: the summary is presentation on top of delivery, never part
            // of the per-message ack contract.
            payload.batch?.let { batch ->
                val pass = batches.getOrPut(batch.id) { BatchPass(batch, sender.label) }
                pass.items.add(payload)
                pass.messageIds.add(message.id)
            }
        }

        // One summary per batch touched this drain. Re-posting under the same
        // stable id updates the summary a previous drain left, so a batch that
        // trickles in across polls converges on one stacked thread.
        for (pass in batches.values) {
            Notifications.postBatchSummary(
                context,
                pass.batch,
                pass.senderLabel,
                pass.items,
                pass.messageIds,
            )
        }

        store.seen = seen

        // Only tabs this drain actually delivered: one left queued (an unknown sender, say)
        // would be found again by every poll and read as a missed wake each time.
        PushSetup.afterDrain(context, deliveredCreatedAt, fromWake)

        // Group history [0028], last. It rides on the endpoint list this drain
        // already fetched, since both the key election and sealing a copy of the
        // key to a newcomer need it — but it goes AFTER delivery so a slow (or
        // absent) history route can never stand between an arriving tab and its
        // notification. Wholly best-effort and it swallows its own failures,
        // including a relay that has never heard of these routes.
        GroupHistory.sync(context, api, reg, identity, endpoints)

        return DrainSummary(delivered, skipped, pending.size, offline = false)
    }

    /** Tabs of one batch that landed in the current drain (see `batches` above). */
    private class BatchPass(
        val batch: BatchInfo,
        val senderLabel: String?,
        val items: MutableList<SendPayload> = mutableListOf(),
        /** Parallel to [items] — "Open all" marks these opened in the inbox [P-7]. */
        val messageIds: MutableList<String> = mutableListOf(),
    )

    private fun ackQuietly(api: ApiClient, token: String, id: String) {
        try {
            api.ack(token, id)
        } catch (e: ApiException) {
            Log.w(TAG, "ack rejected for $id: ${e.message}")
        } catch (e: IOException) {
            // The notification is up; the ack lands on a later drain (server dedupes).
        }
    }
}
