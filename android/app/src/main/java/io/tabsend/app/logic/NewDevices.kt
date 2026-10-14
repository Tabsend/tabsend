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
 *  - The first list is the baseline and announces nothing. The user looks at it ONCE
 *    instead ([NewDeviceWatch.review], GH6): a card lists the other devices in it, with
 *    "All of these are mine" and a way to remove any. On the first run of a build with
 *    the notice, the list the previous build cached is the baseline when there is one,
 *    so a device that appeared after it was cached is announced. Nothing is held back
 *    from the key while the card waits.
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
     * [NewDevices.endpointsKnownTo] until the user answers its notice ("Yes, it's
     * mine"): a relay can otherwise re-list a removed device under a fresh id and be
     * handed the next key before anyone looks. Held back only until answered, because
     * the extension keeps its device key when it re-pairs, so an honest re-paired device
     * does come back under a new id with the same key: one tap lets it in.
     */
    val removedKeys: List<String>? = null,
    /**
     * The first look (GH6): the other devices in the first list this phone accepted,
     * waiting for ONE answer ("All of these are mine") or for each to be removed. Null
     * once answered, and on a record written before this existed.
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
     */
    fun watch(
        prevRecord: NewDeviceWatch?,
        rawList: List<Endpoint>,
        selfId: String,
        now: String = isoMillisOf(System.currentTimeMillis()),
        currentKeyCreatedAt: String? = null,
        seed: List<Endpoint>? = null,
    ): WatchResult {
        if (!listIncludesSelf(rawList, selfId)) return WatchResult(prevRecord, emptyList())
        // A list that names one id twice (a relay can) counts it once, so no card or banner is doubled.
        val list = rawList.distinctBy { it.id }
        // With no record yet, the list a build from before this rule cached is the
        // baseline, so what appeared after it is announced (GH6). It counts only if it
        // contains this phone, so a cache left by another pairing is ignored.
        val prev = if (prevRecord == null || prevRecord.selfId != selfId) {
            if (seed == null || !listIncludesSelf(seed, selfId)) {
                return WatchResult(baseline(list, selfId), emptyList())
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
        // Shown to the user and never answered (a pending banner, or a device on the first-look
        // card), then gone without this phone removing it: the relay may be hiding it (GH7).
        // That holds for a device on the card too: it was shown once and cannot be allowed to
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

    /** "All of these are mine": the first look is answered; its card goes on this phone only. */
    fun confirmReview(watch: NewDeviceWatch): NewDeviceWatch = watch.copy(review = null)

    /** Dismiss one "joined, then disappeared" notice on this phone. */
    fun dismissVanished(watch: NewDeviceWatch, id: String): NewDeviceWatch =
        watch.copy(vanished = watch.vanished?.filter { it.id != id }?.ifEmpty { null })

    /** The user said "Yes, it's mine": drop that device's pending notice. */
    fun confirm(watch: NewDeviceWatch, id: String): NewDeviceWatch =
        watch.copy(unconfirmed = watch.unconfirmed.filter { it.id != id })

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

    private fun baseline(raw: List<Endpoint>, selfId: String): NewDeviceWatch {
        val list = raw.distinctBy { it.id }
        return NewDeviceWatch(
            selfId,
            list.map { it.id },
            emptyList(),
            keysOf(list),
            // The first look: one card, asked once, when there is anyone else to check.
            review = list.filter { it.id != selfId }
                .map { NewDeviceNotice(it.id, it.label, it.createdAt) }
                .ifEmpty { null },
        )
    }

    private fun keysOf(list: List<Endpoint>): Map<String, String> = list.associate { it.id to it.e2ePubkey }
}
