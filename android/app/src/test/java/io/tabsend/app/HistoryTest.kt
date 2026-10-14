package io.tabsend.app

import io.tabsend.app.logic.Delivery
import io.tabsend.app.logic.Direction
import io.tabsend.app.logic.History
import io.tabsend.app.logic.HistoryItem
import io.tabsend.app.logic.Inbox
import io.tabsend.app.logic.InboxItem
import io.tabsend.app.logic.parseIsoMillis
import io.tabsend.app.wire.BatchInfo
import io.tabsend.app.wire.GroupSealed
import io.tabsend.app.wire.HistoryEntry
import io.tabsend.app.wire.HistoryRecord
import io.tabsend.app.wire.SendPayload
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The merged group history [ADR-0028]: one timeline of what every device sent and
 * received, with the relay's delivery state on it.
 */
class HistoryTest {

    private val now = parseIsoMillis("2026-08-06T12:00:00.000Z")!!
    private val hour = 3_600_000L

    private fun item(
        id: String,
        source: String = "self",
        target: String = "phone",
        createdAt: String = "2026-08-06T11:00:00.000Z",
        expiresAt: String = "2026-08-13T11:00:00.000Z",
        ackedAt: String? = null,
        url: String? = "https://example.com/$id",
        batch: BatchInfo? = null,
    ) = HistoryItem(
        id = id,
        sourceEndpointId = source,
        targetEndpointId = target,
        createdAt = createdAt,
        expiresAt = expiresAt,
        ackedAt = ackedAt,
        url = url,
        title = if (url == null) null else "Tab $id",
        sourceLabel = if (url == null) null else "Chrome · Work",
        targetLabel = if (url == null) null else "Pixel 8",
        sentAt = if (url == null) null else createdAt,
        batch = batch,
    )

    private fun received(id: String, openedAt: Long? = null) = InboxItem(
        id = id,
        url = "https://example.com/$id",
        title = "Tab $id",
        sourceLabel = "Chrome · Work",
        sentAt = "2026-08-06T10:00:00.000Z",
        receivedAt = now,
        openedAt = openedAt,
    )

    // --- reading a relay row ---

    @Test
    fun `an opened blob fills in what the relay cannot see`() {
        val entry = HistoryEntry(
            id = "m1",
            sourceEndpointId = "self",
            targetEndpointId = "phone",
            createdAt = "2026-08-06T11:00:00.000Z",
            expiresAt = "2026-08-13T11:00:00.000Z",
            blob = GroupSealed("xsalsa20-poly1305/secretbox", "k1", "n", "c"),
        )
        val record = HistoryRecord(
            payload = SendPayload(
                url = "https://a.test/",
                title = "Roadmap",
                sentAt = "2026-08-06T10:59:00.000Z",
                batch = BatchInfo("b1", 3),
            ),
            sourceLabelAtSend = "Chrome · Work",
            targetLabelAtSend = "Pixel 8",
        )
        val projected = History.project(entry, record)
        assertEquals("https://a.test/", projected.url)
        assertEquals("Chrome · Work", projected.sourceLabel)
        assertEquals("Pixel 8", projected.targetLabel)
        assertEquals(BatchInfo("b1", 3), projected.batch)
    }

    @Test
    fun `a row whose key is missing is kept, as a record with no content`() {
        val entry = HistoryEntry(
            id = "m1",
            sourceEndpointId = "desk",
            targetEndpointId = "phone",
            createdAt = "2026-08-06T11:00:00.000Z",
            expiresAt = "2026-08-13T11:00:00.000Z",
            ackedAt = "2026-08-06T11:00:05.000Z",
            blob = GroupSealed("xsalsa20-poly1305/secretbox", "gone", "n", "c"),
        )
        val projected = History.project(entry, null)
        assertNull(projected.url)
        assertNull(projected.sourceLabel)
        // The routing facts survive, which is the whole reason to keep the row.
        assertEquals("desk", projected.sourceEndpointId)
        assertEquals("2026-08-06T11:00:05.000Z", projected.ackedAt)
    }

    // --- delivery state ---

    @Test
    fun `an ack is the only proof of arrival`() {
        assertEquals(
            Delivery.ARRIVED,
            History.delivery(item("m", ackedAt = "2026-08-06T11:00:01.000Z"), now),
        )
    }

    @Test
    fun `unacked but not yet expired is still waiting, which is normal for a sleeping phone`() {
        assertEquals(Delivery.WAITING, History.delivery(item("m"), now))
    }

    @Test
    fun `unacked past expiry is a verdict, not a delay`() {
        val expired = item("m", expiresAt = "2026-08-06T11:59:00.000Z")
        assertEquals(Delivery.NEVER_ARRIVED, History.delivery(expired, now))
    }

    @Test
    fun `an ack past expiry still counts as arrived`() {
        val late = item("m", expiresAt = "2026-08-06T11:59:00.000Z", ackedAt = "2026-08-06T11:58:00.000Z")
        assertEquals(Delivery.ARRIVED, History.delivery(late, now))
    }

    // --- direction ---

    @Test
    fun `direction names which end this phone was, including neither`() {
        assertEquals(Direction.SENT, History.direction(item("m", source = "self"), "self"))
        // Both ends must be named: item()'s source defaults to "self", so passing
        // only a target built a self-to-self row, which is SENT by precedence.
        assertEquals(
            Direction.RECEIVED,
            History.direction(item("m", source = "desk", target = "self"), "self"),
        )
        assertEquals(
            Direction.ELSEWHERE,
            History.direction(item("m", source = "desk", target = "phone"), "self"),
        )
    }

    // --- the cache ---

    @Test
    fun `the cache keeps the newest, capped`() {
        val many = (0 until History.MAX + 10).map {
            item("m$it", createdAt = "2026-08-06T${"%02d".format(it % 24)}:00:00.000Z")
        }
        assertEquals(History.MAX, History.cache(many).size)
    }

    @Test
    fun `the relay is the authority, so a later row for the same id wins`() {
        val stale = item("m1")
        val acked = item("m1", ackedAt = "2026-08-06T11:00:05.000Z")
        val cached = History.cache(listOf(stale, acked))
        assertEquals(1, cached.size)
        assertEquals("2026-08-06T11:00:05.000Z", cached.first().ackedAt)
    }

    // --- the merged timeline ---

    @Test
    fun `sent and received land in one timeline, newest first`() {
        val rows = History.rows(
            listOf(
                item("m1", source = "self", createdAt = "2026-08-06T09:00:00.000Z"),
                item("m2", source = "desk", target = "self", createdAt = "2026-08-06T11:00:00.000Z"),
            ),
            emptyList(),
            "self",
            now,
        )
        assertEquals(listOf("m2", "m1"), rows.map { it.id })
        assertEquals(Direction.RECEIVED, rows[0].direction)
        assertEquals(Direction.SENT, rows[1].direction)
    }

    @Test
    fun `a received tab with no relay row of its own is still listed`() {
        // A sender predating ADR-0028 attaches no blob, so the relay has nothing
        // to return — but the tab did arrive, and this phone recorded it.
        val rows = History.rows(emptyList(), listOf(received("old")), "self", now)
        assertEquals(listOf("old"), rows.map { it.id })
        assertEquals(Direction.RECEIVED, rows.first().direction)
        assertEquals(Delivery.ARRIVED, rows.first().delivery)
    }

    @Test
    fun `a relay row borrows the one fact only this phone knows`() {
        // The relay is never told that the user opened the link.
        val rows = History.rows(
            listOf(item("m1", source = "desk", target = "self")),
            listOf(received("m1", openedAt = 42L)),
            "self",
            now,
        )
        assertEquals(1, rows.size)
        assertEquals(42L, rows.first().openedAt)
    }

    @Test
    fun `an unreadable row reports itself as such rather than pretending`() {
        val rows = History.rows(listOf(item("m1", url = null)), emptyList(), "self", now)
        assertFalse(rows.first().readable)
        assertNull(History.displayTitle(rows.first()))
    }

    @Test
    fun `a readable row names the tab`() {
        val rows = History.rows(listOf(item("m1")), emptyList(), "self", now)
        assertEquals("Tab m1", History.displayTitle(rows.first()))
    }

    @Test
    fun `the merged timeline still groups a batch and admits a gap`() {
        val batch = BatchInfo("b1", 3)
        val rows = History.rows(
            listOf(
                item("m1", createdAt = "2026-08-06T11:00:00.000Z", batch = batch),
                item("m2", createdAt = "2026-08-06T11:00:01.000Z", batch = batch),
            ),
            emptyList(),
            "self",
            now,
        )
        val groups = Inbox.group(rows)
        assertEquals(1, groups.size)
        assertEquals("2 of 3 tabs", Inbox.batchHeading(groups.first()))
    }

    // --- the never-arrived announcement ---

    @Test
    fun `only this phone's own failed sends are announced, and only once`() {
        val expired = "2026-08-06T11:59:00.000Z"
        val rows = History.rows(
            listOf(
                item("mine", source = "self", expiresAt = expired),
                item("theirs", source = "desk", target = "phone", expiresAt = expired),
                item("fine", source = "self", ackedAt = "2026-08-06T11:00:01.000Z"),
            ),
            emptyList(),
            "self",
            now,
        )
        val fresh = History.unannouncedNeverArrived(rows, emptyList())
        assertEquals(listOf("mine"), fresh.map { it.id })
        // And a second wake says nothing.
        assertTrue(History.unannouncedNeverArrived(rows, listOf("mine")).isEmpty())
    }

    @Test
    fun `the announced list is bounded but never forgets a row still on screen`() {
        val remembered = History.rememberAnnounced(listOf("old"), listOf("new"))
        assertEquals(listOf("new", "old"), remembered)
        val many = (0 until 500).map { "m$it" }
        assertEquals(History.MAX * 2, History.rememberAnnounced(emptyList(), many).size)
    }

    @Test
    fun `a tab still waiting is not announced as lost`() {
        val rows = History.rows(listOf(item("m1", source = "self")), emptyList(), "self", now - hour)
        assertTrue(History.unannouncedNeverArrived(rows, emptyList()).isEmpty())
    }
}
