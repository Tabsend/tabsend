package io.tabsend.app.crypto

import org.bouncycastle.crypto.agreement.X25519Agreement
import org.bouncycastle.crypto.macs.Poly1305
import org.bouncycastle.crypto.params.KeyParameter
import org.bouncycastle.crypto.params.X25519PrivateKeyParameters
import org.bouncycastle.crypto.params.X25519PublicKeyParameters
import java.security.SecureRandom

/**
 * NaCl `crypto_box` (X25519 + XSalsa20-Poly1305), assembled to be byte-for-byte
 * compatible with libsodium's `crypto_box_easy` / `crypto_box_open_easy` — the
 * exact primitive the Tabsend extension and server agreed on (ADR-0009).
 *
 * Pieces:
 *  - X25519 scalar mult: Bouncy Castle (RFC 7748, clamped like libsodium).
 *  - HSalsa20 / XSalsa20 keystream: [Salsa20] (hand-rolled, NaCl reference).
 *  - Poly1305 one-time MAC: Bouncy Castle (r pre-clamped, see below).
 *
 * The whole thing is pinned to libsodium by CryptoInteropTest against a committed
 * vector generated on the TS side.
 */
object CryptoBox {
    const val NONCE_BYTES = 24
    private const val MAC_BYTES = 16
    private const val KEY_BYTES = 32

    /** Thrown when authentication fails: a forged, tampered, or mis-addressed box. */
    class AuthenticationFailure : Exception("crypto_box authentication failed")

    data class KeyPair(val publicKey: ByteArray, val privateKey: ByteArray) {
        override fun equals(other: Any?): Boolean =
            other is KeyPair && publicKey.contentEquals(other.publicKey) &&
                privateKey.contentEquals(other.privateKey)

        override fun hashCode(): Int = publicKey.contentHashCode() * 31 + privateKey.contentHashCode()
    }

    /** Fresh X25519 keypair (raw 32-byte values), like libsodium `crypto_box_keypair`. */
    fun generateKeyPair(random: SecureRandom = SecureRandom()): KeyPair {
        val priv = X25519PrivateKeyParameters(random)
        val pub = priv.generatePublicKey()
        return KeyPair(pub.encoded, priv.encoded)
    }

    /** A random 24-byte nonce for one message. */
    fun randomNonce(random: SecureRandom = SecureRandom()): ByteArray =
        ByteArray(NONCE_BYTES).also { random.nextBytes(it) }

    /**
     * A fresh 32-byte symmetric key — the group history key [0028]. Same length
     * as the `crypto_box` shared secret because it feeds the same construction;
     * the only difference is that it is chosen rather than derived.
     */
    fun randomSecretKey(random: SecureRandom = SecureRandom()): ByteArray =
        ByteArray(KEY_BYTES).also { random.nextBytes(it) }

    /** crypto_scalarmult(sk, pk): raw X25519 shared point (RFC 7748). */
    private fun scalarMult(secretKey: ByteArray, publicKey: ByteArray): ByteArray {
        val agreement = X25519Agreement()
        agreement.init(X25519PrivateKeyParameters(secretKey, 0))
        val out = ByteArray(agreement.agreementSize)
        agreement.calculateAgreement(X25519PublicKeyParameters(publicKey, 0), out, 0)
        return out
    }

    /** crypto_box_beforenm: HSalsa20(0^16, X25519(sk, pk)). */
    private fun beforeNm(publicKey: ByteArray, secretKey: ByteArray): ByteArray {
        val shared = scalarMult(secretKey, publicKey)
        return Salsa20.hsalsa20(ByteArray(16), shared)
    }

    /** crypto_box_easy: seal `message` to `targetPublicKey`, authenticated by `senderSecretKey`. */
    fun boxEasy(
        message: ByteArray,
        nonce: ByteArray,
        targetPublicKey: ByteArray,
        senderSecretKey: ByteArray,
    ): ByteArray {
        require(nonce.size == NONCE_BYTES) { "nonce must be $NONCE_BYTES bytes" }
        val key = beforeNm(targetPublicKey, senderSecretKey)
        return secretBoxEasy(message, nonce, key)
    }

    /** crypto_box_open_easy: open a box addressed to us; throws [AuthenticationFailure] on any mismatch. */
    fun boxOpenEasy(
        boxed: ByteArray,
        nonce: ByteArray,
        senderPublicKey: ByteArray,
        recipientSecretKey: ByteArray,
    ): ByteArray {
        require(nonce.size == NONCE_BYTES) { "nonce must be $NONCE_BYTES bytes" }
        val key = beforeNm(senderPublicKey, recipientSecretKey)
        return secretBoxOpenEasy(boxed, nonce, key)
    }

    // --- crypto_secretbox (XSalsa20-Poly1305), output = tag(16) || ciphertext ---
    //
    // Public rather than private since [0028]: the group history key is used
    // DIRECTLY here, with no X25519 exchange in front of it. That is the whole
    // reason ADR-0028 could pick this construction — the bytes below are already
    // the inner half of every tab this app sends, so nothing new was introduced.

    /** crypto_secretbox_easy: seal `message` under a 32-byte symmetric `key`. */
    fun secretBoxEasy(message: ByteArray, nonce: ByteArray, key: ByteArray): ByteArray {
        val keystream = Salsa20.xsalsa20Keystream(32 + message.size, nonce, key)
        val polyKey = clampPolyR(keystream.copyOfRange(0, 32))
        val cipher = ByteArray(message.size)
        for (i in message.indices) cipher[i] = (message[i].toInt() xor keystream[32 + i].toInt()).toByte()
        val tag = poly1305(cipher, polyKey)
        return tag + cipher
    }

    /** crypto_secretbox_open_easy: throws [AuthenticationFailure] on any mismatch. */
    fun secretBoxOpenEasy(boxed: ByteArray, nonce: ByteArray, key: ByteArray): ByteArray {
        if (boxed.size < MAC_BYTES) throw AuthenticationFailure()
        val cipherLen = boxed.size - MAC_BYTES
        val keystream = Salsa20.xsalsa20Keystream(32 + cipherLen, nonce, key)
        val polyKey = clampPolyR(keystream.copyOfRange(0, 32))
        val cipher = boxed.copyOfRange(MAC_BYTES, boxed.size)
        val expected = poly1305(cipher, polyKey)
        val given = boxed.copyOfRange(0, MAC_BYTES)
        if (!constantTimeEquals(expected, given)) throw AuthenticationFailure()
        val plain = ByteArray(cipherLen)
        for (i in 0 until cipherLen) plain[i] = (cipher[i].toInt() xor keystream[32 + i].toInt()).toByte()
        return plain
    }

    private fun poly1305(data: ByteArray, key32: ByteArray): ByteArray {
        val mac = Poly1305()
        mac.init(KeyParameter(key32))
        mac.update(data, 0, data.size)
        val out = ByteArray(MAC_BYTES)
        mac.doFinal(out, 0)
        return out
    }

    /**
     * Clamp the `r` half (first 16 bytes) of the Poly1305 key exactly as the
     * Poly1305 spec (and libsodium) require. Doing it here makes the tag correct
     * regardless of whether Bouncy Castle's `Poly1305` clamps internally or
     * rejects an unclamped key — the masking is idempotent either way.
     */
    private fun clampPolyR(key32: ByteArray): ByteArray {
        key32[3] = (key32[3].toInt() and 15).toByte()
        key32[7] = (key32[7].toInt() and 15).toByte()
        key32[11] = (key32[11].toInt() and 15).toByte()
        key32[15] = (key32[15].toInt() and 15).toByte()
        key32[4] = (key32[4].toInt() and 252).toByte()
        key32[8] = (key32[8].toInt() and 252).toByte()
        key32[12] = (key32[12].toInt() and 252).toByte()
        return key32
    }

    private fun constantTimeEquals(a: ByteArray, b: ByteArray): Boolean {
        if (a.size != b.size) return false
        var diff = 0
        for (i in a.indices) diff = diff or (a[i].toInt() xor b[i].toInt())
        return diff == 0
    }
}
