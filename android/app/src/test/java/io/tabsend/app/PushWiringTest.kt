package io.tabsend.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The parts of the Google push fixes that live where a JVM test cannot run them: the
 * manifest, Application start-up, the activity, the services and the workers [2026-10-02,
 * SECURITY_REVIEW G3, G4, G8, G9, G10]. Each is read as written, the way the relay's
 * Dockerfile test reads its Dockerfile, so undoing the fix fails here rather than on
 * someone's phone.
 */
class PushWiringTest {

    /** Gradle runs unit tests from the module directory; an IDE may run them from the root. */
    private fun source(path: String): String =
        listOf(File(path), File("app/$path"), File("android/app/$path"))
            .first { it.exists() }
            .readText()

    /** Where [later] comes after [earlier] in [text], both present. */
    private fun assertOrder(text: String, earlier: String, later: String) {
        val a = text.indexOf(earlier)
        val b = text.indexOf(later)
        assertTrue("$earlier not found", a >= 0)
        assertTrue("$later not found", b >= 0)
        assertTrue("$earlier must come before $later", a < b)
    }

    /** The body of one Kotlin function, from its signature to the next top-level member. */
    private fun body(file: String, signature: String): String {
        val start = file.indexOf(signature)
        assertTrue("$signature not found", start >= 0)
        val next = Regex("""\n    (private |override |internal )?fun """).find(file, start + signature.length)
        return file.substring(start, next?.range?.first ?: file.length)
    }

    @Test
    fun `the manifest turns off Firebase Messaging's automatic registration`() {
        val manifest = source("src/main/AndroidManifest.xml")
        val flag = Regex(
            """<meta-data\s+android:name="firebase_messaging_auto_init_enabled"\s+android:value="false"\s*/>""",
        )
        assertTrue("firebase_messaging_auto_init_enabled must be false", flag.containsMatchIn(manifest))
    }

    @Test
    fun `the app starts Firebase at launch only when it may hold a registration`() {
        val app = source("src/main/java/io/tabsend/app/TabsendApp.kt")
        assertTrue(app.contains("GooglePush.startIfInUse(this)"))
        assertFalse(
            "TabsendApp must not start Firebase unconditionally",
            Regex("""GooglePush\.initialize\(""").containsMatchIn(app),
        )
        val push = source("src/main/java/io/tabsend/app/push/GooglePush.kt")
        assertTrue(body(push, "fun startIfInUse(").contains("if (isConfigured && inUse(context)) initialize(context)"))
    }

    @Test
    fun `the flag that starts Firebase at launch is written before Google is first asked`() {
        val push = source("src/main/java/io/tabsend/app/push/GooglePush.kt")
        val token = body(push, "suspend fun token(")
        assertOrder(token, "putBoolean(K_IN_USE, true).commit()", "initialize(context)")
    }

    /** G4, and the verification pass: an update in progress is "cannot say", not "no". */
    @Test
    fun `Play Services is asked directly, and an update in progress is not read as absent`() {
        val push = source("src/main/java/io/tabsend/app/push/GooglePush.kt")
        val asked = body(push, "fun playServices(")
        assertTrue(asked.contains("GoogleApiAvailabilityLight.getInstance()"))
        assertTrue(asked.contains("ConnectionResult.SERVICE_UPDATING -> null"))
        assertTrue(body(push, "fun isAvailable(").contains("playServices(context) == true"))
        val setup = source("src/main/java/io/tabsend/app/push/PushSetup.kt")
        assertTrue(setup.contains("override fun available(): Boolean? = GooglePush.playServices(context)"))
    }

    /**
     * Found by the 2026-10-02 verification pass: without Play Services the push token cannot
     * be deleted, so waiting on it kept Firebase starting at every launch for ever.
     */
    @Test
    fun `forgetting Google goes ahead without Play Services, which no longer delivers to it`() {
        val push = source("src/main/java/io/tabsend/app/push/GooglePush.kt")
        val forget = body(push, "suspend fun forget(")
        assertTrue(forget.contains("val tokenSettled = tokenGone || playServices(context) == false"))
        assertTrue(forget.contains("val installationGone = tokenSettled && settle { FirebaseInstallations.getInstance().delete() }"))
    }

    @Test
    fun `the main screen settles delivery each time it comes back, outside its own lifetime`() {
        val activity = source("src/main/java/io/tabsend/app/ui/MainActivity.kt")
        assertTrue(body(activity, "override fun onResume(").contains("settleDelivery {"))
        // In the app's scope, so turning the phone or leaving the screen cannot cancel a
        // change half applied.
        val settle = body(activity, "private fun settleDelivery(")
        assertTrue(settle.contains("AppScope.launch {"))
        assertTrue(settle.contains("PushSetup.sync(app)"))
    }

    @Test
    fun `every launch settles push delivery, paired or not, and a visible app may start the service`() {
        val app = source("src/main/java/io/tabsend/app/TabsendApp.kt")
        val registered = app.indexOf("if (Store.get(this@TabsendApp).isRegistered) {")
        val blockEnd = app.indexOf("}", registered)
        val sync = app.indexOf("PushSetup.sync(this@TabsendApp)")
        assertTrue(registered >= 0 && sync > blockEnd)
        assertTrue(body(app, "override fun onStart(").contains("StreamService.sync(this@TabsendApp)"))
    }

    @Test
    fun `tapping a tab's notification may start the service a background check could not`() {
        val activity = source("src/main/java/io/tabsend/app/receive/OpenLinksActivity.kt")
        assertTrue(activity.contains("StreamService.sync(this)"))
    }

    @Test
    fun `the heartbeat retries what push still owes, after its own drain`() {
        val workers = source("src/main/java/io/tabsend/app/work/Workers.kt")
        val heartbeat = workers.substring(workers.indexOf("class HeartbeatWorker"))
        assertOrder(
            heartbeat,
            "Deliverer.drain(applicationContext)",
            "if (PushSetup.hasPendingWork(applicationContext)) PushSetup.sync(applicationContext)",
        )
    }

    @Test
    fun `the service goes foreground before it decides to stop`() {
        val service = source("src/main/java/io/tabsend/app/receive/StreamService.kt")
        val start = body(service, "override fun onStartCommand(")
        assertOrder(start, "startForeground(NOTIFICATION_ID", "stopSelf()")
    }

    @Test
    fun `Unpair and Start fresh both leave through the one path that retires the wake token`() {
        val activity = source("src/main/java/io/tabsend/app/ui/MainActivity.kt")
        assertTrue(body(activity, "private fun confirmUnpair(").contains("leaveGroup()"))
        assertTrue(body(activity, "private fun confirmStartFresh(").contains("leaveGroup()"))
        assertTrue(body(activity, "private fun leaveGroup(").contains("store.leavePairing()"))
        // A bare wipe anywhere in the activity would be a way out that skips the retirement.
        assertFalse(activity.contains("store.clear()"))
    }

    @Test
    fun `a wake is drained whenever the phone is paired, enrolled or not`() {
        val service = source("src/main/java/io/tabsend/app/push/WakeMessagingService.kt")
        val onMessage = body(service, "override fun onMessageReceived(")
        assertTrue(onMessage.contains("Deliverer.drain(applicationContext, fromWake = true)"))
        assertEquals(
            "the only early return is for an unpaired phone",
            1,
            Regex("""\breturn\b""").findAll(onMessage).count(),
        )
        assertTrue(onMessage.contains("if (!store.isRegistered) return"))
        // The wake is recorded first, and clears a verdict that wakes had stopped [G10].
        assertOrder(
            onMessage,
            "if (store.noteWakeArrived(System.currentTimeMillis())) StreamService.sync(applicationContext)",
            "Deliverer.drain(",
        )
    }

    /** G10's check runs on every drain a wake did not start, over what it delivered. */
    @Test
    fun `a drain no wake started asks whether its tabs arrived without one`() {
        val deliverer = source("src/main/java/io/tabsend/app/receive/Deliverer.kt")
        assertTrue(deliverer.contains("PushSetup.afterDrain(context, deliveredCreatedAt, fromWake)"))
        val setup = source("src/main/java/io/tabsend/app/push/PushSetup.kt")
        val after = body(setup, "fun afterDrain(")
        // Judged only when no wake started it, and against the contact BEFORE this one.
        assertTrue(after.contains("if (!fromWake && core(context).judgeDrain(deliveredCreatedAt, now))"))
        assertOrder(after, "judgeDrain(", "store.lastContactAt = now")
        // A verdict starts the phone's own connection where Android allows it.
        assertOrder(after, "judgeDrain(deliveredCreatedAt, now)) {", "StreamService.sync(context)")
        // Collected only for tabs this drain delivered, after the notification posted.
        val delivered = deliverer.indexOf("delivered++")
        val collected = deliverer.indexOf("deliveredCreatedAt.add(")
        assertTrue(delivered >= 0 && collected > delivered)
    }

    /**
     * Sync runs at every start from a scope with no handler: anything it threw would end the
     * process at every start (found by the 2026-10-02 verification pass, with a relay that
     * answered with a page the app could not read).
     */
    @Test
    fun `nothing a sync throws reaches the start-up scope`() {
        val setup = source("src/main/java/io/tabsend/app/push/PushSetup.kt")
        assertTrue(body(setup, "private suspend fun settle(").contains("} catch (e: Exception) {"))
        val relay = setup.substring(setup.indexOf("private object RelayClient"), setup.indexOf("private class ForwarderClient"))
        assertEquals(2, Regex("""\} catch \(e: Exception\) \{""").findAll(relay).count())
    }

    @Test
    fun `when wakes stopped arriving, the screen offers to try Google push again`() {
        val activity = source("src/main/java/io/tabsend/app/ui/MainActivity.kt")
        assertTrue(activity.contains("binding.instantMethodButton.setOnClickListener { retryGooglePush() }"))
        assertTrue(body(activity, "private fun retryGooglePush(").contains("PushSetup.retryGoogle(app)"))
    }
}
