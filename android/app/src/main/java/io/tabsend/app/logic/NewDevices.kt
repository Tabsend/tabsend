package io.tabsend.app.logic

import io.tabsend.app.wire.Endpoint
import kotlinx.serialization.Serializable

/**
 * The "new device joined" notice (PLANS.md P-10): the Android mirror of
 * `shared/src/newdevices.ts`. Same semantics, same cases
 * (`shared/vectors/new-devices.json`, run by NewDevicesTest), so the clients
 * cannot drift apart silently.
 *
 * Never trusts the `endpoint_added` stream event. Each fetch of the device list
 * is compared with the ids this phone saw last, so a device inserted straight
 * into the relay's database is caught on the next fetch.
 *
 *  - The first list is the baseline and announces nothing as joined. Its other devices
 *    are the first look ([NewDeviceWatch.review], GH6), told once (P-23). On the first
 *    run of a build with the notice, the list the previous build cached is the baseline
 *    when there is one, so a device that appeared after it was cached is announced. Nothing is held back
 *    from the key while a device waits for an answer.
 *  - Since P-23 (owner, 2026-10-30: "show that warning once", information only) a joined
 *    device and the first look are told once and nothing waits for an answer: the phone
 *    stores [NewDevices.settleNotices] of each record, and [NewDevices.announcesNewDevices]
 *    says whether this device is the one that tells.
 *  - The device that showed the pairing link vouches for the first list (P-23): the
 *    link carries a short tag of each device that device has accepted
 *    ([NewDevices.vouchTags]), and a device this phone finds in its first list under a vouched key is not put on
 *    the first look. The link travels from the user's hand to this phone, so the relay
 *    cannot add to it. Only what does not match is asked about; a link from an older
 *    client carries no tags and everything is asked about, as before.
 *  - A device announced as new, never answered, and then gone from the list without this
 *    phone removing it is kept in [NewDeviceWatch.vanished] until dismissed (GH7): a
 *    relay can show a device once and hide it.
 *  - This device never announces itself; a rename keeps the id.
 *  - A list without this device is ignored entirely (removed, or a bad fetch).
 *  - A device that leaves the list drops its pending notice, and leaves a key
 *    rotation owed ([NewDeviceWatch.rotateOwedAt]): whatever left may hold the
 *    current history key (ADR-0028 §7). A removal and a device the relay showed
 *    once and then hid are the same event here, so both are covered.
 *  - A known id whose published key changed is announced as new. An honest relay
 *    never changes an endpoint's key, so that is a different device wearing an
 *    old name.
 *  - A removal this phone made is recorded at once ([NewDevices.removeDevice]),
 *    not left to the relay's next list: "Remove it" is only a request, and a relay
 *    that answers it and keeps listing the device would otherwise trigger no
 *    departure and no rotation (X13). The id goes on [NewDeviceWatch.removed],
 *    which keeps it out of [NewDevices.endpointsKnownTo] for good, and a list that
 *    shows it again announces it like any new device.
 *  - A rotation is owed FOR named devices ([NewDeviceWatch.rotateFor]), and the key
 *    that pays it must name them (`GroupKeyRecord.departed`). A newer key that does
 *    not is not a rotation for them: a relay that holds key copies back can
 *    otherwise make a device stand down on a key the departed device holds (X14).
 *
 * The phone must never use, cache or hand a key to a list this rule ignored (one
 * without this device): the rule is only a notice if the list it judged is the
 * list the rest of the app acts on. [NewDeviceWatcher.record] enforces that.
 */
@Serializable
data class NewDeviceNotice(
    val id: String,
    val label: String,
    val createdAt: String,
)

/** What the phone stores between fetches. Device-local; never sent anywhere. */
@Serializable
data class NewDeviceWatch(
    /** The endpoint this record belongs to. A different one starts a fresh baseline. */
    val selfId: String,
    /** Every device id in the last list that was accepted. */
    val known: List<String>,
    /** Joined since the baseline, not yet answered. Oldest first. */
    val unconfirmed: List<NewDeviceNotice>,
    /**
     * Each known device's published key (`e2ePubkey`), by id. Null on a record
     * written before 2026-10-13; such a record learns the keys on its next list
     * without announcing anything.
     */
    val keys: Map<String, String>? = null,
    /**
     * Set when a device left the list: the group key must be replaced. Cleared by
     * [NewDevices.rotationDone], which also matches on it, so a departure that
     * arrives while a rotation is being minted is not lost.
     */
    val rotateOwedAt: String? = null,
    /**
     * The `createdAt` of the key that was current when that device left: the key
     * to replace. Compared with a KEY, not a clock: a key dated ahead of the clock
     * (allowed by up to a day) would otherwise look like a rotation that already
     * happened, and a device about to be removed could hand one out to keep the
     * group on a key it holds. Null when the ring was empty then: any key that
     * turns up is replaced once.
     */
    val rotateFrom: String? = null,
    /**
     * The ids behind the owed rotation: every device that left, was removed here, or
     * had its key swapped since the last rotation this phone settled. The key that
     * settles the debt must name all of them (`GroupKeyRecord.departed`); the key
     * this phone mints names exactly these. Oldest first, at most
     * [Keyring.MAX_DEPARTED] (the newest are kept). Null when nothing is owed.
     */
    val rotateFor: List<String>? = null,
    /**
     * The devices THIS phone removed, by id, for as long as this pairing lasts. Left
     * out of [NewDevices.endpointsKnownTo] whatever the relay's list says, and
     * announced if the list shows one again. By id only: the extension keeps its
     * device key when it re-pairs, so a removed key can honestly come back under a
     * new id, and an id never does. Those keys are on [removedKeys].
     */
    val removed: List<String>? = null,
    /**
     * The published keys (`e2ePubkey`) of the devices THIS phone removed, where it knew
     * them. A device carrying one of these under a NEW id stays out of
     * [NewDevices.endpointsKnownTo] while its notice is pending: a relay can otherwise
     * re-list a removed device under a fresh id and be handed the next key before anyone
     * looks. Held back only while pending, because the extension keeps its device key when
     * it re-pairs, so an honest re-paired device does come back under a new id with the
     * same key. Since P-23 the phone stores no pending notice ([settleNotices]), so this
     * holds only for a record from before it.
     */
    val removedKeys: List<String>? = null,
    /**
     * The first look (GH6): the other devices in the first list this phone accepted that
     * the pairing link did not vouch for (P-23). Told once and then dropped
     * ([NewDevices.settleNotices]), so the stored record never keeps it; null on a record
     * written before this existed.
     */
    val review: List<NewDeviceNotice>? = null,
    /**
     * Devices that were announced as new, never answered, and then left the list
     * without this phone removing them (GH7). Shown until dismissed. Newest last, at
     * most [NewDevices.MAX_VANISHED].
     */
    val vanished: List<NewDeviceNotice>? = null,
)

data class WatchResult(
    /** What to store next. Null only when there was nothing before and the list could not be used. */
    val watch: NewDeviceWatch?,
    /** Devices that joined since the previous fetch: announce these once, as a system alert. */
    val joined: List<NewDeviceNotice>,
)

object NewDevices {

    /** The most "joined, then disappeared" notices kept; a relay that flaps ids cannot grow the record. */
    const val MAX_VANISHED = 20

    /**
     * The most devices a pairing link vouches for. A larger group's link vouches for the
     * first ones; the rest are asked about.
     */
    const val MAX_VOUCHED = 50

    /** Characters of a published key a pairing link carries per device: 96 bits, too many to grind a key for. */
    const val VOUCH_TAG_LENGTH = 16

    /** A tag as [parseVouch] accepts it: exactly [VOUCH_TAG_LENGTH] URL-safe characters. */
    private val VOUCH_TAG = Regex("[A-Za-z0-9_-]{$VOUCH_TAG_LENGTH}")

    /** True when a list may be used at all: it has to contain this device. */
    fun listIncludesSelf(list: List<Endpoint>, selfId: String): Boolean = list.any { it.id == selfId }

    /**
     * Compare a freshly fetched device list with what this phone saw last. Pure.
     * When a device has left, [now] stamps `rotateOwedAt` and [currentKeyCreatedAt]
     * (the `createdAt` of this phone's current group key, if it has one) becomes
     * `rotateFrom`.
     *
     * The TypeScript also restarts from a baseline when a stored record's `known`
     * is not a list; here the typed decode already refuses such a record (the
     * Store reads it as null), which lands on the same baseline.
     *
     * [vouched] is the tags the pairing link carried ([parseVouch]), if any. It is used
     * only when this list becomes the baseline: a device in it whose key has a vouched tag
     * is not put on the first look (P-23). Once a record exists it is never consulted again.
     */
    fun watch(
        prevRecord: NewDeviceWatch?,
        rawList: List<Endpoint>,
        selfId: String,
        now: String = isoMillisOf(System.currentTimeMillis()),
        currentKeyCreatedAt: String? = null,
        seed: List<Endpoint>? = null,
        vouched: List<String>? = null,
    ): WatchResult {
        if (!listIncludesSelf(rawList, selfId)) return WatchResult(prevRecord, emptyList())
        // A list that names one id twice (a relay can) counts it once, so no row is marked twice.
        val list = rawList.distinctBy { it.id }
        // With no record yet, the list a build from before this rule cached is the
        // baseline, so what appeared after it is announced (GH6). It counts only if it
        // contains this phone, so a cache left by another pairing is ignored.
        val prev = if (prevRecord == null || prevRecord.selfId != selfId) {
            if (seed == null || !listIncludesSelf(seed, selfId)) {
                return WatchResult(baseline(list, selfId, vouched), emptyList())
            }
            baseline(seed, selfId)
        } else {
            prevRecord
        }

        val known = prev.known.toSet()
        val prevKeys = prev.keys
        val byId = list.associateBy { it.id }
        fun rekeyed(e: Endpoint): Boolean {
            val before = prevKeys?.get(e.id) ?: return false
            return before != e.e2ePubkey
        }
        val joined = list
            .filter { it.id != selfId && (it.id !in known || rekeyed(it)) }
            .map { NewDeviceNotice(it.id, it.label, it.createdAt) }
        val joinedIds = joined.map { it.id }.toSet()

        fun refreshed(n: NewDeviceNotice) = n.copy(label = byId[n.id]?.label ?: n.label)
        val unconfirmed = prev.unconfirmed
            .filter { it.id in byId && it.id !in joinedIds }
            .map(::refreshed) + joined
        val removedIds = prev.removed.orEmpty().toSet()
        val review = prev.review.orEmpty()
            .filter { it.id in byId && it.id !in joinedIds }
            .map(::refreshed)
        // Shown to the user and never answered (a pending notice, or a device on the first
        // look), then gone without this phone removing it: the relay may be hiding it (GH7).
        // That holds for a device on the first look too: it was shown once and cannot be allowed to
        // drop off without a trace. One that is back is a pending notice again, not both. One
        // whose key is still on screen as another unanswered device (a browser that re-paired:
        // new id, same key, old id deleted) is not hidden, only renamed, and is not reported.
        val onScreenKeys = (unconfirmed + review).mapNotNull { byId[it.id]?.e2ePubkey }.toSet()
        val vanished = (
            prev.vanished.orEmpty().filter { it.id !in joinedIds } +
                (prev.unconfirmed + prev.review.orEmpty()).filter {
                    it.id !in byId && it.id !in removedIds &&
                        (prevKeys?.get(it.id) == null || prevKeys[it.id] !in onScreenKeys)
                }
            ).takeLast(MAX_VANISHED)

        // A changed key counts as leaving too: whoever held the old key may hold
        // the group key, and a key swapped in and back out must not keep it.
        // A device this phone removed owes nothing when it leaves again: it was left out of
        // key handoff the whole time it was listed, and its removal already owed (and
        // settled, or still owes) the rotation.
        val departed = (
            prev.known.filter { it != selfId && it !in byId } +
                list.filter { it.id != selfId && it.id in known && rekeyed(it) }.map { it.id }
            ).filter { it !in removedIds }
        val left = departed.isNotEmpty()
        return WatchResult(
            NewDeviceWatch(
                selfId = selfId,
                known = list.map { it.id },
                unconfirmed = unconfirmed,
                keys = keysOf(list),
                rotateOwedAt = if (left) now else prev.rotateOwedAt,
                rotateFrom = if (left) currentKeyCreatedAt else prev.rotateFrom,
                rotateFor = if (left) owedIds(prev.rotateFor, departed, prev.removed.orEmpty()) else prev.rotateFor,
                removed = prev.removed,
                removedKeys = prev.removedKeys,
                review = review.ifEmpty { null },
                vanished = vanished.ifEmpty { null },
            ),
            joined,
        )
    }

    /**
     * This phone removed [id] and the relay accepted the request. Record it NOW, in
     * the watch, rather than waiting for a list to confirm it: the relay is the one
     * party that can say the removal did not happen, and a relay that answers the
     * DELETE and keeps listing the device would otherwise cost the attacker
     * nothing. The device leaves `known`, `keys` and the pending notices, goes on
     * `removed`, and a rotation is owed at once against the key current now, named
     * for it. If the relay then keeps listing it, the next list announces it as new
     * and [endpointsKnownTo] still leaves it out. Pure. A phone never removes itself
     * here (Unpair is the way out).
     */
    fun removeDevice(
        watch: NewDeviceWatch,
        id: String,
        now: String = isoMillisOf(System.currentTimeMillis()),
        currentKeyCreatedAt: String? = null,
    ): NewDeviceWatch {
        if (id == watch.selfId) return watch
        val removed = if (watch.removed.orEmpty().contains(id)) watch.removed.orEmpty() else watch.removed.orEmpty() + id
        val key = watch.keys?.get(id)
        return watch.copy(
            known = watch.known.filter { it != id },
            unconfirmed = watch.unconfirmed.filter { it.id != id },
            vanished = watch.vanished?.filter { it.id != id }?.ifEmpty { null },
            review = watch.review?.filter { it.id != id }?.ifEmpty { null },
            keys = watch.keys?.filterKeys { it != id },
            removed = removed,
            removedKeys = if (key == null || watch.removedKeys.orEmpty().contains(key)) {
                watch.removedKeys
            } else {
                watch.removedKeys.orEmpty() + key
            },
            rotateOwedAt = now,
            rotateFrom = currentKeyCreatedAt,
            rotateFor = owedIds(watch.rotateFor, listOf(id), removed),
        )
    }

    /**
     * The owed ids after adding [more]: unique, oldest first, at most [Keyring.MAX_DEPARTED].
     * An id a key record could not carry (empty, or over [Keyring.MAX_DEPARTED_ID_LENGTH]) is
     * not owed: the relay mints UUIDs, and a record naming such an id would be refused by every
     * other client, leaving this phone writing under a key nobody shares. Over the cap the
     * oldest ids go first, but never one the user removed while another can go instead, so a
     * flood of invented ids cannot push a real removal out.
     */
    private fun owedIds(prev: List<String>?, more: List<String>, removed: List<String> = emptyList()): List<String> {
        val add = more.distinct().filter { it.isNotEmpty() && it.length <= Keyring.MAX_DEPARTED_ID_LENGTH }
        val all = prev.orEmpty().filter { it !in add } + add
        var excess = all.size - Keyring.MAX_DEPARTED
        if (excess <= 0) return all
        val kept = all.filter {
            if (excess > 0 && it !in removed) {
                excess -= 1
                false
            } else {
                true
            }
        }
        return kept.takeLast(Keyring.MAX_DEPARTED)
    }

    /** The ids a key minted for this debt names: sorted, so every client writes the same record. */
    fun rotationDeparted(watch: NewDeviceWatch?): List<String> = watch?.rotateFor.orEmpty().sorted()

    /**
     * The devices in [list] this watch has accepted: id in `known`, with the same
     * published key it recorded, never one this phone removed, and not one that carries
     * the key of a device this phone removed until its notice is answered. The key sync
     * hands keys only to these and trusts key copies only from these, so a list read
     * before the watch moved on (a removed device still in it), or a relay that keeps
     * a removed device listed, cannot carry a new key to the device that was removed.
     */
    fun endpointsKnownTo(watch: NewDeviceWatch?, list: List<Endpoint>): List<Endpoint> {
        if (watch == null) return emptyList()
        val known = watch.known.toSet()
        val removed = watch.removed.orEmpty().toSet()
        val heldKeys = watch.removedKeys.orEmpty().toSet()
        val unanswered = watch.unconfirmed.map { it.id }.toSet()
        val keys = watch.keys
        return list.filter {
            it.id in known &&
                it.id !in removed &&
                !(it.id in unanswered && it.e2ePubkey in heldKeys) &&
                (keys == null || keys[it.id] == it.e2ePubkey)
        }
    }

    /**
     * The devices a held tab whose device is gone may be moved to (P-15 item 3,
     * SECURITY_REVIEW L3): those this watch has accepted ([endpointsKnownTo], so never
     * one this phone removed), never this phone or a console, and none the user has
     * not answered yet, a pending "new device" notice or one on the first look. The relay
     * decides when a held tab asks for a new device, so it must not also decide what
     * is offered. The device the tab was for is not left out: once accepted again it
     * is a fair choice. In list order; the home screen sorts. A watch that belongs to
     * another pairing offers nothing.
     */
    fun heldTabChoices(watch: NewDeviceWatch?, list: List<Endpoint>, selfId: String): List<Endpoint> {
        if (watch == null || watch.selfId != selfId) return emptyList()
        val unanswered = (watch.unconfirmed + watch.review.orEmpty()).map { it.id }.toSet()
        return endpointsKnownTo(watch, list).filter {
            it.id != selfId && it.kind != "console" && it.id !in unanswered
        }
    }

    /**
     * "All of these are mine": the whole first look is answered on this phone only. The
     * home screen no longer asks this (P-23 answers per device, [confirm]); kept because
     * the shared vectors run it on every client.
     */
    fun confirmReview(watch: NewDeviceWatch): NewDeviceWatch = watch.copy(review = null)

    /** Dismiss one "joined, then disappeared" notice on this phone. */
    fun dismissVanished(watch: NewDeviceWatch, id: String): NewDeviceWatch =
        watch.copy(vanished = watch.vanished?.filter { it.id != id }?.ifEmpty { null })

    /**
     * One device answered: drop its pending notice, or its place on the first look. The
     * home screen no longer asks (P-23: told once, [settleNotices]); kept because the
     * shared vectors run it on every client.
     */
    fun confirm(watch: NewDeviceWatch, id: String): NewDeviceWatch =
        watch.copy(
            unconfirmed = watch.unconfirmed.filter { it.id != id },
            review = watch.review?.filter { it.id != id }?.ifEmpty { null },
        )

    /**
     * Should this phone replace the group key now? Only when a rotation is owed and
     * the ring's newest key does not already pay it. It pays it when it is newer
     * than the key that was current when the device left (`rotateFrom`) AND names
     * every device owed for (`rotateFor`, against the key's `departed`). A key that
     * is merely newer proves nothing: it may have been minted before the departure
     * by the departed device itself, and held back by the relay until now (X14). A
     * key that names the debt was minted after the departure by a device that knew
     * of it, and was never sealed to the departed device. Compared as text, like
     * the keyring. The caller clears the debt ([rotationDone]) either way once its
     * ring holds a key. A debt with no ids is paid by any newer key.
     */
    fun rotationDue(
        watch: NewDeviceWatch?,
        newestKeyCreatedAt: String?,
        newestKeyDeparted: List<String>? = null,
    ): Boolean {
        if (watch?.rotateOwedAt == null || newestKeyCreatedAt == null) return false
        val from = watch.rotateFrom ?: return true
        if (newestKeyCreatedAt <= from) return true
        val named = newestKeyDeparted.orEmpty().toSet()
        return !watch.rotateFor.orEmpty().all { it in named }
    }

    /**
     * Clear an owed rotation, but only the one that was read: a device that left
     * while the rotation was being minted owes another.
     */
    fun rotationDone(watch: NewDeviceWatch, owedAt: String): NewDeviceWatch =
        if (watch.rotateOwedAt != owedAt) {
            watch
        } else {
            watch.copy(rotateOwedAt = null, rotateFrom = null, rotateFor = null)
        }

    /** A phone not seen for this long no longer counts as the one that tells the user (P-23). */
    const val ANNOUNCER_STALE_MS = 30L * 24 * 60 * 60 * 1000

    /**
     * Should THIS device tell the user that a device joined (P-23; owner, 2026-10-30: "show
     * that warning once", information only)? A phone always does. A browser does only when
     * the group has no phone this device had accepted before this list and has seen in the
     * last 30 days, so a user without a phone still hears, and one with a phone hears it
     * once. A console never does: it has no notifications.
     *
     * Only a phone from the record BEFORE this list counts ([prev]): a phone that arrives in
     * the same list as the newcomer, or is the newcomer, silences nobody, so a relay cannot
     * hush the browsers by adding a phone along with its device. A time that cannot be read
     * counts as not seen. [now] is epoch milliseconds. Pure.
     */
    fun announcesNewDevices(prev: NewDeviceWatch?, list: List<Endpoint>, selfId: String, now: Long): Boolean {
        val self = list.find { it.id == selfId } ?: return false
        if (self.kind == "mobile") return true
        if (self.kind != "extension") return false
        val before = prev?.takeIf { it.selfId == selfId }
        return endpointsKnownTo(before, list.distinctBy { it.id }).none {
            if (it.id == selfId || it.kind != "mobile") return@none false
            val seen = parseIsoMillis(it.lastSeenAt) ?: return@none false
            now - seen <= ANNOUNCER_STALE_MS
        }
    }

    /**
     * The notices, once told (P-23): a joined device is reported once, as information, and
     * nothing waits for an answer, so nothing is kept on the first look
     * ([NewDeviceWatch.review]) or pending ([NewDeviceWatch.unconfirmed]), with one
     * exception: a device carrying the published key of a device THIS phone removed stays
     * pending, so [endpointsKnownTo] keeps it out of key handoff. A relay could otherwise
     * list a removed device again under a fresh id and have it handed the next key a moment
     * after one notification. Everything else in the record stays.
     */
    fun settleNotices(watch: NewDeviceWatch): NewDeviceWatch {
        val held = watch.removedKeys.orEmpty().toSet()
        val unconfirmed = watch.unconfirmed.filter { n ->
            val key = watch.keys?.get(n.id)
            key != null && key in held
        }
        return watch.copy(unconfirmed = unconfirmed, review = null)
    }

    /**
     * A device's tag in a pairing link: the first [VOUCH_TAG_LENGTH] characters of its
     * published key, in the URL-safe alphabet so the link needs no escaping.
     */
    fun vouchTag(e2ePubkey: String): String =
        e2ePubkey
            .take(VOUCH_TAG_LENGTH)
            .replace('+', '-')
            .replace('/', '_')
            .replace("=", "")

    /**
     * The tags a pairing link this phone shows vouches for (P-23): every device it has
     * accepted ([endpointsKnownTo], this phone included), never one it has not answered
     * yet, a pending notice or one on its own first look. Unique, in list order, at most
     * [MAX_VOUCHED]. Empty when the watch belongs to another pairing or the list is not
     * one this phone may use; the link then vouches for nothing.
     */
    fun vouchTags(watch: NewDeviceWatch?, list: List<Endpoint>, selfId: String): List<String> {
        if (watch == null || watch.selfId != selfId || !listIncludesSelf(list, selfId)) return emptyList()
        val unanswered = (watch.unconfirmed + watch.review.orEmpty()).map { it.id }.toSet()
        return endpointsKnownTo(watch, list.distinctBy { it.id })
            .filter { it.id !in unanswered }
            .map { vouchTag(it.e2ePubkey) }
            .filter { it.length == VOUCH_TAG_LENGTH }
            .distinct()
            .take(MAX_VOUCHED)
    }

    /** A pairing link with the tags appended to its fragment as `&v=tag.tag`. Unchanged when there are none. */
    fun withVouch(link: String, tags: List<String>): String {
        // The relay makes the base link, so any `v` already in its fragment goes first,
        // tags or not: only this device may vouch (v0.9.0 review, finding 1).
        val hash = link.indexOf('#')
        if (hash < 0) return link
        val kept = link.substring(hash + 1).split('&').filterNot { it.startsWith("v=") }
        val base = link.substring(0, hash + 1) + kept.joinToString("&")
        return if (tags.isEmpty()) base else "$base&v=${tags.joinToString(".")}"
    }

    /**
     * The tags a pairing link carries, or null when it carries none (a link from an
     * older client, or one whose `v` held nothing usable). A tag that is not exactly
     * [VOUCH_TAG_LENGTH] URL-safe characters is dropped: a shorter one would match more keys.
     */
    fun parseVouch(link: String): List<String>? {
        val hash = link.indexOf('#')
        if (hash < 0) return null
        // More than one `v` means something other than the showing device wrote one.
        val param = link.substring(hash + 1)
            .split('&')
            .filter { it.startsWith("v=") }
            .singleOrNull()
            ?: return null
        val tags = param.substring(2).trim().split('.')
            .distinct()
            .filter { VOUCH_TAG.matches(it) }
            .take(MAX_VOUCHED)
        return tags.ifEmpty { null }
    }

    private fun baseline(raw: List<Endpoint>, selfId: String, vouched: List<String>? = null): NewDeviceWatch {
        val list = raw.distinctBy { it.id }
        val vouchedTags = vouched.orEmpty().toSet()
        return NewDeviceWatch(
            selfId,
            list.map { it.id },
            emptyList(),
            keysOf(list),
            // The first look: asked once, when anyone the pairing link did not vouch for is there (P-23).
            review = list.filter { it.id != selfId && vouchTag(it.e2ePubkey) !in vouchedTags }
                .map { NewDeviceNotice(it.id, it.label, it.createdAt) }
                .ifEmpty { null },
        )
    }

    private fun keysOf(list: List<Endpoint>): Map<String, String> = list.associate { it.id to it.e2ePubkey }
}
