package io.tabsend.app.crypto

import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.Base64

/**
 * Base64 helpers matching the extension's `lib/base64.ts` and the server's keyId
 * convention exactly — so the wire encoding is byte-identical across TS and Kotlin.
 *
 * We use `java.util.Base64` (available on API 26+ and the host JVM) rather than
 * `android.util.Base64` so the SAME code runs in unit tests without an emulator.
 */
object Base64x {
    private val STD_ENC: Base64.Encoder = Base64.getEncoder()
    private val STD_DEC: Base64.Decoder = Base64.getDecoder()
    private val URL_ENC_NOPAD: Base64.Encoder = Base64.getUrlEncoder().withoutPadding()

    /** Raw bytes -> standard base64 (with `+` `/` and `=` padding). Matches `btoa`. */
    fun encode(bytes: ByteArray): String = STD_ENC.encodeToString(bytes)

    /** Standard base64 -> raw bytes. Matches `atob`. */
    fun decode(b64: String): ByteArray = STD_DEC.decode(b64)

    /** Raw bytes -> base64url without padding (the extension's `base64ToBase64Url`). */
    fun encodeUrlNoPad(bytes: ByteArray): String = URL_ENC_NOPAD.encodeToString(bytes)

    /**
     * keyId of a public-key STRING: `base64url(sha256(utf8(pubkeyBase64String)))`.
     * MUST match the relay's `keyIdFor()` and the extension's `keyId()` verbatim,
     * or the server rejects sends with `expired_key`. Note it hashes the base64
     * STRING, not the raw key bytes.
     *
     * The group history key [0028] is fingerprinted with this same function, over
     * its own base64 string — one convention for "which key is this", so a keyId
     * means the same thing wherever it appears.
     */
    fun keyId(pubkeyBase64: String): String {
        val digest = MessageDigest.getInstance("SHA-256")
            .digest(pubkeyBase64.toByteArray(StandardCharsets.UTF_8))
        return encodeUrlNoPad(digest)
    }
}
