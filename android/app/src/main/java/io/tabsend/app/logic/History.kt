package io.tabsend.app.logic

import io.tabsend.app.wire.BatchInfo
import io.tabsend.app.wire.HistoryEntry
import io.tabsend.app.wire.HistoryRecord
import kotlinx.serialization.Serializable

/**
 * Which end of a transfer this phone was [ADR-0028 §9].
 *
 * A group history is not a list of things that happened TO this device, so a row
 * has to say where it sits. [ELSEWHERE] is a real and ordinary case — two other
 * devices of the same group — and is the reason the screen cannot lean on a
 * preposition: "from" and "to" both need a second end that is implicitly us.
 */
enum class Direction { SENT, RECEIVED, ELSEWHERE }

/**
 * What the relay knows about whether a tab landed.
 *
 * [NEVER_ARRIVED] is the state ADR-0028 exists for: before it, a tab the target
 * never picked up was forgotten by the source the moment the relay accepted it
 * (ADR-0008: "Sent" only ever meant "the relay took it"), so nothing anywhere
 * could say it had not landed.
 */
enum class Delivery { ARRIVED, WAITING, NEVER_ARRIVED }

/**
 * One cached row of the group's history [0028].
 *
 * The relay's list is authoritative and this is a CACHE of it, kept only so the
 * screen reads on a phone with no signal. Everything except the routing facts may
 * be missing: a row whose blob was sealed under a key this device does not hold
 * is still a true record of a transfer, and is kept as one rather than hidden.
 */
@Serializable
data class HistoryItem(
    /** The relay message id — the same id the inbox and the seen-set use. */
    val id: String,
    val sourceEndpointId: String,
    val targetEndpointId: String,
    /** When the relay accepted it. Always present, so it orders the timeline. */
    val createdAt: String,
    val expiresAt: String,
    val ackedAt: String? = null,
    // --- everything below comes from the sealed blob, so it is absent on a row
    // this device cannot open ---
    val url: String? = null,
    val title: String? = null,
    /** The two ends as they were NAMED at send time, so a rename can't rewrite history. */
    val sourceLabel: String? = null,
    val targetLabel: String? = null,
    /** The sender's own clock, which is what every other surface displays. */
    val sentAt: String? = null,
    override val batch: BatchInfo? = null,
) : Batched

/** One row as the screen shows it: a cached record plus this phone's view of it. */
data class HistoryRow(
    val id: String,
    val direction: Direction,
    val delivery: Delivery,
    val targetEndpointId: String,
    val url: String? = null,
    val title: String? = null,
    val sourceLabel: String? = null,
    val targetLabel: String? = null,
    /** The instant the row displays, and the one it is sorted by. */
    val at: String,
    /** Received rows only: epoch ms the user opened the link, null while they haven't. */
    val openedAt: Long? = null,
    override val batch: BatchInfo? = null,
) : Batched {
    /** False when the blob was sealed under a key this device does not hold. */
    val readable: Boolean get() = url != null
}

/**
 * The group's shared history [ADR-0028].
 *
 * Two sources, deliberately, merged by message id:
 *
 *  - the relay's list, which is authoritative and covers the WHOLE group,
 *    including transfers neither end of which was this phone, and which is the
 *    only thing that can say a tab never arrived;
 *  - this phone's own received-tabs inbox [P-7], which covers a sender that
 *    predates ADR-0028 or a group with no key yet (no blob, so no relay row to
 *    read), and which is the only place the fact that the user OPENED a link is
 *    recorded, since the relay is not told.
 *
 * Everything here is pure and `java.*`-only so it runs in a host JVM test, which
 * is where all of this is actually verified.
 */
object History {
    /** How many rows this phone caches for offline reading. Stated in the UI verbatim. */
    const val MAX = Inbox.MAX

    /** Read a relay row plus its opened blob, if this device could open it. */
    fun project(entry: HistoryEntry, record: HistoryRecord?): HistoryItem = HistoryItem(
        id = entry.id,
        sourceEndpointId = entry.sourceEndpointId,
        targetEndpointId = entry.targetEndpointId,
        createdAt = entry.createdAt,
        expiresAt = entry.expiresAt,
        ackedAt = entry.ackedAt,
        url = record?.payload?.url,
        title = record?.payload?.title,
        sourceLabel = record?.sourceLabelAtSend,
        targetLabel = record?.targetLabelAtSend,
        sentAt = record?.payload?.sentAt,
        batch = record?.payload?.batch,
    )

    /**
     * The cache the screen falls back on with no relay: newest first, capped.
     *
     * Deduped on the message id, and the LAST occurrence wins, so a caller that
     * appends a fresher read onto an older one ends up with the fresher facts. The
     * relay remains the authority: a row that was waiting last time and has since
     * been acked has to be able to say so.
     */
    fun cache(items: List<HistoryItem>, max: Int = MAX): List<HistoryItem> {
        val byId = LinkedHashMap<String, HistoryItem>()
        for (item in items) byId[item.id] = item
        return byId.values
            .sortedByDescending { parseIsoMillis(it.createdAt) ?: 0L }
            .take(max)
    }

    /**
     * Did it land?
     *
     * An ack is the only proof of arrival, and the relay holds it. Past expiry
     * without one, nothing further can happen — the relay drops the payload — so
     * that is a verdict, not a delay. Before expiry it is genuinely still open:
     * the target may simply be asleep, which is the ordinary case for a phone.
     */
    fun delivery(item: HistoryItem, nowMs: Long): Delivery = when {
        item.ackedAt != null -> Delivery.ARRIVED
        (parseIsoMillis(item.expiresAt) ?: Long.MAX_VALUE) <= nowMs -> Delivery.NEVER_ARRIVED
        else -> Delivery.WAITING
    }

    fun direction(item: HistoryItem, selfEndpointId: String): Direction = when (selfEndpointId) {
        item.sourceEndpointId -> Direction.SENT
        item.targetEndpointId -> Direction.RECEIVED
        else -> Direction.ELSEWHERE
    }

    /**
     * The merged timeline, newest first.
     *
     * A relay row wins over an inbox row for the same message — it knows the
     * delivery state and both labels — but it borrows that row's `openedAt`,
     * which only this phone knows. An inbox row with no relay row of its own is
     * kept as a received row: it arrived, whatever the relay can still tell us.
     */
    fun rows(
        items: List<HistoryItem>,
        inbox: List<InboxItem>,
        selfEndpointId: String,
        nowMs: Long,
        max: Int = MAX,
    ): List<HistoryRow> {
        val openedById = inbox.associate { it.id to it.openedAt }
        val fromRelay = items.map { item ->
            HistoryRow(
                id = item.id,
                direction = direction(item, selfEndpointId),
                delivery = delivery(item, nowMs),
                targetEndpointId = item.targetEndpointId,
                url = item.url,
                title = item.title,
                sourceLabel = item.sourceLabel,
                targetLabel = item.targetLabel,
                at = item.sentAt ?: item.createdAt,
                openedAt = openedById[item.id],
                batch = item.batch,
            )
        }
        val covered = items.map { it.id }.toSet()
        val fromInbox = inbox.filterNot { covered.contains(it.id) }.map { item ->
            HistoryRow(
                id = item.id,
                direction = Direction.RECEIVED,
                // It is on this phone, so it arrived, whether or not the relay
                // kept a row saying so.
                delivery = Delivery.ARRIVED,
                targetEndpointId = selfEndpointId,
                url = item.url,
                title = item.title,
                sourceLabel = item.sourceLabel,
                at = item.sentAt,
                openedAt = item.openedAt,
                batch = item.batch,
            )
        }
        return (fromRelay + fromInbox)
            .sortedByDescending { parseIsoMillis(it.at) ?: 0L }
            .take(max)
    }

    /**
     * Tabs this phone sent that never arrived and have not been announced yet.
     *
     * Only this phone's own sends: the tab is on the device that sent it, and
     * telling somebody about a failure they cannot act on from here would be
     * noise — every device in the group would announce the same one otherwise.
     */
    fun unannouncedNeverArrived(rows: List<HistoryRow>, announced: List<String>): List<HistoryRow> {
        val done = announced.toSet()
        return rows.filter {
            it.direction == Direction.SENT &&
                it.delivery == Delivery.NEVER_ARRIVED &&
                !done.contains(it.id)
        }
    }

    /**
     * Keep the announced-ids list from growing without limit, while never
     * shrinking it below what the screen can still show — an id pruned while its
     * row is still listed would be announced a second time.
     */
    fun rememberAnnounced(announced: List<String>, ids: List<String>, max: Int = MAX * 2): List<String> =
        (ids + announced).distinct().take(max)

    /** What a row calls the tab, or null when this device cannot read its blob. */
    fun displayTitle(row: HistoryRow): String? =
        row.url?.let { Inbox.displayTitle(row.title, it) }
}
