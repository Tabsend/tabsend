package io.tabsend.app.push

import io.tabsend.app.logic.WakeWatch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable

/**
 * Which of the two ways instant delivery is being honoured, and why [P-11].
 *
 * The screen shows this verbatim-ish, which is the point: the user answers one question
 * ("instant delivery, yes or no?") and the app says what it did about it. The `why` cases
 * exist because "no permanent notification" and "permanent notification, because this phone
 * has no Play Services" and "permanent notification, because you asked for no Google" are
 * three different things to a person and must not render as one.
 */
enum class DeliveryMode {
    /** Google push. Silent: no foreground service, no notification. */
    GOOGLE,

    /** The app's own connection, held up by StreamService and its mandated notification. */
    OWN_CONNECTION,

    /** Instant delivery is off. Polling, and drain on open. */
    OFF,
}

/** Why the app is on the mode it is on. Drives one line of copy and nothing else. */
enum class DeliveryReason {
    /** Google push is working. */
    GOOGLE_ACTIVE,

    /** The user asked for no Google. */
    GOOGLE_REFUSED,

    /** This phone has no Play Services, or this build has no Firebase values. */
    GOOGLE_UNAVAILABLE,

    /** Google push could be used, but there is no wake-up service to ring this phone. */
    NO_FORWARDER,

    /** Enrolment has not succeeded yet — offline, or the forwarder refused. */
    GOOGLE_PENDING,

    /**
     * Enrolled, but wakes stopped arriving, so the app went back to its own connection
     * [2026-10-02, SECURITY_REVIEW G10]. The usual cause is PLANS.md P-9: the relay rings
     * a different wake-up service from the one built into this app.
     */
    GOOGLE_NOT_ARRIVING,

    /** Instant delivery is switched off. */
    DISABLED,
}

data class DeliveryState(val mode: DeliveryMode, val reason: DeliveryReason)

/** What the relay said about its wake-up service. "Could not ask" is its own answer [G8]. */
enum class RelayForwarder { YES, NO, UNKNOWN }

/** What the relay made of a push subscription it was handed by heartbeat. */
enum class RelayAnswer {
    /** Stored. */
    ACCEPTED,

    /** The relay no longer knows this endpoint, so it rings nothing for it either. */
    GONE,

    /** The relay answered and said no (a `forwarder` subscription it cannot ring). */
    REFUSED,

    /** No answer: offline, or the relay is down. */
    UNREACHABLE,
}

/**
 * The parts of a registration a relay call needs, kept so a retirement can outlive the
 * pairing it belongs to: an unpair wipes the registration at once, and the wake token it
 * held still has to be retired afterwards [G9].
 */
@Serializable
data class RelayRef(
    val relayUrl: String,
    val endpointId: String,
    val deviceToken: String,
    val certFingerprint: String? = null,
) {
    /** The same endpoint on the same relay, whatever address it is reached at (P-4). */
    fun sameEndpointAs(other: RelayRef): Boolean =
        endpointId == other.endpointId && deviceToken == other.deviceToken
}

/**
 * A wake token on its way out [2026-10-02, SECURITY_REVIEW G8, G9]. Kept in the store
 * until the forwarder has been told, so being offline at the wrong moment cannot leave a
 * relay ringing a phone that believes it has stopped listening.
 */
@Serializable
data class Retirement(
    val wakeToken: String,
    /** The relay to tell `{transport:"none"}` first, or null once that is done. */
    val relay: RelayRef? = null,
    /**
     * True while the phone is still paired to that relay: the relay must accept `none`
     * before the forwarder forgets the token, or it would go on ringing a dead token while
     * the phone believes it had switched over. False after an unpair or a Start fresh: the
     * relay left behind is told once, best effort, because it may be gone for good, and
     * the revoke at the forwarder is what actually stops the ringing.
     */
    val relayMustAccept: Boolean = false,
)

/** A live Google push enrolment. */
data class Enrolment(
    val wakeToken: String,
    val pushToken: String,
    /** `endpointId@relayUrl` of the relay told about [wakeToken]. */
    val announcedTo: String,
    /** When this relay was handed this wake token (phone clock), for [WakeWatch]. */
    val enrolledAt: Long,
)

/** The stored state `PushCore` works on. Implemented over `Store`, and by a fake in tests. */
interface PushState {
    /** The current pairing, or null when unpaired. */
    val paired: RelayRef?
    val instantDelivery: Boolean
    val avoidGoogle: Boolean
    val enrolment: Enrolment?
    /** Set when [WakeWatch] decided wakes stopped arriving [G10]. */
    val wakesMissedAt: Long?
    val retirements: List<Retirement>

    /** When a wake last arrived (phone clock), or null. */
    val lastWakeAt: Long?

    /** When the current strike was recorded, or null. See [WakeWatch]. */
    val wakeStrikeAt: Long?

    /**
     * When a drain last reached the relay before the one being judged (phone clock), or
     * null. A long gap means this phone may simply have been offline [WakeWatch].
     */
    val previousContactAt: Long?

    /** The relay's clock minus this phone's, from the heartbeat; 0 when not known. */
    val relayClockOffsetMs: Long

    /**
     * Save an enrolment, but only if the pairing is still the one it was made for [G11].
     * Atomic with an unpair, so an enrolment that finishes after one never lands in the
     * wiped store. Returns whether it was saved. [resetWatch] clears any strike and any
     * "wakes stopped arriving" verdict: a new wake token, or the user asking to try again.
     * A token Google rotated, or the same relay at a new address, keeps them.
     */
    fun commitEnrolment(expectedTarget: String, enrolment: Enrolment, resetWatch: Boolean): Boolean

    /** Record a strike or a verdict, but only about the enrolment that was judged. */
    fun recordWakeVerdict(judgedWakeToken: String, strikeAt: Long?, missedAt: Long?)

    /** Drop the live enrolment and queue its token for retirement, in one step. */
    fun retireEnrolment(retirement: Retirement)

    /** Read-modify-write the retirement queue. */
    fun updateRetirements(transform: (List<Retirement>) -> List<Retirement>)

    /** The relay's last definite answer about its wake-up service, for the screen. */
    var relayForwarderKnown: Boolean?
}

interface RelayPort {
    fun forwarderAdvertised(relay: RelayRef): RelayForwarder

    /** Rotate the relay's push subscription by heartbeat: a wake token, or null for none. */
    fun setSubscription(relay: RelayRef, wakeToken: String?): RelayAnswer
}

interface ForwarderPort {
    /** Enrol a Google push token; a wake token, or null on any refusal or outage. */
    fun register(pushToken: String): String?

    /** Retire a wake token. True when the forwarder answered at all: it answers alike. */
    fun revoke(wakeToken: String): Boolean
}

interface GooglePort {
    /** This build carries the Firebase values. */
    val configured: Boolean

    /**
     * This phone has Google Play Services [G4]: true, false, or null while it is being
     * updated and cannot say. Null changes nothing, as an unreachable relay changes nothing.
     */
    fun available(): Boolean?

    /** Firebase may hold a registration for this install [G3]. */
    fun inUse(): Boolean

    /** This install's push token, starting Firebase to get it. Null if it cannot be had. */
    suspend fun token(): String?

    /** Delete the push token and the Firebase installation [G3]. True when both went. */
    suspend fun forget(): Boolean
}

/**
 * Keeps the delivery mechanism matching the user's one switch, as plain Kotlin so every
 * branch is tested on the JVM [2026-10-02, SECURITY_REVIEW G24]. `PushSetup` supplies the
 * Android halves.
 *
 * [sync] is the only real entry point and is safe to call as often as anything changes.
 * It works out what the mode SHOULD be, then makes the things that implement it agree:
 * the retirements still owed, the Google enrolment, and the relay's push subscription.
 * StreamService is the caller's to start or stop afterwards, from the state this leaves.
 *
 * Ordering matters in one place: when switching ONTO Google push, the relay is told about
 * the wake token BEFORE the enrolment is saved, and the saved enrolment is what stops
 * StreamService. For a moment both paths are live, which is harmless, whereas the other
 * order leaves a window where nothing can reach the phone at all.
 */
class PushCore(
    private val state: PushState,
    private val relay: RelayPort,
    /** Null when this build has no wake-up service to register with. */
    private val forwarder: ForwarderPort?,
    private val google: GooglePort,
    private val now: () -> Long,
    private val log: (String) -> Unit = {},
) {

    companion object {
        /**
         * ONE lock for every sync and retirement in the process [2026-10-02, SECURITY_REVIEW
         * G11]. Sync runs at app start, from the screen, after an unpair, from the heartbeat
         * and when Google rotates the token; two at once could enrol one token twice (the
         * second wake token killing the first) or write an enrolment after an unpair's wipe.
         */
        private val lock = Mutex()

        fun target(relay: RelayRef): String = "${relay.endpointId}@${relay.relayUrl}"
    }

    /** What the app would be doing right now, without changing anything. For rendering. */
    fun delivery(): DeliveryState {
        if (state.paired == null || !state.instantDelivery) {
            return DeliveryState(DeliveryMode.OFF, DeliveryReason.DISABLED)
        }
        if (state.enrolment != null) {
            return if (state.wakesMissedAt != null) {
                DeliveryState(DeliveryMode.OWN_CONNECTION, DeliveryReason.GOOGLE_NOT_ARRIVING)
            } else {
                DeliveryState(DeliveryMode.GOOGLE, DeliveryReason.GOOGLE_ACTIVE)
            }
        }
        val reason = when {
            state.avoidGoogle -> DeliveryReason.GOOGLE_REFUSED
            !google.configured || google.available() == false -> DeliveryReason.GOOGLE_UNAVAILABLE
            forwarder == null || state.relayForwarderKnown == false -> DeliveryReason.NO_FORWARDER
            else -> DeliveryReason.GOOGLE_PENDING
        }
        return DeliveryState(DeliveryMode.OWN_CONNECTION, reason)
    }

    /** Bring the mechanism into line with the settings. Never throws on a network failure. */
    suspend fun sync(): DeliveryState = lock.withLock { reconcile(forceNewEnrolment = false) }

    /**
     * "Try Google push again" [G10]: a fresh wake token, a fresh watch, and StreamService
     * stops again once the relay has it. If wakes still do not arrive, [WakeWatch] notices
     * the same way it did the first time.
     */
    suspend fun retryGoogle(): DeliveryState = lock.withLock { reconcile(forceNewEnrolment = true) }

    private suspend fun reconcile(forceNewEnrolment: Boolean): DeliveryState {
        processRetirements()
        val relayRef = state.paired
        if (relayRef == null || !state.instantDelivery) {
            retireActive(relayRef)
            forgetGoogleIfUnused()
            return delivery()
        }
        val eligible = !state.avoidGoogle && google.configured && forwarder != null
        val playServices = if (eligible) google.available() else false
        // Play Services in the middle of an update cannot say; like an unreachable relay,
        // that changes nothing.
        if (playServices == null) return delivery()
        if (!playServices) {
            retireActive(relayRef)
            forgetGoogleIfUnused()
            return delivery()
        }
        when (relay.forwarderAdvertised(relayRef)) {
            // Could not ask: change nothing [G8]. An offline sync used to read as "this relay
            // has no wake-up service" and threw a working enrolment away, without telling
            // the relay, which then rang a token this phone had forgotten.
            RelayForwarder.UNKNOWN -> return delivery()
            RelayForwarder.NO -> {
                state.relayForwarderKnown = false
                retireActive(relayRef)
                forgetGoogleIfUnused()
            }
            RelayForwarder.YES -> {
                state.relayForwarderKnown = true
                enrol(relayRef, forceNewEnrolment)
            }
        }
        return delivery()
    }

    /**
     * Get a Google token, enrol it at the forwarder, and hand the relay the wake token.
     *
     * Re-enrols when Google has rotated the token, re-announces when the relay endpoint
     * changed, and does nothing at all when the stored enrolment still matches — the common
     * case on every app start.
     */
    private suspend fun enrol(relayRef: RelayRef, forceNew: Boolean) {
        val fwd = forwarder ?: return
        val target = target(relayRef)
        val pushToken = google.token() ?: return
        val existing = state.enrolment
        if (!forceNew && existing != null && existing.pushToken == pushToken) {
            if (existing.announcedTo == target) return
            // The enrolment is good but a DIFFERENT relay endpoint knows about it — a relay
            // switch (ADR-0013) or the same relay at a new address (P-4). Re-announce rather
            // than re-mint: the token is the forwarder's and is still live. What was decided
            // about wakes stands for the same relay at a new address, which rings the same
            // wake-up service; a different relay may not, so it gets a fresh watch [G10].
            if (relay.setSubscription(relayRef, existing.wakeToken) == RelayAnswer.ACCEPTED) {
                val announced = existing.copy(announcedTo = target, enrolledAt = now())
                val sameRelay = existing.announcedTo.substringBefore('@') == relayRef.endpointId
                if (state.commitEnrolment(target, announced, resetWatch = !sameRelay)) {
                    supersedeRelaySteps(relayRef, announced.wakeToken)
                }
            }
            return
        }

        // Registering the same push token again replaces the old wake token at the
        // forwarder, so a forced re-enrolment needs no revoke of its own.
        val wakeToken = fwd.register(pushToken) ?: return
        // Told to the relay BEFORE anything is saved: a stored token the relay does not know
        // would make the screen claim Google push while the relay still rings nobody.
        when (relay.setSubscription(relayRef, wakeToken)) {
            RelayAnswer.ACCEPTED -> {
                val enrolment = Enrolment(wakeToken, pushToken, target, now())
                // A first enrolment, or the user's "try again", starts a new watch for missed
                // wakes; a token Google rotated is the same doorbell and keeps it [G10].
                val resetWatch = existing == null || forceNew
                if (!state.commitEnrolment(target, enrolment, resetWatch)) {
                    // Unpaired, or moved, while this was in flight [G11]. The relay just took
                    // the token, so it is told `none` once and the forwarder forgets it.
                    state.updateRetirements { it + Retirement(wakeToken, relayRef, relayMustAccept = false) }
                    processRetirements()
                    return
                }
                supersedeRelaySteps(relayRef, wakeToken)
                log("Google push enrolled; instant delivery needs no foreground service")
            }
            else -> {
                // The forwarder minted a token the relay never learned. Revoke it rather
                // than leave an enrolment nothing will use.
                fwd.revoke(wakeToken)
                // Registering the same push token again replaced the old wake token at the
                // forwarder, so an enrolment still holding it is dead now too. Retire it
                // rather than go on claiming it.
                if (existing != null && existing.pushToken == pushToken) retireActive(relayRef)
            }
        }
    }

    /**
     * The relay just took [liveWakeToken] for this endpoint, which replaced whatever the
     * endpoint's one subscription slot held. A `none` still queued for that endpoint would
     * now overwrite the live token, so its relay step is done; only the forwarder is left.
     * Found by the 2026-10-02 verification pass: a `none` that had failed offline was sent
     * after the user turned Google push back on, and silently unhooked the new enrolment.
     */
    private fun supersedeRelaySteps(relayRef: RelayRef, liveWakeToken: String) {
        state.updateRetirements { list ->
            list.map { retirement ->
                val queued = retirement.relay
                if (queued != null && retirement.wakeToken != liveWakeToken && queued.sameEndpointAs(relayRef)) {
                    retirement.copy(relay = null)
                } else {
                    retirement
                }
            }
        }
    }

    /**
     * Judge a drain a wake did NOT start [G10]: did its tabs arrive with no wake near them?
     * [deliveredAt] is each delivered tab's `createdAt` on the relay's clock. Returns true
     * when this drain decided that wakes stopped arriving, so the caller starts the phone's
     * own connection. Takes no lock: the verdict is written only about the enrolment it
     * judged, so a sync that replaced it meanwhile loses nothing.
     */
    fun judgeDrain(deliveredAt: List<Long>, now: Long): Boolean {
        val enrolment = state.enrolment ?: return false
        if (state.wakesMissedAt != null || deliveredAt.isEmpty()) return false
        val onPhoneClock = deliveredAt.map { it - state.relayClockOffsetMs }
        return when (
            WakeWatch.judge(
                enrolledAt = enrolment.enrolledAt,
                lastWakeAt = state.lastWakeAt,
                strikeAt = state.wakeStrikeAt,
                previousContactAt = state.previousContactAt,
                delivered = onPhoneClock,
                now = now,
            )
        ) {
            WakeWatch.Verdict.FINE -> false
            WakeWatch.Verdict.STRIKE -> {
                state.recordWakeVerdict(enrolment.wakeToken, strikeAt = now, missedAt = null)
                log("A tab arrived that no wake announced; watching for a second")
                false
            }
            WakeWatch.Verdict.MISSED -> {
                state.recordWakeVerdict(enrolment.wakeToken, strikeAt = null, missedAt = now)
                log("Wakes through Google stopped arriving; back on this app's own connection")
                true
            }
        }
    }

    /**
     * Give up the live enrolment: it moves to the retirement queue, so StreamService can take
     * over at once, and the queue tells the relay and then the forwarder.
     */
    private fun retireActive(relayRef: RelayRef?) {
        val enrolment = state.enrolment ?: return
        state.retireEnrolment(
            Retirement(enrolment.wakeToken, relayRef, relayMustAccept = relayRef != null),
        )
        log("Google push retired; delivery falls back to this app's own connection")
        processRetirements()
    }

    /**
     * Work through the retirement queue: tell the relay `none`, then revoke at the
     * forwarder, each step kept until it succeeds [G8]. Ordered so the relay stops first:
     * a relay still holding a revoked wake token would ring a forwarder that answers 202 and
     * does nothing, so the phone would look reachable and never ring.
     */
    private fun processRetirements() {
        for (retirement in state.retirements) {
            var current = retirement
            val relayRef = current.relay
            if (relayRef != null) {
                val answer = relay.setSubscription(relayRef, null)
                val told = answer == RelayAnswer.ACCEPTED || answer == RelayAnswer.GONE
                if (!told && current.relayMustAccept) continue
                current = current.copy(relay = null)
                state.updateRetirements { list ->
                    list.map { if (it.wakeToken == retirement.wakeToken) current else it }
                }
            }
            val fwd = forwarder
            if (fwd == null || fwd.revoke(current.wakeToken)) {
                state.updateRetirements { list -> list.filterNot { it.wakeToken == retirement.wakeToken } }
            }
        }
    }

    /**
     * Delete the push token and the Firebase installation once nothing here uses them [G3],
     * so a phone that turned Google push off, or unpaired, stops being addressable through
     * Google and stops checking in with it. Retried on every sync until it works.
     */
    private suspend fun forgetGoogleIfUnused() {
        if (state.enrolment != null || !google.inUse()) return
        if (!google.forget()) log("Could not reach Google to delete this install's push token yet")
    }
}
