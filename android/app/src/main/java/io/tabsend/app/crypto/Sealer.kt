package io.tabsend.app.crypto

import io.tabsend.app.wire.EncryptedEnvelope
import io.tabsend.app.wire.GroupSealed
import java.nio.charset.StandardCharsets

/**
 * High-level seal/open over [CryptoBox] — the exact analogue of the extension's
 * `sealFor()` / `open()` (extension/src/background/send.ts + lib/crypto.ts), so an
 * envelope built here opens there and vice versa.
 */
object Sealer {
    const val ALG = "x25519-xsalsa20-poly1305/box"

    /** The group-sealed variant [0028] — same cipher, key supplied rather than derived. */
    const val GROUP_ALG = "xsalsa20-poly1305/secretbox"

    /**
     * Seal `payloadJson` to `targetPubB64`, authenticated by our secret key.
     * `senderKeyId` is the cached fingerprint of our own public key (identity),
     * matching how the extension avoids recomputing it per send.
     */
    fun seal(
        payloadJson: String,
        targetPubB64: String,
        senderPrivB64: String,
        senderKeyId: String,
        nonce: ByteArray = CryptoBox.randomNonce(),
    ): EncryptedEnvelope {
        val boxed = CryptoBox.boxEasy(
            payloadJson.toByteArray(StandardCharsets.UTF_8),
            nonce,
            Base64x.decode(targetPubB64),
            Base64x.decode(senderPrivB64),
        )
        return EncryptedEnvelope(
            alg = ALG,
            senderKeyId = senderKeyId,
            targetKeyId = Base64x.keyId(targetPubB64),
            nonce = Base64x.encode(nonce),
            ciphertext = Base64x.encode(boxed),
        )
    }

    /** Open an envelope addressed to us; throws on a forged/tampered/mis-addressed box. */
    fun open(envelope: EncryptedEnvelope, senderPubB64: String, recipientPrivB64: String): String {
        val plain = CryptoBox.boxOpenEasy(
            Base64x.decode(envelope.ciphertext),
            Base64x.decode(envelope.nonce),
            Base64x.decode(senderPubB64),
            Base64x.decode(recipientPrivB64),
        )
        return String(plain, StandardCharsets.UTF_8)
    }

    /**
     * Seal `plaintextJson` under the group history key [0028], naming the key so a
     * reader holding several knows which one opened it. The mirror of the
     * extension's `sealGroup()` in lib/crypto.ts.
     */
    fun sealGroup(
        plaintextJson: String,
        keyB64: String,
        keyId: String,
        nonce: ByteArray = CryptoBox.randomNonce(),
    ): GroupSealed {
        val boxed = CryptoBox.secretBoxEasy(
            plaintextJson.toByteArray(StandardCharsets.UTF_8),
            nonce,
            Base64x.decode(keyB64),
        )
        return GroupSealed(
            alg = GROUP_ALG,
            keyId = keyId,
            nonce = Base64x.encode(nonce),
            ciphertext = Base64x.encode(boxed),
        )
    }

    /** Open a group-sealed blob; throws when the key is wrong or the blob is corrupt. */
    fun openGroup(blob: GroupSealed, keyB64: String): String {
        val plain = CryptoBox.secretBoxOpenEasy(
            Base64x.decode(blob.ciphertext),
            Base64x.decode(blob.nonce),
            Base64x.decode(keyB64),
        )
        return String(plain, StandardCharsets.UTF_8)
    }
}
