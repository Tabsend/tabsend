package io.tabsend.app

import io.tabsend.app.logic.Chooser
import io.tabsend.app.logic.Feedback
import io.tabsend.app.logic.Labels
import io.tabsend.app.logic.Mru
import io.tabsend.app.logic.Pairing
import io.tabsend.app.logic.SeenSet
import io.tabsend.app.logic.ShortcutPlan
import io.tabsend.app.logic.SourcePrefs
import io.tabsend.app.logic.parseIsoMillis
import io.tabsend.app.wire.Endpoint
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class LogicTest {
    private fun ep(
        id: String,
        label: String = id,
        kind: String = "extension",
        presence: String = "online",
        lastSeenAt: String = "2026-07-18T12:00:00.000Z",
    ) = Endpoint(
        id = id,
        groupId = "g",
        kind = kind,
        browser = "chrome",
        platform = "macos",
        label = label,
        e2ePubkey = "pk-$id",
        presence = presence,
        lastSeenAt = lastSeenAt,
        createdAt = "2026-07-01T00:00:00.000Z",
    )

    // --- MRU -----------------------------------------------------------------

    @Test
    fun `recordSend moves target to MRU head and tracks primary when unpinned`() {
        var prefs = SourcePrefs()
        prefs = Mru.recordSend(prefs, "b")
        prefs = Mru.recordSend(prefs, "a")
        assertEquals(listOf("a", "b"), prefs.recentTargetIds)
        assertEquals("a", prefs.primaryTargetId)
    }

    @Test
    fun `recordSend keeps a pinned primary put`() {
        val prefs = SourcePrefs(primaryTargetId = "pinned", primaryPinned = true)
        val after = Mru.recordSend(prefs, "other")
        assertEquals("pinned", after.primaryTargetId)
        assertEquals(listOf("other"), after.recentTargetIds)
    }

    @Test
    fun `recordSend dedupes and caps the MRU`() {
        var prefs = SourcePrefs()
        repeat(30) { prefs = Mru.recordSend(prefs, "t$it") }
        prefs = Mru.recordSend(prefs, "t0")
        assertEquals("t0", prefs.recentTargetIds.first())
        assertTrue(prefs.recentTargetIds.size <= Mru.MAX_RECENTS)
        assertEquals(prefs.recentTargetIds.toSet().size, prefs.recentTargetIds.size)
    }

    // --- Chooser -------------------------------------------------------------

    @Test
    fun `chooser excludes self and console, orders primary then recents then rest`() {
        val endpoints = listOf(
            ep("self"),
            ep("console1", kind = "console"),
            ep("zebra", label = "Zebra"),
            ep("apple", label = "Apple"),
            ep("primary", label = "Primary"),
            ep("recent", label = "Recent"),
        )
        val prefs = SourcePrefs(primaryTargetId = "primary", recentTargetIds = listOf("recent"))
        val rows = Chooser.build(endpoints, selfEndpointId = "self", prefs = prefs, nowMs = ms("2026-07-18T12:00:00.000Z"))

        assertEquals(listOf("primary", "recent", "apple", "zebra"), rows.map { it.endpoint.id })
        assertFalse(rows.any { it.endpoint.id == "self" || it.endpoint.kind == "console" })
        assertTrue(rows.first { it.endpoint.id == "primary" }.isPrimary)
    }

    @Test
    fun `chooser marks an old offline endpoint stale but still lists it`() {
        val endpoints = listOf(
            ep("self"),
            ep("old", presence = "offline", lastSeenAt = "2026-01-01T00:00:00.000Z"),
        )
        val rows = Chooser.build(endpoints, "self", SourcePrefs(), ms("2026-07-18T12:00:00.000Z"))
        assertEquals(1, rows.size)
        assertTrue(rows.first().stale)
        assertFalse(rows.first().online)
    }

    @Test
    fun `chooser keeps presence while the snapshot is recent`() {
        val now = ms("2026-07-18T12:00:00.000Z")
        val endpoints = listOf(ep("self"), ep("other", presence = "online"))
        val rows = Chooser.build(endpoints, "self", SourcePrefs(), now, fetchedAtMs = now - 30_000)
        assertTrue(rows.first().presenceKnown)
        assertTrue(rows.first().online)
    }

    // A relay that has not answered in two hours cannot vouch for anyone being
    // online; the row says unknown rather than repeating the last green dot.
    @Test
    fun `chooser drops presence once the snapshot outlives the online window`() {
        val now = ms("2026-07-18T12:00:00.000Z")
        val endpoints = listOf(ep("self"), ep("other", presence = "online"))
        val rows = Chooser.build(endpoints, "self", SourcePrefs(), now, fetchedAtMs = now - 2 * 60 * 60 * 1000)
        assertFalse(rows.first().presenceKnown)
        assertFalse(rows.first().online)
    }

    // A cache written before the timestamp existed. Unknown is the safe reading.
    @Test
    fun `chooser treats a missing snapshot time as unknown`() {
        val now = ms("2026-07-18T12:00:00.000Z")
        val rows = Chooser.build(listOf(ep("self"), ep("other", presence = "online")), "self", SourcePrefs(), now, fetchedAtMs = 0L)
        assertFalse(rows.first().presenceKnown)
    }

    // --- Sharing Shortcuts (Direct Share) ------------------------------------

    @Test
    fun `shortcut plan is the chooser order, truncated and ranked`() {
        val endpoints = listOf(
            ep("self"),
            ep("console1", kind = "console"),
            ep("zebra", label = "Zebra"),
            ep("apple", label = "Apple"),
            ep("primary", label = "Primary"),
            ep("recent", label = "Recent"),
        )
        val prefs = SourcePrefs(primaryTargetId = "primary", recentTargetIds = listOf("recent"))
        val rows = Chooser.build(endpoints, "self", prefs, ms("2026-07-18T12:00:00.000Z"))

        val plan = ShortcutPlan.build(rows, max = 3)
        assertEquals(listOf("primary", "recent", "apple"), plan.map { it.endpointId })
        assertEquals(listOf("Primary", "Recent", "Apple"), plan.map { it.label })
        // Rank is the position, so the sheet agrees with the chooser about the top.
        assertEquals(listOf(0, 1, 2), plan.map { it.rank })
    }

    @Test
    fun `shortcut plan gives no slot to a stale endpoint`() {
        val endpoints = listOf(
            ep("self"),
            // Alphabetically first, so only the staleness filter can demote it.
            ep("abandoned", label = "Abandoned", presence = "offline", lastSeenAt = "2026-01-01T00:00:00.000Z"),
            ep("live", label = "Live"),
        )
        val rows = Chooser.build(endpoints, "self", SourcePrefs(), ms("2026-07-18T12:00:00.000Z"))
        assertEquals(2, rows.size) // still selectable in the chooser (ADR-0001)

        val plan = ShortcutPlan.build(rows)
        assertEquals(listOf("live"), plan.map { it.endpointId })
    }

    @Test
    fun `shortcut plan carries kind through and copes with no room`() {
        val rows = Chooser.build(
            listOf(ep("self"), ep("phone", label = "Pixel", kind = "mobile")),
            "self", SourcePrefs(), ms("2026-07-18T12:00:00.000Z"),
        )
        assertEquals("mobile", ShortcutPlan.build(rows).single().kind)
        // A launcher reporting zero slots must yield an empty publish, not a crash.
        assertTrue(ShortcutPlan.build(rows, max = 0).isEmpty())
    }

    @Test
    fun `shortcut ids round-trip and reject ids that aren't ours`() {
        val id = ShortcutPlan.shortcutIdFor("ep-42")
        assertEquals("ep-42", ShortcutPlan.endpointIdOf(id))
        // A share with no shortcut, or another app's, must take the chooser path
        // rather than resolve to some endpoint.
        assertNull(ShortcutPlan.endpointIdOf(null))
        assertNull(ShortcutPlan.endpointIdOf("ep-42"))
        assertNull(ShortcutPlan.endpointIdOf("conversation:ep-42"))
        assertNull(ShortcutPlan.endpointIdOf(ShortcutPlan.shortcutIdFor("")))
    }

    // --- SeenSet -------------------------------------------------------------

    @Test
    fun `seen-set is idempotent and prunes by age`() {
        val now = SeenSet.RETENTION_MS + 10_000
        var seen = SeenSet.add(emptyList(), "m1", now) // recent
        seen = SeenSet.add(seen, "m1", now + 1) // no dup
        assertEquals(1, seen.size)
        assertTrue(SeenSet.has(seen, "m1"))

        seen = SeenSet.add(seen, "m2", 0) // ancient
        val pruned = SeenSet.prune(seen, now)
        assertFalse(SeenSet.has(pruned, "m2")) // aged out
        assertTrue(SeenSet.has(pruned, "m1")) // still fresh
    }

    // --- Labels --------------------------------------------------------------

    @Test
    fun `default label prefers the consumer-facing settings device name`() {
        assertEquals("Galaxy S24", Labels.defaultDeviceLabel("Galaxy S24", "samsung", "SM-S921B"))
        assertEquals("Ben's phone", Labels.defaultDeviceLabel("Ben's phone", "Google", "Pixel 8"))
    }

    @Test
    fun `default label falls back to make plus model with no OS prefix`() {
        assertEquals("Google Pixel 8", Labels.defaultDeviceLabel(null, "Google", "Pixel 8"))
        assertEquals("Samsung SM-S921B", Labels.defaultDeviceLabel("  ", "samsung", "SM-S921B"))
        // Model already names the maker — don't double it.
        assertEquals("OnePlus 9", Labels.defaultDeviceLabel(null, "OnePlus", "OnePlus 9"))
        assertEquals("Phone", Labels.defaultDeviceLabel(null, null, null))
    }

    // --- Pairing QR scans ----------------------------------------------------

    @Test
    fun `pairing link yields its internal secret and relay`() {
        val parsed = Pairing.parse("https://relay.example/pair#c=abc12345")!!
        assertEquals("ABC12345", parsed.code)
        assertEquals("https://relay.example", parsed.relayUrl)
    }

    @Test
    fun `pairing link with fp param yields code, relay, and pin`() {
        val parsed = Pairing.parse("https://192.168.1.20:8787/pair#c=ABC123&fp=QUJDREVGR0hJSktMTU5PUA")!!
        assertEquals("ABC123", parsed.code)
        assertEquals("https://192.168.1.20:8787", parsed.relayUrl)
        assertEquals("QUJDREVGR0hJSktMTU5PUA", parsed.certFingerprint)
    }

    @Test
    fun `native route hint corrects a browser link with custom ports`() {
        val parsed = Pairing.parse(
            "http://relay.lan:9080/pair#c=ABC123&fp=PIN&native=https%3A%2F%2Frelay.lan%3A9443",
        )!!
        assertEquals("https://relay.lan:9443", parsed.relayUrl)
        assertEquals("PIN", parsed.certFingerprint)
    }

    @Test
    fun `legacy default browser port is corrected for native pairing`() {
        val parsed = Pairing.parse("http://192.168.1.20:8786/pair#c=ABC123&fp=PIN")!!
        assertEquals("https://192.168.1.20:8787", parsed.relayUrl)
    }

    @Test
    fun `pairing link without fp has null pin, unknown params are ignored`() {
        val plain = Pairing.parse("https://relay.example/pair#c=ABC12345")!!
        assertEquals("ABC12345", plain.code)
        assertEquals(null, plain.certFingerprint)

        val future = Pairing.parse("https://relay.example/pair#c=ABC123&x=1&fp=PIN&y=2")!!
        assertEquals("ABC123", future.code)
        assertEquals("PIN", future.certFingerprint)
    }

    @Test
    fun `bare secret is rejected because it carries no relay or trust pin`() {
        assertEquals(null, Pairing.parse("abc12345"))
    }

    @Test
    fun `scanner preserves the complete pinned link for the join handoff`() {
        val link = "https://relay.example/pair#c=abc123&fp=SOMEPIN"
        assertEquals(link, Pairing.scannedLink(link))
        val parsed = Pairing.parse(Pairing.scannedLink(link)!!)!!
        assertEquals("ABC123", parsed.code)
        assertEquals("SOMEPIN", parsed.certFingerprint)
        assertEquals(null, Pairing.scannedLink("https://example.com/menu"))
    }

    @Test
    fun `scanner rejects standalone secrets and unrelated QR content`() {
        assertEquals(null, Pairing.scannedLink("ABC12345"))
        assertEquals(null, Pairing.scannedLink("https://example.com/menu"))
        assertEquals(null, Pairing.scannedLink("WIFI:S:HomeNet;T:WPA;P:hunter2;;"))
    }

    // --- Feedback copy (§4 table; the failure lines live in SendFeedbackTest) --

    @Test
    fun `feedback lines match the copy rules`() {
        assertEquals("Sent to Pixel 8", Feedback.sentOnline("Pixel 8"))
        assertEquals("Sent to Pixel 8 — opens when it wakes", Feedback.sentOffline("Pixel 8"))
        assertEquals("No connection — will send when you're back online", Feedback.sourceOffline())
        assertEquals("Couldn't send — check Tabsend is still linked", Feedback.hardError())
    }

    private fun ms(iso: String): Long = parseIsoMillis(iso)!!
}
