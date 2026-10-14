package io.tabsend.app.logic

import kotlinx.serialization.Serializable

/**
 * Device-local send preferences for THIS endpoint (ADR-0002/0009). Never leaves
 * the phone — the relay stores no primary/pin/MRU. `recentTargetIds` is updated
 * on each send and drives chooser ordering.
 */
@Serializable
data class SourcePrefs(
    val primaryTargetId: String? = null,
    val primaryPinned: Boolean = false,
    val recentTargetIds: List<String> = emptyList(),
)

/** Most-recently-used bookkeeping — the pure half of `recordSend` (extension parity). */
object Mru {
    const val MAX_RECENTS = 20

    /**
     * Record a send to `targetId`: move it to the front of the MRU list and,
     * unless the user pinned a primary, let the primary track the MRU head.
     */
    fun recordSend(prefs: SourcePrefs, targetId: String): SourcePrefs {
        val recents = (listOf(targetId) + prefs.recentTargetIds.filter { it != targetId })
            .take(MAX_RECENTS)
        val primary = if (prefs.primaryPinned) prefs.primaryTargetId else targetId
        return prefs.copy(primaryTargetId = primary, recentTargetIds = recents)
    }
}
