package io.tabsend.app.logic

import io.tabsend.app.wire.Endpoint
import java.io.IOException

/**
 * "Is this phone replacing Pixel 8?" (PLANS.md P-31 item 2). The Android mirror of
 * `shared/src/replacing.ts`; read its header for the whole reasoning.
 *
 * A reinstalled app pairs as a NEW device, and the relay renames it so two entries
 * never share a label ("Pixel 8" comes back as "Pixel 8 2"). The old entry stays in
 * the group and other devices keep sending to it. So, right after this phone pairs,
 * during its OWN setup and only then, it looks for an old offline copy of itself and
 * offers to replace it. [findReplacedSelf] picks that old entry, or none.
 *
 * Why this is not the withdrawn "Remove old one" (SECURITY_REVIEW.md L1, L2, L6):
 *  - It is about THIS phone only. It never answers or accepts any device (L1):
 *    replacing removes the old entry and renames this one, nothing else ([replace]).
 *  - It never offers a device this phone removed, and never this phone.
 *  - The wording asks, and shows the old entry's full name and when it was last
 *    seen; it does not assert the two are the same (L2).
 *  - Times must be exactly `YYYY-MM-DDTHH:mm:ss.sssZ` naming a real instant (GH4).
 *    Names are compared after ASCII-only lowercasing and collapsing ASCII spaces, as
 *    UTF-16 code units (Kotlin's own String order), so the extension, iOS and this
 *    phone give the same answer on every input (L6). All three run
 *    `shared/vectors/replacing-devices.json`.
 */
object Replacing {

    /** How long an entry must have been quiet before it is offered: a day. */
    const val REPLACE_QUIET_MS = 24L * 60 * 60 * 1000

    private const val SEP = " · "

    /** The highest counter the relay's dedupe writes (`uniqueBrowserName`, `naming.ts`). */
    private const val MAX_COUNTER = 99

    private val CANONICAL_ISO = Regex("""^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$""")

    /**
     * Milliseconds for exactly `YYYY-MM-DDTHH:mm:ss.sssZ` naming a real instant, else
     * null. The rule of [Keyring.isAcceptableKeyCreatedAt] (GH4) without its "ahead of
     * the clock" part.
     */
    fun strictIsoMillis(text: String): Long? {
        if (!CANONICAL_ISO.matches(text)) return null
        val at = parseIsoMillis(text) ?: return null
        // Round-trips exactly, so a day that does not exist is refused rather than rolled over.
        if (isoMillisOf(at) != text) return null
        return at
    }

    /**
     * ASCII-only lowercase, runs of ASCII spaces, tabs and line breaks as one space,
     * none at either end. Deliberately not `lowercase()` or `trim()`: those know
     * Unicode, and the TypeScript and Swift twins must reach the same string.
     */
    fun normalizeName(name: String): String {
        val out = StringBuilder()
        var pendingSpace = false
        for (c in name) {
            if (c == ' ' || c == '\t' || c == '\n' || c == '\r') {
                pendingSpace = out.isNotEmpty()
                continue
            }
            if (pendingSpace) out.append(' ')
            pendingSpace = false
            out.append(if (c in 'A'..'Z') c + 0x20 else c)
        }
        return out.toString()
    }

    /**
     * A normalized name without the relay's counter: "dia 2" to "dia", "pixel 8 2" to
     * "pixel 8". Only a trailing " N" with N from 2 to 99 and no leading zero, which is
     * what the dedupe writes; "dia 1", "dia 02" and "dia 100" stay as they are.
     */
    fun withoutCounter(normalized: String): String {
        val space = normalized.lastIndexOf(' ')
        if (space <= 0) return normalized
        val digits = normalized.substring(space + 1)
        val shaped = when (digits.length) {
            1 -> digits[0] in '1'..'9'
            2 -> digits[0] in '1'..'9' && digits[1] in '0'..'9'
            else -> false
        }
        if (!shaped) return normalized
        val n = digits.toInt()
        if (n < 2 || n > MAX_COUNTER) return normalized
        return normalized.substring(0, space)
    }

    /** The two halves a match compares: the app name without its counter, and the computer name. */
    data class Key(val app: String, val computer: String)

    fun replacingKey(label: String): Key {
        val i = label.indexOf(SEP)
        val app = if (i == -1) label else label.substring(0, i)
        val computer = if (i == -1) "" else label.substring(i + SEP.length)
        return Key(withoutCounter(normalizeName(app)), normalizeName(computer))
    }

    /** The app half of a label as shown: "Dia" from "Dia · MacBook Pro", "Pixel 8" from "Pixel 8". */
    fun appNameOf(label: String): String {
        val i = label.indexOf(SEP)
        return if (i == -1) label else label.substring(0, i)
    }

    /**
     * The old entry this phone may be replacing, or null. A candidate is another entry
     * that is not this phone and not on its removed list; is the same kind; has the same
     * app name once the counter is stripped and the same computer name; is offline and
     * was last seen more than a day before [nowMs]; and joined, and was last seen, before
     * this phone joined. With several, the one seen most recently; ties go to the newer
     * `createdAt`, then the larger id, so every client picks the same one.
     */
    fun findReplacedSelf(
        selfId: String,
        list: List<Endpoint>,
        removed: Collection<String>,
        nowMs: Long,
    ): Endpoint? {
        val self = list.firstOrNull { it.id == selfId } ?: return null
        val selfCreated = strictIsoMillis(self.createdAt) ?: return null
        val mine = replacingKey(self.label)
        if (mine.app.isEmpty()) return null

        var best: Endpoint? = null
        var bestSeen = 0L
        var bestCreated = 0L
        for (e in list) {
            if (e.id == selfId || e.id in removed) continue
            if (e.kind != self.kind) continue
            if (e.presence == "online") continue
            val seen = strictIsoMillis(e.lastSeenAt) ?: continue
            val created = strictIsoMillis(e.createdAt) ?: continue
            if (nowMs - seen <= REPLACE_QUIET_MS) continue
            if (created >= selfCreated || seen >= selfCreated) continue
            val theirs = replacingKey(e.label)
            if (theirs.app != mine.app || theirs.computer != mine.computer) continue
            val current = best
            if (
                current == null ||
                seen > bestSeen ||
                (seen == bestSeen && created > bestCreated) ||
                (seen == bestSeen && created == bestCreated && e.id > current.id)
            ) {
                best = e
                bestSeen = seen
                bestCreated = created
            }
        }
        return best
    }

    /** How "Replace" ended. */
    sealed class Outcome {
        /** The old entry was removed and this phone took its name. */
        object Replaced : Outcome()

        /** A fresh list no longer offers the same entry: nothing was done. */
        object NoLongerOffered : Outcome()

        /** The fresh list could not be fetched: nothing was done. */
        data class ListFailed(val error: IOException) : Outcome()

        /** The removal failed: this phone was NOT renamed. */
        data class RemoveFailed(val error: IOException) : Outcome()

        /** The old entry is gone, but this phone could not take its name. */
        data class RenameFailed(val error: IOException) : Outcome()
    }

    /**
     * The steps behind "Replace", in the only order allowed: look again, remove the old
     * entry, and only once that worked take its exact name. Each step is handed in, so
     * the order is tested without a relay.
     *
     * [list] fetches the device list afresh and [removed] reads this phone's removed list;
     * if the match no longer names [oldId], nothing else runs. [remove] is the device
     * row's own Remove (the relay's DELETE plus the removal in the new-device watch, so
     * the group key is rotated; a "not found" counts as removed there); when it throws,
     * [rename] never runs. [rename] is the device row's rename of this phone. Nothing
     * here answers, confirms or accepts any device (L1).
     */
    suspend fun replace(
        selfId: String,
        oldId: String,
        nowMs: () -> Long,
        list: suspend () -> List<Endpoint>,
        removed: () -> Collection<String>,
        remove: suspend (id: String) -> Unit,
        rename: suspend (label: String) -> Unit,
    ): Outcome {
        val fresh = try {
            list()
        } catch (e: IOException) {
            return Outcome.ListFailed(e)
        }
        val old = findReplacedSelf(selfId, fresh, removed(), nowMs())
        if (old == null || old.id != oldId) return Outcome.NoLongerOffered
        try {
            remove(old.id)
        } catch (e: IOException) {
            return Outcome.RemoveFailed(e)
        }
        try {
            rename(old.label)
        } catch (e: IOException) {
            return Outcome.RenameFailed(e)
        }
        return Outcome.Replaced
    }
}
