package io.tabsend.app

import io.tabsend.app.net.Tls
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.security.KeyPairGenerator
import java.security.MessageDigest

/**
 * The SPKI-pin matcher (P-3), tested against real keys: `publicKey.encoded`
 * on the JVM IS the SPKI DER, so a KeyPairGenerator gives us exactly the bytes
 * the trust manager hashes from a server's leaf certificate.
 */
class TlsTest {

    private fun freshSpki(): ByteArray =
        KeyPairGenerator.getInstance("EC").apply { initialize(256) }
            .generateKeyPair().public.encoded

    @Test
    fun `pin matches the key it was derived from and no other`() {
        val spki = freshSpki()
        val pin = Tls.spkiPin(spki)
        assertTrue(Tls.pinMatches(pin, spki))
        assertFalse(Tls.pinMatches(pin, freshSpki()))
    }

    @Test
    fun `pin is base64url of the SHA-256 digest, unpadded`() {
        val spki = freshSpki()
        val expected = java.util.Base64.getUrlEncoder().withoutPadding()
            .encodeToString(MessageDigest.getInstance("SHA-256").digest(spki))
        assertEquals(expected, Tls.spkiPin(spki))
        assertFalse(Tls.spkiPin(spki).contains('='))
    }

    @Test
    fun `padded and unpadded pins both match`() {
        val spki = freshSpki()
        val unpadded = Tls.spkiPin(spki)
        val padded = unpadded + "=".repeat((4 - unpadded.length % 4) % 4)
        assertTrue(Tls.pinMatches(padded, spki))
    }

    @Test
    fun `garbage pins never match and never throw`() {
        val spki = freshSpki()
        assertFalse(Tls.pinMatches("", spki))
        assertFalse(Tls.pinMatches("not/base64url+really!", spki))
        assertFalse(Tls.pinMatches("QUJD", spki)) // valid base64url, wrong hash
    }
}
