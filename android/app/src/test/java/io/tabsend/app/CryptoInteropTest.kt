package io.tabsend.app

import io.tabsend.app.crypto.Base64x
import io.tabsend.app.crypto.CryptoBox
import io.tabsend.app.crypto.Sealer
import io.tabsend.app.wire.EncryptedEnvelope
import io.tabsend.app.wire.WireJson
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.charset.StandardCharsets

/**
 * BYTE-FOR-BYTE interop proof. The vector in `resources/interop-vector.json` was
 * generated on the TS side by `android/tools/gen-interop-vector.mjs` running the
 * SAME `libsodium-wrappers` the browser extension uses. If Android's hand-assembled
 * crypto_box deviates by a single bit — Salsa20 round, HSalsa20 output order,
 * Poly1305 clamp, base64, or keyId convention — one of these assertions fails.
 */
class CryptoInteropTest {

    @Serializable
    private data class Vector(
        val alg: String,
        val sender: Party,
        val recipient: Party,
        val nonce: String,
        val plaintext: String,
        val envelope: EncryptedEnvelope,
    )

    @Serializable
    private data class Party(val publicKey: String, val privateKey: String, val keyId: String)

    private val vector: Vector by lazy {
        val json = javaClass.getResourceAsStream("/interop-vector.json")
            ?.readBytes()?.toString(StandardCharsets.UTF_8)
            ?: error("interop-vector.json missing from test resources")
        Json { ignoreUnknownKeys = true }.decodeFromString(Vector.serializer(), json)
    }

    @Test
    fun `keyId matches the server-or-extension convention`() {
        assertEquals(vector.sender.keyId, Base64x.keyId(vector.sender.publicKey))
        assertEquals(vector.recipient.keyId, Base64x.keyId(vector.recipient.publicKey))
    }

    @Test
    fun `opens a ciphertext sealed by libsodium (TS side)`() {
        val opened = Sealer.open(
            vector.envelope,
            senderPubB64 = vector.sender.publicKey,
            recipientPrivB64 = vector.recipient.privateKey,
        )
        assertEquals(vector.plaintext, opened)
    }

    @Test
    fun `reseals byte-for-byte identical to libsodium given the same nonce`() {
        // Determinism check: same keys + same nonce + same plaintext ⇒ same ciphertext.
        val nonce = Base64x.decode(vector.nonce)
        val boxed = CryptoBox.boxEasy(
            vector.plaintext.toByteArray(StandardCharsets.UTF_8),
            nonce,
            targetPublicKey = Base64x.decode(vector.recipient.publicKey),
            senderSecretKey = Base64x.decode(vector.sender.privateKey),
        )
        assertArrayEquals(Base64x.decode(vector.envelope.ciphertext), boxed)
    }

    @Test
    fun `full seal via Sealer reproduces the wire envelope`() {
        val envelope = Sealer.seal(
            payloadJson = vector.plaintext,
            targetPubB64 = vector.recipient.publicKey,
            senderPrivB64 = vector.sender.privateKey,
            senderKeyId = vector.sender.keyId,
            nonce = Base64x.decode(vector.nonce),
        )
        assertEquals(vector.envelope.alg, envelope.alg)
        assertEquals(vector.envelope.senderKeyId, envelope.senderKeyId)
        assertEquals(vector.envelope.targetKeyId, envelope.targetKeyId)
        assertEquals(vector.envelope.nonce, envelope.nonce)
        assertEquals(vector.envelope.ciphertext, envelope.ciphertext)
    }

    @Test
    fun `envelope survives a JSON round-trip on the wire`() {
        val encoded = WireJson.encodeToString(EncryptedEnvelope.serializer(), vector.envelope)
        val decoded = WireJson.decodeFromString(EncryptedEnvelope.serializer(), encoded)
        assertEquals(vector.envelope, decoded)
    }

    @Test
    fun `rejects a tampered ciphertext`() {
        val tampered = Base64x.decode(vector.envelope.ciphertext).also { it[0] = (it[0].toInt() xor 0xff).toByte() }
        val bad = vector.envelope.copy(ciphertext = Base64x.encode(tampered))
        assertThrows(CryptoBox.AuthenticationFailure::class.java) {
            Sealer.open(bad, vector.sender.publicKey, vector.recipient.privateKey)
        }
    }

    @Test
    fun `rejects a message from the wrong sender`() {
        // Open with the recipient's own public key as the claimed sender → auth fails.
        assertThrows(CryptoBox.AuthenticationFailure::class.java) {
            Sealer.open(vector.envelope, vector.recipient.publicKey, vector.recipient.privateKey)
        }
    }

    @Test
    fun `freshly generated keypairs round-trip through box and open`() {
        val alice = CryptoBox.generateKeyPair()
        val bob = CryptoBox.generateKeyPair()
        val payload = """{"url":"https://ok","sentAt":"2026-07-18T00:00:00.000Z"}"""
        val env = Sealer.seal(payload, Base64x.encode(bob.publicKey), Base64x.encode(alice.privateKey), Base64x.keyId(Base64x.encode(alice.publicKey)))
        val opened = Sealer.open(env, Base64x.encode(alice.publicKey), Base64x.encode(bob.privateKey))
        assertEquals(payload, opened)
        assertTrue(env.nonce.isNotEmpty())
    }
}
