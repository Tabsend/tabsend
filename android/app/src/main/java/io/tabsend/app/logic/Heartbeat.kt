package io.tabsend.app.logic

import kotlinx.coroutines.delay

/**
 * Is the relay still on the other end of the stream? [2026-10-27]
 *
 * The phone pings every 30 seconds and the relay answers `pong` (shared §11). The app used
 * to send the pings and never look at the answers, so a connection that died without
 * either side closing it (a NAT that forgot it, a dead path) looked alive to the phone
 * until TCP gave up, which can take many minutes. A tab sent then reached the phone only
 * through the ~5-minute poll, or when the socket finally failed.
 *
 * So every ping now expects an answer: if nothing at all arrives from the relay within
 * [PONG_TIMEOUT_MS] of a ping, the socket is treated as dead and [run] returns, and the
 * caller drops it and reconnects (which drains). Any frame counts as an answer, not only
 * `pong`. The cadence stays one ping per [PING_INTERVAL_MS], well inside the relay's
 * 90-second idle limit and the presence window.
 */
object Heartbeat {
    const val PING_INTERVAL_MS = 30_000L // WS_CLIENT_PING_INTERVAL_SECONDS (§11)
    const val PONG_TIMEOUT_MS = 10_000L // WS_CLIENT_PONG_TIMEOUT_SECONDS (§11)

    enum class End { CLOSED, SILENT }

    /**
     * Ping until the socket closes ([isClosed], or [sendPing] refusing) or a ping goes
     * unanswered. [now] and [lastHeardAt] share one clock; [lastHeardAt] is when the last
     * frame of any kind arrived from the relay.
     */
    suspend fun run(
        now: () -> Long,
        lastHeardAt: () -> Long,
        isClosed: () -> Boolean,
        sendPing: () -> Boolean,
    ): End {
        while (!isClosed()) {
            delay(PING_INTERVAL_MS - PONG_TIMEOUT_MS)
            if (isClosed()) break
            val pingAt = now()
            if (!sendPing()) break
            delay(PONG_TIMEOUT_MS)
            if (isClosed()) break
            if (lastHeardAt() < pingAt) return End.SILENT
        }
        return End.CLOSED
    }
}
