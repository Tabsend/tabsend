package io.tabsend.app

import com.android.billingclient.api.BillingClient.BillingResponseCode
import io.tabsend.app.logic.LinkOut
import java.net.URLDecoder
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Google Play's link-out program, the parts that need no phone (PLANS.md P-19). */
class LinkOutTest {

    @Test
    fun `the token is added to the address as the gpt query parameter`() {
        assertEquals(
            "https://account.tabsend.org/start?from=app&gpt=abc123",
            LinkOut.withToken("https://account.tabsend.org/start?from=app", "abc123"),
        )
        assertEquals(
            "https://account.tabsend.org/account?from=app&gpt=abc123",
            LinkOut.withToken("https://account.tabsend.org/account?from=app", "abc123"),
        )
    }

    @Test
    fun `an address with no query gets one, and a fragment stays last`() {
        assertEquals(
            "https://account.tabsend.org/start?gpt=t",
            LinkOut.withToken("https://account.tabsend.org/start", "t"),
        )
        assertEquals(
            "https://account.tabsend.org/account?from=app&gpt=t#danger",
            LinkOut.withToken("https://account.tabsend.org/account?from=app#danger", "t"),
        )
    }

    @Test
    fun `a token with reserved characters is encoded and reads back the same`() {
        val token = "A+b/c=d&e#f g%h"
        val link = LinkOut.withToken("https://account.tabsend.org/start?from=app", token)
        val sent = link.substringAfter("&gpt=")
        // Nothing in it can end the parameter or start a fragment.
        assertFalse(sent.contains('&'))
        assertFalse(sent.contains('#'))
        assertFalse(sent.contains(' '))
        assertEquals(token, URLDecoder.decode(sent, "UTF-8"))
    }

    @Test
    fun `Google's answers decide what happens next`() {
        assertEquals(LinkOut.Step.Proceed, LinkOut.stepAfter(BillingResponseCode.OK))
        // The person closed Google's notice: nothing opens and nothing is said.
        assertEquals(LinkOut.Step.Cancelled, LinkOut.stepAfter(BillingResponseCode.USER_CANCELED))
        for (code in listOf(
            BillingResponseCode.ERROR,
            BillingResponseCode.DEVELOPER_ERROR,
            BillingResponseCode.BILLING_UNAVAILABLE,
            BillingResponseCode.FEATURE_NOT_SUPPORTED,
            BillingResponseCode.NETWORK_ERROR,
        )) {
            assertEquals("code $code", LinkOut.Step.Failed, LinkOut.stepAfter(code))
        }
    }

    @Test
    fun `only an OK answer makes the link-out available`() {
        assertTrue(LinkOut.isAvailable(BillingResponseCode.OK))
        assertFalse(LinkOut.isAvailable(BillingResponseCode.BILLING_UNAVAILABLE))
        assertFalse(LinkOut.isAvailable(BillingResponseCode.FEATURE_NOT_SUPPORTED))
        assertFalse(LinkOut.isAvailable(BillingResponseCode.DEVELOPER_ERROR))
    }

    @Test
    fun `a dropped connection is asked again later, a plain no is kept`() {
        for (code in listOf(
            BillingResponseCode.SERVICE_DISCONNECTED,
            BillingResponseCode.SERVICE_UNAVAILABLE,
            BillingResponseCode.NETWORK_ERROR,
            BillingResponseCode.ERROR,
        )) {
            assertTrue("code $code", LinkOut.isRetryable(code))
        }
        // Not in the US, not enrolled, a build Google does not know: asking again changes nothing.
        for (code in listOf(
            BillingResponseCode.BILLING_UNAVAILABLE,
            BillingResponseCode.FEATURE_NOT_SUPPORTED,
            BillingResponseCode.DEVELOPER_ERROR,
        )) {
            assertFalse("code $code", LinkOut.isRetryable(code))
        }
    }
}
