package io.tabsend.app.push

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import io.tabsend.app.receive.Deliverer
import io.tabsend.app.receive.StreamService
import io.tabsend.app.store.Store
import io.tabsend.app.work.Scheduling
import kotlinx.coroutines.runBlocking

/**
 * Where a wake lands [P-11].
 *
 * The message carries nothing — one `wake` marker, by construction on the forwarder's side —
 * so this does exactly what the WebSocket's `message` event does: run the ONE idempotent
 * drain loop and let it fetch from the relay. **Nothing in the push payload is ever trusted
 * or read** (PRD §6.1), which is what keeps a forwarder, Google, and anyone who can forge a
 * push unable to put a link in front of the user.
 *
 * `runBlocking` rather than a scope launch: Android keeps this service alive only for the
 * duration of `onMessageReceived`, so a drain launched and left behind would be killed
 * mid-fetch. Blocking here is the documented shape for work that must finish, and the drain
 * is a few HTTP calls.
 */
class WakeMessagingService : FirebaseMessagingService() {

    override fun onMessageReceived(message: RemoteMessage) {
        val store = Store.get(this)
        if (!store.isRegistered) return
        // The evidence that the doorbell works, recorded before anything else [G10]. It also
        // clears a "wakes stopped arriving" verdict, so the connection that verdict started
        // can stop: a high-priority wake is one of the moments Android allows that.
        if (store.noteWakeArrived(System.currentTimeMillis())) StreamService.sync(applicationContext)
        // Drain on ANY wake while paired [2026-10-02, SECURITY_REVIEW G8]. A wake with no
        // enrolment behind it means the relay still holds a token this phone is retiring
        // (it was offline when it tried); ignoring the wake used to leave the tab waiting
        // for a poll. The drain trusts nothing in the message, so draining costs nothing,
        // and the heartbeat is what retries the retirement.
        if (store.wakeToken == null) Scheduling.enqueueHeartbeat(applicationContext)
        runBlocking { Deliverer.drain(applicationContext, fromWake = true) }
    }

    /**
     * Google rotated this install's address. The old enrolment at the forwarder is now a
     * doorbell that rings nothing, so re-enrol — which replaces the wake token at the
     * forwarder and hands the relay the new one.
     */
    override fun onNewToken(token: String) {
        val store = Store.get(this)
        if (!store.isRegistered) return
        runBlocking { PushSetup.sync(applicationContext) }
    }
}
