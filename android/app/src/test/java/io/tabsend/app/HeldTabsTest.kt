package io.tabsend.app

import io.tabsend.app.crypto.Base64x
import io.tabsend.app.crypto.CryptoBox
import io.tabsend.app.crypto.Sealer
import io.tabsend.app.logic.NewDeviceNotice
import io.tabsend.app.logic.NewDeviceWatch
import io.tabsend.app.logic.NewDevices
import io.tabsend.app.logic.OutboundItem
import io.tabsend.app.logic.parseIsoMillis
import io.tabsend.app.send.FlushReport
import io.tabsend.app.send.Sender
import io.tabsend.app.store.Identity
import io.tabsend.app.store.Registration
import io.tabsend.app.store.Store
import io.tabsend.app.wire.Endpoint
import io.tabsend.app.wire.GroupKeyRecord
import io.tabsend.app.wire.HistoryRecord
import io.tabsend.app.wire.SendPayload
import io.tabsend.app.wire.SendRejection
import io.tabsend.app.wire.SendRequest
import io.tabsend.app.wire.SendResponse
import io.tabsend.app.wire.WireJson
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException

/**
 * Held tabs whose device is gone (PLANS.md P-15 item 3), through the real queue:
 * the flush that decides what is posted, and the re-target that seals a tab again
 * for another device (SECURITY_REVIEW L3, L7). Run against the Store over
 * in-memory preferences, real sealing, and a stand-in for the relay's POST, so
 * what is tested is what ships. Each test names the rule it would catch undone.
 */
class HeldTabsTest {

    private val createdAt = "2026-10-20T10:00:00.000Z"
    private val now = parseIsoMillis(createdAt)!! + 60_000L

    /** A device with a real keypair, so what is sealed to it can be opened. */
    private class Device(val id: String, val label: String, val kind: String = "extension") {
        val pair = CryptoBox.generateKeyPair()
        val pub: String = Base64x.encode(pair.publicKey)
        val priv: String = Base64x.encode(pair.privateKey)
        val endpoint = Endpoint(
            id = id,
            groupId = "g",
            kind = kind,
            platform = "macos",
            label = label,
            e2ePubkey = pub,
            presence = "online",
            lastSeenAt = "2026-10-20T00:00:00.000Z",
            createdAt = "2026-10-01T00:00:00.000Z",
        )
    }

    private val me = Device("me", "Pixel 8", kind = "android")
    private val laptop = Device("laptop", "Laptop")
    private val phone = Device("phone", "Galaxy S24 Ultra")
    private val console = Device("console", "Console", kind = "console")
    private val newbie = Device("newbie", "Chrome · Mac")
    private val stranger = Device("stranger", "Firefox · Linux")
    private val all = listOf(me, laptop, phone, console, newbie, stranger)

    private val groupKey = Base64x.encode(CryptoBox.randomSecretKey())

    /**
     * The watch as it stands after the first look was answered: everything but the
     * stranger accepted, and "newbie" still waiting on its "new device" notice.
     */
    private fun acceptedWatch(known: List<String> = listOf("me", "laptop", "phone", "console", "newbie")) =
        NewDeviceWatch(
            selfId = "me",
            known = known,
            unconfirmed = listOf(NewDeviceNotice("newbie", newbie.label, "2026-10-19T00:00:00.000Z")),
            keys = all.filter { it.id in known }.associate { it.id to it.pub },
        )

    private fun store(
        watch: NewDeviceWatch? = acceptedWatch(),
        listed: List<Device> = all,
    ): Store = Store.over(MemoryPrefs()).apply {
        registration = Registration(
            endpointId = "me",
            groupId = "g",
            deviceToken = "t",
            relayUrl = "https://relay.example",
            label = "Pixel 8",
        )
        identity = Identity(me.pub, me.priv, Base64x.keyId(me.pub))
        groupKeys = listOf(GroupKeyRecord(groupKey, Base64x.keyId(groupKey), "2026-10-01T00:00:00.000Z"))
        cachedEndpoints = listed.map { it.endpoint }
        newDeviceWatch = watch
    }

    /** A held tab for [to], sealed to it the way a send would have. */
    private fun held(
        id: String,
        to: Device,
        url: String = "https://example.com/$id",
        targetGone: Boolean = false,
        goneFromList: Boolean = false,
    ): OutboundItem {
        val payload = SendPayload(url = url, title = "Tab $id", sentAt = createdAt)
        return OutboundItem(
            id = id,
            targetEndpointId = to.id,
            envelope = Sealer.seal(
                WireJson.encodeToString(SendPayload.serializer(), payload),
                to.pub,
                me.priv,
                Base64x.keyId(me.pub),
            ),
            createdAt = createdAt,
            title = payload.title,
            url = url,
            targetLabel = to.label,
            targetGone = targetGone,
            goneFromList = goneFromList,
        )
    }

    /** A relay that accepts every tab, or answers [refuse] for the ids it names, and remembers what was posted. */
    private class FakeRelay(private val refuse: Map<String, String> = emptyMap()) {
        val posted = mutableListOf<String>()
        fun send(body: SendRequest): SendResponse {
            val ids = body.items.map { it.id }
            posted += ids
            return SendResponse(
                accepted = ids.filter { it !in refuse },
                rejected = ids.filter { it in refuse }.map { SendRejection(it, refuse.getValue(it)) },
            )
        }
    }

    private fun flush(store: Store, relay: FakeRelay): FlushReport =
        Sender.flushOutbound(store, now) { relay.send(it) }

    // --- the flush ----------------------------------------------------------

    @Test
    fun `a tab whose device left the list is not posted, is flagged as the list's, and is announced once`() {
        val store = store(listed = listOf(me, laptop))
        store.outbound = listOf(held("t1", phone))
        val relay = FakeRelay()

        val report = flush(store, relay)

        assertTrue(relay.posted.isEmpty())
        val item = store.outbound.single()
        assertTrue(item.targetGone)
        assertTrue(item.goneFromList)
        assertEquals(1, report.newlyGone)
        assertEquals("Galaxy S24 Ultra", report.firstGoneTargetLabel)
        assertFalse(report.firstGoneRemovedHere)

        // Still gone on the next pass, and not said a second time.
        assertEquals(0, flush(store, relay).newlyGone)
        assertTrue(relay.posted.isEmpty())
    }

    @Test
    fun `a tab the relay refused is not posted even while its device is listed and accepted`() {
        val store = store()
        store.outbound = listOf(held("t1", phone, targetGone = true, goneFromList = false))
        val relay = FakeRelay()

        flush(store, relay)

        assertTrue(relay.posted.isEmpty())
        assertTrue(store.outbound.single().targetGone)
        assertFalse(store.outbound.single().goneFromList)
    }

    @Test
    fun `a list's flag lifts and the tab is posted in the same pass once its device is accepted again`() {
        val store = store()
        store.outbound = listOf(held("t1", phone, targetGone = true, goneFromList = true))
        val relay = FakeRelay()

        val report = flush(store, relay)

        assertEquals(listOf("t1"), relay.posted)
        assertEquals(1, report.sent)
        assertTrue(store.outbound.isEmpty())
    }

    @Test
    fun `a lifted flag is written back when the relay does not answer`() {
        val store = store()
        store.outbound = listOf(held("t1", phone, targetGone = true, goneFromList = true))

        val report = Sender.flushOutbound(store, now) { throw IOException("no route") }

        assertEquals(1, report.stillHeld)
        val item = store.outbound.single()
        assertFalse(item.targetGone)
        assertFalse(item.goneFromList)
    }

    @Test
    fun `a tab for a device this phone removed is not posted while the relay still lists it`() {
        val removed = NewDevices.removeDevice(acceptedWatch(), "phone", "2026-10-20T09:00:00.000Z")
        val store = store(watch = removed) // the cache still lists "phone", as the relay does
        store.outbound = listOf(held("t1", phone))
        val relay = FakeRelay()

        val report = flush(store, relay)

        assertTrue(relay.posted.isEmpty())
        assertTrue(store.outbound.single().targetGone)
        assertEquals(1, report.newlyGone)
        assertTrue(report.firstGoneRemovedHere)
    }

    @Test
    fun `the relay's refusal flags the tab as the relay's, and no later list lifts it`() {
        val store = store()
        store.outbound = listOf(held("t1", phone))
        val refusing = FakeRelay(refuse = mapOf("t1" to "unknown_target"))

        val report = flush(store, refusing)

        assertEquals(1, report.newlyGone)
        val item = store.outbound.single()
        assertTrue(item.targetGone)
        assertFalse(item.goneFromList)

        val relay = FakeRelay()
        flush(store, relay)
        assertTrue(relay.posted.isEmpty())
    }

    @Test
    fun `a tab already announced as gone is not announced again when the relay then refuses it`() {
        // Its list flag lifts (the device is accepted again), it is posted, and the
        // relay says the device is gone after all. The user was told once already.
        val store = store()
        store.outbound = listOf(held("t1", phone, targetGone = true, goneFromList = true))
        val refusing = FakeRelay(refuse = mapOf("t1" to "unknown_target"))

        val report = flush(store, refusing)

        assertEquals(listOf("t1"), refusing.posted)
        assertEquals(0, report.newlyGone)
        val item = store.outbound.single()
        assertTrue(item.targetGone)
        assertFalse(item.goneFromList)
    }

    @Test
    fun `a tab moved while the flush runs is not put back by the flush`() {
        val store = store(listed = listOf(me, laptop))
        store.outbound = listOf(held("t1", phone), held("t2", laptop))
        // The user moves t1 to the laptop while t2 is being posted.
        val report = Sender.flushOutbound(store, now) { body ->
            if (body.items.single().id == "t2") {
                store.cachedEndpoints = listOf(me, laptop, phone).map { it.endpoint }
                assertTrue(Sender.retargetHeld(store, "t1", phone.endpoint))
            }
            SendResponse(accepted = body.items.map { it.id })
        }

        assertEquals(1, report.newlyGone)
        val left = store.outbound.single()
        assertNotEquals("t1", left.id)
        assertEquals("phone", left.targetEndpointId)
        assertFalse(left.targetGone)
    }

    // --- the re-target ------------------------------------------------------

    @Test
    fun `a moved tab is sealed afresh to the new device, under a new id, with history naming it`() {
        val store = store()
        store.outbound = listOf(held("t1", phone, targetGone = true))

        assertTrue(Sender.retargetHeld(store, "t1", laptop.endpoint))

        val moved = store.outbound.single()
        assertNotEquals("t1", moved.id)
        assertEquals("laptop", moved.targetEndpointId)
        assertEquals("Laptop", moved.targetLabel)
        assertFalse(moved.targetGone)
        assertFalse(moved.goneFromList)
        // The new device can open it, and the old one cannot.
        val payload = WireJson.decodeFromString(
            SendPayload.serializer(),
            Sealer.open(moved.envelope, me.pub, laptop.priv),
        )
        assertEquals("https://example.com/t1", payload.url)
        assertEquals(createdAt, payload.sentAt)
        assertThrows(CryptoBox.AuthenticationFailure::class.java) {
            Sealer.open(moved.envelope, me.pub, phone.priv)
        }
        // The history blob opens with the group key and names the new device.
        val record = WireJson.decodeFromString(
            HistoryRecord.serializer(),
            Sealer.openGroup(moved.history!!, groupKey),
        )
        assertEquals("Laptop", record.targetLabelAtSend)
        assertEquals("Pixel 8", record.sourceLabelAtSend)
        assertEquals("https://example.com/t1", record.payload.url)
    }

    @Test
    fun `a moved tab never keeps the history blob that named the old device`() {
        val store = store()
        val old = held("t1", phone, targetGone = true)
        val oldHistory = Sealer.sealGroup(
            WireJson.encodeToString(
                HistoryRecord.serializer(),
                HistoryRecord(
                    payload = SendPayload(url = old.url!!, title = old.title, sentAt = createdAt),
                    sourceLabelAtSend = "Pixel 8",
                    targetLabelAtSend = phone.label,
                ),
            ),
            groupKey,
            Base64x.keyId(groupKey),
        )
        store.outbound = listOf(old.copy(history = oldHistory))

        assertTrue(Sender.retargetHeld(store, "t1", laptop.endpoint))

        val moved = store.outbound.single()
        assertNotEquals(oldHistory, moved.history)
        val record = WireJson.decodeFromString(
            HistoryRecord.serializer(),
            Sealer.openGroup(moved.history!!, groupKey),
        )
        assertEquals("Laptop", record.targetLabelAtSend)
    }

    @Test
    fun `the tab is sealed to the device as the watch accepted it, not as the caller passed it`() {
        val store = store()
        store.outbound = listOf(held("t1", phone, targetGone = true))
        val impostor = Device("laptop", "Someone else's laptop")

        assertTrue(Sender.retargetHeld(store, "t1", impostor.endpoint))

        val moved = store.outbound.single()
        Sealer.open(moved.envelope, me.pub, laptop.priv)
        assertThrows(CryptoBox.AuthenticationFailure::class.java) {
            Sealer.open(moved.envelope, me.pub, impostor.priv)
        }
        assertEquals("Laptop", moved.targetLabel)
    }

    @Test
    fun `the device the tab was for, accepted again, is a fair choice`() {
        val store = store()
        store.outbound = listOf(held("t1", phone, targetGone = true, goneFromList = true))

        assertTrue(Sender.retargetHeld(store, "t1", phone.endpoint))

        val moved = store.outbound.single()
        assertNotEquals("t1", moved.id)
        Sealer.open(moved.envelope, me.pub, phone.priv)
    }

    @Test
    fun `no move to this phone, a console, a device not accepted, one removed here, or one with a notice pending`() {
        val removedHere = NewDevices.removeDevice(acceptedWatch(), "laptop", "2026-10-20T09:00:00.000Z")
        val cases = listOf(
            "this phone" to (store() to me),
            "a console" to (store() to console),
            "a device the watch has not accepted" to (store() to stranger),
            "a device this phone removed, still listed" to (store(watch = removedHere) to laptop),
            "a device with a pending notice" to (store() to newbie),
        )
        for ((name, case) in cases) {
            val (store, target) = case
            val before = listOf(held("t1", phone, targetGone = true))
            store.outbound = before
            assertFalse(name, Sender.retargetHeld(store, "t1", target.endpoint))
            assertEquals(name, before, store.outbound)
        }
    }

    @Test
    fun `no move for a held link that is not http(s)`() {
        val store = store()
        val before = listOf(held("t1", phone, url = "javascript:alert(1)", targetGone = true))
        store.outbound = before

        assertFalse(Sender.retargetHeld(store, "t1", laptop.endpoint))
        assertEquals(before, store.outbound)
    }

    @Test
    fun `no move with a watch from another pairing`() {
        val store = store(watch = acceptedWatch().copy(selfId = "someone-else"))
        val before = listOf(held("t1", phone, targetGone = true))
        store.outbound = before

        assertFalse(Sender.retargetHeld(store, "t1", laptop.endpoint))
        assertEquals(before, store.outbound)
    }
}
