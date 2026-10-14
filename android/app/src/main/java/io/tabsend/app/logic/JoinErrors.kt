package io.tabsend.app.logic

import java.io.IOException
import java.net.URI
import java.net.UnknownServiceException
import javax.net.ssl.SSLException

/**
 * Why a join failed, in words the person holding the phone can act on.
 *
 * The subtlety this exists for: on Android a TLS failure IS an [IOException]
 * (both [SSLException] and [UnknownServiceException] extend it), so a single
 * `catch (e: IOException)` cannot tell "the relay never answered" apart from
 * "the relay answered and this phone refused its certificate". Reporting the
 * second as the first sends the owner to check a relay that is running
 * perfectly — the exact dead end dogfooding hit on 2026-07-28.
 *
 * Kept pure (no Context, no resources) so the wording is unit-testable; the
 * strings live here rather than strings.xml for the same reason. If the app is
 * ever localised these move, and the classification stays.
 */
object JoinErrors {
    /**
     * Message for a failed join attempt.
     *
     * @param relay the relay URL that was tried
     * @param hadPin whether the pairing link carried a certificate fingerprint
     *   (`fp=`, P-3).
     */
    fun message(
        e: IOException,
        relay: String,
        hadPin: Boolean,
        retryAction: String = "tap Try again",
    ): String = when {
        e is SSLException && hadPin ->
            "The relay answered, but its security certificate doesn't match the one in " +
                "this pairing link. If the relay was rebuilt or reinstalled it will have a " +
                "new certificate — create a fresh pairing link and scan it again."

        e is SSLException ->
            "The relay answered, but this phone doesn't trust its security certificate. " +
                "The pairing link did not include the certificate fingerprint this phone " +
                "needs. Create a fresh link from the relay or an updated Tabsend device."

        e is UnknownServiceException ->
            "Android won't send plain http anywhere but localhost, so this address is " +
                "blocked. The relay needs an https address — one with its own self-signed " +
                "certificate is fine, as long as its pairing link carries the fingerprint."

        isLoopback(relay) ->
            "$relay means this phone itself, so there's nothing there to reach. That " +
                "address came from a relay that describes itself as localhost, which is a " +
                "development-only setting. Give the relay a PUBLIC_RELAY_URL that other " +
                "devices can reach, then create a new pairing link."

        else ->
            "Couldn't reach the relay at $relay. Check that it's running and that this " +
                "phone is on the same network, then $retryAction."
    }

    /**
     * Does this URL point at the device it is typed on? Matched on the HOST, not
     * as a substring: a real relay could legitimately be called
     * `localhost.example.com`, and a substring test would wrongly call it local.
     */
    fun isLoopback(relay: String): Boolean {
        val host = try {
            URI(relay.trim()).host
        } catch (_: Exception) {
            null
        } ?: return false
        val bare = host.trim('[', ']').lowercase()
        return bare == "localhost" || bare == "127.0.0.1" || bare == "::1" || bare == "0.0.0.0"
    }
}
