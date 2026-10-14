package io.tabsend.app.logic

import io.tabsend.app.crypto.Base64x
import io.tabsend.app.wire.Endpoint
import io.tabsend.app.wire.GroupKeyRecord
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive

/**
 * The group history keyring [ADR-0028]. A port of extension/src/lib/keyring.ts,
 * function for function — every client has to reach the SAME answer from the same
 * ring without asking the others, so a second algorithm here would be a bug, not
 * a variation.
 *
 * A device holds a SET of group keys, not one. That single decision collapses
 * three problems into the same code path:
 *
 *  - **Rotation.** A device leaving the group mints a new key (the next key
 *    sync after the new-device watch sees it go; see `GroupHistory.rotateIfOwed`).
 *    History written before it stays readable, because the old key is still in
 *    the ring.
 *  - **A generation race.** A group upgrading from before ADR-0028 has no key,
 *    and two devices could mint one at the same moment. Both end up in every
 *    ring, everyone converges on the same current one, and the blobs written
 *    under the loser stay readable instead of becoming garbage.
 *  - **Arriving late.** A device that has been off for a month collects whatever
 *    it missed and can read the whole window.
 *
 * The convergence rule is total and deterministic: newest `createdAt` wins, and
 * `keyId` breaks a tie. `keyId` is a hash, so the tiebreak is arbitrary but
 * identical everywhere. Both halves are compared as STRINGS, like the TypeScript
 * original — see [isoMillisOf] for why the minting side has to be careful about
 * how it writes an instant.
 */
object Keyring {

    /** Newest first, deterministic. The head is what new sends are sealed under. */
    fun sort(ring: List<GroupKeyRecord>): List<GroupKeyRecord> =
        ring.sortedWith(compareByDescending<GroupKeyRecord> { it.createdAt }.thenByDescending { it.keyId })

    /** The key to seal NEW history under, or null while the group has none. */
    fun current(ring: List<GroupKeyRecord>): GroupKeyRecord? = sort(ring).firstOrNull()

    /** The key a stored blob names, for reading history sealed under an older one. */
    fun byId(ring: List<GroupKeyRecord>, keyId: String): GroupKeyRecord? =
        ring.firstOrNull { it.keyId == keyId }

    /**
     * Fold newly-received keys into the ring, deduped by `keyId`. Never drops a
     * key: an old one is what makes old history readable, and they are 32 bytes
     * each.
     */
    fun merge(ring: List<GroupKeyRecord>, incoming: List<GroupKeyRecord>): List<GroupKeyRecord> {
        val byId = LinkedHashMap<String, GroupKeyRecord>()
        for (key in ring) byId[key.keyId] = key
        for (key in incoming) if (!byId.containsKey(key.keyId)) byId[key.keyId] = key
        return sort(byId.values.toList())
    }

    /**
     * Should THIS device mint the group's first key?
     *
     * Only when the ring is empty, and only for the endpoint with the lowest id
     * among the group's current members. Any device minting whenever it noticed a
     * missing key would have every device in an upgrading group mint a different
     * one at once — survivable (see the race note above) but it would fragment the
     * first day of history across N keys for no reason. Lowest-id is an election
     * that needs no coordination, from a list every device already fetches.
     *
     * If that device never comes online the group simply has no history yet, and
     * the election moves to the next id the moment it leaves the group.
     *
     * Consoles are not candidates: a console never mints, so one holding the
     * lowest id would leave the group with no key at all.
     */
    fun shouldMintFirstKey(
        ring: List<GroupKeyRecord>,
        endpoints: List<Endpoint>,
        selfEndpointId: String,
    ): Boolean {
        if (ring.isNotEmpty()) return false
        if (endpoints.none { it.id == selfEndpointId }) return false
        return endpoints.filter { it.kind != KIND_CONSOLE }.all { selfEndpointId <= it.id }
    }

    private const val KIND_CONSOLE = "console"

    /** The most a key's `createdAt` may run ahead of this device's clock. */
    const val KEY_CREATED_AT_MAX_AHEAD_MS = 24L * 60 * 60 * 1000

    private val CANONICAL_ISO = Regex("""^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$""")

    /**
     * Whether a received key's `createdAt` may enter the ring (ADR-0028 §6,
     * amended 2026-10-13). The mirror of `shared/src/keyrecord.ts`, run against
     * `shared/vectors/group-key-records.json` by KeyringTest.
     *
     * [sort] compares dates AS TEXT, so the text has to be one exact shape.
     * Without this a copy dated `"Wed, 31 Dec 9999 …"` (sorts above every ISO
     * date) or far in the future would stay the current key for good, and no
     * rotation could ever replace it. Accepted: exactly `YYYY-MM-DDTHH:mm:ss.sssZ`,
     * a real instant, and no more than a day ahead of this clock (slack for a
     * wrong clock on the device that minted it).
     */
    fun isAcceptableKeyCreatedAt(createdAt: String, nowMs: Long): Boolean {
        if (!CANONICAL_ISO.matches(createdAt)) return false
        val at = parseIsoMillis(createdAt) ?: return false
        // Round-trips exactly, so a day that does not exist is refused rather than rolled over.
        if (isoMillisOf(at) != createdAt) return false
        return at <= nowMs + KEY_CREATED_AT_MAX_AHEAD_MS
    }

    /**
     * Whether a key copy someone handed us may enter the ring at all: a date
     * [isAcceptableKeyCreatedAt] accepts, a `departed` list [isAcceptableDeparted]
     * accepts, a real 32-byte secretbox key, and a `keyId` that really is that
     * key's fingerprint.
     *
     * Everything downstream finds keys BY id ([byId] when reading a blob,
     * [deliveryId] when handing one on), so a mismatched pair would poison the
     * ring quietly: blobs sealed under it would name an id nothing can open.
     */
    fun isAcceptableRecord(record: GroupKeyRecord, nowMs: Long): Boolean {
        if (!isAcceptableKeyCreatedAt(record.createdAt, nowMs)) return false
        if (!isAcceptableDeparted(record.departed?.let { ids -> JsonArray(ids.map(::JsonPrimitive)) })) return false
        val bytes = try {
            Base64x.decode(record.key)
        } catch (e: IllegalArgumentException) {
            return false
        }
        if (bytes.size != GROUP_KEY_BYTES) return false
        return record.keyId == Base64x.keyId(record.key)
    }

    private const val GROUP_KEY_BYTES = 32

    /**
     * The most ids a key record names, and a new-device watch tracks as owed. A key
     * copy has to fit the relay's 4096-byte envelope cap, and a relay that makes ids
     * appear and disappear must not be able to grow the record until the cap
     * refuses the copy. The mirror of `MAX_DEPARTED` in `shared/src/keyrecord.ts`.
     */
    const val MAX_DEPARTED = 32
    const val MAX_DEPARTED_ID_LENGTH = 64

    /**
     * Whether a record's `departed` field, read from the raw JSON, may enter the
     * ring: absent or `null`, or an array of at most [MAX_DEPARTED] distinct,
     * non-empty STRINGS of at most 64 characters. Anything else refuses the whole
     * record. Checked on the JSON element, not on a decoded list, because the wire
     * parser is lenient and would read `[1]` as `["1"]` where the other clients
     * refuse it. The mirror of `isAcceptableDeparted`; run against
     * `shared/vectors/group-key-records.json` by KeyringTest.
     */
    fun isAcceptableDeparted(departed: JsonElement?): Boolean {
        if (departed == null || departed is JsonNull) return true
        if (departed !is JsonArray || departed.size > MAX_DEPARTED) return false
        val seen = HashSet<String>()
        for (item in departed) {
            if (item !is JsonPrimitive || !item.isString) return false
            val id = item.content
            if (id.isEmpty() || id.length > MAX_DEPARTED_ID_LENGTH) return false
            if (!seen.add(id)) return false
        }
        return true
    }

    /**
     * The `departed` list a receiver may rely on: the record's, minus the device
     * that sent the copy. A device cannot vouch that IT has left. Without this a
     * device about to be removed could mint a key naming itself, and a relay that
     * held the copies back until after the removal would let everyone stand down on
     * a key that device holds (X14). Null for a record that names nobody.
     */
    fun vouchedDeparted(departed: List<String>?, senderEndpointId: String): List<String>? =
        departed.orEmpty().filter { it != senderEndpointId }.ifEmpty { null }

    /** One copy of the current key that still needs handing to a group member. */
    data class PendingDelivery(
        /** Deterministic, so a replay dedupes server-side instead of piling up rows. */
        val id: String,
        val targetEndpointId: String,
        val targetPubkey: String,
    )

    /**
     * Which group members still need the current key.
     *
     * Excludes this device, consoles included on purpose (a console reads history
     * like anything else — it is excluded from CHOOSERS, not from the group), and
     * anything already delivered. [delivered] is a local record of
     * `keyId:endpointId` pairs, which is enough because both halves are stable: a
     * device that re-pairs gets a new endpoint id and so reappears here.
     */
    fun pendingDeliveries(
        ring: List<GroupKeyRecord>,
        endpoints: List<Endpoint>,
        selfEndpointId: String,
        delivered: List<String>,
    ): List<PendingDelivery> {
        val key = current(ring) ?: return emptyList()
        val done = delivered.toSet()
        // Never to a device the key itself names as gone: a key minted after a departure
        // exists to keep that device out, and a relay that lists it again (or shows this
        // phone a list from before) must not get it handed over (X14).
        val gone = key.departed.orEmpty().toSet()
        return endpoints
            .filter { it.id != selfEndpointId && it.id !in gone }
            .map {
                PendingDelivery(
                    id = deliveryId(key.keyId, it.id),
                    targetEndpointId = it.id,
                    targetPubkey = it.e2ePubkey,
                )
            }
            .filterNot { done.contains(it.id) }
    }

    /** The stable id for one (key, recipient) pair. */
    fun deliveryId(keyId: String, endpointId: String): String = "gk-$keyId-$endpointId"

    /**
     * Mint the record for a new key. Separate from generation so the caller cannot
     * accidentally date a new key earlier than the one it replaces — which would
     * make [current] keep choosing the old one and silently un-rotate the group.
     * The first key of a group has nothing to outrank and is simply dated now.
     * [departed] is the debt it pays ([NewDevices.rotationDeparted]).
     */
    fun mintedKey(
        ring: List<GroupKeyRecord>,
        key: String,
        keyId: String,
        nowMs: Long,
        departed: List<String> = emptyList(),
    ): GroupKeyRecord {
        val newest = current(ring)
        val nowIso = isoMillisOf(nowMs)
        val createdAt = if (newest != null && newest.createdAt >= nowIso) {
            bumpIso(newest.createdAt, nowMs)
        } else {
            nowIso
        }
        // Names the devices it replaces, so a device that owes a rotation for them can
        // tell this key from one that merely arrived later (X14). A first key names nobody.
        return GroupKeyRecord(key = key, keyId = keyId, createdAt = createdAt, departed = departed.ifEmpty { null })
    }

    /** One millisecond past an ISO instant, so a rotation always sorts newer. */
    private fun bumpIso(iso: String, fallbackMs: Long): String =
        isoMillisOf((parseIsoMillis(iso) ?: fallbackMs) + 1)
}
