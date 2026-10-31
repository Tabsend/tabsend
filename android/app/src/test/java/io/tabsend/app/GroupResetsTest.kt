package io.tabsend.app

import io.tabsend.app.logic.GroupResetRecord
import io.tabsend.app.logic.GroupResets
import io.tabsend.app.receive.GroupResetWatcher
import io.tabsend.app.store.Registration
import io.tabsend.app.store.Store
import io.tabsend.app.wire.GroupResetState
import io.tabsend.app.wire.GroupStateResponse
import io.tabsend.app.wire.WireJson
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test
import java.io.IOException
import java.time.ZoneId

/** The reset that waits (PLANS.md P-18 item 12): which reset to alert about and show. */
class GroupResetsTest {

    private val first = GroupResetState("2026-10-27T14:00:00.000Z", "2026-10-30T14:00:00.000Z")
    private val second = GroupResetState("2026-11-02T09:30:00.000Z", "2026-11-05T09:30:00.000Z")

    // --- observe: alert once per reset ---------------------------------------

    @Test
    fun `a new reset is alerted and shown`() {
        val o = GroupResets.observe(null, "me", first)
        assertEquals(first, o.notify)
        assertEquals(first, GroupResets.toShow(o.record, "me"))
    }

    @Test
    fun `the same reset is never alerted twice`() {
        val once = GroupResets.observe(null, "me", first).record
        val again = GroupResets.observe(once, "me", first)
        assertNull(again.notify)
        assertEquals(first, GroupResets.toShow(again.record, "me"))
    }

    @Test
    fun `a stopped reset hides the card, and a later one alerts again`() {
        val seen = GroupResets.observe(null, "me", first).record
        val stopped = GroupResets.observe(seen, "me", null)
        assertNull(stopped.notify)
        assertNull(GroupResets.toShow(stopped.record, "me"))
        // Coming back with the same request (a relay that flickered) does not alert again.
        assertNull(GroupResets.observe(stopped.record, "me", first).notify)
        // A new request does.
        val later = GroupResets.observe(stopped.record, "me", second)
        assertEquals(second, later.notify)
        assertEquals(second, GroupResets.toShow(later.record, "me"))
    }

    @Test
    fun `It was me hides that reset only`() {
        val seen = GroupResets.observe(null, "me", first).record
        val dismissed = GroupResets.dismiss(seen, first.requestedAt)
        assertNull(GroupResets.toShow(dismissed, "me"))
        // Still pending on the relay: stays hidden, no new alert.
        val again = GroupResets.observe(dismissed, "me", first)
        assertNull(again.notify)
        assertNull(GroupResets.toShow(again.record, "me"))
        // A new reset shows and alerts.
        val next = GroupResets.observe(again.record, "me", second)
        assertEquals(second, next.notify)
        assertEquals(second, GroupResets.toShow(next.record, "me"))
    }

    @Test
    fun `a reset dismissed before it was alerted is not alerted`() {
        val record = GroupResetRecord(selfId = "me", dismissed = first.requestedAt)
        assertNull(GroupResets.observe(record, "me", first).notify)
    }

    @Test
    fun `a record from another pairing is ignored`() {
        val other = GroupResetRecord(selfId = "old", reset = first, notified = first.requestedAt, dismissed = first.requestedAt)
        assertNull(GroupResets.toShow(other, "me"))
        assertNull(GroupResets.toShow(other, null))
        val o = GroupResets.observe(other, "me", first)
        assertEquals(first, o.notify)
        assertEquals("me", o.record.selfId)
        assertEquals(first, GroupResets.toShow(o.record, "me"))
    }

    // --- the wire ------------------------------------------------------------

    @Test
    fun `the group state parses with a reset, with null, and with nothing`() {
        val with = WireJson.decodeFromString(
            GroupStateResponse.serializer(),
            """{"reset":{"requestedAt":"2026-10-27T14:00:00.000Z","resetsAt":"2026-10-30T14:00:00.000Z"},"later":1}""",
        )
        assertEquals(first, with.reset)
        assertNull(WireJson.decodeFromString(GroupStateResponse.serializer(), """{"reset":null}""").reset)
        assertNull(WireJson.decodeFromString(GroupStateResponse.serializer(), "{}").reset)
    }

    // --- dates in the phone's own time zone ----------------------------------

    @Test
    fun `days and times are written in the phone's time zone`() {
        val chicago = ZoneId.of("America/Chicago")
        assertEquals("October 27", GroupResets.day(first.requestedAt, chicago))
        assertEquals("October 30", GroupResets.day(first.resetsAt, chicago))
        assertEquals("9:00 AM", GroupResets.time(first.resetsAt, chicago))

        val berlin = ZoneId.of("Europe/Berlin")
        assertEquals("3:00 PM", GroupResets.time(first.resetsAt, berlin))
        // Late in the day in UTC is already tomorrow further east.
        val tokyo = ZoneId.of("Asia/Tokyo")
        assertEquals("October 31", GroupResets.day("2026-10-30T20:15:00.000Z", tokyo))
        assertEquals("5:15 AM", GroupResets.time("2026-10-30T20:15:00.000Z", tokyo))
    }

    @Test
    fun `a time that does not parse gives no words rather than wrong ones`() {
        val utc = ZoneId.of("UTC")
        assertNull(GroupResets.day("soon", utc))
        assertNull(GroupResets.time("", utc))
    }

    // --- the record on the phone ---------------------------------------------

    private fun pairedStore(): Store = Store.over(MemoryPrefs()).apply {
        registration = Registration(
            endpointId = "me",
            groupId = "g",
            deviceToken = "t",
            relayUrl = "https://relay.example",
            label = "Pixel 8",
        )
    }

    @Test
    fun `the record survives the store, alerts once, and clears with the pairing`() {
        val store = pairedStore()
        assertEquals(first, GroupResetWatcher.record(store, "me", first))
        assertNull(GroupResetWatcher.record(store, "me", first))
        assertEquals(first, GroupResetWatcher.pending(store))

        GroupResetWatcher.dismiss(store, first.requestedAt)
        assertNull(GroupResetWatcher.pending(store))

        store.clear()
        assertNull(store.groupReset)
    }

    @Test
    fun `a stop the relay accepted clears the card`() {
        val store = pairedStore()
        GroupResetWatcher.record(store, "me", first)
        GroupResetWatcher.stop(store) { /* the relay said {reset:null} */ }
        assertNull(GroupResetWatcher.pending(store))
        // The alert for it is not repeated if a stale answer brings it back.
        assertNull(GroupResetWatcher.record(store, "me", first))
    }

    @Test
    fun `a stop that failed keeps the card`() {
        val store = pairedStore()
        GroupResetWatcher.record(store, "me", first)
        assertThrows(IOException::class.java) {
            GroupResetWatcher.stop(store) { throw IOException("offline") }
        }
        assertEquals(first, GroupResetWatcher.pending(store))
    }
}
