package io.tabsend.app.logic

import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.time.format.DateTimeParseException

/** Parse an ISO-8601 UTC timestamp to epoch millis, or null if unparseable.
 *  `java.time.Instant` is available on API 26+ (our minSdk) and the host JVM. */
fun parseIsoMillis(iso: String): Long? = try {
    Instant.parse(iso).toEpochMilli()
} catch (_: DateTimeParseException) {
    null
}

/** ISO-8601 UTC string for an epoch-millis instant (e.g. SendPayload.sentAt). */
fun isoOf(epochMillis: Long): String = Instant.ofEpochMilli(epochMillis).toString()

/**
 * The same instant with the milliseconds ALWAYS spelled out, exactly as
 * JavaScript's `toISOString()` writes them.
 *
 * [isoOf] leaves them off on a whole second (`Instant.toString` omits a zero
 * fraction), which is invisible everywhere a timestamp is parsed — and wrong in
 * the one place ADR-0028 compares them as STRINGS. The group keyring orders keys
 * by `createdAt` and every client must reach the same answer without talking to
 * the others; `"…:00Z"` sorts after `"…:00.000Z"` because `Z` outranks `.`, so a
 * key minted on a whole second here would look newer than an identical one from
 * a browser. Different devices would then seal history under different keys.
 */
fun isoMillisOf(epochMillis: Long): String = ISO_MILLIS.format(Instant.ofEpochMilli(epochMillis))

private val ISO_MILLIS: DateTimeFormatter =
    DateTimeFormatter.ofPattern("uuuu-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC)

private const val MINUTE_MS = 60_000L
private const val HOUR_MS = 60 * MINUTE_MS
private const val DAY_MS = 24 * HOUR_MS

/**
 * Compact, calm relative time ("just now", "3m ago", "5d ago"). Wording is kept
 * identical to console/src/lib/time.ts and extension/src/lib/inbox.ts on
 * purpose: those surfaces list the same sends this one does, and two
 * vocabularies for one age would read as two different facts.
 */
fun relativeTime(iso: String, nowMs: Long = System.currentTimeMillis()): String {
    val then = parseIsoMillis(iso) ?: return "unknown"
    val delta = nowMs - then
    return when {
        delta < MINUTE_MS -> "just now"
        delta < HOUR_MS -> "${delta / MINUTE_MS}m ago"
        delta < DAY_MS -> "${delta / HOUR_MS}h ago"
        else -> {
            val days = delta / DAY_MS
            when {
                days < 30 -> "${days}d ago"
                days < 365 -> "${days / 30}mo ago"
                else -> "${days / 365}y ago"
            }
        }
    }
}
