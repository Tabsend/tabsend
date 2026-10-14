package io.tabsend.app.logic

import kotlinx.serialization.Serializable

/**
 * The rolling verdict on "is our relay answering?", persisted so a surface the
 * user opens LATER (the home screen, ten minutes into an outage) can say WHY
 * nothing is arriving, instead of rendering a healthy-looking device list from
 * cache while every send piles up in the outbound queue.
 *
 * Mirrors the extension's `lib/health.ts`. Fed by every authenticated call —
 * heartbeat, poll, endpoint list, send — so it stays fresh with no probe of its
 * own, and correctness never depends on it: it is purely what the UI is allowed
 * to claim.
 */
@Serializable
data class RelayHealth(
    /** The relay this verdict is about; a stale verdict for another URL is ignored. */
    val relayUrl: String,
    /** Did the last call reach it? Any HTTP answer counts, even a rejection. */
    val reachable: Boolean,
    /** ISO — when this reachable/unreachable state began. */
    val since: String,
    /** ISO — the last time a call actually reached this relay, if ever. */
    val lastOkAt: String? = null,
)

/** How long an outage must persist before surfaces call it out (avoid flapping). */
const val OUTAGE_GRACE_MS = 30_000L

/**
 * True when the relay has been unreachable long enough to be worth telling the
 * user about. A single missed call during a radio handover or a container
 * restart is noise; half a minute of silence is a fact.
 */
fun isRelayDown(health: RelayHealth?, nowMs: Long): Boolean {
    if (health == null || health.reachable) return false
    val since = parseIsoMillis(health.since) ?: return false
    return nowMs - since >= OUTAGE_GRACE_MS
}

/**
 * Fold one call's outcome into the stored verdict, or null when nothing needs
 * writing. Pure so the throttle and the `since` rule are testable.
 *
 * [refreshMs] throttles same-state writes; transitions always write. `since`
 * must survive a same-state refresh, or an outage would perpetually read as
 * "started just now" and never clear the grace period that gates the warning.
 */
fun foldRelayContact(
    previous: RelayHealth?,
    relayUrl: String,
    reachable: Boolean,
    nowMs: Long,
    lastWriteMs: Long,
    refreshMs: Long = 20_000L,
): RelayHealth? {
    val sameState = previous?.relayUrl == relayUrl && previous.reachable == reachable
    if (sameState && nowMs - lastWriteMs < refreshMs) return null
    val nowIso = isoOf(nowMs)
    return RelayHealth(
        relayUrl = relayUrl,
        reachable = reachable,
        since = if (sameState && previous != null) previous.since else nowIso,
        lastOkAt = if (reachable) nowIso else previous?.lastOkAt,
    )
}

/** Whole minutes since the relay last answered, for [Feedback.relayDownLine]. */
fun minutesSinceLastOk(health: RelayHealth, nowMs: Long): Int {
    val last = health.lastOkAt?.let { parseIsoMillis(it) }
        ?: parseIsoMillis(health.since)
        ?: return 0
    return ((nowMs - last).coerceAtLeast(0L) / 60_000L).toInt()
}
