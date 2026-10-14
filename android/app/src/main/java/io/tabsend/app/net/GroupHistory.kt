package io.tabsend.app.net

import android.content.Context
import android.util.Log
import io.tabsend.app.crypto.Base64x
import io.tabsend.app.crypto.CryptoBox
import io.tabsend.app.crypto.Sealer
import io.tabsend.app.logic.History
import io.tabsend.app.logic.HistoryItem
import io.tabsend.app.logic.HistoryRow
import io.tabsend.app.logic.Keyring
import io.tabsend.app.logic.NewDeviceWatch
import io.tabsend.app.logic.NewDevices
import io.tabsend.app.receive.NewDeviceWatcher
import io.tabsend.app.send.SendNotifications
import io.tabsend.app.store.Identity
import io.tabsend.app.store.Registration
import io.tabsend.app.store.Store
import io.tabsend.app.wire.Endpoint
import io.tabsend.app.wire.GroupKeyDelivery
import io.tabsend.app.wire.GroupKeyItem
import io.tabsend.app.wire.GroupKeyRecord
import io.tabsend.app.wire.GroupKeyRequest
import io.tabsend.app.wire.GroupKeyResponse
import io.tabsend.app.wire.HistoryRecord
import io.tabsend.app.wire.WireJson
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject

/**
 * The group history key and the group's shared history [ADR-0028].
 *
 * Runs on every wake that already refreshes the endpoint list, because both jobs
 * need exactly that list: the key election reads it, and sealing a copy of the
 * key to a new device needs the `e2ePubkey` it publishes there.
 *
 * EVERYTHING here is best-effort and nothing it does may escape. History is a
 * record of sending and receiving, not part of either, so a relay that refuses,
 * a blob that will not open, or a key that never arrives must cost a row on a
 * screen and nothing else. That includes the whole feature being absent: a relay
 * predating ADR-0028 answers 404 on `/v1/group-keys` and 400 on
 * `?history=1`, which means "this relay has no group history", not "something
 * broke". An app updates itself and a self-hosted relay is updated by hand, so
 * new-client-against-old-relay is the normal state for a while, not an edge case.
 */
object GroupHistory {
    private const val TAG = "Tabsend"

    /**
     * Key upkeep then history, with a list the caller has already fetched.
     *
     * One catch-all around the lot, on top of the narrower ones inside: this is
     * called from the middle of the drain, and the rule that history can never
     * cost a tab is worth stating in code rather than trusting to every branch
     * below staying careful.
     */
    fun sync(
        context: Context,
        api: ApiClient,
        reg: Registration,
        identity: Identity,
        endpoints: List<Endpoint>,
    ) {
        try {
            syncKeys(context, api, reg, identity, endpoints)
            refresh(context, api, reg)
        } catch (e: Exception) {
            Log.w(TAG, "group history skipped: ${e.message}")
        }
    }

    /**
     * Refresh from a surface that has no endpoint list to hand (the History
     * screen opening). Falls back to the cached list rather than skipping: a
     * stale list can still be wrong about who needs a key, and [Keyring] is
     * written to tolerate that — it just does the work again next wake. The cache
     * only ever holds a list the new-device rule accepted; a fetched list without
     * this phone throws in [NewDeviceWatcher.record] and lands on the fallback.
     */
    suspend fun syncNow(context: Context): Unit = withContext(Dispatchers.IO) {
        val store = Store.get(context)
        val reg = store.registration ?: return@withContext
        val identity = store.identity ?: return@withContext
        val api = ApiClient.forRegistration(reg)
        val endpoints = try {
            api.listEndpoints(reg.deviceToken).also { NewDeviceWatcher.record(context, it) }
        } catch (e: Exception) {
            store.cachedEndpoints
        }
        sync(context, api, reg, identity, endpoints)
    }

    // --- the key ------------------------------------------------------------

    /** The two relay calls the key sync makes, so a test can stand in for the relay. */
    internal interface KeyRelay {
        fun fetch(): List<GroupKeyDelivery>
        fun post(body: GroupKeyRequest): GroupKeyResponse
    }

    private fun syncKeys(
        context: Context,
        api: ApiClient,
        reg: Registration,
        identity: Identity,
        endpoints: List<Endpoint>,
    ) {
        val relay = object : KeyRelay {
            override fun fetch() = api.getGroupKeys(reg.deviceToken)
            override fun post(body: GroupKeyRequest) = api.postGroupKeys(reg.deviceToken, body)
        }
        try {
            syncKeys(Store.get(context), relay, reg.endpointId, identity, endpoints, System.currentTimeMillis())
        } catch (e: Exception) {
            Log.w(TAG, "group key upkeep skipped: ${e.message}")
        }
    }

    /**
     * Collect whatever copies of the group key are waiting for us, mint the
     * group's first key if this device is the one elected to, replace the key if
     * a device has left, and hand the current key to any member that has not been
     * given it.
     */
    internal fun syncKeys(
        store: Store,
        relay: KeyRelay,
        selfId: String,
        identity: Identity,
        endpoints: List<Endpoint>,
        nowMs: Long,
        freshKey: () -> String = { Base64x.encode(CryptoBox.randomSecretKey()) },
    ) {
        // Only a list the new-device rule accepted may decide who is trusted and
        // who gets the key, and the rule ignores a list without this phone.
        // [NewDeviceWatcher.record] no longer lets one through; this catches a
        // cache an older build wrote.
        if (!NewDevices.listIncludesSelf(endpoints, selfId)) return
        // Read once, so trust, hand-out and the rotation all act on the same view.
        // Trust and hand out only to devices the watch has accepted, by id AND key:
        // a list read before the watch moved on may still hold a device that just
        // left, and the new key must not reach it.
        val watch = store.newDeviceWatch
        val trusted = NewDevices.endpointsKnownTo(watch, endpoints)
        collect(store, relay, identity, trusted, nowMs)
        mintFirstKeyIfElected(store, selfId, trusted, nowMs, freshKey)
        // After collecting, so a rotation another device already made is seen and
        // not repeated; before handing out, so the new key goes to every device
        // still in the list (the one that left is not).
        rotateIfOwed(store, watch, nowMs, freshKey)
        deliver(store, relay, selfId, identity, trusted)
    }

    /**
     * Fold every copy sealed to us into the ring.
     *
     * The sender check is the same anti-injection rule a tab gets (ADR-0009): the
     * envelope's `senderKeyId` has to fingerprint a CURRENT group endpoint's
     * published key. Without it a relay could hand this device a key of its own
     * choosing and then read every history blob written under it — which is
     * precisely the property ADR-0028 rests on.
     */
    private fun collect(
        store: Store,
        relay: KeyRelay,
        identity: Identity,
        endpoints: List<Endpoint>,
        nowMs: Long,
    ) {
        val deliveries = try {
            relay.fetch()
        } catch (e: Exception) {
            // Unreachable, or a relay that has never heard of the route.
            return
        }
        if (deliveries.isEmpty()) return

        val incoming = openCopies(deliveries, endpoints, identity.privateKey, nowMs)
        if (incoming.isEmpty()) return
        store.updateGroupKeys { ring -> Keyring.merge(ring, incoming) }
    }

    /**
     * Open every copy addressed to us, dropping anything we cannot vouch for: a
     * sender that is not in [endpoints], an envelope that will not open, and a
     * record [Keyring.isAcceptableRecord] refuses (a date that would pin it as
     * the current key, a malformed list of departed devices, a key that is not 32
     * bytes, or a `keyId` that is not its fingerprint).
     */
    internal fun openCopies(
        deliveries: List<GroupKeyDelivery>,
        endpoints: List<Endpoint>,
        privateKey: String,
        nowMs: Long,
    ): List<GroupKeyRecord> {
        val senderByKeyId = endpoints.associateBy { Base64x.keyId(it.e2ePubkey) }
        val incoming = mutableListOf<GroupKeyRecord>()
        for (delivery in deliveries) {
            val sender = senderByKeyId[delivery.envelope.senderKeyId] ?: continue
            val record = try {
                val json = Sealer.open(delivery.envelope, sender.e2ePubkey, privateKey)
                // `departed` is read from the raw JSON first: the wire parser is
                // lenient and would take `[1]` for `["1"]`, where the other clients
                // refuse the record.
                val raw = WireJson.parseToJsonElement(json) as? JsonObject ?: continue
                if (!Keyring.isAcceptableDeparted(raw["departed"])) continue
                WireJson.decodeFromString(GroupKeyRecord.serializer(), json)
            } catch (e: Exception) {
                // Forged, sealed to a key we have replaced, or simply not a key
                // record. Drop the copy; the ring is unchanged and a later
                // delivery from a device that agrees with us still works.
                continue
            }
            if (!Keyring.isAcceptableRecord(record, nowMs)) continue
            // What the key claims to replace, minus the device that sent this copy: a
            // device cannot vouch that it has left (X14).
            incoming += record.copy(departed = Keyring.vouchedDeparted(record.departed, sender.id))
        }
        return incoming
    }

    /**
     * Mint the group's first key, but only if this device is the one elected to
     * (see [Keyring.shouldMintFirstKey] for why an election at all). A group that
     * predates ADR-0028 has no key and nobody to send one; somebody has to start.
     */
    private fun mintFirstKeyIfElected(
        store: Store,
        selfId: String,
        endpoints: List<Endpoint>,
        nowMs: Long,
        freshKey: () -> String,
    ) {
        store.updateGroupKeys { ring ->
            if (!Keyring.shouldMintFirstKey(ring, endpoints, selfId)) {
                ring
            } else {
                val key = freshKey()
                Keyring.merge(ring, listOf(Keyring.mintedKey(ring, key, Base64x.keyId(key), nowMs)))
            }
        }
    }

    /**
     * Replace the group key when a device has left (ADR-0028 §7).
     *
     * The new-device rule records a departure as `rotateOwedAt`, whoever removed
     * the device (this phone, a browser, the console) and whether or not the relay
     * only showed it once, together with the key that was current then
     * (`rotateFrom`). Nothing to do while the ring is empty (the first-key
     * election covers that). Otherwise mint unless the ring already holds a key
     * newer than `rotateFrom` (another device rotated, and a second key would only
     * add churn), and settle the debt EITHER WAY, or every device would mint once
     * per departure. It is cleared through the watch's own read-modify-write, and
     * only if it is still the one that was read: a device that left in between
     * owes another.
     */
    private fun rotateIfOwed(
        store: Store,
        watch: NewDeviceWatch?,
        nowMs: Long,
        freshKey: () -> String,
    ) {
        val owedAt = watch?.rotateOwedAt ?: return
        var settled = false
        store.updateGroupKeys { ring ->
            val newest = Keyring.current(ring) ?: return@updateGroupKeys ring
            settled = true
            // Stand down only for a key that is newer AND names the devices owed
            // for: one that merely arrived later may be held by the device that left (X14).
            if (!NewDevices.rotationDue(watch, newest.createdAt, newest.departed)) {
                ring
            } else {
                val key = freshKey()
                val departed = NewDevices.rotationDeparted(watch)
                Keyring.merge(ring, listOf(Keyring.mintedKey(ring, key, Base64x.keyId(key), nowMs, departed)))
            }
        }
        if (!settled) return
        store.updateNewDeviceWatch { prev -> prev?.let { NewDevices.rotationDone(it, owedAt) } to Unit }
    }

    /**
     * Seal the current key to every member that has not been given it and post
     * the copies.
     *
     * Only ACCEPTED ids are recorded as delivered. A rejection is usually
     * `expired_key` — the target re-paired and republished — and forgetting it
     * here is what lets the next wake try again against the key it publishes now.
     */
    private fun deliver(
        store: Store,
        relay: KeyRelay,
        selfId: String,
        identity: Identity,
        endpoints: List<Endpoint>,
    ) {
        val ring = store.groupKeys
        val key = Keyring.current(ring) ?: return
        val pending = Keyring.pendingDeliveries(ring, endpoints, selfId, store.deliveredGroupKeys)
        if (pending.isEmpty()) return

        val recordJson = WireJson.encodeToString(GroupKeyRecord.serializer(), key)
        val items = pending.mapNotNull { target ->
            try {
                GroupKeyItem(
                    // The relay dedupes on this id, so two devices racing to help
                    // the same newcomer is a no-op rather than two copies.
                    id = target.id,
                    targetEndpointId = target.targetEndpointId,
                    envelope = Sealer.seal(
                        payloadJson = recordJson,
                        targetPubB64 = target.targetPubkey,
                        senderPrivB64 = identity.privateKey,
                        senderKeyId = identity.keyId,
                    ),
                )
            } catch (e: Exception) {
                // A malformed published key for one device must not stop the rest.
                null
            }
        }
        if (items.isEmpty()) return

        val response = try {
            relay.post(GroupKeyRequest(items))
        } catch (e: Exception) {
            return
        }
        if (response.accepted.isEmpty()) return
        store.updateDeliveredGroupKeys { done -> (response.accepted + done).distinct() }
    }

    // --- the history --------------------------------------------------------

    /**
     * Pull the group's history, open what this device holds a key for, and cache
     * it for offline reading.
     *
     * A row whose key is missing is KEPT, unopened. It is still a true record
     * that a tab went from one device to another and whether it landed, which is
     * more than existed before ADR-0028; dropping it would silently shorten the
     * list for a device that joined after a rotation.
     */
    private fun refresh(context: Context, api: ApiClient, reg: Registration) {
        val store = Store.get(context)
        val entries = try {
            api.getHistory(reg.deviceToken)
        } catch (e: Exception) {
            // Offline, or a relay with no history to serve. The cache stands.
            return
        }

        val ring = store.groupKeys
        val items = entries.map { entry ->
            val record = Keyring.byId(ring, entry.blob.keyId)?.let { key ->
                try {
                    WireJson.decodeFromString(
                        HistoryRecord.serializer(),
                        Sealer.openGroup(entry.blob, key.key),
                    )
                } catch (e: Exception) {
                    null
                }
            }
            History.project(entry, record)
        }
        // The relay is authoritative, so its rows REPLACE the cache rather than
        // merging into it — a row it has dropped past the retention window is
        // gone, and one it has re-stated as acked has to be able to say so.
        store.updateHistory { History.cache(items) }
        announceNeverArrived(context, store.history, reg.endpointId)
    }

    /**
     * Tell the user, once, about a tab this phone sent that will now never land.
     *
     * They were told "Sent" and walked away, and under ADR-0008 that only ever
     * meant the relay took it. Nothing else will ever mention it again.
     */
    private fun announceNeverArrived(
        context: Context,
        items: List<HistoryItem>,
        selfEndpointId: String,
    ) {
        val store = Store.get(context)
        val rows = History.rows(items, store.inbox, selfEndpointId, System.currentTimeMillis())
        val fresh: List<HistoryRow> = History.unannouncedNeverArrived(rows, store.announcedNeverArrived)
        if (fresh.isEmpty()) return

        val posted = SendNotifications.postNeverArrived(
            context,
            fresh.size,
            fresh.firstOrNull()?.let { History.displayTitle(it) },
            fresh.firstOrNull()?.targetLabel,
        )
        // Remembered only once it was actually said. A notification we could not
        // post (permission revoked) has to stay pending, or the one thing that
        // would have told them is lost for good.
        if (posted) {
            store.updateAnnouncedNeverArrived { done -> History.rememberAnnounced(done, fresh.map { it.id }) }
        }
    }
}
