package io.tabsend.app.logic

import io.tabsend.app.wire.GroupResetState
import kotlinx.serialization.Serializable
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * What this phone knows about a reset that waits [PLANS.md P-18 item 12], kept on the
 * phone only. The relay is asked again on every check; this record is what the home
 * screen paints between checks, and what keeps the alert to once per reset.
 *
 * A reset is known by its `requestedAt`: [notified] and [dismissed] hold the one each
 * was given for, so a NEW reset (a later `requestedAt`) alerts and shows again.
 */
@Serializable
data class GroupResetRecord(
    /** The pairing this record belongs to: a record from another pairing is ignored. */
    val selfId: String,
    /** The reset the relay last reported, or null when it reported none. */
    val reset: GroupResetState? = null,
    /** The reset "It was me" hid on this phone. */
    val dismissed: String? = null,
    /** The reset the system alert was already posted for. */
    val notified: String? = null,
)

/** The pure rules: which reset to alert about, which to show, and the dates in its words. */
object GroupResets {

    /** The record after a check, and the reset to alert about now (null: no alert). */
    data class Observed(val record: GroupResetRecord, val notify: GroupResetState?)

    /**
     * Record what the relay said. [reset] is null when the relay reported none (or is
     * too old to know the route). Alerts once per reset, and never for one this phone
     * already answered "It was me" to.
     */
    fun observe(prev: GroupResetRecord?, selfId: String, reset: GroupResetState?): Observed {
        val mine = prev?.takeIf { it.selfId == selfId } ?: GroupResetRecord(selfId)
        val notify = reset?.takeIf { it.requestedAt != mine.notified && it.requestedAt != mine.dismissed }
        val next = mine.copy(reset = reset, notified = notify?.requestedAt ?: mine.notified)
        return Observed(next, notify)
    }

    /** The reset the home screen's card shows, or null. */
    fun toShow(record: GroupResetRecord?, selfId: String?): GroupResetState? {
        if (record == null || selfId == null || record.selfId != selfId) return null
        return record.reset?.takeIf { it.requestedAt != record.dismissed }
    }

    /** "It was me": hide this reset on this phone. A later reset shows again. */
    fun dismiss(record: GroupResetRecord, requestedAt: String): GroupResetRecord =
        record.copy(dismissed = requestedAt)

    /** This phone stopped it and the relay agreed: nothing is pending any more. */
    fun stopped(record: GroupResetRecord): GroupResetRecord = record.copy(reset = null)

    /** "October 27", in [zone]; null for a time that does not parse. */
    fun day(iso: String, zone: ZoneId): String? = format(iso, zone, DAY)

    /** "3:05 PM", in [zone]; null for a time that does not parse. */
    fun time(iso: String, zone: ZoneId): String? = format(iso, zone, TIME)

    // English, like every other word in the app: a month in another language
    // would sit oddly inside an English sentence.
    private val DAY = DateTimeFormatter.ofPattern("MMMM d", Locale.ENGLISH)
    private val TIME = DateTimeFormatter.ofPattern("h:mm a", Locale.ENGLISH)

    private fun format(iso: String, zone: ZoneId, formatter: DateTimeFormatter): String? {
        val millis = parseIsoMillis(iso) ?: return null
        return formatter.format(Instant.ofEpochMilli(millis).atZone(zone))
    }
}
