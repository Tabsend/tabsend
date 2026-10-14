package io.tabsend.app

import io.tabsend.app.crypto.Base64x
import io.tabsend.app.crypto.CryptoBox
import io.tabsend.app.logic.Keyring
import io.tabsend.app.logic.isoMillisOf
import io.tabsend.app.logic.parseIsoMillis
import io.tabsend.app.wire.Endpoint
import io.tabsend.app.wire.GroupKeyRecord
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The group history keyring [ADR-0028]. Mirrors extension/src/lib/keyring.test.ts
 * case for case: every client has to reach the SAME answer from the same ring
 * without asking the others, so a divergence here is a divergence in the product.
 */
class KeyringTest {

    private fun key(keyId: String, createdAt: String) =
        GroupKeyRecord(key = "secret-$keyId", keyId = keyId, createdAt = createdAt)

    private fun endpoint(id: String, kind: String = "extension") = Endpoint(
        id = id,
        groupId = "g",
        kind = kind,
        platform = "linux",
        label = id,
        e2ePubkey = "pk-$id",
        presence = "online",
        lastSeenAt = "2026-08-05T00:00:00.000Z",
        createdAt = "2026-08-01T00:00:00.000Z",
    )

    // --- choosing which key to seal under ---

    @Test
    fun `the current key is the newest`() {
        val ring = listOf(key("a", "2026-08-01T00:00:00.000Z"), key("b", "2026-08-05T00:00:00.000Z"))
        assertEquals("b", Keyring.current(ring)?.keyId)
    }

    @Test
    fun `a same-instant tie breaks deterministically, so every device agrees`() {
        val same = "2026-08-05T00:00:00.000Z"
        val one = listOf(key("aaa", same), key("bbb", same))
        val other = listOf(key("bbb", same), key("aaa", same))
        assertEquals(Keyring.current(one)?.keyId, Keyring.current(other)?.keyId)
        assertEquals("bbb", Keyring.current(one)?.keyId)
    }

    @Test
    fun `there is no current key while the group has never had one`() {
        assertNull(Keyring.current(emptyList()))
    }

    @Test
    fun `older keys stay reachable by id, which is what makes old history readable`() {
        val ring = listOf(key("old", "2026-07-01T00:00:00.000Z"), key("new", "2026-08-01T00:00:00.000Z"))
        assertEquals("secret-old", Keyring.byId(ring, "old")?.key)
        assertNull(Keyring.byId(ring, "nope"))
    }

    // --- merging keys as they arrive ---

    @Test
    fun `merging never drops a key, because an old one opens old history`() {
        val ring = listOf(key("a", "2026-07-01T00:00:00.000Z"))
        val merged = Keyring.merge(ring, listOf(key("b", "2026-08-01T00:00:00.000Z")))
        assertEquals(listOf("b", "a"), merged.map { it.keyId })
    }

    @Test
    fun `merging is idempotent on keyId`() {
        val ring = listOf(key("a", "2026-07-01T00:00:00.000Z"))
        assertEquals(1, Keyring.merge(ring, listOf(key("a", "2026-07-01T00:00:00.000Z"))).size)
    }

    @Test
    fun `a copy reusing a held keyId never replaces the key already held`() {
        // Blobs already sealed under k1 must stay readable, so whatever arrives
        // later under the same id is ignored, not swapped in.
        val held = listOf(key("k1", "2026-07-01T00:00:00.000Z"))
        val impostor = GroupKeyRecord(key = "other-secret", keyId = "k1", createdAt = "2026-08-01T00:00:00.000Z")
        assertEquals(held, Keyring.merge(held, listOf(impostor)))
    }

    @Test
    fun `two devices that minted at the same moment converge, and neither key is lost`() {
        val same = "2026-08-05T00:00:00.000Z"
        val deviceA = Keyring.merge(listOf(key("aaa", same)), listOf(key("zzz", same)))
        val deviceB = Keyring.merge(listOf(key("zzz", same)), listOf(key("aaa", same)))
        assertEquals(Keyring.current(deviceA)?.keyId, Keyring.current(deviceB)?.keyId)
        assertNotNull(Keyring.byId(deviceA, "aaa"))
        assertNotNull(Keyring.byId(deviceB, "aaa"))
    }

    @Test
    fun `a ring sorts newest first`() {
        val ring = Keyring.sort(
            listOf(
                key("mid", "2026-07-15T00:00:00.000Z"),
                key("new", "2026-08-01T00:00:00.000Z"),
                key("old", "2026-07-01T00:00:00.000Z"),
            ),
        )
        assertEquals(listOf("new", "mid", "old"), ring.map { it.keyId })
    }

    // --- electing who mints the first key ---

    @Test
    fun `exactly one device mints, without any coordination`() {
        val group = listOf(endpoint("a"), endpoint("b"), endpoint("c"))
        val elected = group.filter { Keyring.shouldMintFirstKey(emptyList(), group, it.id) }
        assertEquals(listOf("a"), elected.map { it.id })
    }

    @Test
    fun `nobody mints once the group has a key`() {
        val group = listOf(endpoint("a"), endpoint("b"), endpoint("c"))
        val ring = listOf(key("a", "2026-08-01T00:00:00.000Z"))
        assertFalse(group.any { Keyring.shouldMintFirstKey(ring, group, it.id) })
    }

    @Test
    fun `the election moves on when the elected device leaves`() {
        val remaining = listOf(endpoint("b"), endpoint("c"))
        assertTrue(Keyring.shouldMintFirstKey(emptyList(), remaining, "b"))
        assertFalse(Keyring.shouldMintFirstKey(emptyList(), remaining, "c"))
    }

    @Test
    fun `a stale endpoint list that lacks this device never elects it`() {
        // An empty or not-yet-refreshed list must not make a device think it is
        // alone and in charge.
        assertFalse(Keyring.shouldMintFirstKey(emptyList(), emptyList(), "a"))
        assertFalse(Keyring.shouldMintFirstKey(emptyList(), listOf(endpoint("b")), "a"))
    }

    @Test
    fun `a console is never elected, since a console never mints`() {
        // With the console holding the lowest id, electing it would leave the
        // group with no key at all. (A console never runs this, so only the others ask.)
        val group = listOf(endpoint("a", kind = "console"), endpoint("b"), endpoint("c"))
        val elected = group.filter { it.kind != "console" && Keyring.shouldMintFirstKey(emptyList(), group, it.id) }
        assertEquals(listOf("b"), elected.map { it.id })
    }

    // --- which key copies may enter the ring ---

    @Serializable
    private data class CreatedAtCase(val value: String, val accept: Boolean, val why: String)

    @Serializable
    private data class DepartedCase(val value: JsonElement? = null, val accept: Boolean, val why: String)

    @Serializable
    private data class VouchedCase(
        val departed: List<String>? = null,
        val sender: String,
        val expect: List<String>? = null,
        val why: String,
    )

    @Serializable
    private data class RecordVectors(
        val nowMs: Long,
        val nowIso: String,
        val createdAt: List<CreatedAtCase>,
        val departed: List<DepartedCase>,
        val vouched: List<VouchedCase>,
    )

    /** `shared/vectors/group-key-records.json`, found by walking up like NewDevicesTest does. */
    private val recordVectors: RecordVectors by lazy {
        var dir: File? = File("").absoluteFile
        var found: File? = null
        while (dir != null && found == null) {
            found = File(dir, "shared/vectors/group-key-records.json").takeIf { it.isFile }
            dir = dir.parentFile
        }
        val file = found ?: error("shared/vectors/group-key-records.json not found above ${File("").absolutePath}")
        Json { ignoreUnknownKeys = true }.decodeFromString(RecordVectors.serializer(), file.readText())
    }

    @Test
    fun `every createdAt case matches the shared vector`() {
        assertEquals(recordVectors.nowIso, isoMillisOf(recordVectors.nowMs))
        assertTrue(recordVectors.createdAt.isNotEmpty())
        for (c in recordVectors.createdAt) {
            assertEquals(
                "${c.value} (${c.why})",
                c.accept,
                Keyring.isAcceptableKeyCreatedAt(c.value, recordVectors.nowMs),
            )
        }
    }

    @Test
    fun `every departed case matches the shared vector`() {
        assertTrue(recordVectors.departed.isNotEmpty())
        for (c in recordVectors.departed) {
            assertEquals("${c.value} (${c.why})", c.accept, Keyring.isAcceptableDeparted(c.value))
        }
        // An absent field is the same as null.
        assertTrue(Keyring.isAcceptableDeparted(null))
    }

    @Test
    fun `every vouched case matches the shared vector`() {
        assertTrue(recordVectors.vouched.isNotEmpty())
        for (c in recordVectors.vouched) {
            assertEquals(c.why, c.expect, Keyring.vouchedDeparted(c.departed, c.sender))
        }
    }

    @Test
    fun `a record carries the devices it replaces, and a first key names nobody`() {
        val named = Keyring.mintedKey(emptyList(), "k", "id", 0L, listOf("a", "b"))
        assertEquals(listOf("a", "b"), named.departed)
        assertNull(Keyring.mintedKey(emptyList(), "k", "id", 0L).departed)
    }

    @Test
    fun `a typed record with a repeated or oversized departed list is refused`() {
        assertTrue(Keyring.isAcceptableRecord(realRecord().copy(departed = listOf("a", "b")), recordNow))
        assertFalse(Keyring.isAcceptableRecord(realRecord().copy(departed = listOf("a", "a")), recordNow))
        assertFalse(
            Keyring.isAcceptableRecord(
                realRecord().copy(departed = (1..33).map { "id-$it" }),
                recordNow,
            ),
        )
    }

    private fun realRecord(createdAt: String = "2026-10-13T12:00:00.000Z"): GroupKeyRecord {
        val secret = Base64x.encode(CryptoBox.randomSecretKey())
        return GroupKeyRecord(key = secret, keyId = Base64x.keyId(secret), createdAt = createdAt)
    }

    private val recordNow = parseIsoMillis("2026-10-13T12:00:00.000Z")!!

    @Test
    fun `a leap second is refused, as every browser refuses it`() {
        // Java reads 23:59:60 as the last instant of 23:59:59; JavaScript's
        // Date.parse refuses it. Only the round trip catches the difference.
        assertFalse(Keyring.isAcceptableKeyCreatedAt("2026-06-30T23:59:60.000Z", recordNow))
    }

    @Test
    fun `a real key copy is accepted`() {
        assertTrue(Keyring.isAcceptableRecord(realRecord(), recordNow))
    }

    @Test
    fun `a copy whose keyId is not its key's fingerprint is refused`() {
        val other = realRecord()
        assertFalse(Keyring.isAcceptableRecord(realRecord().copy(keyId = other.keyId), recordNow))
    }

    @Test
    fun `a copy whose key is not 32 bytes is refused`() {
        val short = Base64x.encode(ByteArray(16) { 7 })
        assertFalse(Keyring.isAcceptableRecord(GroupKeyRecord(short, Base64x.keyId(short), "2026-10-13T12:00:00.000Z"), recordNow))
        val notBase64 = "not base64!"
        assertFalse(Keyring.isAcceptableRecord(GroupKeyRecord(notBase64, Base64x.keyId(notBase64), "2026-10-13T12:00:00.000Z"), recordNow))
    }

    @Test
    fun `a copy dated to pin itself as the current key is refused`() {
        assertFalse(Keyring.isAcceptableRecord(realRecord("Wed, 31 Dec 9999 00:00:00 GMT"), recordNow))
        assertFalse(Keyring.isAcceptableRecord(realRecord("9999-12-31T23:59:59.999Z"), recordNow))
    }

    // --- handing the key to the rest of the group ---

    private val ring = listOf(key("k1", "2026-08-01T00:00:00.000Z"))
    private val group = listOf(endpoint("self"), endpoint("phone"), endpoint("desk"))

    @Test
    fun `every member except this device needs a copy`() {
        val pending = Keyring.pendingDeliveries(ring, group, "self", emptyList())
        assertEquals(listOf("desk", "phone"), pending.map { it.targetEndpointId }.sorted())
        assertEquals("pk-phone", pending.first().targetPubkey)
    }

    @Test
    fun `a key is never handed to a device it names as gone`() {
        val named = listOf(key("k2", "2026-08-02T00:00:00.000Z").copy(departed = listOf("desk")))
        val pending = Keyring.pendingDeliveries(named, group, "self", emptyList())
        assertEquals(listOf("phone"), pending.map { it.targetEndpointId })
    }

    @Test
    fun `a console gets one too, since it reads history like anything else`() {
        val withConsole = group + endpoint("web", kind = "console")
        val pending = Keyring.pendingDeliveries(ring, withConsole, "self", emptyList())
        assertTrue(pending.any { it.targetEndpointId == "web" })
    }

    @Test
    fun `what has already been delivered is skipped`() {
        val done = listOf(Keyring.deliveryId("k1", "phone"))
        val pending = Keyring.pendingDeliveries(ring, group, "self", done)
        assertEquals(listOf("desk"), pending.map { it.targetEndpointId })
    }

    @Test
    fun `a rotation re-delivers, because the id names the key`() {
        val done = listOf(Keyring.deliveryId("k1", "phone"), Keyring.deliveryId("k1", "desk"))
        assertTrue(Keyring.pendingDeliveries(ring, group, "self", done).isEmpty())
        val rotated = ring + key("k2", "2026-08-09T00:00:00.000Z")
        assertEquals(2, Keyring.pendingDeliveries(rotated, group, "self", done).size)
    }

    @Test
    fun `there is nothing to deliver while the group has no key`() {
        assertTrue(Keyring.pendingDeliveries(emptyList(), group, "self", emptyList()).isEmpty())
    }

    // --- minting ---

    @Test
    fun `a minted key always sorts newer than the one it replaces`() {
        val existing = listOf(key("old", "2026-08-05T00:00:00.000Z"))
        val at = parseIsoMillis("2026-08-06T00:00:00.000Z")!!
        val fresh = Keyring.mintedKey(existing, "secret", "new", at)
        assertEquals("new", Keyring.current(Keyring.merge(existing, listOf(fresh)))?.keyId)
    }

    @Test
    fun `a slow clock cannot silently un-rotate the group`() {
        val existing = listOf(key("old", "2026-08-05T00:00:00.000Z"))
        val at = parseIsoMillis("2026-08-01T00:00:00.000Z")!!
        val fresh = Keyring.mintedKey(existing, "secret", "new", at)
        assertEquals("new", Keyring.current(Keyring.merge(existing, listOf(fresh)))?.keyId)
    }

    @Test
    fun `the first key is dated by the clock, having nothing to outrank`() {
        val at = parseIsoMillis("2026-08-06T00:00:00.000Z")!!
        assertEquals("2026-08-06T00:00:00.000Z", Keyring.mintedKey(emptyList(), "secret", "first", at).createdAt)
    }

    @Test
    fun `an instant on a whole second still spells its milliseconds out`() {
        // Ordering is a STRING comparison across clients, and "…00Z" sorts after
        // "…00.000Z" because Z outranks the dot. A key minted on a whole second
        // here would look newer than an identical one minted in a browser.
        assertEquals("2026-08-06T00:00:00.000Z", isoMillisOf(parseIsoMillis("2026-08-06T00:00:00Z")!!))
    }
}
