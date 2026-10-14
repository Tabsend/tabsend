package io.tabsend.app

import android.app.Application
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import androidx.work.Configuration
import io.tabsend.app.net.RelayHealthTracker
import io.tabsend.app.net.StreamManager
import io.tabsend.app.push.GooglePush
import io.tabsend.app.push.PushSetup
import io.tabsend.app.receive.Notifications
import io.tabsend.app.receive.StreamService
import io.tabsend.app.send.SendNotifications
import io.tabsend.app.store.Store
import io.tabsend.app.work.Scheduling
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

/**
 * App entry point. Sets up the notification channel and, when already paired,
 * arms the poll chain + periodic heartbeat and drains on launch — so delivery
 * never waits on anything having arrived while we were dead (PRD §6.1). The WS
 * fast path [0015] follows the process lifecycle: connected while any of our
 * screens is visible, plus in the background when instant delivery is on
 * (the default for new installs).
 */
class TabsendApp : Application(), Configuration.Provider {

    /**
     * WorkManager on demand instead of at process start.
     *
     * Its default initializer is a ContentProvider, so without this it opens its
     * Room database on the main thread BEFORE `onCreate` runs, on every cold
     * start. The share sheet is very often what triggers that cold start, and
     * there the cost lands squarely in front of the chooser's first frame —
     * while the sharing app sits frozen behind a translucent window waiting for
     * it. Nothing needs WorkManager to exist before something asks for it, so
     * the first `getInstance()` pays for it instead, off the critical path.
     *
     * (Paired with the manifest's `tools:node="remove"` of
     * `androidx.work.WorkManagerInitializer` — one without the other is either
     * no change at all or an uninitialised WorkManager.)
     */
    override val workManagerConfiguration: Configuration
        get() = Configuration.Builder().build()

    override fun onCreate() {
        super.onCreate()
        Notifications.ensureChannel(this)
        SendNotifications.ensureChannels(this)
        // Before anything else can need it: a wake arriving at a cold process starts
        // WakeMessagingService right after this method, and the library looks for Firebase's
        // default app as it does. Only when Firebase may hold a registration for this
        // install, because a wake can arrive only then; at any other launch, starting
        // Firebase would register the install with Google whatever the user chose
        // [2026-10-02, SECURITY_REVIEW G3].
        GooglePush.startIfInUse(this)
        // Reachability is recorded from ordinary traffic, so the handler has to be
        // in place before anything talks to the relay — including the share sheet,
        // which runs in this same process and may be the first thing to.
        RelayHealthTracker.install(this)

        ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onStart(owner: LifecycleOwner) {
                StreamManager.onAppVisible(this@TabsendApp, true)
                // Any Tabsend screen in front may start the instant-delivery service, which a
                // background check cannot on Android 12 and later: this is where a fallback
                // decided in the background takes effect [G8, G10]. Off the main thread, as it
                // reads the store.
                AppScope.launch(Dispatchers.Default) { StreamService.sync(this@TabsendApp) }
            }

            override fun onStop(owner: LifecycleOwner) {
                StreamManager.onAppVisible(this@TabsendApp, false)
            }
        })

        // Delivery plumbing, off the main thread. Reading the store is a disk
        // load, arming the poll and starting the stream service are binder round
        // trips, and enqueuing work opens WorkManager's database — none of which
        // has to have happened before the first screen draws. It all used to run
        // here inline, ahead of ShareActivity.onCreate on a cold share, so every
        // millisecond of it was a millisecond the sharing app stayed frozen.
        //
        // Deferring is safe because none of these are deadlines: they schedule
        // work, and each is idempotent (unique work, and StreamService.sync
        // reconciles against the store rather than assuming). A screen that
        // needs its own refresh already asks for one.
        AppScope.launch(Dispatchers.Default) {
            if (Store.get(this@TabsendApp).isRegistered) {
                Scheduling.ensurePeriodicHeartbeat(this@TabsendApp)
                Scheduling.enqueueHeartbeat(this@TabsendApp) // heartbeat + drain now
                Scheduling.armPoll(this@TabsendApp)
            }
            // Instant delivery, by whichever means is available: Google push if this build,
            // this phone and this relay can all do it, otherwise the foreground service.
            // Reconciles rather than assumes, so it is safe on every start [P-11]. Paired or
            // not: an unpair may still owe a retirement, or Google a deleted token [G3, G9].
            PushSetup.sync(this@TabsendApp)
        }
    }
}
