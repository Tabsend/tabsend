package io.tabsend.app.logic

/**
 * The little a queue rule needs to know about the thing it is holding. Keeping
 * it to this is what lets the rule below be tested on a plain JVM, with no
 * Store, no SharedPreferences and no envelope.
 */
interface HeldItem {
    val id: String

    /** ISO — when the user hit send. Age is measured from here, never from a retry. */
    val createdAt: String
}

/**
 * What bounds the source-side outbound queue.
 *
 * An item leaves that queue only on a DEFINITE answer from the relay: accepted,
 * or refused in a way retrying cannot change (ADR-0008, INTERACTION_FLOWS §4e).
 * Silence, a 429 and any 5xx all keep it, deliberately — dropping a tab because
 * a reverse proxy answered HTML 502 for the few seconds a relay container takes
 * to restart was silent data loss, and in a flush it was the whole queue at once.
 *
 * That rule is unchanged. What it left open is the other side: nothing ever
 * ENDED a wait. A relay that permanently 5xxes one particular envelope retried
 * it on every drain and every heartbeat forever, and sharing through a long
 * outage grew the queue without bound — on a phone, where the whole queue is one
 * blob rewritten into SharedPreferences on every single change.
 *
 * Hand-mirrored from `extension/src/lib/outbound.ts`, and by
 * `TabsendKit/OutboundQueue.swift`. The three must agree: a tab that dies on the
 * phone at seven days and lives on the laptop for a month is two products.
 */
object OutboundQueue {

    /**
     * How long a tab may wait before Tabsend gives up on it.
     *
     * Mirrors `DEFAULT_MESSAGE_TTL_DAYS` in `shared/src/types.ts` — the SOURCE,
     * which is TypeScript and cannot be consumed from Kotlin, so like the copy
     * tables it lives twice. Pinned to the relay's own message TTL rather than
     * picked: past that horizon the relay would have deleted the message anyway,
     * so both sides hold one opinion about when a send is dead instead of two.
     *
     * An age cap and NOT a consecutive-5xx counter, which was the other option
     * on the table: a counter kills tabs during a legitimately long proxy
     * outage, which is exactly the failure the recoverable/final split exists to
     * prevent. Age has no false-kill mode — a relay back inside the week keeps
     * every tab — and it ends the poison envelope too, since that ages out as
     * well.
     */
    const val MAX_AGE_DAYS = 7
    const val MAX_AGE_MS = MAX_AGE_DAYS * 24L * 60L * 60L * 1000L

    /**
     * How many held tabs the queue keeps.
     *
     * Age alone does not bound a burst, and a week is a long time to keep
     * sharing at a relay that is not answering. The number is a compromise
     * between "nobody sharing normally ever meets it" and what the storage
     * actually costs: this queue is one JSON blob rewritten on every enqueue and
     * every flush, so its length is paid for on every send, not only when it is
     * read. Identical in all three clients on purpose.
     */
    const val MAX_ITEMS = 200

    /**
     * What to do with a queue, decided before anything is written or POSTed.
     *
     * [expired] and [evicted] are kept apart because the user is told about them
     * differently: one waited too long, the other was pushed out by newer sends,
     * and a single sentence covering both would be false half the time.
     */
    data class Plan<T>(
        /** The queue as it should now be stored, in its original order. */
        val keep: List<T>,
        /** Given up on: older than the relay's own message TTL. */
        val expired: List<T> = emptyList(),
        /** Given up on: the oldest tabs, pushed out by the size cap. */
        val evicted: List<T> = emptyList(),
    )

    /**
     * Age out, then cap. Pure: the caller stores [Plan.keep] and announces the
     * rest — never silently, because the user was promised "the tab is held here
     * and sends itself once the relay answers again" and this is the moment that
     * promise stops being kept (INTERACTION_FLOWS §4d).
     *
     * Run at BOTH ends — when something is enqueued, and at the top of a flush.
     * The flush is the half that matters for the poison envelope: it is never
     * competing with newer sends for the size cap, so nothing but its own age
     * can ever finish it.
     *
     * A `createdAt` that will not parse is treated as brand new rather than as
     * infinitely old. Guessing the other way would let a formatting bug delete
     * somebody's tabs, and the size cap still bounds the queue either way.
     */
    fun <T : HeldItem> plan(queue: List<T>, nowMs: Long): Plan<T> {
        val expired = mutableListOf<T>()
        val survived = mutableListOf<T>()
        for (item in queue) {
            if (nowMs - createdAtMs(item, nowMs) >= MAX_AGE_MS) expired += item else survived += item
        }

        val excess = survived.size - MAX_ITEMS
        if (excess <= 0) return Plan(keep = survived, expired = expired)

        // Oldest first, by the TIMESTAMP rather than by position in the list: a
        // place in the queue only says when the item was last written, and the
        // newest item is the one the user just asked for — dropping that one to
        // make room would be the single worst choice available. Ties (and
        // unparseable stamps, which read as "now") fall back to position, so the
        // ordering is total and the same list always yields the same plan.
        val doomed = survived.withIndex()
            .sortedWith(compareBy({ createdAtMs(it.value, nowMs) }, { it.index }))
            .take(excess)
            .mapTo(HashSet()) { it.value.id }
        return Plan(
            keep = survived.filterNot { it.id in doomed },
            expired = expired,
            evicted = survived.filter { it.id in doomed },
        )
    }

    /**
     * Abandon one held tab: a pure local delete, and NOTHING is transmitted.
     *
     * Same principle as the extension's quick-send undo window — there is no
     * retraction message to build because there is nothing to retract. Be honest
     * about the limit that follows: this can only forget something nobody else
     * has yet. An item whose POST is in flight at this instant may still be
     * accepted by the relay and delivered, and a tab the relay has already taken
     * is long past anything this can reach. Cancelling is "stop trying", not
     * "unsend"; the product has never had an unsend and this does not add one.
     */
    fun <T : HeldItem> cancel(queue: List<T>, id: String): List<T> = queue.filterNot { it.id == id }

    // --- a held tab whose device is gone (PLANS.md P-15 item 3) --------------
    //
    // Before this, a tab held for a device that was then removed waited until
    // the relay answered, and the relay's `unknown_target` then dropped it with
    // an error. Now it is FLAGGED: the flush stops posting it, the home screen
    // says the device is no longer in the group, and the user picks another
    // device for it. Mirrors `extension/src/lib/outbound.ts`. Android makes no
    // console history copies, so there are none to hold back with it.
    //
    // The flag has two sources, and they are not worth the same (SECURITY_REVIEW
    // L3). The relay refusing the tab is final: it is the one party that delivers.
    // A device list that no longer has the device is not: a list can be old, or
    // wrong on purpose, so that flag lifts once the device is accepted again.

    /**
     * Whether this held tab waits for a device that is no longer in the group.
     *
     * [acceptedIds] is the group as this phone last ACCEPTED it: the ids
     * [NewDevices.endpointsKnownTo] keeps from the cached list, not the list
     * itself, so a device this phone removed that the relay still lists counts as
     * gone (X13). The relay's refusal outweighs any list: the list a flush reads
     * can be older than the refusal, and trusting it would post the tab to a
     * device the relay has already said is gone. An empty list proves nothing (a
     * fresh install, a cache not yet filled), so it changes nothing either way.
     */
    fun isTargetGone(item: TargetedItem, acceptedIds: Set<String>): Boolean = when {
        item.targetGone && !item.goneFromList -> true
        acceptedIds.isEmpty() -> item.targetGone
        else -> item.targetEndpointId !in acceptedIds
    }

    /**
     * Flag every held tab whose device has left the group, and lift a list's flag
     * from a tab whose device is accepted again. [setFromList] copies one item with
     * the list's flag set (true: [TargetedItem.targetGone] and
     * [TargetedItem.goneFromList]) or lifted (false: both off). A relay's flag is
     * never lifted here. Pure: an item that does not change comes back as itself.
     */
    fun <T : TargetedItem> markGoneTargets(
        queue: List<T>,
        acceptedIds: Set<String>,
        setFromList: (T, Boolean) -> T,
    ): List<T> = queue.map {
        val gone = isTargetGone(it, acceptedIds)
        when {
            gone && !it.targetGone -> setFromList(it, true)
            !gone && it.targetGone -> setFromList(it, false)
            else -> it
        }
    }

    /**
     * Point a held tab at another device: [replacement] (the tab sealed afresh
     * for the new device) takes the old item's place, so it keeps its turn.
     * Pure, and it seals nothing: an envelope sealed to one device's key must
     * never be sent to another. An id no longer queued changes nothing.
     */
    fun <T : HeldItem> retarget(queue: List<T>, id: String, replacement: T): List<T> =
        queue.map { if (it.id == id) replacement else it }

    /** When the send was made, in epoch ms; [nowMs] when the stamp won't parse. */
    private fun createdAtMs(item: HeldItem, nowMs: Long): Long =
        parseIsoMillis(item.createdAt) ?: nowMs
}

/** The slice of a held item the "is its device gone?" rule needs. */
interface TargetedItem : HeldItem {
    val targetEndpointId: String

    /**
     * Set once the device is known to be gone. Sticky when the relay set it;
     * lifted again when [goneFromList] says a list set it and a later list has the
     * device accepted again.
     */
    val targetGone: Boolean

    /**
     * True when [targetGone] was set because a device list no longer had the
     * device; false when the relay refused the tab (`unknown_target`,
     * `not_in_group`). A tab stored before this existed reads false, which is the
     * relay's flag: the safe reading, since it keeps the tab unposted.
     */
    val goneFromList: Boolean
}
