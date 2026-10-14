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

    /** When the send was made, in epoch ms; [nowMs] when the stamp won't parse. */
    private fun createdAtMs(item: HeldItem, nowMs: Long): Long =
        parseIsoMillis(item.createdAt) ?: nowMs
}
