package io.tabsend.app.logic

/**
 * Why a send didn't land, and the sentence to say about it.
 *
 * Hand-mirrored from the extension's `lib/strings.ts` + `lib/health.ts`
 * (INTERACTION_FLOWS §4a, ADR-0008 amendment 2026-07-29). `shared/` is
 * TypeScript and can't be consumed from Kotlin, so the copy lives twice; what
 * MUST stay in step are the two closed wire sets it switches on —
 * `ApiErrorCode` and `SendResponse.rejected[].reason` — which
 * [ALL_API_ERROR_CODES] / [ALL_REJECTION_REASONS] pin down for the tests.
 *
 * Two bugs this replaces, both inherited when the app was ported from the
 * extension's pre-amendment send path:
 *
 *  1. `"Relay rejected the send (${rejected.reason})"` put a wire code in front
 *     of a person. `unknown_target` is a string for a program.
 *  2. Any transport failure rendered "No connection — will send when you're back
 *     online", which for a self-hosted relay is a WRONG diagnosis: the phone's
 *     network is fine, the relay isn't answering, and the user checks their wifi
 *     and finds nothing wrong (dogfood 2026-07-29).
 */
sealed interface SendFailure {
    /** This phone has no network at all. Nothing to fix but the wifi. */
    data object PhoneOffline : SendFailure

    /** Network is up; the relay never answered. Names the address it tried. */
    data class RelayUnreachable(val relayUrl: String) : SendFailure

    /**
     * The relay took the request but refused this item (per-item reason set).
     *
     * [limit] rides along with `limit_reached` and names WHICH per-group cap said
     * no [0030], which is what lets the copy describe the wait instead of a
     * generic refusal. That one reason is also the only refusal here that is NOT
     * final: every cap clears itself, so the tab stays queued and is retried by
     * the ordinary flush, exactly like a [RelayBusy] answer. The rest stay final.
     */
    data class RelayRejected(val reason: String, val limit: String? = null) : SendFailure

    /** The relay answered the whole request with an error envelope. */
    data class RelayError(val code: String) : SendFailure

    /**
     * The relay answered, but with something that says "not now" rather than
     * "no": a 429, or any 5xx — including the HTML 502/504 a reverse proxy or a
     * restarting container returns, which [ApiClient] can only map to the
     * generic `internal` code.
     *
     * Recoverable, and that is the whole point of separating it from
     * [RelayError]: treating a 502 as a definite refusal DISCARDED the tab, and
     * in a queue flush discarded every queued tab in one pass. A relay that is
     * merely having a bad minute must not cost anyone their links.
     */
    data object RelayBusy : SendFailure

    /** The relay no longer accepts this phone's token. */
    data object RelayUnauthorized : SendFailure

    /**
     * Tabsend itself stopped holding the tab. Not a thing the relay said — this
     * is the ONE failure the client decides on its own, which is why it is a
     * classification and not a wire code, and why `shared/src/types.ts` grows no
     * member for it.
     *
     * Final, and deliberately so: the queue kept the tab through every 429,
     * every 5xx and every silence, and this is what eventually ends that.
     * [GaveUpReason.TOO_OLD] is the relay's own message TTL running out;
     * [GaveUpReason.QUEUE_FULL] is the size cap making room for the send the
     * user just made. Told apart because they are told to the user differently,
     * and one sentence for both would be false half the time.
     */
    data class GaveUp(val reason: GaveUpReason) : SendFailure

    /** Nothing sendable in what was shared. */
    data object NothingToSend : SendFailure
}

/** Why Tabsend stopped holding a tab. See [OutboundQueue] for the two bounds. */
enum class GaveUpReason { TOO_OLD, QUEUE_FULL }

/** Three tones. The tone is a promise about where the tab actually is. */
enum class SendTone { SUCCESS, PENDING, ERROR }

/**
 * What to show for one completed send.
 *
 * [title] is the shared page's title, so a user with several sends in flight
 * knows WHICH one is being reported — the thing a bare "Sent to Arc" never said.
 */
data class SendBanner(
    val tone: SendTone,
    val headline: String,
    val title: String? = null,
    val detail: String? = null,
)

/**
 * Feedback copy. The §4 copy table (locked, and predating the no-em-dash rule)
 * plus the failure lines added by the 2026-07-29 amendment, which use short
 * sentences instead.
 */
object Feedback {
    // The LOCKED §4 copy table, which predates the no-em-dash rule. Kept as the
    // shared reference for what the three clients agree to say on success, so
    // don't delete these for want of a caller: the tests assert them, and the
    // banner headlines below are derived from the same wording.
    fun sentOnline(label: String): String = "Sent to $label"
    fun sentOffline(label: String): String = "Sent to $label — opens when it wakes"
    fun sourceOffline(): String = "No connection — will send when you're back online"
    fun noDevices(): String = "No devices yet — pair one to start sending"
    fun hardError(): String = "Couldn't send — check Tabsend is still linked"

    /** The no-label fallback. NOT a proper noun, hence the mid-sentence rule below. */
    const val THAT_DEVICE = "that device"

    /**
     * One sentence saying what happened and, where there is one, what to do.
     *
     * Nothing here may leak a wire code, and every line places the device label
     * MID-sentence: a real label ("Arc · Mac mini") is a proper noun but
     * [THAT_DEVICE] is not, so a line opening with it would read as a lowercase
     * sentence. Both rules are enforced by SendFeedbackTest.
     */
    fun failureLine(failure: SendFailure, targetLabel: String? = null): String {
        val device = targetLabel ?: THAT_DEVICE
        return when (failure) {
            SendFailure.PhoneOffline ->
                "You're offline. This tab sends itself as soon as you're back."
            is SendFailure.RelayUnreachable ->
                "Can't reach your relay at ${failure.relayUrl}. The tab is held here and " +
                    "sends itself once the relay answers again."
            is SendFailure.RelayRejected -> rejectionLine(failure.reason, device, failure.limit)
            is SendFailure.RelayError -> relayErrorLine(failure.code, device)
            SendFailure.RelayBusy ->
                "Your relay is having trouble right now. The tab is held here and sends " +
                    "itself once the relay is answering properly again."
            SendFailure.RelayUnauthorized -> UNAUTHORIZED_LINE
            is SendFailure.GaveUp -> givenUpLine(failure.reason)
            SendFailure.NothingToSend -> "There's no link in what you shared."
        }
    }

    /**
     * The two ways Tabsend gives up on a tab it was holding.
     *
     * Both name the number that decided it, because the number is the only thing
     * that makes the sentence answerable: "seven days" tells a self-hoster their
     * relay has been down for a week, and "at most 200" tells someone who shared
     * all evening exactly what happened to the rest. Neither line names a device,
     * so all three clients say them verbatim and the §4c "this phone" / "this
     * browser" rule does not bite.
     */
    private fun givenUpLine(reason: GaveUpReason): String = when (reason) {
        GaveUpReason.TOO_OLD ->
            "This tab waited ${OutboundQueue.MAX_AGE_DAYS} days for your relay and was never " +
                "taken, so Tabsend has stopped holding it. Send it again once the relay is answering."
        GaveUpReason.QUEUE_FULL ->
            "Tabsend holds at most ${OutboundQueue.MAX_ITEMS} tabs while your relay isn't taking " +
                "them, and this one was the oldest. Send it again once the relay is answering."
    }

    /**
     * Per-item refusals [SendResponse.rejected] — always about ONE target. An
     * unrecognised reason folds to the generic line rather than leaking: a relay
     * newer than this app will send reasons we have no copy for.
     */
    private fun rejectionLine(
        reason: String,
        device: String,
        limit: String? = null,
    ): String = when (reason) {
        "unknown_target" ->
            "Your relay doesn't know $device any more. Pair it again, then send this tab a second time."
        "expired_key" ->
            "The keys on $device have changed since this phone last saw them. Open Tabsend " +
                "once to pick up the new ones, then send again."
        "not_in_group" ->
            "Your relay says $device has left your group of devices."
        "limit_reached" -> capHeldLine(limit)
        else -> INTERNAL_LINE
    }

    /**
     * A per-group cap refused the item [0030]. Said as a wait, not as a failure,
     * because every one of these caps clears itself: the send window rolls over
     * within a minute of the relay's own clock, and the queue caps drain as the
     * receiving device reads what is already waiting for it. The tab stays in
     * the same outbound queue that holds tabs through an outage, and the same
     * flush sends it.
     *
     * Named per cap because the two waits end for different reasons, and
     * "shortly" would be a lie about a queue that only moves when someone picks
     * up their phone. `endpoints` cannot refuse a send (it refuses a join), and
     * a fifth cap added later has no literal here, so both take the general line
     * — which is true of every cap, and is why the relay may omit the field.
     *
     * Word-for-word the same sentences as `lib/strings.ts` and
     * `SendFeedback.swift`; only the extension can pluralize them, because only
     * it can send several tabs at once.
     */
    private fun capHeldLine(limit: String?): String = when (limit) {
        "sends_per_window" ->
            "Your relay is pacing sends for your group right now. This tab is queued and " +
                "will send itself shortly."
        "queued_messages", "queued_bytes" ->
            "Your relay is holding as much as your group's limit allows. This tab is queued " +
                "and will send once the receiving device catches up."
        else ->
            "Your relay has reached a limit for your group. This tab is queued and will send " +
                "itself once there is room."
    }

    /** Whole-request errors [ApiError.code]. The relay answered, and said no. */
    private fun relayErrorLine(code: String, device: String): String = when (code) {
        "not_found" ->
            "Your relay couldn't find $device."
        "forbidden" ->
            "Your relay wouldn't let this phone send to $device."
        "invalid_request" ->
            "Your relay didn't understand this send. It's most likely running an older " +
                "version than this phone. Updating it should fix this."
        // classify() routes a 429 to RelayBusy, which DOES retry itself, so this
        // is belt-and-braces for a relay that sends the code with another status.
        "rate_limited" ->
            "Your relay is busy right now. Give it a moment and send again."
        // Both mean "your token is no good"; classify() routes them to
        // RelayUnauthorized before they get here, so this is belt-and-braces.
        "unauthorized", "endpoint_removed" -> UNAUTHORIZED_LINE
        "invalid_pairing_code" ->
            "That pairing link is no longer valid."
        // Only ever answered to a register/create call [ADR-0022], never to a send;
        // it has a line so the wire set stays fully covered as it grows.
        "group_exists" ->
            "Your relay already hosts a group of devices."
        // Not reachable on a send either: of the per-group caps, only the endpoint
        // one can refuse a whole call, and it does that to a join [0030]. A pairing
        // mint can also answer `limit_reached` [0031 amended], and does not come
        // through here: the mint's own error path shows the relay's message, which is
        // the one that names that limit.
        "limit_reached" -> DEVICE_LIMIT_LINE
        else -> INTERNAL_LINE
    }

    private const val UNAUTHORIZED_LINE =
        "Your relay doesn't recognise this phone any more. Set Tabsend up again here to start sending."
    private const val INTERNAL_LINE =
        "Something went wrong inside your relay. It may be worth checking that it is healthy."

    /**
     * The device cap turned this phone away at the door [0030]. Said in the
     * client's own words rather than passing the relay's prose through:
     * `message` is written for a log and is explicitly allowed to change
     * (`shared/src/types.ts` §10b), and this is a status line a person reads.
     *
     * FINAL, which is what makes it read nothing like [capHeldLine] above. A
     * group that is full stays full until a person removes a device, so there is
     * no retry to promise and the only useful sentence names the action. Nothing
     * is queued either: pairing never got as far as an identity on the relay.
     *
     * Word-for-word the same sentence as `lib/strings.ts` and `SendFeedback.swift`.
     */
    const val DEVICE_LIMIT_LINE =
        "Your relay has reached its device limit for your group. Remove a device you are not " +
            "using, then pair this one again."

    /** True when the tab is safely queued and will retry itself (no user action). */
    fun isRecoverable(failure: SendFailure): Boolean =
        failure is SendFailure.PhoneOffline ||
            failure is SendFailure.RelayUnreachable ||
            failure is SendFailure.RelayBusy ||
            (failure is SendFailure.RelayRejected && isCapRefusal(failure.reason))
    // GaveUp is deliberately NOT here. It is the thing that ENDS the retrying;
    // reading it as "will retry itself" would put the tab back in the pending
    // tone and re-make the promise the queue has just stopped keeping.

    /**
     * The one per-item refusal that is not final [0030].
     *
     * A cap refusal is the relay saying "not this minute", not "no" — the send
     * window rolls over on its own, and the queue caps drain as the target reads
     * its tabs. Treating it as final threw the tab away over a wait of about a
     * minute, which is the same mistake [SendFailure.RelayBusy] exists to
     * prevent for a 429.
     *
     * Keyed on the REASON and never on the limit: a relay that names no cap has
     * still said the same thing, and [capHeldLine] has a sentence for that.
     */
    fun isCapRefusal(reason: String): Boolean = reason == "limit_reached"

    /**
     * The banner for a completed send. Only [SendTone.SUCCESS] may say "Sent",
     * and it means the relay ACCEPTED the tab — not that the button was tapped.
     * A tab merely held in the outbound queue is `ok` (it isn't lost) but gets
     * [SendTone.PENDING]; claiming "Sent" there is the exact lie that made a
     * dead relay invisible.
     */
    fun banner(outcome: SendOutcomeView): SendBanner {
        val label = outcome.targetLabel ?: "your device"
        val failure = outcome.failure
        if (failure != null) {
            val recoverable = isRecoverable(failure)
            return SendBanner(
                tone = if (recoverable) SendTone.PENDING else SendTone.ERROR,
                headline = if (recoverable) "Waiting to send to $label" else "Couldn't send to $label",
                title = outcome.title,
                detail = failureLine(failure, outcome.targetLabel),
            )
        }
        if (!outcome.ok) {
            return SendBanner(SendTone.ERROR, "Couldn't send to $label", outcome.title, hardError())
        }
        if (outcome.queued) {
            return SendBanner(SendTone.SUCCESS, "Sent to $label", outcome.title, "Opens when it wakes")
        }
        return SendBanner(SendTone.SUCCESS, "Sent to $label", outcome.title)
    }

    /**
     * Heading for the tabs still sitting on THIS phone because the relay hasn't
     * taken them. Deliberately distinct from any "N waiting for <device>" count,
     * which counts tabs the relay already HAS and is holding for a sleeping
     * target — a different promise, and merging them lets an outage read as a
     * normal sleeping device.
     */
    fun heldTabsHeading(count: Int): String =
        if (count == 1) "Waiting on this phone" else "$count tabs waiting on this phone"

    /**
     * What to call a held tab in a list. The title is what the user recognises;
     * the site is the fallback, because a bare URL path tells nobody anything.
     */
    fun heldTabLabel(title: String?, url: String?): String {
        if (!title.isNullOrBlank()) return title
        if (url.isNullOrBlank()) return "Untitled tab"
        return hostOf(url) ?: url
    }

    /** Confirmation that the queue drained, naming the tab when there's just one. */
    fun recoveredLine(count: Int, firstTitle: String? = null): String = when {
        count == 1 && !firstTitle.isNullOrBlank() -> "Sent “$firstTitle”"
        count == 1 -> "Sent the tab that was waiting"
        else -> "Sent $count tabs that were waiting"
    }

    /**
     * The standing relay-outage line, for a surface the user opens LATER. Not
     * tied to any one send: it answers "why did nothing arrive?" for someone who
     * has already walked away from the tab they shared.
     */
    fun relayDownLine(relayUrl: String, sinceMinutes: Int): String {
        val ago = when {
            sinceMinutes < 1 -> "just now"
            sinceMinutes < 60 -> "${sinceMinutes}m ago"
            else -> "${Math.round(sinceMinutes / 60.0)}h ago"
        }
        return "Can't reach your relay at $relayUrl. It last answered $ago, and sends are " +
            "being held until it's back."
    }

    /**
     * Host of a URL, by hand rather than via `android.net.Uri` — this whole
     * object is pure so the copy rules can be tested on the JVM without
     * Robolectric, which is the only reason those tests are cheap enough to
     * cover every member of both wire sets.
     */
    private fun hostOf(url: String): String? {
        val scheme = url.indexOf("://")
        if (scheme < 0) return null
        val rest = url.substring(scheme + 3)
        val host = rest.takeWhile { it != '/' && it != '?' && it != '#' }
            .substringAfterLast('@')      // strip any userinfo
            .substringBefore(':')          // strip the port
        return host.takeIf { it.isNotEmpty() }
    }
}

/** The subset of a send's outcome the copy needs. Kept small so tests are pure. */
data class SendOutcomeView(
    val ok: Boolean,
    val queued: Boolean,
    val targetLabel: String?,
    val title: String? = null,
    val failure: SendFailure? = null,
)

/**
 * The two closed wire sets, mirrored from `shared/src/types.ts` so a test can
 * assert every member produces a sentence. When the relay grows a code, adding
 * it here fails the test until it has copy — which is how `group_exists` was
 * caught in the extension.
 */
val ALL_API_ERROR_CODES = listOf(
    "unauthorized",
    "endpoint_removed",
    "forbidden",
    "not_found",
    "invalid_request",
    "invalid_pairing_code",
    "group_exists",
    // A per-group limit refusing a whole call: the endpoint cap on a register
    // [0030], or the live-link limit on a pairing mint [0031 amended]. Listed here so
    // the copy test covers it.
    "limit_reached",
    "rate_limited",
    "internal",
)

/** [SendResponse.rejected[].reason] — its own set, and NOT errors (still HTTP 200). */
val ALL_REJECTION_REASONS = listOf("unknown_target", "expired_key", "not_in_group", "limit_reached")

/**
 * [SendResponse.rejected[].limit] — which per-group cap refused the item [0030].
 * Rides with `limit_reached` only. `endpoints` can refuse a join but never a
 * send; it is listed anyway so a test covers the line it would get if one ever
 * arrived, which is the same general line an unnamed or future cap gets.
 */
val ALL_GROUP_LIMITS = listOf("endpoints", "queued_messages", "queued_bytes", "sends_per_window")
