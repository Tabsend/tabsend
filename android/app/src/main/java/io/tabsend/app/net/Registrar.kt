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
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.IOException

/**
 * Registration + heartbeat for the mobile endpoint. Registers as `kind:'mobile'`
 * (browser = null → mobile receive opens in the OS default browser, PRD §3/§6.4)
 * with `pushSubscription: {transport:"none"}` [0015] — pairing needs no push
 * setup at all. Delivery: WS fast path while the app is alive, polling otherwise.
 */
object Registrar {

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
     */
    suspend fun join(
        context: Context,
        relayUrl: String,
        code: String,
        deviceLabel: String,
        certFingerprint: String? = null,
        relayId: String? = null,
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
}
