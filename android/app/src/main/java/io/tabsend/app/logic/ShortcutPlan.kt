package io.tabsend.app.logic

/** One endpoint promoted to a Sharing Shortcut (Direct Share) slot. */
data class ShortcutTarget(
    val endpointId: String,
    val label: String,
    val kind: String,
    /** Lower sorts earlier in the system's Direct Share row. */
    val rank: Int,
)

/**
 * Which endpoints get a Direct Share slot in the Android share sheet
 * (INTERACTION_FLOWS §2.8) — the pure half of `send/ShareShortcuts`.
 *
 * Slots are scarce and the system caps them, so this is the chooser list
 * *truncated*, never a different list: same exclusions (self, consoles) and same
 * order (primary → recents → alphabetical), so what sits on top of the chooser is
 * also what the share sheet offers. Rank mirrors that order, which is all the
 * ordering hint the system takes — placement itself is never guaranteed.
 *
 * Stale endpoints are the one extra exclusion. They stay perfectly sendable in
 * the chooser (presence is non-gating, ADR-0001), but a month-dark endpoint
 * spending one of four slots costs a live device its place, and Direct Share
 * offers no way to say "inactive" the way the chooser row does.
 */
object ShortcutPlan {
    /**
     * Our own cap, under every launcher's. Android promises no particular number
     * of Direct Share slots and surfaces vary (4 is the common floor), so asking
     * for more just buries the tail; [build] additionally clamps to whatever the
     * platform reports.
     */
    const val MAX_TARGETS = 4

    /**
     * Shortcut ids are namespaced rather than bare endpoint ids, so a shortcut id
     * arriving from the system is always recognisably one of ours — the share
     * intent carries whatever id the *sheet* picked, and answering it by sending a
     * tab somewhere is only safe once we know we published it.
     */
    private const val ID_PREFIX = "endpoint:"

    fun shortcutIdFor(endpointId: String): String = ID_PREFIX + endpointId

    /** The endpoint a share-sheet pick names, or null if this wasn't one of ours. */
    fun endpointIdOf(shortcutId: String?): String? {
        if (shortcutId == null || !shortcutId.startsWith(ID_PREFIX)) return null
        return shortcutId.removePrefix(ID_PREFIX).takeIf { it.isNotEmpty() }
    }

    fun build(rows: List<ChooserRow>, max: Int = MAX_TARGETS): List<ShortcutTarget> =
        rows.asSequence()
            .filterNot { it.stale }
            .take(max.coerceAtLeast(0))
            .mapIndexed { index, row ->
                ShortcutTarget(
                    endpointId = row.endpoint.id,
                    label = row.endpoint.label,
                    kind = row.endpoint.kind,
                    rank = index,
                )
            }
            .toList()
}
