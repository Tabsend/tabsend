package io.tabsend.app.net

import android.content.Context
import io.tabsend.app.crypto.Base64x
import io.tabsend.app.crypto.CryptoBox
import io.tabsend.app.logic.parseIsoMillis
import io.tabsend.app.store.Identity
import io.tabsend.app.store.Registration
import io.tabsend.app.store.Store
import io.tabsend.app.wire.PushSubscription
import io.tabsend.app.wire.RegisterRequest
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import java.io.IOException

/**
 * Registration + heartbeat for the mobile endpoint. Registers as `kind:'mobile'`
 * (browser = null → mobile receive opens in the OS default browser, PRD §3/§6.4)
 * with `pushSubscription: {transport:"none"}` [0015] — pairing needs no push
 * setup at all. Delivery: WS fast path while the app is alive, polling otherwise.
 */
object Registrar {

    /** How long leaving waits to hear from the relay before wiping the phone anyway. */
    private const val LEAVE_PATIENCE_MS = 3_000L

    /** Ensure this install has an X25519 identity, generating one on first use. */
    fun ensureIdentity(store: Store): Identity {
        store.identity?.let { return it }
        val kp = CryptoBox.generateKeyPair()
        val pub = Base64x.encode(kp.publicKey)
        val priv = Base64x.encode(kp.privateKey)
        val identity = Identity(publicKey = pub, privateKey = priv, keyId = Base64x.keyId(pub))
        store.identity = identity
        return identity
    }

    /**
     * Join an existing group via pairing link. Nothing to wait for first —
     * the phone registers push-less ({transport:"none"}, [0015]).
     *
     * [vouched] is the tags the link carried (P-23). Saved with the registration
     * for the first device-list watch of this pairing, which reads it once.
     */
    suspend fun join(
        context: Context,
        relayUrl: String,
        code: String,
        deviceLabel: String,
        certFingerprint: String? = null,
        relayId: String? = null,
        vouched: List<String>? = null,
    ): Registration = withContext(Dispatchers.IO) {
        val store = Store.get(context)
        val identity = ensureIdentity(store)

        val request = RegisterRequest(
            label = deviceLabel,
            kind = "mobile",
            browser = null,
            platform = "android",
            pushSubscription = PushSubscription.none(),
            e2ePubkey = identity.publicKey,
            pairingCode = code,
        )
        val resp = ApiClient(relayUrl, certFingerprint).register(request)
        val registration = Registration(
            endpointId = resp.endpointId,
            groupId = resp.groupId,
            deviceToken = resp.deviceToken,
            relayUrl = relayUrl.trimEnd('/'),
            // The relay's label wins: it de-duplicates within the group, so it may
            // have stored something other than what we sent. Keeping our own copy
            // would show this phone one name while every other device sees another.
            label = resp.label ?: deviceLabel,
            certFingerprint = certFingerprint,
            relayId = relayId,
        )
        // The vouch first: the first watch needs the registration, so it cannot run
        // before both are in. Null clears any left over (P-23).
        store.pairingVouch = vouched
        store.registration = registration
        registration
    }

    /**
     * Heartbeat: refresh presence. No push subscription to rotate ([0015] — the
     * relay holds {transport:"none"} forever). Silent no-op if offline or
     * unregistered — the next tick retries.
     */
    suspend fun heartbeat(context: Context) = withContext(Dispatchers.IO) {
        val store = Store.get(context)
        val reg = store.registration ?: return@withContext
        try {
            val sent = System.currentTimeMillis()
            val answer = ApiClient.forRegistration(reg).heartbeat(reg.deviceToken, reg.endpointId, null)
            // How far the relay's clock is from this phone's, for the missed-wake check,
            // which compares a tab's relay-clock `createdAt` with a wake's arrival here [G10].
            parseIsoMillis(answer.serverTime)?.let { relayNow ->
                val here = (sent + System.currentTimeMillis()) / 2
                store.relayClockOffsetMs = relayNow - here
            }
        } catch (_: IOException) {
            // offline — presence refreshes on the next heartbeat
        }
    }

    /**
     * Rename this endpoint (PATCH /v1/endpoints/:id) and mirror the label locally
     * — the STORED one, since the relay de-duplicates within the group and may
     * have suffixed what we asked for.
     */
    suspend fun rename(context: Context, label: String) = withContext(Dispatchers.IO) {
        val store = Store.get(context)
        val reg = store.registration ?: return@withContext
        val stored = ApiClient.forRegistration(reg).rename(reg.deviceToken, reg.endpointId, label)
        store.updateLabel(stored.label)
    }

    /**
     * Ask the relay to drop this phone from its group, for Unpair and Start fresh [PLANS P-28].
     * Best effort, like the iPhone and the browsers: a relay that is down, or refuses, must
     * not keep anyone from leaving, so nothing here throws.
     *
     * Returns when the relay has answered or after [patienceMs], whichever is first, because
     * the caller's wipe should not wait out a dead relay's timeouts. The call itself runs
     * on in [background], with its own copy of the token, so a slow relay still gets it.
     *
     * The relay also retires the wake token it holds for this entry, and the phone's own
     * retirement (`Store.leavePairing`, then `PushCore`) still runs after this. Either order
     * is safe: a relay that has already dropped the entry answers 401, which counts as told,
     * and the forwarder answers a second revoke the same as the first.
     */
    internal suspend fun leaveRelay(
        reg: Registration,
        background: CoroutineScope,
        patienceMs: Long = LEAVE_PATIENCE_MS,
        delete: () -> Unit = { ApiClient.forRegistration(reg).deleteEndpoint(reg.deviceToken, reg.endpointId) },
    ) {
        val removal = background.launch(Dispatchers.IO) {
            try {
                delete()
            } catch (_: Exception) {
                // Down, refused or unreadable: the local wipe is what the user asked for.
            }
        }
        withTimeoutOrNull(patienceMs) { removal.join() }
    }
}
