package io.tabsend.app

import io.tabsend.app.logic.JoinErrors
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException
import java.net.SocketTimeoutException
import java.net.UnknownServiceException
import javax.net.ssl.SSLHandshakeException
import javax.net.ssl.SSLPeerUnverifiedException

/**
 * The regression these lock down (dogfood 2026-07-28): every one of these
 * failures is an IOException, and reporting them all as "couldn't reach the
 * relay" sent the owner to check a relay that was answering perfectly.
 */
class JoinErrorsTest {
    private val lan = "https://192.168.68.65:8787"

    @Test
    fun `an untrusted certificate is never reported as unreachable`() {
        val msg = JoinErrors.message(SSLHandshakeException("no trust anchor"), lan, hadPin = false)
        assertFalse(msg.contains("Couldn't reach"))
        assertTrue(msg.contains("doesn't trust"))
        assertTrue(msg.contains("fresh link"))
    }

    @Test
    fun `a pinned join that fails TLS blames the certificate changing, not the network`() {
        val msg = JoinErrors.message(SSLPeerUnverifiedException("pin mismatch"), lan, hadPin = true)
        assertFalse(msg.contains("Couldn't reach"))
        assertTrue(msg.contains("doesn't match"))
        assertTrue(msg.contains("fresh pairing link"))
    }

    @Test
    fun `blocked cleartext explains https rather than recommending adb`() {
        val msg = JoinErrors.message(UnknownServiceException("cleartext blocked"), "http://192.168.68.65:8787", hadPin = false)
        assertTrue(msg.contains("https"))
        assertFalse(msg.contains("adb"))
    }

    @Test
    fun `a localhost relay explains what localhost means on a phone`() {
        val msg = JoinErrors.message(IOException("connect failed"), "http://localhost:8787", hadPin = false)
        assertTrue(msg.contains("means this phone"))
        assertTrue(msg.contains("PUBLIC_RELAY_URL"))
        // The old copy sent the owner to a USB cable he does not use.
        assertFalse(msg.contains("adb"))
        assertFalse(msg.contains("USB"))
    }

    @Test
    fun `a genuinely unreachable relay still says so`() {
        val msg = JoinErrors.message(SocketTimeoutException("timeout"), lan, hadPin = true)
        assertTrue(msg.contains("Couldn't reach"))
        assertTrue(msg.contains(lan))
    }

    @Test
    fun `a pairing-link retry names the action that retries it`() {
        val msg = JoinErrors.message(
            SocketTimeoutException("timeout"),
            lan,
            hadPin = true,
            retryAction = "tap Pair another device again",
        )
        assertTrue(msg.contains("Pair another device again"))
        assertFalse(msg.contains("tap Try again"))
    }

    @Test
    fun `loopback is matched on the host, not as a substring`() {
        assertTrue(JoinErrors.isLoopback("http://localhost:8787"))
        assertTrue(JoinErrors.isLoopback("http://127.0.0.1:8787"))
        assertTrue(JoinErrors.isLoopback("https://[::1]:8787"))
        assertTrue(JoinErrors.isLoopback("http://0.0.0.0:8787"))
        assertFalse(JoinErrors.isLoopback("https://192.168.68.65:8787"))
        assertFalse(JoinErrors.isLoopback("https://relay.example.com"))
        // Would be a false positive under the old substring test.
        assertFalse(JoinErrors.isLoopback("https://localhost.example.com"))
        assertFalse(JoinErrors.isLoopback("not a url"))
    }
}
