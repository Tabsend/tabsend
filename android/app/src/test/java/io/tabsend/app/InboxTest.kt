package io.tabsend.app

import io.tabsend.app.logic.Inbox
import io.tabsend.app.logic.InboxGroup
import io.tabsend.app.logic.InboxItem
import io.tabsend.app.logic.parseIsoMillis
import io.tabsend.app.logic.relativeTime
import io.tabsend.app.wire.BatchInfo
import io.tabsend.app.wire.SendPayload
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The received-tabs inbox [P-7]. Mirrors extension/src/lib/inbox.test.ts case for
 * case — the two clients must not disagree about what a batch is or what the
 * count line says.
 */
class InboxTest {

    private fun item(
        id: String,
        batch: BatchInfo? = null,
        openedAt: Long? = null,
        receivedAt: Long = 1000,
        title: String? = null,
    ) = InboxItem(
        id = id,
        url = "https://example.com/$id",
        title = title,
        sourceLabel = "Chrome · Work",
        sentAt = "2026-08-05T10:00:00.000Z",
        receivedAt = receivedAt,
        batch = batch,
        openedAt = openedAt,
    )

    /** Record a whole batch the way the drain does: one at a time, in order. */
    private fun recordAll(start: List<InboxItem>, items: List<InboxItem>): List<InboxItem> =
        items.fold(start) { acc, i -> Inbox.record(acc, i) }

    @Test
    fun `project snapshots the sender label and carries the batch`() {
        val payload = SendPayload(
            url = "https://a.test/",
            title = "Roadmap",
            sentAt = "2026-08-05T10:00:00.000Z",
            batch = BatchInfo("b1", 3),
        )
        val result = Inbox.project("m1", payload, "Firefox · Laptop", 5)
        assertEquals("Firefox · Laptop", result.sourceLabel)
        assertEquals("Roadmap", result.title)
        assertEquals(5L, result.receivedAt)
        assertEquals(BatchInfo("b1", 3), result.batch)
        assertNull(result.openedAt)
    }

    @Test
    fun `record puts the newest arrival first`() {
        val list = recordAll(emptyList(), listOf(item("a"), item("b")))
        assertEquals(listOf("b", "a"), list.map { it.id })
    }

    @Test
    fun `record is idempotent on the message id`() {
        val once = Inbox.record(emptyList(), item("a"))
        assertSame(once, Inbox.record(once, item("a")))
    }

    @Test
    fun `a re-delivery does not resurrect an opened tab as unopened`() {
        val opened = listOf(item("a", openedAt = 42))
        assertEquals(42L, Inbox.record(opened, item("a")).first().openedAt)
    }

    @Test
    fun `record drops the oldest past the cap`() {
        val many = (0 until Inbox.MAX + 10).map { item("m$it") }
        val list = recordAll(emptyList(), many)
        assertEquals(Inbox.MAX, list.size)
        assertEquals("m${Inbox.MAX + 9}", list.first().id)
        assertTrue(list.none { it.id == "m0" })
    }

    @Test
    fun `markOpened stamps the tab, once`() {
        val list = Inbox.markOpened(listOf(item("a")), "a", 99)
        assertEquals(99L, list.first().openedAt)
        // A second open keeps the FIRST time, and changes nothing.
        assertSame(list, Inbox.markOpened(list, "a", 500))
    }

    @Test
    fun `markOpened ignores an id it does not hold`() {
        val list = listOf(item("a"))
        assertSame(list, Inbox.markOpened(list, "nope", 99))
    }

    @Test
    fun `markOpened stamps a whole batch at once`() {
        val list = Inbox.markOpened(listOf(item("a"), item("b")), listOf("a", "b"), 7)
        assertEquals(listOf(7L, 7L), list.map { it.openedAt })
    }

    @Test
    fun `single sends pass through as groups of one`() {
        val groups = Inbox.group(listOf(item("a"), item("b")))
        assertEquals(2, groups.size)
        assertNull(groups.first().batchId)
    }

    @Test
    fun `a group restores the order the sender picked its tabs in`() {
        val batch = BatchInfo("b1", 3)
        val list = recordAll(
            emptyList(),
            listOf(item("one", batch), item("two", batch), item("three", batch)),
        )
        // Stored newest-first, so the raw list is reversed...
        assertEquals(listOf("three", "two", "one"), list.map { it.id })
        // ...and the group puts them back.
        assertEquals(listOf("one", "two", "three"), Inbox.group(list).first().items.map { it.id })
    }

    @Test
    fun `a batch split across drains still groups, with a later send between`() {
        val batch = BatchInfo("b1", 2)
        val list = recordAll(emptyList(), listOf(item("one", batch), item("single"), item("two", batch)))
        val groups = Inbox.group(list)
        assertEquals(2, groups.size)
        // The group holds the position of its FIRST item in the newest-first list.
        assertEquals("b1", groups[0].batchId)
        assertEquals(listOf("one", "two"), groups[0].items.map { it.id })
        assertEquals(listOf("single"), groups[1].items.map { it.id })
    }

    @Test
    fun `a group trusts the largest count any of its tabs carries`() {
        val list = listOf(item("a", BatchInfo("b", 2)), item("c", BatchInfo("b", 5)))
        assertEquals(5, Inbox.group(list).first().sentCount)
    }

    @Test
    fun `the count line admits a gap instead of quietly showing fewer`() {
        assertEquals("3 tabs", Inbox.batchHeading(InboxGroup("b", 3, listOf(item("a"), item("b"), item("c")))))
        assertEquals("2 of 3 tabs", Inbox.batchHeading(InboxGroup("b", 3, listOf(item("a"), item("b")))))
        // And it never claims fewer tabs than it is showing.
        assertEquals("2 tabs", Inbox.batchHeading(InboxGroup("b", 1, listOf(item("a"), item("b")))))
    }

    @Test
    fun `a row falls back to the host when the tab had no title`() {
        assertEquals("Roadmap", Inbox.displayTitle("Roadmap", "https://example.com/a"))
        assertEquals("example.com", Inbox.displayTitle(null, "https://example.com/a"))
        assertEquals("example.com", Inbox.displayTitle("   ", "https://example.com/a"))
    }

    @Test
    fun `hostOf hands back anything it cannot parse rather than throwing`() {
        assertEquals("example.com", Inbox.hostOf("https://example.com/deep/path?q=1"))
        assertEquals("not a url", Inbox.hostOf("not a url"))
    }

    @Test
    fun `relative time matches the wording the other clients use`() {
        val iso = "2026-08-05T10:00:00.000Z"
        val then = parseIsoMillis(iso)!!
        assertEquals("just now", relativeTime(iso, then + 30_000))
        assertEquals("3m ago", relativeTime(iso, then + 3 * 60_000))
        assertEquals("2h ago", relativeTime(iso, then + 2 * 3_600_000))
        assertEquals("5d ago", relativeTime(iso, then + 5 * 86_400_000L))
        assertEquals("unknown", relativeTime("not a date", then))
    }
}
