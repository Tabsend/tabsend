package io.tabsend.app.logic

import io.tabsend.app.wire.Endpoint

/** One selectable target in the share chooser (mirrors the extension's ChooserRow). */
data class ChooserRow(
    val endpoint: Endpoint,
    val isPrimary: Boolean,
    val isRecent: Boolean,
    /** Online AND confirmed recently enough to say so — false whenever unknown. */
    val online: Boolean,
    /** Offline past the 30-day horizon — a likely abandoned endpoint (still valid). */
    val stale: Boolean,
    /** False when the snapshot is too old to claim any presence from. */
    val presenceKnown: Boolean = true,
)

/**
 * Builds the target list for the share sheet: excludes self and every `console`
 * endpoint (ADR-0010 — consoles are never send destinations), orders
 * primary → recents → the rest (alphabetical), and marks staleness. Presence is
 * non-gating (ADR-0001): an offline target is still selectable.
 */
object Chooser {
    /** lastSeenAt older than this ⇒ rendered as inactive/stale (ADR-0004 follow-up). */
    const val STALE_HORIZON_MS = 30L * 24 * 60 * 60 * 1000

    /**
     * How long a cached presence verdict is still worth showing as fact. Mirrors
     * the relay's own PRESENCE_ONLINE_THRESHOLD_SECONDS (@tabsend/shared) and the
     * extension's PRESENCE_TRUST_MS: the relay calls an endpoint online for this
     * long after its last heartbeat, so a snapshot of that verdict cannot outlive
     * the same window. Past it the UI says unknown instead of repeating a green
     * dot nobody can check — the whole list is painted from cache while offline.
     */
    const val PRESENCE_TRUST_MS = 90L * 1000

    /** Is presence in a snapshot taken at [fetchedAtMs] still claimable? 0 ⇒ never recorded. */
    fun presenceKnown(fetchedAtMs: Long, nowMs: Long): Boolean =
        fetchedAtMs > 0L && nowMs - fetchedAtMs <= PRESENCE_TRUST_MS

    fun build(
        endpoints: List<Endpoint>,
        selfEndpointId: String,
        prefs: SourcePrefs,
        nowMs: Long,
        fetchedAtMs: Long = nowMs,
    ): List<ChooserRow> {
        val known = presenceKnown(fetchedAtMs, nowMs)
        val targets = endpoints.filter { it.id != selfEndpointId && it.kind != "console" }

        val recentRank = prefs.recentTargetIds.withIndex().associate { (i, id) -> id to i }
        val primaryId = prefs.primaryTargetId

        val rows = targets.map { ep ->
            ChooserRow(
                endpoint = ep,
                isPrimary = ep.id == primaryId,
                isRecent = recentRank.containsKey(ep.id),
                online = known && ep.presence == "online",
                stale = ep.presence != "online" && isStale(ep.lastSeenAt, nowMs),
                presenceKnown = known,
            )
        }

        return rows.sortedWith(
            compareByDescending<ChooserRow> { it.isPrimary }
                .thenBy { recentRank[it.endpoint.id] ?: Int.MAX_VALUE }
                .thenBy { it.endpoint.label.lowercase() },
        )
    }

    private fun isStale(lastSeenAtIso: String, nowMs: Long): Boolean {
        val seen = parseIsoMillis(lastSeenAtIso) ?: return false
        return nowMs - seen > STALE_HORIZON_MS
    }
}
