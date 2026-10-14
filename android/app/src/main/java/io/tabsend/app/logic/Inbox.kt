package io.tabsend.app.logic

import io.tabsend.app.wire.BatchInfo
import io.tabsend.app.wire.SendPayload
import kotlinx.serialization.Serializable

/**
 * Anything that can belong to a multi-tab send, so [Inbox.group] can put one
 * back together whatever kind of row it is looking at.
 *
 * It has two implementations since ADR-0028: a tab this phone received, and a
 * row of the group's shared history. The grouping rule is subtle enough (see
 * [Inbox.group]) that having it twice would eventually mean having it two ways.
 */
interface Batched {
    val batch: BatchInfo?
}

/**
 * One tab this phone RECEIVED, kept device-locally so it outlives its
 * notification [P-7]. Mirrors extension/src/lib/model.ts `InboxItem` and
 * TabsendKit's `InboxItem`.
 *
 * Still device-local after ADR-0028, and still the only record of a tab whose
 * sender predates group history: the relay's list is authoritative for what the
 * GROUP did, but it holds nothing about a send that carried no blob, and nothing
 * at all about whether this phone's user actually opened the link.
 *
 * No favicon: nothing on this screen draws one, and storing a field no surface
 * reads is debris.
 */
@Serializable
data class InboxItem(
    /** The relay message id — the dedupe key, same one the seen-set uses. */
    val id: String,
    val url: String,
    val title: String? = null,
    /** The sender's label as it read WHEN THIS ARRIVED (survives a later rename). */
    val sourceLabel: String,
    /** ISO — when the sender hit send. */
    val sentAt: String,
    /** epoch ms — when this phone recorded it. */
    val receivedAt: Long,
    /** The multi-tab send this belonged to, when it was one. */
    override val batch: BatchInfo? = null,
    /**
     * epoch ms the user actually opened it, null while they have not. This is the
     * distinction the extension has no use for (a browser opens every tab it
     * receives) and that matters most here: an unopened row is a tab whose
     * notification was swiped away or never tapped, which is the whole reason
     * this screen exists.
     */
    val openedAt: Long? = null,
) : Batched

/** One rendered block: a single tab, or every tab of one multi-tab send. */
data class InboxGroup<T : Batched>(
    val batchId: String? = null,
    val sentCount: Int? = null,
    val items: List<T>,
)

/**
 * The received-tabs inbox [P-7].
 *
 * A received link used to exist in exactly one place, its notification, and the
 * relay deletes the payload on ack — so one swipe lost the tab for good. This is
 * the device-local record that survives it.
 *
 * Retention is a COUNT, not an age (owner decision 2026-08-05): the newest [MAX],
 * stated on the screen rather than buried in settings.
 *
 * Grouping mirrors extension/src/lib/inbox.ts and console/src/lib/view.ts
 * deliberately. The console settled the shape during multi-tab send; a second
 * shape for the same idea would be a parity bug, not a choice.
 */
object Inbox {
    /** How many received tabs this phone keeps. Stated in the UI verbatim. */
    const val MAX = 50

    /**
     * Project a decrypted payload into the stored record. Pure. The sender label
     * is snapshotted at receipt so the row still reads correctly after a later
     * rename, or after that device leaves the group.
     */
    fun project(
        messageId: String,
        payload: SendPayload,
        sourceLabel: String,
        receivedAt: Long,
    ): InboxItem = InboxItem(
        id = messageId,
        url = payload.url,
        title = payload.title,
        sourceLabel = sourceLabel,
        sentAt = payload.sentAt,
        receivedAt = receivedAt,
        batch = payload.batch,
    )

    /**
     * Add one received tab, newest first, dropping anything past the cap.
     *
     * Prepending is what lets [group] restore a batch's original order (see
     * there). Idempotent on the message id, and a re-delivery keeps the ORIGINAL
     * record — so a tab the user already opened does not come back unopened.
     */
    fun record(items: List<InboxItem>, item: InboxItem, max: Int = MAX): List<InboxItem> =
        if (items.any { it.id == item.id }) items else (listOf(item) + items).take(max)

    /** Stamp a tab as opened. Returns the same list when nothing changed. */
    fun markOpened(items: List<InboxItem>, id: String, atMs: Long): List<InboxItem> {
        if (items.none { it.id == id && it.openedAt == null }) return items
        return items.map { if (it.id == id && it.openedAt == null) it.copy(openedAt = atMs) else it }
    }

    /** Stamp several at once — the batch summary's "Open all" opens them together. */
    fun markOpened(items: List<InboxItem>, ids: Collection<String>, atMs: Long): List<InboxItem> =
        ids.fold(items) { acc, id -> markOpened(acc, id, atMs) }

    /**
     * Group so one multi-tab send reads as one send instead of N unrelated rows.
     * Grouping is by batch id across the WHOLE list, not just adjacent rows: a
     * batch can be recorded across separate drains, so a later single send can
     * land between two of its tabs.
     *
     * A group takes the position of its FIRST item, so the list stays newest
     * first. Items within a group are reversed, which restores the order the
     * sender picked them in: [record] prepends, so the last tab of a batch ends
     * up in front.
     */
    fun <T : Batched> group(items: List<T>): List<InboxGroup<T>> {
        val groups = mutableListOf<InboxGroup<T>>()
        val indexByBatch = mutableMapOf<String, Int>()
        for (item in items) {
            val batch = item.batch
            if (batch == null) {
                groups += InboxGroup(items = listOf(item))
                continue
            }
            val at = indexByBatch[batch.id]
            if (at != null) {
                val existing = groups[at]
                groups[at] = existing.copy(
                    // Trust the largest count seen: every tab of the batch carries it.
                    sentCount = maxOf(existing.sentCount ?: 0, batch.count),
                    items = existing.items + item,
                )
                continue
            }
            indexByBatch[batch.id] = groups.size
            groups += InboxGroup(batchId = batch.id, sentCount = batch.count, items = listOf(item))
        }
        return groups.map { if (it.batchId != null) it.copy(items = it.items.reversed()) else it }
    }

    /**
     * The count line for a batch block: "3 tabs" when all of them are here,
     * "2 of 3 tabs" when they are not. A gap is a real outcome, not a bug — a tab
     * can still be queued at the relay, or have been pushed off the end of the
     * cap — so this names it instead of quietly showing a shorter list.
     */
    fun batchHeading(group: InboxGroup<*>): String {
        val here = group.items.size
        val sent = maxOf(group.sentCount ?: here, here)
        return if (here == sent) "$sent tabs" else "$here of $sent tabs"
    }

    /**
     * What a row calls the tab. A tab sent without a title is normal (some pages
     * have none), and the host is a better handle than an empty line. Same rule
     * as the link notification's title, so a row and its notification agree.
     */
    fun displayTitle(title: String?, url: String): String =
        title?.takeIf { it.isNotBlank() } ?: hostOf(url)

    /**
     * A safe host for the row's secondary line; the raw string if it won't parse.
     *
     * `java.net.URI` rather than `android.net.Uri`, so this whole object stays a
     * plain-JVM unit under test — the Android class is a stub in host tests and
     * would silently return null for every URL there.
     */
    fun hostOf(url: String): String = try {
        java.net.URI(url).host ?: url
    } catch (_: Exception) {
        url
    }
}
