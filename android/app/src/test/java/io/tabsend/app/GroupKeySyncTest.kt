package io.tabsend.app

import io.tabsend.app.crypto.Base64x
import io.tabsend.app.crypto.CryptoBox
import io.tabsend.app.crypto.Sealer
import io.tabsend.app.logic.Keyring
import io.tabsend.app.logic.NewDeviceWatch
import io.tabsend.app.logic.NewDevices
import io.tabsend.app.logic.isoMillisOf
import io.tabsend.app.logic.parseIsoMillis
import io.tabsend.app.net.GroupHistory
import io.tabsend.app.store.Identity
import io.tabsend.app.store.Store
import io.tabsend.app.wire.Endpoint
import io.tabsend.app.wire.GroupKeyDelivery
import io.tabsend.app.wire.GroupKeyRecord
import io.tabsend.app.wire.GroupKeyRequest
import io.tabsend.app.wire.GroupKeyResponse
import io.tabsend.app.wire.WireJson
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The group key sync [ADR-0028] end to end: which copies are trusted, when the key
 * is replaced after a device leaves, and who is handed it. Run against the real
 * Store over in-memory preferences, real sealing, and a stand-in relay, so what
 * is tested is what ships.
 */
class GroupKeySyncTest {

    private val now = parseIsoMillis("2026-10-13T12:00:00.000Z")!!

    // This phone and one other device, each with a real keypair.
    private val mePair = CryptoBox.generateKeyPair()
    private val mePub = Base64x.encode(mePair.publicKey)
    private val identity = Identity(mePub, Base64x.encode(mePair.privateKey), Base64x.keyId(mePub))
    private val peerPair = CryptoBox.generateKeyPair()
    private val peerPub = Base64x.encode(peerPair.publicKey)
    private val gonePub = Base64x.encode(CryptoBox.generateKeyPair().publicKey)

    private fun endpoint(id: String, pub: String) = Endpoint(
        id = id,
        groupId = "g",
        kind = "extension",
        platform = "macos",
        label = id,
        e2ePubkey = pub,
        presence = "online",
        lastSeenAt = "2026-10-13T00:00:00.000Z",
        createdAt = "2026-10-01T00:00:00.000Z",
    )

    private val me = endpoint("me", mePub)
    private val peer = endpoint("a", peerPub)
    private val gone = endpoint("gone", gonePub)

    private fun real(createdAt: String): GroupKeyRecord {
        val secret = Base64x.encode(CryptoBox.randomSecretKey())
        return GroupKeyRecord(secret, Base64x.keyId(secret), createdAt)
    }

    private val oldKey = real("2026-10-01T00:00:00.000Z")

    /** The watch after "gone" left: only this phone and the peer are accepted. */
    private fun watch(rotateOwedAt: String?, rotateFrom: String? = oldKey.createdAt) = NewDeviceWatch(
        selfId = "me",
        known = listOf("me", "a"),
        unconfirmed = emptyList(),
        keys = mapOf("me" to mePub, "a" to peerPub),
        rotateOwedAt = rotateOwedAt,
        rotateFrom = if (rotateOwedAt == null) null else rotateFrom,
    )

    /**
     * A relay that serves [waiting] and accepts every copy, remembering who it was
     * for, once each: a device is handed every key the ring holds.
     */
    private class FakeRelay(private val waiting: List<GroupKeyDelivery> = emptyList()) : GroupHistory.KeyRelay {
        val postedTo = mutableListOf<String>()
        override fun fetch() = waiting
        override fun post(body: GroupKeyRequest): GroupKeyResponse {
            postedTo += body.items.map { it.targetEndpointId }.filterNot { it in postedTo }.distinct()
            return GroupKeyResponse(accepted = body.items.map { it.id })
        }
    }

    /** A copy of [record] sealed by the peer to this phone. */
    private fun copyOf(record: GroupKeyRecord, fromPair: CryptoBox.KeyPair = peerPair) = GroupKeyDelivery(
        id = "d-${record.keyId}",
        sourceEndpointId = "a",
        envelope = Sealer.seal(
            payloadJson = WireJson.encodeToString(GroupKeyRecord.serializer(), record),
            targetPubB64 = mePub,
            senderPrivB64 = Base64x.encode(fromPair.privateKey),
            senderKeyId = Base64x.keyId(Base64x.encode(fromPair.publicKey)),
        ),
        createdAt = "2026-10-13T12:00:00.000Z",
    )

    private fun sync(store: Store, relay: FakeRelay, list: List<Endpoint>, freshKey: (() -> String)? = null) =
        if (freshKey == null) {
            GroupHistory.syncKeys(store, relay, "me", identity, list, now)
        } else {
            GroupHistory.syncKeys(store, relay, "me", identity, list, now, freshKey)
        }

    // --- a device left, so the key is replaced (F3) --------------------------

    @Test
    fun `a departure replaces the key, hands it to those left, and settles the debt`() {
        val store = Store.over(MemoryPrefs())
        store.groupKeys = listOf(oldKey)
        store.newDeviceWatch = watch(rotateOwedAt = "2026-10-13T11:00:00.000Z")
        val relay = FakeRelay()

        sync(store, relay, listOf(me, peer))

        val current = Keyring.current(store.groupKeys)!!
        assertNotEquals(oldKey.keyId, current.keyId)
        assertEquals("2026-10-13T12:00:00.000Z", current.createdAt)
        assertEquals(listOf("a"), relay.postedTo)
        assertEquals(watch(null), store.newDeviceWatch)
    }

    @Test
    fun `a key planted a day ahead cannot block the rotation`() {
        // The device about to be removed handed out a key dated 23 hours ahead,
        // and it was current when it left. Compared with the clock it would look
        // like a rotation that already happened; compared with the key, it is
        // the key to replace.
        val planted = real(isoMillisOf(now + 23L * 60 * 60 * 1000))
        val store = Store.over(MemoryPrefs())
        store.groupKeys = listOf(oldKey, planted)
        store.newDeviceWatch = watch(rotateOwedAt = "2026-10-13T11:00:00.000Z", rotateFrom = planted.createdAt)

        sync(store, FakeRelay(), listOf(me, peer))

        val current = Keyring.current(store.groupKeys)!!
        assertNotEquals(planted.keyId, current.keyId)
        assertEquals(3, store.groupKeys.size)
        assertNull(store.newDeviceWatch?.rotateOwedAt)
    }

    @Test
    fun `a newer key from another device settles the debt without minting a second one`() {
        val theirs = real("2026-10-13T11:30:00.000Z")
        val store = Store.over(MemoryPrefs())
        store.groupKeys = listOf(oldKey)
        store.newDeviceWatch = watch(rotateOwedAt = "2026-10-13T11:00:00.000Z")

        sync(store, FakeRelay(listOf(copyOf(theirs))), listOf(me, peer))

        assertEquals(listOf(theirs.keyId, oldKey.keyId), store.groupKeys.map { it.keyId })
        assertNull(store.newDeviceWatch?.rotateOwedAt)
        assertNull(store.newDeviceWatch?.rotateFrom)
    }

    @Test
    fun `nothing is minted when no rotation is owed`() {
        val store = Store.over(MemoryPrefs())
        store.groupKeys = listOf(oldKey)
        store.newDeviceWatch = watch(rotateOwedAt = null)

        sync(store, FakeRelay(), listOf(me, peer))

        assertEquals(listOf(oldKey), store.groupKeys)
    }

    @Test
    fun `an empty ring is left to the first-key election, and the debt waits`() {
        val store = Store.over(MemoryPrefs())
        // "a" holds the lowest id, so this phone is not elected.
        store.newDeviceWatch = watch(rotateOwedAt = "2026-10-13T11:00:00.000Z", rotateFrom = null)

        sync(store, FakeRelay(), listOf(me, peer))

        assertTrue(store.groupKeys.isEmpty())
        assertEquals("2026-10-13T11:00:00.000Z", store.newDeviceWatch?.rotateOwedAt)
    }

    @Test
    fun `a departure noticed while minting still owes its own rotation`() {
        val store = Store.over(MemoryPrefs())
        store.groupKeys = listOf(oldKey)
        store.newDeviceWatch = watch(rotateOwedAt = "2026-10-13T11:00:00.000Z")

        sync(store, FakeRelay(), listOf(me, peer), freshKey = {
            // Another fetch lands mid-mint and records a later departure.
            store.newDeviceWatch = watch(rotateOwedAt = "2026-10-13T12:30:00.000Z")
            Base64x.encode(CryptoBox.randomSecretKey())
        })

        assertEquals("2026-10-13T12:30:00.000Z", store.newDeviceWatch?.rotateOwedAt)
    }

    // --- only accepted devices are trusted or handed the key (F1) ------------

    @Test
    fun `the new key never goes to a device the watch has not accepted`() {
        // A list read before the watch moved on still holds the device that left.
        val store = Store.over(MemoryPrefs())
        store.groupKeys = listOf(oldKey)
        store.newDeviceWatch = watch(rotateOwedAt = "2026-10-13T11:00:00.000Z")
        val relay = FakeRelay()

        sync(store, relay, listOf(me, peer, gone))

        assertEquals(listOf("a"), relay.postedTo)
    }

    @Test
    fun `a copy from a device the watch has not accepted is not trusted`() {
        val store = Store.over(MemoryPrefs())
        store.groupKeys = listOf(oldKey)
        store.newDeviceWatch = watch(rotateOwedAt = null)
        val strangerPair = CryptoBox.generateKeyPair()
        val stranger = endpoint("x", Base64x.encode(strangerPair.publicKey))
        val theirs = real("2026-10-13T11:30:00.000Z")

        sync(store, FakeRelay(listOf(copyOf(theirs, strangerPair))), listOf(me, peer, stranger))

        assertEquals(listOf(oldKey), store.groupKeys)
    }

    // --- which copies may enter the ring (F4) --------------------------------

    private fun open(copies: List<GroupKeyDelivery>, list: List<Endpoint>) =
        GroupHistory.openCopies(copies, list, identity.privateKey, now)

    @Test
    fun `a good copy from a listed device is taken`() {
        val good = real("2026-10-13T11:00:00.000Z")
        assertEquals(listOf(good), open(listOf(copyOf(good)), listOf(me, peer)))
    }

    @Test
    fun `a copy dated to pin itself, or with a forged keyId, is dropped`() {
        val pinned = real("9999-12-31T23:59:59.999Z")
        val forged = real("2026-10-13T11:00:00.000Z").copy(keyId = "someone-elses-id")
        assertTrue(open(listOf(copyOf(pinned), copyOf(forged)), listOf(me, peer)).isEmpty())
    }

    @Test
    fun `a copy from a device that is not in the list is dropped`() {
        val good = real("2026-10-13T11:00:00.000Z")
        assertTrue(open(listOf(copyOf(good)), listOf(me)).isEmpty())
    }

    // --- X14: a newer key is not proof of a rotation -------------------------

    /** The watch after "gone" left, owing a rotation for it by name. */
    private fun owingForGone() = watch(rotateOwedAt = "2026-10-13T11:00:00.000Z").copy(rotateFor = listOf("gone"))

    @Test
    fun `a newer key that does not name the departed device does not settle the debt`() {
        // The relay held this key back until now. It is newer than the key current
        // when "gone" left, but it was minted before, and "gone" may hold it.
        val lagging = real("2026-10-13T11:30:00.000Z")
        val store = Store.over(MemoryPrefs())
        store.groupKeys = listOf(oldKey)
        store.newDeviceWatch = owingForGone()
        val relay = FakeRelay(listOf(copyOf(lagging)))

        sync(store, relay, listOf(me, peer))

        val current = Keyring.current(store.groupKeys)!!
        assertNotEquals(lagging.keyId, current.keyId)
        assertEquals(3, store.groupKeys.size)
        assertEquals(listOf("gone"), current.departed)
        assertEquals(listOf("a"), relay.postedTo)
        assertNull(store.newDeviceWatch?.rotateOwedAt)
        assertNull(store.newDeviceWatch?.rotateFor)
    }

    @Test
    fun `a newer key that names the departed device settles the debt without a second mint`() {
        val theirs = real("2026-10-13T11:30:00.000Z").copy(departed = listOf("gone"))
        val store = Store.over(MemoryPrefs())
        store.groupKeys = listOf(oldKey)
        store.newDeviceWatch = owingForGone()

        sync(store, FakeRelay(listOf(copyOf(theirs))), listOf(me, peer))

        assertEquals(listOf(theirs.keyId, oldKey.keyId), store.groupKeys.map { it.keyId })
        assertEquals(listOf("gone"), store.groupKeys.first().departed)
        assertNull(store.newDeviceWatch?.rotateOwedAt)
    }

    @Test
    fun `a sender cannot vouch that it has left itself`() {
        // The peer names itself as departed. It is the one device that cannot know,
        // and the key it names itself in is one it holds.
        val selfNamed = real("2026-10-13T11:30:00.000Z").copy(departed = listOf("a"))
        val store = Store.over(MemoryPrefs())
        store.groupKeys = listOf(oldKey)
        store.newDeviceWatch = owingForGone().copy(rotateFor = listOf("a"))

        sync(store, FakeRelay(listOf(copyOf(selfNamed))), listOf(me, peer))

        val taken = store.groupKeys.first { it.keyId == selfNamed.keyId }
        assertNull(taken.departed)
        val current = Keyring.current(store.groupKeys)!!
        assertNotEquals(selfNamed.keyId, current.keyId)
        assertEquals(listOf("a"), current.departed)
    }

    @Test
    fun `a record whose departed list is not strings is refused, not read leniently`() {
        val good = real("2026-10-13T11:30:00.000Z")
        val withNumbers = WireJson.encodeToString(GroupKeyRecord.serializer(), good)
            .dropLast(1) + ",\"departed\":[1]}"
        val copy = GroupKeyDelivery(
            id = "d-num",
            sourceEndpointId = "a",
            envelope = Sealer.seal(
                payloadJson = withNumbers,
                targetPubB64 = mePub,
                senderPrivB64 = Base64x.encode(peerPair.privateKey),
                senderKeyId = Base64x.keyId(peerPub),
            ),
            createdAt = "2026-10-13T12:00:00.000Z",
        )
        assertTrue(open(listOf(copy), listOf(me, peer)).isEmpty())
    }

    // --- X13: a relay that keeps a removed device listed ---------------------

    @Test
    fun `a removed device the relay still lists gets nothing, and the rotation happens at once`() {
        val store = Store.over(MemoryPrefs())
        store.groupKeys = listOf(oldKey)
        store.newDeviceWatch = NewDevices.removeDevice(
            NewDeviceWatch(
                selfId = "me",
                known = listOf("me", "a", "gone"),
                unconfirmed = emptyList(),
                keys = mapOf("me" to mePub, "a" to peerPub, "gone" to gonePub),
            ),
            "gone",
            "2026-10-13T11:00:00.000Z",
            oldKey.createdAt,
        )
        val relay = FakeRelay()

        sync(store, relay, listOf(me, peer, gone))

        val current = Keyring.current(store.groupKeys)!!
        assertNotEquals(oldKey.keyId, current.keyId)
        assertEquals(listOf("gone"), current.departed)
        assertEquals(listOf("a"), relay.postedTo)
        assertNull(store.newDeviceWatch?.rotateOwedAt)
        assertEquals(listOf("gone"), store.newDeviceWatch?.removed)
    }
}
