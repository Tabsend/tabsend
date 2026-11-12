package io.tabsend.app

import io.tabsend.app.logic.Replacing
import io.tabsend.app.logic.parseIsoMillis
import io.tabsend.app.net.ApiException
import io.tabsend.app.wire.Endpoint
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.io.IOException

/**
 * "Is this phone replacing …?" (PLANS.md P-31 item 2). Runs every case in
 * `shared/vectors/replacing-devices.json`, the same file the TypeScript and iOS tests
 * run, so the three rules cannot drift (SECURITY_REVIEW L6); then the order of
 * Replace's steps, and the activity's wiring of them.
 */
class ReplacingTest {

    @Serializable
    private data class ListEntry(
        val id: String,
        val label: String,
        val kind: String,
        val presence: String,
        val lastSeenAt: String,
        val createdAt: String,
    )

    @Serializable
    private data class Case(
        val name: String,
        val selfId: String,
        val removed: List<String>,
        val now: String,
        val list: List<ListEntry>,
        val expect: String?,
    )

    @Serializable
    private data class Vectors(val cases: List<Case>)

    private val vectors: Vectors by lazy {
        Json { ignoreUnknownKeys = true }.decodeFromString(Vectors.serializer(), vectorFile().readText())
    }

    /** Walk up from wherever Gradle runs the test until the shared vector is found. */
    private fun vectorFile(): File {
        var dir: File? = File("").absoluteFile
        while (dir != null) {
            val candidate = File(dir, "shared/vectors/replacing-devices.json")
            if (candidate.isFile) return candidate
            dir = dir.parentFile
        }
        error("shared/vectors/replacing-devices.json not found above ${File("").absolutePath}")
    }

    /** The rule reads id, label, kind, presence, lastSeenAt and createdAt; the rest is a fixture. */
    private fun ListEntry.endpoint() = Endpoint(
        id = id,
        groupId = "g",
        kind = kind,
        platform = "test",
        label = label,
        e2ePubkey = "pk",
        presence = presence,
        lastSeenAt = lastSeenAt,
        createdAt = createdAt,
    )

    @Test
    fun `every shared case gives the expected entry`() {
        assertTrue(vectors.cases.size > 30)
        for (c in vectors.cases) {
            val now = parseIsoMillis(c.now) ?: error("bad now in ${c.name}")
            val got = Replacing.findReplacedSelf(c.selfId, c.list.map { it.endpoint() }, c.removed, now)
            assertEquals(c.name, c.expect, got?.id)
        }
    }

    @Test
    fun `lowercases ASCII only and collapses ASCII spaces`() {
        assertEquals("dia 2", Replacing.normalizeName("  Dia\t2 \n"))
        assertEquals("ÄΣ", Replacing.normalizeName("ÄΣ"))
        // A no-break space is not an ASCII space: kept as it is.
        assertEquals("a b", Replacing.normalizeName("A B"))
    }

    @Test
    fun `strips only the counter the relay writes`() {
        assertEquals("dia", Replacing.withoutCounter("dia 2"))
        assertEquals("dia", Replacing.withoutCounter("dia 99"))
        assertEquals("dia 1", Replacing.withoutCounter("dia 1"))
        assertEquals("dia 02", Replacing.withoutCounter("dia 02"))
        assertEquals("dia 100", Replacing.withoutCounter("dia 100"))
        assertEquals("7", Replacing.withoutCounter("7"))
    }

    @Test
    fun `reads only canonical times`() {
        assertEquals(parseIsoMillis("2026-10-30T08:00:00.000Z"), Replacing.strictIsoMillis("2026-10-30T08:00:00.000Z"))
        assertNull(Replacing.strictIsoMillis("2026-10-30T08:00:00Z"))
        assertNull(Replacing.strictIsoMillis("2026-02-30T08:00:00.000Z"))
        assertNull(Replacing.strictIsoMillis("2026-10-30T08:00:00.000Z\n"))
    }

    @Test
    fun `names the app half for the button`() {
        assertEquals("Dia", Replacing.appNameOf("Dia · MacBook Pro"))
        assertEquals("Pixel 8", Replacing.appNameOf("Pixel 8"))
    }

    // --- Replace's steps ---------------------------------------------------------

    private val now = parseIsoMillis("2026-11-09T12:00:00.000Z")!!

    private fun ep(id: String, label: String, presence: String, lastSeenAt: String, createdAt: String) =
        Endpoint(id, "g", "mobile", null, "android", label, "pk", presence, lastSeenAt, createdAt)

    // The relay's dedupe continues a name's own number: a second "Pixel 8" is "Pixel 9".
    private val self = ep("me", "Pixel 9", "online", "2026-11-09T11:59:00.000Z", "2026-11-09T11:50:00.000Z")
    private val old = ep("old", "Pixel 8", "offline", "2026-10-30T08:00:00.000Z", "2026-08-01T10:00:00.000Z")

    /** Every call the steps make, in order. */
    private class Calls {
        val log = mutableListOf<String>()
    }

    private suspend fun run(
        calls: Calls,
        list: List<Endpoint> = listOf(self, old),
        listFails: Boolean = false,
        removeFails: IOException? = null,
        renameFails: Boolean = false,
    ): Replacing.Outcome = Replacing.replace(
        selfId = "me",
        oldId = "old",
        nowMs = { now },
        list = {
            calls.log += "list"
            if (listFails) throw IOException("offline")
            list
        },
        removed = { emptyList() },
        remove = { id ->
            calls.log += "remove $id"
            removeFails?.let { throw it }
        },
        rename = { label ->
            calls.log += "rename $label"
            if (renameFails) throw IOException("offline")
        },
    )

    @Test
    fun `replace looks again, removes the old entry, then takes its exact name`() = runTest {
        val calls = Calls()
        assertEquals(Replacing.Outcome.Replaced, run(calls))
        assertEquals(listOf("list", "remove old", "rename Pixel 8"), calls.log)
    }

    @Test
    fun `a refused or unreachable removal renames nothing`() = runTest {
        for (failure in listOf(ApiException(500, "internal", "x"), IOException("offline"))) {
            val calls = Calls()
            val outcome = run(calls, removeFails = failure)
            assertTrue(outcome is Replacing.Outcome.RemoveFailed)
            assertEquals(listOf("list", "remove old"), calls.log)
        }
    }

    @Test
    fun `a list that no longer offers the same entry does nothing`() = runTest {
        // Back online since the offer.
        val calls = Calls()
        assertEquals(Replacing.Outcome.NoLongerOffered, run(calls, list = listOf(self, old.copy(presence = "online"))))
        assertEquals(listOf("list"), calls.log)
        // Gone from the list.
        val gone = Calls()
        assertEquals(Replacing.Outcome.NoLongerOffered, run(gone, list = listOf(self)))
        assertEquals(listOf("list"), gone.log)
        // Another, newer copy is now the match.
        val other = old.copy(id = "older2", lastSeenAt = "2026-11-01T08:00:00.000Z")
        val moved = Calls()
        assertEquals(Replacing.Outcome.NoLongerOffered, run(moved, list = listOf(self, old, other)))
        assertEquals(listOf("list"), moved.log)
    }

    @Test
    fun `a list that cannot be fetched does nothing`() = runTest {
        val calls = Calls()
        assertTrue(run(calls, listFails = true) is Replacing.Outcome.ListFailed)
        assertEquals(listOf("list"), calls.log)
    }

    @Test
    fun `a rename that fails after the removal says so`() = runTest {
        val calls = Calls()
        assertTrue(run(calls, renameFails = true) is Replacing.Outcome.RenameFailed)
        assertEquals(listOf("list", "remove old", "rename Pixel 8"), calls.log)
    }

    // --- the activity's wiring, read as written (like RemoveWiringTest) ---------

    private fun sourceRoot(): File =
        listOf(File("src/main"), File("app/src/main"), File("android/app/src/main"))
            .first { it.isDirectory }

    private val activity: String by lazy {
        File(sourceRoot(), "java/io/tabsend/app/ui/MainActivity.kt").readText()
    }

    private fun body(signature: String): String {
        val start = activity.indexOf(signature)
        assertTrue("$signature not found", start >= 0)
        val next = Regex("""\n    (private |override |internal )?fun """).find(activity, start + signature.length)
        return activity.substring(start, next?.range?.first ?: activity.length)
    }

    @Test
    fun `Replace uses the device row's Remove and rename, and accepts nothing`() {
        val replace = body("private fun replaceOldCopy(")
        assertTrue(replace.contains("Replacing.replace("))
        assertTrue(replace.contains("remove = { id -> removeFromGroup(reg, id) }"))
        // The device row's Remove goes through the same function, which records the removal.
        assertTrue(body("private fun removeDevice(").contains("removeFromGroup(reg, endpointId)"))
        assertTrue(body("private suspend fun removeFromGroup(").contains("NewDeviceWatcher.removeFromGroup(store, endpointId)"))
        assertTrue(replace.contains("Registrar.rename(this@MainActivity, reg.endpointId, label)"))
        val offer = body("private fun offerReplace(")
        // The withdrawn offer's high bug (L1) was answering for a device. No call here
        // confirms, accepts or dismisses anything about any device.
        val answers = Regex("""\.(confirm|confirmReview|accept|dismissVanished)\(""")
        for (code in listOf(replace, offer)) assertFalse(answers.containsMatchIn(code))
    }

    @Test
    fun `the offer is asked only after this phone's own pairing`() {
        // Set in one place, the pairing's success, and spent by the first device list.
        assertEquals(1, Regex("""replaceOfferPending = true""").findAll(activity).count())
        assertTrue(body("private fun pair(").contains("replaceOfferPending = true"))
        val load = body("private fun loadDevices(")
        assertTrue(load.contains("replaceOfferPending = false"))
        assertTrue(load.contains("if (fetched) offerReplace(endpoints, reg)"))
        // Its definition and that one call, nothing else.
        assertEquals(2, Regex("""\bofferReplace\(""").findAll(activity).count())
    }
}
