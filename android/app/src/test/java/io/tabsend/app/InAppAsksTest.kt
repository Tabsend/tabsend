package io.tabsend.app

import io.tabsend.app.logic.HelpTabsend
import io.tabsend.app.logic.InAppAsks
import io.tabsend.app.logic.InAppAsks.ShareVariant
import io.tabsend.app.logic.ServicePlan
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** The share box and the review ask rules [P-22], and the English they use. */
class InAppAsksTest {
    private val day = 24L * 60 * 60 * 1000
    private val now = 1_000L * day

    private fun box(
        plan: ServicePlan? = ServicePlan.Account,
        door: Boolean = true,
        firstHome: Long? = now - 100 * day,
        devices: Int = 2,
        dismissed: Long? = null,
        review: Long? = null,
        reviewSession: Boolean = false,
    ) = InAppAsks.shareBox(now, plan, door, firstHome, devices, dismissed, review, reviewSession)

    @Test
    fun `an account with the door open gets the credit box at once`() {
        assertEquals(ShareVariant.Credit, box(firstHome = now, devices = 1))
    }

    @Test
    fun `an account without the door gets the plain box`() {
        assertEquals(ShareVariant.Plain, box(door = false))
    }

    @Test
    fun `a trial never shows the box`() {
        assertNull(box(plan = ServicePlan.Trial(now + day)))
        assertNull(box(plan = ServicePlan.TrialEnded))
    }

    @Test
    fun `self-hosted waits 30 days and 2 devices`() {
        assertEquals(ShareVariant.Plain, box(plan = null, firstHome = now - 30 * day))
        assertNull(box(plan = null, firstHome = now - 30 * day + 1))
        assertNull(box(plan = null, firstHome = null))
        assertNull(box(plan = null, devices = 1))
    }

    @Test
    fun `a dismissal hides the box for a year`() {
        assertNull(box(dismissed = now - 364 * day))
        assertEquals(ShareVariant.Credit, box(dismissed = now - 365 * day))
    }

    @Test
    fun `a review ask keeps the box away in the session and for 14 days`() {
        assertNull(box(reviewSession = true))
        assertNull(box(review = now - 13 * day))
        assertEquals(ShareVariant.Credit, box(review = now - 14 * day))
    }

    @Test
    fun `the variant needs the door and an account`() {
        assertEquals(ShareVariant.Credit, InAppAsks.shareVariant(true, ServicePlan.Account))
        assertEquals(ShareVariant.Plain, InAppAsks.shareVariant(false, ServicePlan.Account))
        assertEquals(ShareVariant.Plain, InAppAsks.shareVariant(true, null))
        assertEquals(ShareVariant.Plain, InAppAsks.shareVariant(true, ServicePlan.TrialEnded))
    }

    private fun review(
        firstHome: Long? = now - 7 * day,
        devices: Int = 2,
        asks: List<Long> = emptyList(),
        shareDismissed: Long? = null,
        boxShown: Boolean = false,
        sendOk: Boolean = true,
        error: Boolean = false,
    ) = InAppAsks.mayAskForReview(now, firstHome, devices, asks, shareDismissed, boxShown, sendOk, error)

    @Test
    fun `a review ask needs a good send and no error`() {
        assertTrue(review())
        assertFalse(review(sendOk = false))
        assertFalse(review(error = true))
    }

    @Test
    fun `a review ask needs 7 days and 2 devices`() {
        assertFalse(review(firstHome = now - 7 * day + 1))
        assertFalse(review(firstHome = null))
        assertFalse(review(devices = 1))
    }

    @Test
    fun `reviews are 120 days apart and 3 a year at most`() {
        assertFalse(review(asks = listOf(now - 119 * day)))
        assertTrue(review(asks = listOf(now - 120 * day)))
        assertFalse(review(asks = listOf(now - 120 * day, now - 250 * day, now - 360 * day)))
        assertTrue(review(asks = listOf(now - 120 * day, now - 250 * day, now - 366 * day)))
    }

    @Test
    fun `reviews and the share box keep 14 days apart`() {
        assertFalse(review(shareDismissed = now - 13 * day))
        assertTrue(review(shareDismissed = now - 14 * day))
        assertFalse(review(boxShown = true))
    }

    @Test
    fun `the rate row is hidden while no store page is set`() {
        assertEquals("", HelpTabsend.REVIEW_URL)
        assertFalse(HelpTabsend.showsRateRow)
    }

    @Test
    fun `the English is word for word`() {
        val xml = File("src/main/res/values/strings.xml").readText().replace("\\'", "'")
        fun text(name: String) = Regex("""<string name="$name">(.*?)</string>""", RegexOption.DOT_MATCHES_ALL)
            .find(xml)!!.groupValues[1]
        assertEquals("Know someone who'd like Tabsend?", text("share_box_title"))
        assertEquals(
            "Built by a dad to support his family. Share it, and get \$5 off your next payment when a friend " +
                "subscribes (once a year, however many friends join).",
            text("share_box_body_credit"),
        )
        assertEquals(
            "Built by a dad to support his family. If you like it, would you share it with a coworker or friend?",
            text("share_box_body_plain"),
        )
        assertEquals(
            "Tabsend was built by a dad to support his family. If you like it, would you share it with a coworker " +
                "or friend? It's not for everyone, but I bet you have a good idea who else would find it useful. " +
                "As a thank you, you'll get \$5 off your next payment when a friend subscribes. That's once a year, " +
                "however many friends join.",
            text("share_box_more_credit"),
        )
        assertEquals(
            "Tabsend was built by a dad to support his family. If you like it, would you share it with a coworker " +
                "or friend? It's not for everyone, but I bet you have a good idea who else would find it useful.",
            text("share_box_more_plain"),
        )
        assertEquals("Share Tabsend", text("share_tabsend"))
        assertEquals("Read more", text("share_box_read_more"))
        assertEquals("Show less", text("share_box_show_less"))
        assertEquals("Dismiss", text("share_box_dismiss"))
        assertEquals("Help Tabsend", text("section_help_tabsend"))
        assertEquals("Rate Tabsend", text("rate_tabsend"))
        assertEquals("Something not working? Tell me", text("feedback_row"))
        assertEquals(
            "Tabsend sends a link from your computer to your phone, or the other way. https://tabsend.org",
            text("share_text_plain"),
        )
        assertEquals("contact@tabsend.org", HelpTabsend.FEEDBACK_ADDRESS)
        assertEquals("Tabsend feedback", HelpTabsend.FEEDBACK_SUBJECT)
    }

    @Test
    fun `a hosted group with no plan known yet gets no box, however old`() {
        val old = now - 400L * 24 * 60 * 60 * 1000
        assertEquals(
            null,
            InAppAsks.shareBox(now, null, true, old, 3, null, null, false, relayIsHosted = true),
        )
        assertEquals(
            ShareVariant.Plain,
            InAppAsks.shareBox(now, null, true, old, 3, null, null, false, relayIsHosted = false),
        )
    }

    @Test
    fun `only Tabsend's own relay names count as hosted`() {
        assertEquals(true, InAppAsks.isHostedRelay("https://app.tabsend.org"))
        assertEquals(true, InAppAsks.isHostedRelay("https://demo.tabsend.org/"))
        assertEquals(false, InAppAsks.isHostedRelay("https://app.tabsend.org.evil.example"))
        assertEquals(false, InAppAsks.isHostedRelay("https://relay.example.com"))
        assertEquals(false, InAppAsks.isHostedRelay(""))
    }
}
