package io.tabsend.app.net

import io.tabsend.app.store.Registration
import io.tabsend.app.wire.ApiErrorEnvelope
import io.tabsend.app.wire.CreatePairingResponse
import io.tabsend.app.wire.Endpoint
import io.tabsend.app.wire.GroupKeyDelivery
import io.tabsend.app.wire.GroupKeyRequest
import io.tabsend.app.wire.GroupKeyResponse
import io.tabsend.app.wire.GroupResetState
import io.tabsend.app.wire.GroupStateResponse
import io.tabsend.app.wire.HeartbeatRequest
import io.tabsend.app.wire.HeartbeatResponse
import io.tabsend.app.wire.HistoryEntry
import io.tabsend.app.wire.Message
import io.tabsend.app.wire.PushSubscription
import io.tabsend.app.wire.RegisterRequest
import io.tabsend.app.wire.RegisterResponse
import io.tabsend.app.wire.SendRequest
import io.tabsend.app.wire.SendResponse
import io.tabsend.app.wire.ServerConfigResponse
import io.tabsend.app.wire.WireJson
import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * The relay answered with a non-2xx error envelope (shared/src/types.ts §10b).
 * A raw [IOException] instead means the relay was unreachable — the caller treats
 * that as "offline" and leaves work queued (correctness never depends on being online).
 */
class ApiException(val status: Int, val code: String, message: String) : IOException(message)

/**
 * Blocking REST client for the relay — the Android analogue of `lib/api.ts`. Call
 * from a background thread (Dispatchers.IO). Auth is the per-endpoint Bearer device
 * token on everything except register/config.
 */
class ApiClient(private val relayUrl: String, certFingerprint: String? = null) {

    // A pin (P-3) swaps in a client that trusts exactly that key; no pin keeps
    // the platform-default client untouched.
    private val http = if (certFingerprint != null) Tls.pinnedClient(shared, certFingerprint) else shared

    fun getConfig(): ServerConfigResponse =
        exec(build("GET", "/v1/config", null, null), ServerConfigResponse.serializer())

    fun register(body: RegisterRequest): RegisterResponse =
        exec(build("POST", "/v1/endpoints/register", null, jsonBody(body, RegisterRequest.serializer())), RegisterResponse.serializer())

    fun listEndpoints(token: String): List<Endpoint> =
        exec(build("GET", "/v1/endpoints", token, null), ListSerializer(Endpoint.serializer()))

    fun mintPairing(token: String): CreatePairingResponse =
        exec(build("POST", "/v1/pairing", token, emptyJsonBody()), CreatePairingResponse.serializer())

    fun sendMessages(token: String, body: SendRequest): SendResponse =
        exec(build("POST", "/v1/messages", token, jsonBody(body, SendRequest.serializer())), SendResponse.serializer())

    fun getPending(token: String): List<Message> =
        exec(build("GET", "/v1/messages?pending=1", token, null), ListSerializer(Message.serializer()))

    /**
     * The whole GROUP's history [0028], newest first — not just this endpoint's
     * own traffic, which is the point of the feature.
     *
     * A relay predating ADR-0028 knows only `?pending=1` and `?outbox=1` and
     * answers 400 `invalid_request`. That is not an error to report: it means the
     * relay has no group history, and the caller falls back to its local cache.
     */
    fun getHistory(token: String): List<HistoryEntry> =
        exec(build("GET", "/v1/messages?history=1", token, null), ListSerializer(HistoryEntry.serializer()))

    /** Every group-key copy sealed TO this endpoint. 404 on a relay predating [0028]. */
    fun getGroupKeys(token: String): List<GroupKeyDelivery> =
        exec(build("GET", "/v1/group-keys", token, null), ListSerializer(GroupKeyDelivery.serializer()))

    /** Hand the group key to endpoints that lack it. 404 on a relay predating [0028]. */
    fun postGroupKeys(token: String, body: GroupKeyRequest): GroupKeyResponse =
        exec(
            build("POST", "/v1/group-keys", token, jsonBody(body, GroupKeyRequest.serializer())),
            GroupKeyResponse.serializer(),
        )

    /**
     * The reset waiting on this group, or null [P-18 item 12]. A relay predating the
     * route answers 404, which means it cannot schedule one either: null, quietly.
     */
    fun getGroupReset(token: String): GroupResetState? = try {
        exec(build("GET", "/v1/group", token, null), GroupStateResponse.serializer()).reset
    } catch (e: ApiException) {
        if (e.status == 404) null else throw e
    }

    /** Stop the pending reset. The relay answers `{reset:null}` also when none was pending. */
    fun stopGroupReset(token: String) {
        execRaw(build("POST", "/v1/group/reset/stop", token, emptyJsonBody()))
    }

    fun ack(token: String, id: String) {
        execRaw(build("POST", "/v1/messages/${enc(id)}/ack", token, emptyJsonBody()))
    }

    fun heartbeat(token: String, endpointId: String, pushSubscription: PushSubscription?): HeartbeatResponse =
        exec(
            build("POST", "/v1/endpoints/${enc(endpointId)}/heartbeat", token, jsonBody(HeartbeatRequest(pushSubscription), HeartbeatRequest.serializer())),
            HeartbeatResponse.serializer(),
        )

    /** Returns the endpoint AS STORED — the relay's dedupe may have changed the label. */
    fun rename(token: String, endpointId: String, label: String): Endpoint =
        exec(
            build("PATCH", "/v1/endpoints/${enc(endpointId)}", token, jsonBody(RenameBody(label), RenameBody.serializer())),
            Endpoint.serializer(),
        )

    /**
     * Remove another device from the group (DELETE /v1/endpoints/{id}). A 404 means
     * it is already gone, which is what the caller wanted, so it is not an error.
     */
    fun deleteEndpoint(token: String, endpointId: String) {
        try {
            execRaw(build("DELETE", "/v1/endpoints/${enc(endpointId)}", token, null))
        } catch (e: ApiException) {
            if (e.status != 404) throw e
        }
    }

    // --- plumbing ---

    private fun build(method: String, path: String, token: String?, body: RequestBody?): Request =
        Request.Builder()
            .url(relayUrl.trimEnd('/') + path)
            .method(method, body)
            .apply { token?.let { header("Authorization", "Bearer $it") } }
            .build()

    private fun <T> exec(request: Request, deserializer: KSerializer<T>): T =
        WireJson.decodeFromString(deserializer, execRaw(request))

    /**
     * One round trip, reporting reachability either way.
     *
     * [ApiException] is deliberately re-thrown WITHOUT a report: it extends
     * IOException, but the relay answering "no" is proof it is up, and letting it
     * fall through to the offline branch would record a working relay as down
     * every time it refused something.
     */
    private fun execRaw(request: Request): String {
        val answer = try {
            http.newCall(request).execute().use { resp ->
                Answer(resp.code, resp.isSuccessful, resp.body?.string() ?: "")
            }
        } catch (e: IOException) {
            transportHandler?.invoke(relayUrl, false)
            throw e
        }
        transportHandler?.invoke(relayUrl, true)
        if (!answer.successful) throw parseError(answer.status, answer.text)
        return answer.text
    }

    private data class Answer(val status: Int, val successful: Boolean, val text: String)

    private fun <T> jsonBody(value: T, serializer: KSerializer<T>): RequestBody =
        WireJson.encodeToString(serializer, value).toRequestBody(JSON)

    /**
     * OkHttp requires a body for POST, while these relay routes have no payload.
     * It must still be valid JSON: an empty string with application/json is rejected
     * by Fastify's parser before the authenticated route is reached.
     */
    internal fun emptyJsonBody(): RequestBody = "{}".toRequestBody(JSON)

    private fun parseError(status: Int, text: String): ApiException = try {
        val env = WireJson.decodeFromString(ApiErrorEnvelope.serializer(), text)
        ApiException(status, env.error.code, env.error.message)
    } catch (_: Exception) {
        ApiException(status, "internal", "Request failed ($status).")
    }

    private fun enc(s: String): String = java.net.URLEncoder.encode(s, "UTF-8")

    @Serializable
    private data class RenameBody(val label: String)

    companion object {
        /**
         * Notified `(relayUrl, reachable)` for every call, so relay reachability
         * is recorded from ORDINARY traffic and needs no probe of its own
         * (mirrors the extension's `setTransportHandler` in lib/api.ts).
         *
         * Deliberately dumb: it reports every URL, including candidates typed
         * into "Move to another relay". Deciding which of those say anything
         * about the relay we're registered to is [RelayHealthTracker]'s job.
         */
        @Volatile
        var transportHandler: ((relayUrl: String, reachable: Boolean) -> Unit)? = null

        /** The client for a stored registration — carries its pin (P-3) if it has one. */
        fun forRegistration(reg: Registration): ApiClient =
            ApiClient(reg.relayUrl, reg.certFingerprint)

        private val JSON = "application/json; charset=utf-8".toMediaType()
        private val shared: OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(20, TimeUnit.SECONDS)
            .build()
    }
}
