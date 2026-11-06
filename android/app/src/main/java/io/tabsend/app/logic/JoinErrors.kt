package io.tabsend.app.logic

import io.tabsend.app.R
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
 * Kept pure (no Context) so the classification is unit-testable; the sentences come from a
 * [TextSource], so they are catalog messages like every other (docs/L10N.md), and the
 * classification stays here whatever the language.
 */
object JoinErrors {
    /** The button the unreachable sentence points the person to. */
    enum class RetryAction {
        /** The pairing screen's retry button ("Try again"). */
        TRY_AGAIN,

        /** The home screen's "Add a device" button. */
        ADD_DEVICE,
    }

    /**
     * Message for a failed join attempt.
     *
     * @param relay the relay URL that was tried
     * @param hadPin whether the pairing link carried a certificate fingerprint
     *   (`fp=`, P-3).
     * @param retryAction which button the last sentence names. Each choice is its own whole
     *   sentence, so a translation can end it its own way.
     */
    fun message(
        text: TextSource,
        e: IOException,
        relay: String,
        hadPin: Boolean,
        retryAction: RetryAction = RetryAction.TRY_AGAIN,
    ): String = when {
        e is SSLException && hadPin -> text.string(R.string.join_error_cert_mismatch)
        e is SSLException -> text.string(R.string.join_error_cert_untrusted)
        e is UnknownServiceException -> text.string(R.string.join_error_cleartext)
        isLoopback(relay) -> text.string(R.string.join_error_loopback, relay)
        retryAction == RetryAction.ADD_DEVICE -> text.string(R.string.join_error_unreachable_add_device, relay)
        else -> text.string(R.string.join_error_unreachable_retry, relay)
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
