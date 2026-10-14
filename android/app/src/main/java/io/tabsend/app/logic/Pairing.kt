package io.tabsend.app.logic

import java.net.URI
import java.net.URLDecoder
import java.nio.charset.StandardCharsets

/**
 * A parsed pairing link: its internal one-time secret, relay URL, and optional
 * TLS certificate pin (P-3).
 */
data class ParsedPairing(
    val code: String,
    val relayUrl: String,
    val certFingerprint: String? = null,
)

/**
 * Parse the complete link the user pastes, scans, or opens. Mirrors the
 * extension's `lib/pairing.ts`. Accepts:
 *  - the https pairing link: "https://relay.example/pair#c=ABC12345"  (relay derived)
 *  - the pinned variant:     "https://relay.example/pair#c=ABC12345&fp=…"  (P-3)
 *
 * The code rides in the URL *fragment* so it never hits a server log (ADR-0009).
 * The fragment may carry &-separated params: `c` is the code, `fp` is the
 * base64url SPKI-SHA256 pin of the relay's self-signed cert (shared/src/types.ts).
 * Unknown params are ignored so older apps stay forward-compatible.
 */
object Pairing {
    private const val FRAGMENT_MARKER = "#c="

    fun parse(input: String): ParsedPairing? {
        val trimmed = input.trim()
        if (trimmed.isEmpty()) return null

        val markerIdx = trimmed.indexOf(FRAGMENT_MARKER)
        if (markerIdx >= 0) {
            // Everything after "#c=" is the code up to the first '&'; the rest
            // of the fragment is optional &-separated params (fp=…, and any
            // future ones we don't know yet — ignore those).
            val fragment = trimmed.substring(markerIdx + FRAGMENT_MARKER.length).trim()
            val parts = fragment.split('&')
            val code = parts.first().trim()
            if (code.isEmpty()) return null
            val certFingerprint = parts.drop(1)
                .firstOrNull { it.startsWith("fp=") }
                ?.removePrefix("fp=")
                ?.trim()
                ?.takeIf { it.isNotEmpty() }
            val before = trimmed.substring(0, markerIdx)
                .replace(Regex("/pair/?$"), "")
                .trimEnd('/')
            val linkRelayUrl = before.takeIf {
                it.startsWith("https://", ignoreCase = true) ||
                    it.startsWith("http://", ignoreCase = true)
            } ?: return null
            val relayUrl = routeHint(parts, "native")
                ?: legacyNativeRoute(linkRelayUrl, certFingerprint)
            return ParsedPairing(code.uppercase(), relayUrl, certFingerprint)
        }
        return null
    }

    /**
     * Validate a camera result without reducing it to its internal secret. The
     * original full string must reach the Join handler so `relayUrl` and `fp=`
     * survive the handoff from the scanner.
     */
    fun scannedLink(input: String): String? = input.trim().takeIf { parse(it) != null }

    private fun routeHint(parts: List<String>, name: String): String? {
        val encoded = parts.drop(1)
            .firstOrNull { it.startsWith("$name=") }
            ?.removePrefix("$name=")
            ?.trim()
            ?.takeIf { it.isNotEmpty() }
            ?: return null
        return try {
            val raw = URLDecoder.decode(encoded, StandardCharsets.UTF_8.name()).trimEnd('/')
            val uri = URI(raw)
            raw.takeIf {
                (uri.scheme.equals("http", true) || uri.scheme.equals("https", true)) &&
                    uri.host != null && uri.userInfo == null && uri.query == null && uri.fragment == null
            }
        } catch (_: Exception) {
            null
        }
    }

    /** Older dual-listener links carried only the browser route. */
    private fun legacyNativeRoute(relayUrl: String, fingerprint: String?): String {
        if (fingerprint == null) return relayUrl
        return try {
            val uri = URI(relayUrl)
            if (!uri.scheme.equals("http", true) || uri.port != 8786 || uri.host == null) relayUrl
            else URI("https", null, uri.host, 8787, uri.path, null, null).toString().trimEnd('/')
        } catch (_: Exception) {
            relayUrl
        }
    }
}
