package io.tabsend.app.logic

import kotlinx.serialization.Serializable

/** One message we've already delivered — the idempotency set, pruned by age. */
@Serializable
data class SeenMessage(val id: String, val ts: Long)

/**
 * The seen-set: dedupe delivery so a push, a boot-drain, and a poll can never
 * open the same URL twice (PRD §6.1 idempotency). Retention ≈ 2× the 7-day TTL,
 * matching the server's tombstone window and the extension's seen-set.
 */
object SeenSet {
    const val RETENTION_MS = 14L * 24 * 60 * 60 * 1000

    fun has(seen: List<SeenMessage>, id: String): Boolean = seen.any { it.id == id }

    fun add(seen: List<SeenMessage>, id: String, nowMs: Long): List<SeenMessage> =
        if (has(seen, id)) seen else seen + SeenMessage(id, nowMs)

    fun remove(seen: List<SeenMessage>, id: String): List<SeenMessage> =
        seen.filterNot { it.id == id }

    fun prune(seen: List<SeenMessage>, nowMs: Long): List<SeenMessage> {
        val cutoff = nowMs - RETENTION_MS
        return seen.filter { it.ts >= cutoff }
    }
}
