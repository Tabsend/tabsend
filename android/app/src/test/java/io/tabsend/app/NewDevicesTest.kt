package io.tabsend.app

import io.tabsend.app.logic.NewDeviceNotice
import io.tabsend.app.logic.NewDeviceWatch
import io.tabsend.app.logic.NewDevices
import io.tabsend.app.receive.NewDeviceWatcher
import io.tabsend.app.store.Registration
import io.tabsend.app.store.Store
import io.tabsend.app.wire.Endpoint
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Runs every case in `shared/vectors/new-devices.json` (PLANS.md P-10), the same
 * file the extension's and iOS's tests run, so the three rules cannot drift.
 */
class NewDevicesTest {

    @Serializable
    private data class ListEntry(
        val id: String,
        val label: String,
        val createdAt: String,
        val e2ePubkey: String = "pk",
        val kind: String = "extension",
        val lastSeenAt: String? = null,
    )

    @Serializable
    private data class WatchCase(
        val name: String,
        val selfId: String,
        val now: String,
        val currentKeyCreatedAt: String? = null,
        val prev: NewDeviceWatch?,
        val seed: List<ListEntry>? = null,
        val list: List<ListEntry>,
        val vouched: List<String>? = null,
        val watch: NewDeviceWatch?,
        val joined: List<NewDeviceNotice>,
    )

    @Serializable
    private data class ConfirmCase(
        val name: String,
        val id: String,
        val watch: NewDeviceWatch,
        val expect: NewDeviceWatch,
    )

    @Serializable
    private data class ConfirmReviewCase(
        val name: String,
        val watch: NewDeviceWatch,
        val expect: NewDeviceWatch,
    )

    @Serializable
    private data class DismissVanishedCase(
        val name: String,
        val id: String,
        val watch: NewDeviceWatch,
        val expect: NewDeviceWatch,
    )

    @Serializable
    private data class RemoveCase(
        val name: String,
        val watch: NewDeviceWatch,
        val id: String,
        val now: String,
        val currentKeyCreatedAt: String? = null,
        val expect: NewDeviceWatch,
    )

    @Serializable
    private data class RotationDueCase(
        val name: String,
        val watch: NewDeviceWatch,
        val newest: String?,
        val newestDeparted: List<String>? = null,
        val due: Boolean,
    )

    @Serializable
    private data class DepartedCase(
        val name: String,
        val watch: NewDeviceWatch?,
        val expect: List<String>,
    )

    @Serializable
    private data class RotationDoneCase(
        val name: String,
        val owedAt: String,
        val watch: NewDeviceWatch,
        val expect: NewDeviceWatch,
    )

    @Serializable
    private data class KnownToCase(
        val name: String,
        val watch: NewDeviceWatch?,
        val list: List<ListEntry>,
        val expect: List<String>,
    )

    @Serializable
    private data class HeldTabChoicesCase(
        val name: String,
        val selfId: String,
        val watch: NewDeviceWatch?,
        val list: List<ListEntry>,
        val expect: List<String>,
    )

    @Serializable
    private data class VouchTagCase(
        val name: String,
        val key: String,
        val expect: String,
    )

    @Serializable
    private data class VouchTagsCase(
        val name: String,
        val selfId: String,
        val watch: NewDeviceWatch?,
        val list: List<ListEntry>,
        val expect: List<String>,
    )

    @Serializable
    private data class WithVouchCase(
        val name: String,
        val link: String,
        val tags: List<String>,
        val expect: String,
    )

    /** `expect: null` means the link carries no tags. */
    @Serializable
    private data class ParseVouchCase(
        val name: String,
        val link: String,
        val expect: List<String>?,
    )

    /** `now` is epoch milliseconds. */
    @Serializable
    private data class AnnouncesCase(
        val name: String,
        val selfId: String,
        val now: Long,
        val prev: NewDeviceWatch?,
        val list: List<ListEntry>,
        val expect: Boolean,
    )

    @Serializable
    private data class SettleCase(
        val name: String,
        val watch: NewDeviceWatch,
        val expect: NewDeviceWatch,
    )

    @Serializable
    private data class Vectors(
        val watch: List<WatchCase>,
        val confirm: List<ConfirmCase>,
        val confirmReview: List<ConfirmReviewCase>,
        val dismissVanished: List<DismissVanishedCase>,
        val remove: List<RemoveCase>,
        val rotationDue: List<RotationDueCase>,
        val rotationDeparted: List<DepartedCase>,
        val rotationDone: List<RotationDoneCase>,
        val knownTo: List<KnownToCase>,
        val heldTabChoices: List<HeldTabChoicesCase>,
        val vouchTag: List<VouchTagCase>,
        val vouchTags: List<VouchTagsCase>,
        val withVouch: List<WithVouchCase>,
        val parseVouch: List<ParseVouchCase>,
        val announces: List<AnnouncesCase>,
        val settle: List<SettleCase>,
    )

    private val vectors: Vectors by lazy {
        Json { ignoreUnknownKeys = true }.decodeFromString(Vectors.serializer(), vectorFile().readText())
    }

    /** Walk up from wherever Gradle runs the test until the shared vector is found. */
    private fun vectorFile(): File {
        var dir: File? = File("").absoluteFile
        while (dir != null) {
            val candidate = File(dir, "shared/vectors/new-devices.json")
            if (candidate.isFile) return candidate
            dir = dir.parentFile
        }
        error("shared/vectors/new-devices.json not found above ${File("").absolutePath}")
    }

    /**
     * The rules read id, label, createdAt, e2ePubkey, kind and lastSeenAt (which defaults
     * to createdAt, as in the TypeScript test); everything else is a fixture.
     */
    private fun ep(e: ListEntry) = Endpoint(
        id = e.id,
        groupId = "g",
        kind = e.kind,
        browser = "chrome",
        platform = "macos",
        label = e.label,
        e2ePubkey = e.e2ePubkey,
        presence = "online",
        lastSeenAt = e.lastSeenAt ?: e.createdAt,
        createdAt = e.createdAt,
    )

    @Test
    fun `every watch case matches the shared vector`() {
        assertTrue(vectors.watch.isNotEmpty())
        for (c in vectors.watch) {
            val result = NewDevices.watch(
                c.prev,
                c.list.map(::ep),
                c.selfId,
                c.now,
                c.currentKeyCreatedAt,
                c.seed?.map(::ep),
                c.vouched,
            )
            assertEquals("${c.name}: watch", c.watch, result.watch)
            assertEquals("${c.name}: joined", c.joined, result.joined)
        }
    }

    @Test
    fun `every confirm case matches the shared vector`() {
        assertTrue(vectors.confirm.isNotEmpty())
        for (c in vectors.confirm) {
            assertEquals(c.name, c.expect, NewDevices.confirm(c.watch, c.id))
        }
    }

    @Test
    fun `every confirmReview case matches the shared vector`() {
        assertTrue(vectors.confirmReview.isNotEmpty())
        for (c in vectors.confirmReview) {
            assertEquals(c.name, c.expect, NewDevices.confirmReview(c.watch))
        }
    }

    @Test
    fun `every dismissVanished case matches the shared vector`() {
        assertTrue(vectors.dismissVanished.isNotEmpty())
        for (c in vectors.dismissVanished) {
            assertEquals(c.name, c.expect, NewDevices.dismissVanished(c.watch, c.id))
        }
    }

    @Test
    fun `every remove case matches the shared vector`() {
        assertTrue(vectors.remove.isNotEmpty())
        for (c in vectors.remove) {
            assertEquals(c.name, c.expect, NewDevices.removeDevice(c.watch, c.id, c.now, c.currentKeyCreatedAt))
        }
    }

    @Test
    fun `every rotationDue case matches the shared vector`() {
        assertTrue(vectors.rotationDue.isNotEmpty())
        for (c in vectors.rotationDue) {
            assertEquals(c.name, c.due, NewDevices.rotationDue(c.watch, c.newest, c.newestDeparted))
        }
    }

    @Test
    fun `every rotationDeparted case matches the shared vector`() {
        assertTrue(vectors.rotationDeparted.isNotEmpty())
        for (c in vectors.rotationDeparted) {
            assertEquals(c.name, c.expect, NewDevices.rotationDeparted(c.watch))
        }
    }

    @Test
    fun `every rotationDone case matches the shared vector`() {
        assertTrue(vectors.rotationDone.isNotEmpty())
        for (c in vectors.rotationDone) {
            assertEquals(c.name, c.expect, NewDevices.rotationDone(c.watch, c.owedAt))
        }
    }

    @Test
    fun `every knownTo case matches the shared vector`() {
        assertTrue(vectors.knownTo.isNotEmpty())
        for (c in vectors.knownTo) {
            assertEquals(c.name, c.expect, NewDevices.endpointsKnownTo(c.watch, c.list.map(::ep)).map { it.id })
        }
    }

    @Test
    fun `every heldTabChoices case matches the shared vector`() {
        assertTrue(vectors.heldTabChoices.isNotEmpty())
        for (c in vectors.heldTabChoices) {
            assertEquals(
                c.name,
                c.expect,
                NewDevices.heldTabChoices(c.watch, c.list.map(::ep), c.selfId).map { it.id },
            )
        }
    }

    // --- P-23: the pairing link vouches for the first list --------------------

    @Test
    fun `every vouchTag case matches the shared vector`() {
        assertTrue(vectors.vouchTag.isNotEmpty())
        for (c in vectors.vouchTag) {
            assertEquals(c.name, c.expect, NewDevices.vouchTag(c.key))
        }
    }

    @Test
    fun `every vouchTags case matches the shared vector`() {
        assertTrue(vectors.vouchTags.isNotEmpty())
        for (c in vectors.vouchTags) {
            assertEquals(c.name, c.expect, NewDevices.vouchTags(c.watch, c.list.map(::ep), c.selfId))
        }
    }

    @Test
    fun `every withVouch case matches the shared vector`() {
        assertTrue(vectors.withVouch.isNotEmpty())
        for (c in vectors.withVouch) {
            assertEquals(c.name, c.expect, NewDevices.withVouch(c.link, c.tags))
        }
    }

    @Test
    fun `every parseVouch case matches the shared vector`() {
        assertTrue(vectors.parseVouch.isNotEmpty())
        for (c in vectors.parseVouch) {
            assertEquals(c.name, c.expect, NewDevices.parseVouch(c.link))
        }
    }

    // --- P-23: told once, information only ------------------------------------

    @Test
    fun `every announces case matches the shared vector`() {
        assertTrue(vectors.announces.isNotEmpty())
        for (c in vectors.announces) {
            assertEquals(c.name, c.expect, NewDevices.announcesNewDevices(c.prev, c.list.map(::ep), c.selfId, c.now))
        }
    }

    @Test
    fun `every settle case matches the shared vector`() {
        assertTrue(vectors.settle.isNotEmpty())
        for (c in vectors.settle) {
            assertEquals(c.name, c.expect, NewDevices.settleNotices(c.watch))
        }
    }

    @Test
    fun `the stored record survives a JSON round trip`() {
        val watch = NewDeviceWatch(
            selfId = "me",
            known = listOf("me", "x"),
            unconfirmed = listOf(NewDeviceNotice("x", "Firefox · Linux", "2026-10-08T14:02:00Z")),
            keys = mapOf("me" to "pk", "x" to "pk-x"),
            rotateOwedAt = "2026-10-13T12:00:00.000Z",
            rotateFrom = "2026-10-01T00:00:00.000Z",
            rotateFor = listOf("gone"),
            removed = listOf("gone"),
        )
        val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }
        val text = json.encodeToString(NewDeviceWatch.serializer(), watch)
        assertEquals(watch, json.decodeFromString(NewDeviceWatch.serializer(), text))
    }

    @Test
    fun `a record stored before keys and rotations decodes, and so does one with a field from later`() {
        val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }
        val old = json.decodeFromString(
            NewDeviceWatch.serializer(),
            """{"selfId":"me","known":["me"],"unconfirmed":[]}""",
        )
        assertNull(old.keys)
        assertNull(old.rotateOwedAt)
        assertNull(old.rotateFrom)
        assertNull(old.rotateFor)
        assertNull(old.removed)
        val later = json.decodeFromString(
            NewDeviceWatch.serializer(),
            """{"selfId":"me","known":["me"],"unconfirmed":[],"somethingNew":1}""",
        )
        assertEquals(old, later)
    }

    // --- F1: only a list the rule accepted is cached or used -----------------

    // Real devices each have their own key; the notice for a re-paired browser relies on that.
    private val self = ListEntry("me", "Pixel 8", "2026-10-01T10:00:00.000Z", "pk-me")
    private val peer = ListEntry("a", "Chrome · Mac", "2026-09-01T10:00:00.000Z", "pk-a")
    private val stranger = ListEntry("evil", "Chrome · Mac", "2026-10-13T11:00:00.000Z", "pk-evil")

    private fun pairedStore(prefs: MemoryPrefs = MemoryPrefs()): Store = Store.over(prefs).apply {
        registration = Registration(
            endpointId = "me",
            groupId = "g",
            deviceToken = "t",
            relayUrl = "https://relay.example",
            label = "Pixel 8",
        )
    }

    @Test
    fun `a list without this phone is refused, and neither cached nor judged`() {
        val store = pairedStore()
        NewDeviceWatcher.accept(store, listOf(self, peer).map(::ep))
        val goodCache = store.cachedEndpoints
        val goodWatch = store.newDeviceWatch

        // A relay that drops this phone and slips its own device in.
        assertThrows(NewDeviceWatcher.ListWithoutSelfException::class.java) {
            NewDeviceWatcher.accept(store, listOf(stranger, peer).map(::ep))
        }
        assertEquals(goodCache, store.cachedEndpoints)
        assertEquals(goodWatch, store.newDeviceWatch)
    }

    @Test
    fun `the refusal is a failed fetch to every caller`() {
        // Every fetch site already falls back to the cached list on an IOException.
        assertTrue(NewDeviceWatcher.ListWithoutSelfException() is java.io.IOException)
    }

    @Test
    fun `an accepted list is cached and judged`() {
        val store = pairedStore()
        NewDeviceWatcher.accept(store, listOf(self, peer).map(::ep))
        val told = NewDeviceWatcher.accept(store, listOf(self, peer, stranger).map(::ep))
        assertEquals(listOf("evil"), told.joined.map { it.id })
        assertEquals(listOf("me", "a", "evil"), store.cachedEndpoints.map { it.id })
    }

    @Test
    fun `a watch that cannot be saved leaves the cache untouched, and fails like a bad fetch`() {
        val prefs = MemoryPrefs()
        val store = pairedStore(prefs)
        NewDeviceWatcher.accept(store, listOf(self, peer).map(::ep))
        val goodCache = store.cachedEndpoints

        prefs.failingKeys = setOf("endpoints.newDevices")
        assertThrows(java.io.IOException::class.java) {
            NewDeviceWatcher.accept(store, listOf(self, peer, stranger).map(::ep))
        }
        assertEquals(goodCache, store.cachedEndpoints)
    }

    @Test
    fun `a departure owes a rotation from the key that is current now`() {
        val store = pairedStore()
        store.groupKeys = listOf(
            io.tabsend.app.wire.GroupKeyRecord("k", "id-old", "2026-09-01T00:00:00.000Z"),
            io.tabsend.app.wire.GroupKeyRecord("k", "id-new", "2026-10-01T00:00:00.000Z"),
        )
        NewDeviceWatcher.accept(store, listOf(self, peer).map(::ep))
        NewDeviceWatcher.accept(store, listOf(self).map(::ep), now = "2026-10-13T12:00:00.000Z")
        assertEquals("2026-10-13T12:00:00.000Z", store.newDeviceWatch?.rotateOwedAt)
        assertEquals("2026-10-01T00:00:00.000Z", store.newDeviceWatch?.rotateFrom)
    }

    // --- X13: a removal this phone made is written into the watch -------------

    @Test
    fun `a removal is recorded at once, against the key current now`() {
        val store = pairedStore()
        store.groupKeys = listOf(io.tabsend.app.wire.GroupKeyRecord("k", "id-new", "2026-10-01T00:00:00.000Z"))
        NewDeviceWatcher.accept(store, listOf(self, peer, stranger).map(::ep))

        NewDeviceWatcher.removed(store, "evil", now = "2026-10-13T12:00:00.000Z")

        assertEquals(listOf("me", "a"), store.cachedEndpoints.map { it.id })
        val watch = store.newDeviceWatch!!
        assertEquals(listOf("me", "a"), watch.known)
        assertEquals(listOf("evil"), watch.removed)
        assertEquals(listOf("evil"), watch.rotateFor)
        assertEquals("2026-10-13T12:00:00.000Z", watch.rotateOwedAt)
        assertEquals("2026-10-01T00:00:00.000Z", watch.rotateFrom)
        assertTrue(watch.unconfirmed.isEmpty())
    }

    @Test
    fun `a relay that keeps the removed device listed announces it again and still keeps it out of key handoff`() {
        val store = pairedStore()
        NewDeviceWatcher.accept(store, listOf(self, peer, stranger).map(::ep))
        NewDeviceWatcher.removed(store, "evil")

        val told = NewDeviceWatcher.accept(store, listOf(self, peer, stranger).map(::ep))

        assertEquals(listOf("evil"), told.joined.map { it.id })
        val trusted = NewDevices.endpointsKnownTo(store.newDeviceWatch, listOf(self, peer, stranger).map(::ep))
        assertEquals(listOf("me", "a"), trusted.map { it.id })
        // Announced once, not on every fetch.
        assertTrue(NewDeviceWatcher.accept(store, listOf(self, peer, stranger).map(::ep)).joined.isEmpty())
    }

    // --- the device row's Remove (L7): the DELETE, then the watch ---------------

    @Test
    fun `Remove records the removal once the relay has accepted the DELETE`() {
        val store = pairedStore()
        store.groupKeys = listOf(io.tabsend.app.wire.GroupKeyRecord("k", "id-new", "2026-10-01T00:00:00.000Z"))
        NewDeviceWatcher.accept(store, listOf(self, peer, stranger).map(::ep))
        val deleted = mutableListOf<String>()

        NewDeviceWatcher.removeFromGroup(store, "evil", now = "2026-10-13T12:00:00.000Z") { deleted += it }

        assertEquals(listOf("evil"), deleted)
        val watch = store.newDeviceWatch!!
        assertEquals(listOf("evil"), watch.removed)
        assertEquals(listOf("evil"), watch.rotateFor)
        assertEquals("2026-10-13T12:00:00.000Z", watch.rotateOwedAt)
        assertEquals(listOf("me", "a"), store.cachedEndpoints.map { it.id })
    }

    @Test
    fun `Remove records nothing when the relay refuses the DELETE`() {
        val store = pairedStore()
        NewDeviceWatcher.accept(store, listOf(self, peer, stranger).map(::ep))
        val watch = store.newDeviceWatch
        val cache = store.cachedEndpoints

        assertThrows(io.tabsend.app.net.ApiException::class.java) {
            NewDeviceWatcher.removeFromGroup(store, "evil") {
                throw io.tabsend.app.net.ApiException(500, "internal", "Try again")
            }
        }
        assertThrows(java.io.IOException::class.java) {
            NewDeviceWatcher.removeFromGroup(store, "evil") { throw java.io.IOException("no route") }
        }

        assertEquals(watch, store.newDeviceWatch)
        assertEquals(cache, store.cachedEndpoints)
    }

    @Test
    fun `Remove sends nothing for this phone`() {
        val store = pairedStore()
        NewDeviceWatcher.accept(store, listOf(self, peer).map(::ep))
        val watch = store.newDeviceWatch
        val deleted = mutableListOf<String>()

        NewDeviceWatcher.removeFromGroup(store, "me") { deleted += it }

        assertTrue(deleted.isEmpty())
        assertEquals(watch, store.newDeviceWatch)
    }

    @Test
    fun `a record from another pairing is not changed by a removal`() {
        val store = pairedStore()
        NewDeviceWatcher.accept(store, listOf(self, peer).map(::ep))
        store.newDeviceWatch = store.newDeviceWatch!!.copy(selfId = "someone-else")
        val before = store.newDeviceWatch

        NewDeviceWatcher.removed(store, "a")

        assertEquals(before, store.newDeviceWatch)
    }

    // --- GH6 and GH7: the first look, and a device that joined then disappeared ---

    @Test
    fun `the first list is told once, and nothing waits for an answer`() {
        val store = pairedStore()
        val first = NewDeviceWatcher.accept(store, listOf(self, peer).map(::ep))
        assertEquals(listOf("a"), first.firstList.map { it.id })
        assertTrue(first.joined.isEmpty())
        // Stored settled (P-23): nothing is kept on the first look.
        assertNull(store.newDeviceWatch!!.review)

        val next = NewDeviceWatcher.accept(store, listOf(self, peer).map(::ep))
        assertTrue(next.firstList.isEmpty())
        assertTrue(next.joined.isEmpty())
    }

    @Test
    fun `the list a build from before the rule cached is the baseline`() {
        val store = pairedStore()
        // The previous build's cache, and no watch yet.
        store.cachedEndpoints = listOf(self, peer).map(::ep)

        val told = NewDeviceWatcher.accept(store, listOf(self, peer, stranger).map(::ep))

        assertEquals(listOf("evil"), told.joined.map { it.id })
        assertEquals(listOf("a"), told.firstList.map { it.id })
        assertNull(store.newDeviceWatch!!.review)
        assertTrue(store.newDeviceWatch!!.unconfirmed.isEmpty())
    }

    @Test
    fun `a cache left by another pairing is not used as the baseline`() {
        val store = pairedStore()
        store.cachedEndpoints = listOf(ListEntry("other", "Old tablet", "2026-09-01T10:00:00.000Z")).map(::ep)

        val told = NewDeviceWatcher.accept(store, listOf(self, peer).map(::ep))

        assertTrue(told.joined.isEmpty())
        assertEquals(listOf("a"), told.firstList.map { it.id })
    }

    @Test
    fun `a notice left in a record from before P-23 still reports the device that then disappeared`() {
        val store = pairedStore()
        NewDeviceWatcher.accept(store, listOf(self, peer, stranger).map(::ep))
        // A record written by the build before P-23: "evil" still waiting for an answer.
        store.newDeviceWatch = store.newDeviceWatch!!.copy(
            unconfirmed = listOf(NewDeviceNotice("evil", "Chrome · Mac", "2026-10-13T11:00:00.000Z")),
        )

        NewDeviceWatcher.accept(store, listOf(self, peer).map(::ep))
        assertEquals(listOf("evil"), store.newDeviceWatch!!.vanished!!.map { it.id })
        assertTrue(store.newDeviceWatch!!.unconfirmed.isEmpty())

        store.updateNewDeviceWatch { prev -> prev?.let { NewDevices.dismissVanished(it, "evil") } to Unit }
        assertNull(store.newDeviceWatch!!.vanished)
    }

    @Test
    fun `a device that joined is told once, so leaving later is not reported as hidden`() {
        // P-23: nothing waits for an answer, so a device that joins and then leaves is a
        // departure (a rotation is owed), not a "joined, then disappeared" notice.
        val store = pairedStore()
        NewDeviceWatcher.accept(store, listOf(self, peer).map(::ep))
        NewDeviceWatcher.accept(store, listOf(self, peer, stranger).map(::ep))
        NewDeviceWatcher.accept(store, listOf(self, peer).map(::ep))
        assertNull(store.newDeviceWatch!!.vanished)
        assertEquals(listOf("evil"), store.newDeviceWatch!!.rotateFor)
    }

    // --- P-23: the watcher stores a settled record and tells per announcesNewDevices ---

    private val phoneSelf = ListEntry("me", "Pixel 8", "2026-10-01T10:00:00.000Z", "pk-me", kind = "mobile")
    private val now = "2026-10-30T12:00:00.000Z"

    @Test
    fun `a phone tells every join, and keeps nothing pending`() {
        val store = pairedStore()
        NewDeviceWatcher.accept(store, listOf(phoneSelf, peer).map(::ep), now = now)

        val told = NewDeviceWatcher.accept(store, listOf(phoneSelf, peer, stranger).map(::ep), now = now)

        assertTrue(told.announces)
        assertTrue(told.tells)
        assertEquals(listOf("evil"), told.joined.map { it.id })
        assertTrue(told.firstList.isEmpty())
        val stored = store.newDeviceWatch!!
        assertTrue(stored.unconfirmed.isEmpty())
        assertNull(stored.review)
        assertEquals(listOf("me", "a", "evil"), stored.known)
        // Nothing to tell on the next list.
        assertTrue(!NewDeviceWatcher.accept(store, listOf(phoneSelf, peer, stranger).map(::ep), now = now).tells)
    }

    @Test
    fun `the watcher tells only as announcesNewDevices says`() {
        // This device as a browser (the rule is shared; the phone always tells).
        val browserSelf = ListEntry("me", "Chrome · Mac", "2026-10-01T10:00:00.000Z", "pk-me")
        val phone = ListEntry(
            "phone", "Pixel 8", "2026-09-01T10:00:00.000Z", "pk-phone",
            kind = "mobile", lastSeenAt = "2026-10-29T12:00:00.000Z",
        )
        val store = pairedStore()
        NewDeviceWatcher.accept(store, listOf(browserSelf, phone).map(::ep), now = now)
        val prev = store.newDeviceWatch
        val list = listOf(browserSelf, phone, stranger).map(::ep)

        val told = NewDeviceWatcher.accept(store, list, now = now)

        assertEquals(listOf("evil"), told.joined.map { it.id })
        assertEquals(
            NewDevices.announcesNewDevices(prev, list, "me", io.tabsend.app.logic.parseIsoMillis(now)!!),
            told.announces,
        )
        // A phone it had accepted was seen yesterday: the phone tells, this one stays quiet.
        assertTrue(!told.announces)
        assertTrue(!told.tells)
        assertTrue(store.newDeviceWatch!!.unconfirmed.isEmpty())
    }

    @Test
    fun `a record from before P-23 with notices left in it is settled by the next list`() {
        val store = pairedStore()
        NewDeviceWatcher.accept(store, listOf(phoneSelf, peer, stranger).map(::ep), now = now)
        store.newDeviceWatch = store.newDeviceWatch!!.copy(
            unconfirmed = listOf(NewDeviceNotice("evil", "Chrome · Mac", "2026-10-13T11:00:00.000Z")),
            review = listOf(NewDeviceNotice("a", "Chrome · Mac", "2026-09-01T10:00:00.000Z")),
        )

        val told = NewDeviceWatcher.accept(store, listOf(phoneSelf, peer, stranger).map(::ep), now = now)

        assertTrue(!told.tells)
        assertTrue(store.newDeviceWatch!!.unconfirmed.isEmpty())
        assertNull(store.newDeviceWatch!!.review)
    }

    // --- P-23: the pairing link's vouch, read by the first watch only -----------

    // Real-length keys, so each has a full tag ([NewDevices.VOUCH_TAG_LENGTH]).
    private val selfKeyed =
        ListEntry("me", "Pixel 8", "2026-10-01T10:00:00.000Z", "Me0Me0Me0Me0Me0Me0Me0Me0Me0Me0Me0Me0Me0Me0Q=")
    private val vouchedMac =
        ListEntry("a", "Chrome · Mac", "2026-09-01T10:00:00.000Z", "Pix+el8/Pix+el8/Pix+el8/Pix+el8/Pix+el8/Pi4=")
    private val unvouchedMac =
        ListEntry("b", "Arc · Mac", "2026-09-02T10:00:00.000Z", "Mac1Mac1Mac1Mac1Mac1Mac1Mac1Mac1Mac1Mac1Ma4=")

    @Test
    fun `the first list takes the vouch the pairing link carried, and the vouch is then cleared`() {
        val store = pairedStore()
        store.pairingVouch = listOf("Me0Me0Me0Me0Me0M", "Pix-el8_Pix-el8_")

        val told = NewDeviceWatcher.accept(store, listOf(selfKeyed, vouchedMac, unvouchedMac).map(::ep))

        assertTrue(told.joined.isEmpty())
        // Only the device the link did not vouch for is told about, once.
        assertEquals(listOf("b"), told.firstList.map { it.id })
        assertNull(store.newDeviceWatch!!.review)
        assertNull(store.pairingVouch)
    }

    @Test
    fun `a vouch is not read once a record exists`() {
        val store = pairedStore()
        NewDeviceWatcher.accept(store, listOf(selfKeyed).map(::ep))
        store.pairingVouch = listOf("Pix-el8_Pix-el8_")

        val told = NewDeviceWatcher.accept(store, listOf(selfKeyed, vouchedMac).map(::ep))

        assertEquals(listOf("a"), told.joined.map { it.id })
        assertTrue(told.firstList.isEmpty())
    }

    @Test
    fun `a list without this phone leaves the vouch for the list that has it`() {
        val store = pairedStore()
        store.pairingVouch = listOf("Pix-el8_Pix-el8_")
        assertThrows(NewDeviceWatcher.ListWithoutSelfException::class.java) {
            NewDeviceWatcher.accept(store, listOf(vouchedMac).map(::ep))
        }
        assertEquals(listOf("Pix-el8_Pix-el8_"), store.pairingVouch)
    }

    @Test
    fun `a link this phone shows vouches for the devices it accepted, once told`() {
        val store = pairedStore()
        NewDeviceWatcher.accept(store, listOf(selfKeyed, vouchedMac, unvouchedMac).map(::ep))
        // Told once and settled (P-23): every device in the accepted list is vouched for.
        assertEquals(
            listOf("Me0Me0Me0Me0Me0M", "Pix-el8_Pix-el8_", "Mac1Mac1Mac1Mac1"),
            NewDeviceWatcher.vouchTags(store),
        )

        // A record from before P-23 still holding one on its first look leaves it out.
        store.newDeviceWatch = store.newDeviceWatch!!.copy(
            review = listOf(NewDeviceNotice("b", "Arc · Mac", "2026-09-02T10:00:00.000Z")),
        )
        assertEquals(listOf("Me0Me0Me0Me0Me0M", "Pix-el8_Pix-el8_"), NewDeviceWatcher.vouchTags(store))
    }

    @Test
    fun `an unpaired phone vouches for nothing`() {
        assertTrue(NewDeviceWatcher.vouchTags(Store.over(MemoryPrefs())).isEmpty())
    }
}
