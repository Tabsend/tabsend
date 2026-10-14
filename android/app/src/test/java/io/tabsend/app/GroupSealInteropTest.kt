package io.tabsend.app

import io.tabsend.app.crypto.Base64x
import io.tabsend.app.crypto.CryptoBox
import io.tabsend.app.crypto.Sealer
import io.tabsend.app.wire.GroupSealed
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import java.nio.charset.StandardCharsets

/**
 * BYTE-FOR-BYTE interop proof for the ADR-0028 group seal, the sibling of
 * [CryptoInteropTest] for `crypto_secretbox`.
 *
 * Four clients implement this construction separately — libsodium in the
 * extension and the console, hand-assembled XSalsa20-Poly1305 here and on iOS.
 * A round-trip test only proves a client agrees with ITSELF, which is precisely
 * the bug that would ship: every suite green, and a tab sealed on the phone
 * unreadable in the browser. The vector fixes the bytes instead.
 *
 * `resources/group-history-vector.json` is the same file iOS tests against, and
 * it was generated with `libsodium-wrappers` — the library the extension uses —
 * from a FIXED key and nonce. If Android's XSalsa20 keystream, Poly1305 clamp,
 * base64 alphabet, or keyId convention deviates by one bit, one of these fails.
 */
class GroupSealInteropTest {

    @Serializable
    private data class Vector(
        val key: String,
        val keyId: String,
        val nonce: String,
        val plaintext: String,
        val blob: GroupSealed,
    )

    private val vector: Vector by lazy {
        val json = javaClass.getResourceAsStream("/group-history-vector.json")
            ?.readBytes()?.toString(StandardCharsets.UTF_8)
            ?: error("group-history-vector.json missing from test resources")
        Json { ignoreUnknownKeys = true }.decodeFromString(Vector.serializer(), json)
    }

    @Test
    fun `fingerprints a group key the way every client does`() {
        // Same rule as an endpoint public key: base64url-nopad(SHA-256(utf8(key))).
        assertEquals(vector.keyId, Base64x.keyId(vector.key))
    }

    @Test
    fun `opens a blob sealed by libsodium`() {
        assertEquals(vector.plaintext, Sealer.openGroup(vector.blob, vector.key))
    }

    @Test
    fun `reproduces the libsodium ciphertext byte for byte`() {
        // The strongest direction available: given the vector's key AND nonce,
        // this must emit exactly the bytes libsodium emitted.
        val sealed = Sealer.sealGroup(
            plaintextJson = vector.plaintext,
            keyB64 = vector.key,
            keyId = vector.keyId,
            nonce = Base64x.decode(vector.nonce),
        )
        assertEquals(vector.blob.ciphertext, sealed.ciphertext)
        assertEquals(vector.blob.nonce, sealed.nonce)
        assertEquals(vector.blob.alg, sealed.alg)
        assertEquals(vector.blob.keyId, sealed.keyId)
    }

    @Test
    fun `refuses the blob under a different key`() {
        val wrong = Base64x.encode(ByteArray(32) { 7 })
        assertThrows(CryptoBox.AuthenticationFailure::class.java) {
            Sealer.openGroup(vector.blob, wrong)
        }
    }

    @Test
    fun `refuses a blob whose ciphertext was altered in place`() {
        val bytes = Base64x.decode(vector.blob.ciphertext)
        bytes[0] = (bytes[0].toInt() xor 0xff).toByte()
        val tampered = vector.blob.copy(ciphertext = Base64x.encode(bytes))
        assertThrows(CryptoBox.AuthenticationFailure::class.java) {
            Sealer.openGroup(tampered, vector.key)
        }
    }
}
