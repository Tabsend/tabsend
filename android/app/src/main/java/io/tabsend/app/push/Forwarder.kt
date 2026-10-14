package io.tabsend.app.push

import android.util.Log
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * The app's half of the wake-up forwarder protocol [0032]: enrol this phone's Google push
 * token, get a wake token back, and revoke it on unpair.
 *
 * Two rules from `forwarder/PROTOCOL.md` are structural here rather than incidental:
 *
 *  - **The wake token never rides a URL.** `/v1/revoke` carries it in an Authorization
 *    header, because URLs end up in proxy logs.
 *  - **The relay never learns the Google token, and the forwarder never learns the relay.**
 *    This file talks to the forwarder; `PushSetup` hands the relay only the wake token the
 *    forwarder minted. Neither side can reconstruct the other's half.
 *
 * Plain TLS with no pinning, unlike the relay client: the forwarder is a public service on
 * a CA-certified name, not someone's self-signed box on a LAN (ADR-0019 is about the
 * latter).
 */
object Forwarder {

    private const val TAG = "TabsendPush"
    private val JSON = "application/json; charset=utf-8".toMediaType()
    private val json = Json { ignoreUnknownKeys = true }

    private val client = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .build()

    /** What the forwarder mints: 32 random bytes as base64url, 43 characters. */
    private val WAKE_TOKEN = Regex("^[A-Za-z0-9_-]{43}$")

    @Serializable
    private data class RegisterBody(val fcmToken: String)

    @Serializable
    private data class RegisterReply(val wakeToken: String = "")

    /**
     * Enrol and return a wake token, or null on any refusal or outage.
     *
     * Null is an ordinary answer, not an error to surface: every caller's fallback is the
     * app's own connection, which works. A 501 here means this forwarder has no Google
     * credentials at all, which is worth a log line and nothing more.
     */
    fun register(baseUrl: String, fcmToken: String): String? {
        val body = json.encodeToString(RegisterBody.serializer(), RegisterBody(fcmToken))
        val request = Request.Builder()
            .url("${baseUrl.trimEnd('/')}/v1/register")
            .post(body.toRequestBody(JSON))
            .build()
        return try {
            client.newCall(request).execute().use { response ->
                val text = response.body?.string().orEmpty()
                if (!response.isSuccessful) {
                    Log.i(TAG, "Forwarder refused the registration: ${response.code}")
                    return null
                }
                // Only the shape the forwarder mints (43 base64url characters): anything else
                // could not even be sent back in a header, and would fail every revoke.
                json.decodeFromString(RegisterReply.serializer(), text)
                    .wakeToken.takeIf { WAKE_TOKEN.matches(it) }
            }
        } catch (e: IOException) {
            Log.i(TAG, "Could not reach the forwarder: ${e.message}")
            null
        } catch (e: Exception) {
            Log.i(TAG, "Unreadable forwarder reply: ${e.message}")
            null
        }
    }

    /**
     * Retire a wake token. True once the forwarder has taken it: it answers a live token, a
     * revoked one and an invented one alike (`PROTOCOL.md` §4), so a 2xx means it was told.
     * False when it could not be reached or did not take it, and the caller keeps the token
     * queued and tries again [2026-10-02, SECURITY_REVIEW G8]. It used to be told once and
     * forgotten, which left a live token behind whenever the phone was offline.
     */
    fun revoke(baseUrl: String, wakeToken: String): Boolean {
        // A token the forwarder could never have minted cannot be revoked; nothing to do.
        if (!WAKE_TOKEN.matches(wakeToken)) return true
        return try {
            val request = Request.Builder()
                .url("${baseUrl.trimEnd('/')}/v1/revoke")
                .header("Authorization", "Bearer $wakeToken")
                .post("{}".toRequestBody(JSON))
                .build()
            client.newCall(request).execute().use { response ->
                // The forwarder answers 200 to every well-formed token (`PROTOCOL.md` §4), so
                // 2xx means it was told. A 429 (its per-address limit) or a 5xx (a restart
                // behind its proxy) means it was not, and the token stays queued.
                val told = response.isSuccessful
                if (!told) Log.i(TAG, "Forwarder did not take the revoke yet: ${response.code}")
                told
            }
        } catch (e: IOException) {
            Log.i(TAG, "Could not revoke at the forwarder: ${e.message}")
            false
        } catch (e: Exception) {
            Log.i(TAG, "Could not revoke at the forwarder: ${e.message}")
            false
        }
    }
}
