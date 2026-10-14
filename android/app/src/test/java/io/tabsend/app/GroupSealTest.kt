package io.tabsend.app

import io.tabsend.app.crypto.Base64x
import io.tabsend.app.crypto.CryptoBox
import io.tabsend.app.crypto.Sealer
import io.tabsend.app.wire.GroupSealed
import io.tabsend.app.wire.HistoryRecord
import io.tabsend.app.wire.SendItem
import io.tabsend.app.wire.SendPayload
import io.tabsend.app.wire.WireJson
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Sealing a history record to the GROUP key [ADR-0028].
 *
 * `crypto_secretbox` here is the same XSalsa20-Poly1305 that `crypto_box` already
 * runs underneath — [CryptoInteropTest] pins those bytes against libsodium — with
 * the key supplied instead of derived. What is worth proving separately is the
 * layer on top: that a blob names its key, opens only under it, and refuses a
 * tampered ciphertext just as a tab's envelope does.
 */
class GroupSealTest {

    /** A per-target identity, only so a [SendItem] has a real envelope to carry. */
    private val pair = CryptoBox.generateKeyPair()
    private val pub = Base64x.encode(pair.publicKey)
    private val priv = Base64x.encode(pair.privateKey)

    private val record = HistoryRecord(
        payload = SendPayload(
            url = "https://example.com/roadmap",
            title = "Roadmap",
            sentAt = "2026-08-06T10:00:00.000Z",
        ),
        sourceLabelAtSend = "Chrome · Work",
        targetLabelAtSend = "Pixel 8",
    )

    private fun freshKey(): String = Base64x.encode(CryptoBox.randomSecretKey())

    private fun seal(json: String, key: String): GroupSealed =
        Sealer.sealGroup(json, key, Base64x.keyId(key))

    @Test
    fun `a group key is 32 bytes, like the shared secret it stands in for`() {
        assertEquals(32, Base64x.decode(freshKey()).size)
        assertNotEquals(freshKey(), freshKey())
    }

    @Test
    fun `a record survives sealing and opening`() {
        val key = freshKey()
        val json = WireJson.encodeToString(HistoryRecord.serializer(), record)
        val opened = Sealer.openGroup(seal(json, key), key)
        assertEquals(record, WireJson.decodeFromString(HistoryRecord.serializer(), opened))
    }

    @Test
    fun `a blob names the key that sealed it, so a reader holding several knows which`() {
        val key = freshKey()
        val blob = seal("{}", key)
        assertEquals(Base64x.keyId(key), blob.keyId)
        assertEquals("xsalsa20-poly1305/secretbox", blob.alg)
    }

    @Test
    fun `every blob gets its own nonce`() {
        val key = freshKey()
        assertNotEquals(seal("{}", key).nonce, seal("{}", key).nonce)
    }

    @Test
    fun `another key cannot open it, which is the whole premise`() {
        val blob = seal("{}", freshKey())
        assertThrows(CryptoBox.AuthenticationFailure::class.java) {
            Sealer.openGroup(blob, freshKey())
        }
    }

    @Test
    fun `a tampered blob is refused rather than opened`() {
        val key = freshKey()
        val blob = seal("""{"hello":"there"}""", key)
        val bytes = Base64x.decode(blob.ciphertext).also { it[0] = (it[0].toInt() xor 0xff).toByte() }
        assertThrows(CryptoBox.AuthenticationFailure::class.java) {
            Sealer.openGroup(blob.copy(ciphertext = Base64x.encode(bytes)), key)
        }
    }

    @Test
    fun `a send with no group key omits the field entirely`() {
        // An older relay must see exactly the request it saw before ADR-0028, and
        // a group with no key yet must send exactly what it always did.
        val json = WireJson.encodeToString(
            SendItem.serializer(),
            SendItem("m1", "phone", Sealer.seal("{}", pub, priv, "kid")),
        )
        // Quoted, so a base64 field can never accidentally satisfy it.
        assertFalse(json.contains("\"history\""))
    }

    @Test
    fun `a send with a group key carries the blob beside the envelope`() {
        val key = freshKey()
        val item = SendItem("m1", "phone", Sealer.seal("{}", pub, priv, "kid"), seal("{}", key))
        val round = WireJson.decodeFromString(
            SendItem.serializer(),
            WireJson.encodeToString(SendItem.serializer(), item),
        )
        assertEquals(item.history, round.history)
        assertTrue(round.history!!.ciphertext.isNotEmpty())
    }
}
