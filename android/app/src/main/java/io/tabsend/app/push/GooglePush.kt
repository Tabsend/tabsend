package io.tabsend.app.push

import android.content.Context
import android.util.Log
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailabilityLight
import com.google.android.gms.tasks.Task
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.installations.FirebaseInstallations
import com.google.firebase.messaging.FirebaseMessaging
import io.tabsend.app.BuildConfig
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume

/**
 * Google push, as a capability the app may or may not have [P-11].
 *
 * The whole reason this file exists is that the answer to "can this phone use Google push?"
 * has three independent parts, and all three are decided at RUNTIME so that one apk serves
 * every phone:
 *
 *  1. Was this build given Firebase values? (`BuildConfig.FCM_*`, blank unless a release
 *     build supplied them — a contributor's build has none and needs none.)
 *  2. Does this phone have Google Play Services at all? A degoogled or F-Droid-style phone
 *     does not, and nothing here may crash or nag on it.
 *  3. Is there a wake-up forwarder to mint a wake token? Without one there is nobody to
 *     ring the phone, so the token would be useless.
 *
 * Any "no" means the app keeps its own connection open instead, which is exactly what it
 * did before this path existed. There is deliberately no `google-services.json` and no
 * Gradle plugin: Firebase is initialised here, from values that are not secrets.
 *
 * **Firebase is not started unless it is about to be used** [2026-10-02, SECURITY_REVIEW G3].
 * Its messaging library starts itself with the default app (its registrar is eager) and,
 * with automatic set-up on, registers the install with Google at once and refreshes it
 * weekly. So "Don't use Google" did not keep the app away from Google: the default app was
 * created at every launch, whatever the user chose. Now the manifest turns automatic set-up
 * off (`firebase_messaging_auto_init_enabled`), the default app is created only to enrol,
 * or at launch when an enrolment may exist (a wake can only arrive then), and giving
 * Google push up deletes both the push token and the Firebase installation.
 */
object GooglePush {

    private const val TAG = "TabsendPush"

    /** Its own small file, so the check at every cold start reads almost nothing. */
    private const val PREFS = "tabsend.push"
    private const val K_IN_USE = "firebase.inUse"

    /** True when this build carries a complete set of Firebase values. */
    val isConfigured: Boolean
        get() = BuildConfig.FCM_APP_ID.isNotBlank() &&
            BuildConfig.FCM_PROJECT_ID.isNotBlank() &&
            BuildConfig.FCM_API_KEY.isNotBlank() &&
            BuildConfig.FCM_SENDER_ID.isNotBlank()

    /** The forwarder this build registers with, or null when it has none. */
    val forwarderUrl: String?
        get() = BuildConfig.WAKE_FORWARDER_URL.trimEnd('/').takeIf { it.isNotBlank() }

    /**
     * Whether Google push can be used on this phone right now: this build has the values,
     * and the phone has Google Play Services [2026-10-02, SECURITY_REVIEW G4].
     *
     * It used to answer by starting Firebase and seeing whether the default app appeared,
     * on the theory that Firebase fails to start without Play Services. It does not fail,
     * so a phone without them was taken for one with them, contacted Google's installation
     * service on every sync, and was told Google push was "pending" for ever. Play Services
     * is asked directly now, which starts nothing and sends nothing.
     */
    fun isAvailable(context: Context): Boolean = playServices(context) == true

    /**
     * Play Services, three ways: true, false, or null while it is being updated and cannot
     * say [2026-10-02 verification pass]. An update used to read as "no Play Services" and
     * tore a working enrolment down until the next start; now it changes nothing.
     */
    fun playServices(context: Context): Boolean? {
        if (!isConfigured) return false
        val result = try {
            GoogleApiAvailabilityLight.getInstance()
                .isGooglePlayServicesAvailable(context.applicationContext)
        } catch (e: Exception) {
            return false
        }
        return when (result) {
            ConnectionResult.SUCCESS -> true
            ConnectionResult.SERVICE_UPDATING -> null
            else -> false
        }
    }

    /**
     * Whether Firebase may hold a registration for this install: set before the first
     * token is asked for, cleared only once [forget] has deleted it. It decides whether
     * Firebase is started at launch, because a wake can arrive at a cold process only then.
     */
    fun inUse(context: Context): Boolean = prefs(context).getBoolean(K_IN_USE, false)

    /**
     * Called from `TabsendApp.onCreate`. When a wake arrives at a cold process, Android
     * starts `WakeMessagingService` directly and the library looks for the default app as
     * it does so, and Application onCreate is the last point that always runs first. So the
     * app is created there, but only when it may be needed.
     */
    fun startIfInUse(context: Context) {
        // A build without the values can never have set the flag: no file to read at all.
        if (isConfigured && inUse(context)) initialize(context)
    }

    /**
     * Create Firebase's DEFAULT app from the build's values. The DEFAULT app specifically,
     * not a named one — Firebase Messaging delivers only to the default instance, so a named
     * app would take tokens and never receive anything. Idempotent.
     */
    private fun initialize(context: Context) {
        if (!isConfigured) return
        if (app() != null) return
        try {
            FirebaseApp.initializeApp(
                context.applicationContext,
                FirebaseOptions.Builder()
                    .setApplicationId(BuildConfig.FCM_APP_ID)
                    .setProjectId(BuildConfig.FCM_PROJECT_ID)
                    .setApiKey(BuildConfig.FCM_API_KEY)
                    .setGcmSenderId(BuildConfig.FCM_SENDER_ID)
                    .build(),
            )
        } catch (e: Exception) {
            Log.i(TAG, "Google push unavailable on this device: ${e.message}")
        }
    }

    /** Firebase's default app, or null when this build or this phone cannot have one. */
    private fun app(): FirebaseApp? = try {
        FirebaseApp.getInstance()
    } catch (_: IllegalStateException) {
        null
    }

    /**
     * This phone's registration token, or null if it cannot be had. The one place Firebase
     * is started for a new enrolment.
     *
     * The token is Google's address for this install. It is handed to the forwarder and to
     * nothing else: the relay never sees it, because the relay holds a wake token instead
     * (ADR-0032 — a relay that held a provider address would be a relay that could be made
     * to ring arbitrary devices).
     */
    suspend fun token(context: Context): String? {
        if (!isAvailable(context)) return null
        // Recorded BEFORE Google is contacted, and written through: if the process dies
        // mid-registration, the next launch still knows there may be something to delete.
        prefs(context).edit().putBoolean(K_IN_USE, true).commit()
        initialize(context)
        app() ?: return null
        return suspendCancellableCoroutine { continuation ->
            try {
                FirebaseMessaging.getInstance().token
                    .addOnSuccessListener { token -> continuation.resume(token?.takeIf { it.isNotBlank() }) }
                    .addOnFailureListener { e ->
                        Log.i(TAG, "Could not get a push token: ${e.message}")
                        continuation.resume(null)
                    }
            } catch (e: Exception) {
                Log.i(TAG, "Could not reach Google push: ${e.message}")
                continuation.resume(null)
            }
        }
    }

    /**
     * Make Google forget this install: delete the push token and the Firebase installation,
     * so a phone that has turned Google push off stops being addressable through it and
     * stops checking in with it [G3]. True once both are gone, or there was nothing to
     * delete; false if Google could not be reached, and the next sync tries again.
     */
    suspend fun forget(context: Context): Boolean {
        if (!inUse(context)) return true
        initialize(context)
        if (app() == null) {
            // Firebase cannot start here any more (a build without the values, say), so this
            // side holds nothing to delete and nothing that could be woken.
            prefs(context).edit().putBoolean(K_IN_USE, false).commit()
            return true
        }
        val tokenGone = settle { FirebaseMessaging.getInstance().deleteToken() }
        // Without Play Services the token cannot be deleted (the call goes through it), and
        // Google no longer delivers to it either; the installation can still be deleted, and
        // must be, or this would retry, and start Firebase, at every launch for ever.
        val tokenSettled = tokenGone || playServices(context) == false
        val installationGone = tokenSettled && settle { FirebaseInstallations.getInstance().delete() }
        if (!installationGone) return false
        prefs(context).edit().putBoolean(K_IN_USE, false).commit()
        Log.i(TAG, "Deleted this install's Google push token and Firebase installation")
        return true
    }

    /** Wait for a Firebase task; true if it succeeded. Never throws. */
    private suspend fun settle(start: () -> Task<*>): Boolean =
        suspendCancellableCoroutine { continuation ->
            try {
                start().addOnCompleteListener { task -> continuation.resume(task.isSuccessful) }
            } catch (e: Exception) {
                Log.i(TAG, "Could not reach Google push: ${e.message}")
                continuation.resume(false)
            }
        }

    private fun prefs(context: Context) =
        context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
}
