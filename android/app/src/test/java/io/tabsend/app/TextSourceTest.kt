package io.tabsend.app

import io.tabsend.app.logic.Batched
import io.tabsend.app.logic.Feedback
import io.tabsend.app.logic.GaveUpReason
import io.tabsend.app.logic.GoneTargetCopy
import io.tabsend.app.logic.Inbox
import io.tabsend.app.logic.InboxGroup
import io.tabsend.app.logic.SendFailure
import io.tabsend.app.logic.TextSource
import io.tabsend.app.logic.relativeTime
import io.tabsend.app.wire.BatchInfo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Locale

/**
 * Plurals are the platform's job (docs/L10N.md, rule 4). The code hands the number over and takes the
 * form the language chooses; it never decides "one" or "other" itself. Two kinds of test:
 *
 *  - what the code asks for: the number reaches the plural untouched, for 0, 1, 2 and 21;
 *  - what a language answers: the same code, asked in German, French and Russian, takes each
 *    language's own category (French counts 0 as one, Russian counts 21 as one), which an
 *    `if (count == 1)` in the code could never do.
 */
class TextSourceTest {

    /** A tab that belongs to no batch; the heading only counts them. */
    private class Tab(override val batch: BatchInfo? = null) : Batched

    /** Records the plural questions the code asks. */
    private class Recorder : TextSource {
        val asked = mutableListOf<Pair<String, Int>>()
        override fun string(id: Int, vararg args: Any): String = "s$id"
        override fun plural(id: Int, quantity: Int, vararg args: Any): String {
            asked += names.getValue(id) to quantity
            return "p$id"
        }
        private val names: Map<Int, String> =
            R.plurals::class.java.fields.associate { it.getInt(null) to it.name }
    }

    @Test
    fun `the number reaches the plural untouched`() {
        for (n in listOf(0, 1, 2, 21)) {
            val rec = Recorder()
            Feedback.heldTabsHeading(rec, n)
            Feedback.recoveredLine(rec, n, null)
            Inbox.batchHeading(rec, InboxGroup("b", n, List(n) { Tab() }))
            relativeTime(rec, "2026-11-05T12:00:00.000Z", nowMs = parse("2026-11-05T12:00:00.000Z") + n * 60_000L)
            val banner = GoneTargetCopy.banner(rec, n, null, null, removedHere = false)
            assertTrue(banner.headline.isNotEmpty())
            // Every plural question was asked about the number itself.
            for ((name, quantity) in rec.asked) assertEquals(name, n, quantity)
            assertTrue("asked nothing for $n", rec.asked.isNotEmpty())
        }
    }

    @Test
    fun `the limits Tabsend states are numbers too`() {
        val rec = Recorder()
        Feedback.failureLine(rec, SendFailure.GaveUp(GaveUpReason.TOO_OLD))
        Feedback.failureLine(rec, SendFailure.GaveUp(GaveUpReason.QUEUE_FULL))
        assertEquals(
            listOf("send_failure_too_old" to 7, "send_failure_queue_full" to 200),
            rec.asked,
        )
    }

    @Test
    fun `German picks one for 1 and other for the rest`() {
        val de = XmlText(Locale.GERMANY)
        assertEquals("one", XmlText.categoryOf(Locale.GERMANY, 1))
        assertEquals("other", XmlText.categoryOf(Locale.GERMANY, 0))
        assertEquals("Waiting on this phone", Feedback.heldTabsHeading(de, 1))
        assertEquals("0 tabs waiting on this phone", Feedback.heldTabsHeading(de, 0))
        assertEquals("2 tabs waiting on this phone", Feedback.heldTabsHeading(de, 2))
    }

    @Test
    fun `French counts zero as one, which count == 1 in code would get wrong`() {
        val fr = XmlText(Locale.FRANCE)
        assertEquals("Waiting on this phone", Feedback.heldTabsHeading(fr, 0))
        assertEquals("Waiting on this phone", Feedback.heldTabsHeading(fr, 1))
        assertEquals("2 tabs waiting on this phone", Feedback.heldTabsHeading(fr, 2))
    }

    @Test
    fun `Russian has more categories than the catalog carries, and falls back to other`() {
        val ru = Locale("ru", "RU")
        assertEquals("few", XmlText.categoryOf(ru, 3))
        assertEquals("many", XmlText.categoryOf(ru, 5))
        assertEquals("one", XmlText.categoryOf(ru, 21))
        val text = XmlText(ru)
        // 21 is "one" in Russian; 3 is "few" and 5 is "many", which English has no word for.
        assertEquals("Waiting on this phone", Feedback.heldTabsHeading(text, 21))
        assertEquals("3 tabs waiting on this phone", Feedback.heldTabsHeading(text, 3))
        assertEquals("5 tabs waiting on this phone", Feedback.heldTabsHeading(text, 5))
    }

    @Test
    fun `English still reads the way it always did`() {
        assertEquals("Waiting on this phone", Feedback.heldTabsHeading(EN, 1))
        assertEquals("4 tabs waiting on this phone", Feedback.heldTabsHeading(EN, 4))
        assertEquals("Sent 4 tabs that were waiting", Feedback.recoveredLine(EN, 4))
        assertEquals("5 tabs are waiting for a new device", GoneTargetCopy.banner(EN, 5, null, null, false).headline)
        assertEquals("3m ago", relativeTime(EN, "2026-11-05T12:00:00.000Z", parse("2026-11-05T12:03:30.000Z")))
    }

    private fun parse(iso: String): Long = io.tabsend.app.logic.parseIsoMillis(iso)!!
}
