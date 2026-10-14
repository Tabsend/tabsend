package io.tabsend.app.push

import android.content.Context
import android.util.Log
import io.tabsend.app.net.ApiClient
import io.tabsend.app.net.ApiException
import io.tabsend.app.receive.StreamService
import io.tabsend.app.store.Store
import io.tabsend.app.wire.PushSubscription
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.IOException

/**
 * Keeps the delivery mechanism matching the user's one switch: the Android half of
 * [PushCore], which holds every decision.
 *
 * [sync] is safe to call as often as anything changes — app start, the toggle, a rotated
 * Google token, after an unpair, and from the heartbeat while anything is still owed. Each
 * call settles the core under its process-wide lock and then starts or stops StreamService
 * to match what it left.
 */
object PushSetup {

    private const val TAG = "TabsendPush"

    /**
     * What the app would be doing right now, without changing anything. For rendering.
     *
     * Cheap and synchronous: it reads stored state and asks Play Services whether it exists,
     * and never touches the network. A screen must not wait on Google to draw a line of text.
     */
    fun state(context: Context): DeliveryState = core(context).delivery()

    /**
     * Bring the mechanism into line with the settings, paired or not: an unpaired phone may
     * still owe a retirement. Returns the state it settled on. Never throws on a network
     * failure; every failure ends on the app's own connection, which works.
     */
    suspend fun sync(context: Context): DeliveryState = settle(context) { it.sync() }

    /** "Try Google push again", after wakes stopped arriving [G10]. */
    suspend fun retryGoogle(context: Context): DeliveryState = settle(context) { it.retryGoogle() }

    /**
     * Run one settling step, then start or stop StreamService to match what it left.
     *
     * Nothing it throws may reach the caller: sync runs at every start from a scope with no
     * handler, so an exception here would end the process at every start until the app's
     * data was cleared (found by the 2026-10-02 verification pass: a relay answering with a
     * page the app cannot read did exactly that). What failed is retried at the next sync.
     */
    private suspend fun settle(
        context: Context,
        step: suspend (PushCore) -> DeliveryState,
    ): DeliveryState = withContext(Dispatchers.IO) {
        val core = core(context)
        val settled = try {
            step(core)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Log.w(TAG, "Could not settle push delivery; retrying later: ${e.message}")
            core.delivery()
        }
        StreamService.sync(context)
        settled
    }

    /**
     * Whether a sync is owed even though nothing changed: a wake token still to be retired,
     * or a Google registration to delete because Google push is no longer wanted. The
     * heartbeat asks, so an offline moment is retried within minutes rather than at the
     * next app start [G8]. An enrolment that keeps failing is not retried from here: it
     * waits for the next start, the screen or a new token, as it always did, rather than
     * signing up at the wake-up service every few minutes for ever.
     */
    fun hasPendingWork(context: Context): Boolean {
        val store = Store.get(context)
        if (store.retirements.isNotEmpty()) return true
        val googleUnwanted = !store.isRegistered || !store.instantDelivery || store.avoidGoogle
        return googleUnwanted && store.wakeToken == null && GooglePush.inUse(context)
    }

    /**
     * After a drain that reached the relay [G10]. One a wake did not start is judged: did
     * its tabs arrive with no wake near them? Then this drain's own time is recorded, which
     * is what tells the next judgement whether the phone was in touch with its relay or may
     * have been offline. A verdict starts the phone's own connection; on Android 12 and
     * later a start from the background may be refused, and then it starts the next time a
     * Tabsend screen opens or a tab notification is tapped.
     */
    fun afterDrain(context: Context, deliveredCreatedAt: List<Long>, fromWake: Boolean) {
        val store = Store.get(context)
        val now = System.currentTimeMillis()
        if (!fromWake && core(context).judgeDrain(deliveredCreatedAt, now)) {
            StreamService.sync(context)
        }
        store.lastContactAt = now
    }

    private fun core(context: Context): PushCore {
        val app = context.applicationContext
        val store = Store.get(app)
        val forwarderUrl = GooglePush.forwarderUrl
        return PushCore(
            state = StorePushState(store),
            relay = RelayClient,
            forwarder = forwarderUrl?.let { ForwarderClient(it) },
            google = GoogleClient(app),
            now = { System.currentTimeMillis() },
            log = { Log.i(TAG, it) },
        )
    }

    private class StorePushState(private val store: Store) : PushState {
        override val paired: RelayRef?
            get() = store.registration?.let {
                RelayRef(it.relayUrl, it.endpointId, it.deviceToken, it.certFingerprint)
            }
        override val instantDelivery: Boolean get() = store.instantDelivery
        override val avoidGoogle: Boolean get() = store.avoidGoogle
        override val enrolment: Enrolment?
            get() {
                val wakeToken = store.wakeToken ?: return null
                return Enrolment(
                    wakeToken = wakeToken,
                    pushToken = store.pushToken.orEmpty(),
                    announcedTo = store.pushAnnouncedTo.orEmpty(),
                    enrolledAt = store.enrolledAt,
                )
            }
        override val wakesMissedAt: Long? get() = store.wakesMissedAt
        override val retirements: List<Retirement> get() = store.retirements
        override val lastWakeAt: Long? get() = store.lastWakeAt
        override val wakeStrikeAt: Long? get() = store.wakeStrikeAt
        override val previousContactAt: Long? get() = store.lastContactAt
        override val relayClockOffsetMs: Long get() = store.relayClockOffsetMs

        override fun commitEnrolment(expectedTarget: String, enrolment: Enrolment, resetWatch: Boolean): Boolean =
            store.commitEnrolment(
                expectedTarget,
                enrolment.wakeToken,
                enrolment.pushToken,
                enrolment.enrolledAt,
                resetWatch,
            )

        override fun recordWakeVerdict(judgedWakeToken: String, strikeAt: Long?, missedAt: Long?) =
            store.recordWakeVerdict(judgedWakeToken, strikeAt, missedAt)

        override fun retireEnrolment(retirement: Retirement) = store.retireEnrolment(retirement)

        override fun updateRetirements(transform: (List<Retirement>) -> List<Retirement>) =
            store.updateRetirements(transform)

        override var relayForwarderKnown: Boolean?
            get() = store.relayForwarderKnown
            set(value) {
                store.relayForwarderKnown = value
            }
    }

    private object RelayClient : RelayPort {
        override fun forwarderAdvertised(relay: RelayRef): RelayForwarder = try {
            if (ApiClient(relay.relayUrl, relay.certFingerprint).getConfig().wakeForwarder) {
                RelayForwarder.YES
            } else {
                RelayForwarder.NO
            }
        } catch (e: Exception) {
            // Unreachable, refused, or unreadable: none of them is an answer [G8].
            Log.i(TAG, "Could not ask the relay about its wake-up service: ${e.message}")
            RelayForwarder.UNKNOWN
        }

        override fun setSubscription(relay: RelayRef, wakeToken: String?): RelayAnswer = try {
            ApiClient(relay.relayUrl, relay.certFingerprint).heartbeat(
                relay.deviceToken,
                relay.endpointId,
                wakeToken?.let { PushSubscription.forwarder(it) } ?: PushSubscription.none(),
            )
            RelayAnswer.ACCEPTED
        } catch (e: ApiException) {
            Log.i(TAG, "Relay refused the push subscription: ${e.message}")
            when (e.status) {
                401, 403, 404, 410 -> RelayAnswer.GONE
                else -> RelayAnswer.REFUSED
            }
        } catch (e: IOException) {
            Log.i(TAG, "Could not tell the relay how to wake us: ${e.message}")
            RelayAnswer.UNREACHABLE
        } catch (e: Exception) {
            // An answer the app cannot read (a page where the relay should be, say). Not
            // proof of anything, so the step is kept and tried again.
            Log.i(TAG, "Unreadable answer from the relay: ${e.message}")
            RelayAnswer.REFUSED
        }
    }

    private class ForwarderClient(private val baseUrl: String) : ForwarderPort {
        override fun register(pushToken: String): String? = Forwarder.register(baseUrl, pushToken)
        override fun revoke(wakeToken: String): Boolean = Forwarder.revoke(baseUrl, wakeToken)
    }

    private class GoogleClient(private val context: Context) : GooglePort {
        override val configured: Boolean get() = GooglePush.isConfigured
        override fun available(): Boolean? = GooglePush.playServices(context)
        override fun inUse(): Boolean = GooglePush.inUse(context)
        override suspend fun token(): String? = GooglePush.token(context)
        override suspend fun forget(): Boolean = GooglePush.forget(context)
    }
}
