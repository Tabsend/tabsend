package io.tabsend.app.net

import okhttp3.OkHttpClient
import java.security.MessageDigest
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.concurrent.ConcurrentHashMap
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager

/**
 * SPKI pinning for self-hosted relays with self-signed certs (P-3).
 *
 * The pairing link may carry `fp=base64url(SHA-256(SPKI DER))` of the relay's
 * certificate public key. When it does, TLS trust is the pin and nothing else:
 * the trust manager accepts a server chain iff the leaf's public key hashes to
 * the pin, and hostname verification is disabled — identity comes from the key,
 * not from a CA or the SAN (which may be a stale LAN IP). This is the SSH
 * known-hosts model, and it is deliberate. With no pin, clients stay on the
 * platform defaults (system CA trust + normal hostname verification).
 */
object Tls {

    /** base64url(SHA-256(spkiDer)) — `publicKey.encoded` IS the SPKI DER in Java. */
    fun spkiPin(spkiDer: ByteArray): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(spkiDer)
        return java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(digest)
    }

    /**
     * Does this SPKI hash to the expected pin? Pure and JVM-testable. Tolerates
     * a padded or unpadded base64url pin; a malformed pin simply never matches.
     */
    fun pinMatches(expectedPin: String, spkiDer: ByteArray): Boolean {
        val expected = try {
            java.util.Base64.getUrlDecoder().decode(expectedPin.trimEnd('='))
        } catch (_: IllegalArgumentException) {
            return false
        }
        val actual = MessageDigest.getInstance("SHA-256").digest(spkiDer)
        return MessageDigest.isEqual(expected, actual)
    }

    /**
     * A copy of [base] that trusts exactly the pinned key. Configured clients are
     * cached per pin (and per base, so ApiClient and the WS stream each keep
     * their own timeouts); `newBuilder()` shares the base's connection pool.
     */
    fun pinnedClient(base: OkHttpClient, pin: String): OkHttpClient =
        cache.getOrPut(CacheKey(base, pin)) {
            val trust = PinnedTrustManager(pin)
            val ssl = SSLContext.getInstance("TLS").apply { init(null, arrayOf(trust), null) }
            base.newBuilder()
                .sslSocketFactory(ssl.socketFactory, trust)
                .hostnameVerifier { _, _ -> true } // identity = the pin, not the name
                .build()
        }

    private data class CacheKey(val base: OkHttpClient, val pin: String)

    private val cache = ConcurrentHashMap<CacheKey, OkHttpClient>()

    private class PinnedTrustManager(private val pin: String) : X509TrustManager {
        override fun checkServerTrusted(chain: Array<X509Certificate>?, authType: String?) {
            val leaf = chain?.firstOrNull()
                ?: throw CertificateException("Server presented no certificate.")
            if (!pinMatches(pin, leaf.publicKey.encoded)) {
                throw CertificateException(
                    "Relay certificate does not match the pinned key from the pairing link.",
                )
            }
        }

        override fun checkClientTrusted(chain: Array<X509Certificate>?, authType: String?) {
            throw CertificateException("Client certificates are not used.")
        }

        override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
    }
}
