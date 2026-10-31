package io.tabsend.app.net

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.os.SystemClock
import android.util.Log
import io.tabsend.app.logic.Heartbeat
import io.tabsend.app.receive.Deliverer
import io.tabsend.app.receive.GroupResetWatcher
import io.tabsend.app.store.Store
import io.tabsend.app.work.flushAndReport
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

/**
 * The WS fast path to the relay (`WS /v1/stream`, shared §11): latency only,
 * correctness never depends on it — polling still delivers everything [0001].
 * Replaces UnifiedPush entirely [0015]: no distributor app, no Google. A
 * `message` event just triggers the ONE idempotent drain loop (the envelope in
 * the event is ignored; the drain pulls, dedupes, verifies, opens).
 *
 * Lifecycle is owned by [StreamManager]: the socket runs while the app is
 * visible, and in the background too when the user opts into instant delivery
 * (StreamService). Reconnects with capped backoff while it should be running,
 * at once when the phone changes network, and when the relay stops answering
 * pings ([Heartbeat]).
 */
object StreamManager {
    private const val TAG = "Tabsend"
    private const val BACKOFF_START_MS = 1_000L
    private const val BACKOFF_MAX_MS = 60_000L

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val json = Json { ignoreUnknownKeys = true; isLenient = true }
    private val client = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS) // a stream: no read timeout
        .build()

    private var appVisible = false
    private var serviceActive = false
    private var runner: Job? = null
    private var networkWatch: ConnectivityManager.NetworkCallback? = null

    /** Called from the process-lifecycle observer (app came to front / left it). */
    @Synchronized
    fun onAppVisible(context: Context, visible: Boolean) {
        appVisible = visible
        refresh(context)
    }

    /** Called by StreamService when the instant-delivery service starts/stops. */
    @Synchronized
    fun onServiceActive(context: Context, active: Boolean) {
        serviceActive = active
        refresh(context)
    }

    /**
     * Force a fresh connection: drop the current socket (if any) and re-evaluate.
     * Needed after "Change relay address" (P-4) — [refresh] alone leaves an
     * already-running session on the old URL until it happens to drop, because
     * [runLoop] only re-reads the registration between sessions.
     */
    @Synchronized
    fun restart(context: Context) {
        runner?.cancel()
        runner = null
        refresh(context)
    }

    /** Re-evaluate whether the socket should run (also call after join/unpair). */
    @Synchronized
    fun refresh(context: Context) {
        val appContext = context.applicationContext
        val shouldRun = Store.get(appContext).isRegistered && (appVisible || serviceActive)
        if (shouldRun && runner == null) {
            runner = scope.launch { runLoop(appContext) }
            watchNetwork(appContext)
        } else if (!shouldRun) {
            runner?.cancel()
            runner = null
            unwatchNetwork(appContext)
        }
    }

    /**
     * Reconnect as soon as the phone's default network changes (wifi to mobile data and
     * back). The old socket rode the old network and is usually dead, but the phone only
     * found out at its next ping, up to 30 seconds later, so a tab sent in between waited
     * that long [2026-10-27]. The first callback after registering reports the current
     * network and is only recorded.
     */
    private fun watchNetwork(context: Context) {
        if (networkWatch != null) return
        val cm = context.getSystemService(ConnectivityManager::class.java) ?: return
        val callback = object : ConnectivityManager.NetworkCallback() {
            private var current: Network? = null

            override fun onAvailable(network: Network) {
                val previous = current
                current = network
                if (previous != null && previous != network) {
                    Log.d(TAG, "network changed: reconnecting stream")
                    reconnect(context)
                }
            }
        }
        try {
            cm.registerDefaultNetworkCallback(callback)
            networkWatch = callback
        } catch (e: RuntimeException) {
            // Too many callbacks registered app-wide; the heartbeat still catches it.
            Log.d(TAG, "network watch unavailable: ${e.message}")
        }
    }

    private fun unwatchNetwork(context: Context) {
        val callback = networkWatch ?: return
        networkWatch = null
        try {
            context.getSystemService(ConnectivityManager::class.java)?.unregisterNetworkCallback(callback)
        } catch (_: IllegalArgumentException) {
            // Already gone.
        }
    }

    /** [restart] for a stream that is running; does not start one that should not be. */
    @Synchronized
    private fun reconnect(context: Context) {
        if (runner == null) return
        runner?.cancel()
        runner = scope.launch { runLoop(context) }
    }

    /** Connect → listen → (on drop) back off → reconnect, until cancelled. */
    private suspend fun runLoop(context: Context) {
        var backoff = BACKOFF_START_MS
        while (true) {
            val reg = Store.get(context).registration ?: return
            val outcome = connectOnce(context, reg.relayUrl, reg.deviceToken, reg.certFingerprint)
            if (outcome == Outcome.CLEAN_LONG_SESSION) backoff = BACKOFF_START_MS
            delay(backoff)
            backoff = (backoff * 2).coerceAtMost(BACKOFF_MAX_MS)
        }
    }

    private enum class Outcome { CLEAN_LONG_SESSION, FAILED_FAST }

    /**
     * One socket session: hello, ping every 30 s, drain on `message`. Returns
     * when the socket dies or stops answering. A session that lived a while
     * resets the backoff.
     */
    private suspend fun connectOnce(
        context: Context,
        relayUrl: String,
        deviceToken: String,
        certFingerprint: String?,
    ): Outcome {
        val startedAt = System.currentTimeMillis()
        val url = relayUrl.trimEnd('/') + "/v1/stream"
        val request = Request.Builder().url(url).build()

        val done = CompletableDeferred<Unit>()
        var socket: WebSocket? = null
        // Elapsed time, which keeps counting while the phone sleeps.
        val lastHeardAt = AtomicLong(SystemClock.elapsedRealtime())
        val listener = object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                lastHeardAt.set(SystemClock.elapsedRealtime())
                webSocket.send("""{"type":"hello","deviceToken":"$deviceToken"}""")
                Log.d(TAG, "stream connected")
                // Catch anything queued while we were disconnected — in BOTH
                // directions. A socket that has just come up is the earliest and
                // most certain evidence there is that the relay is answering
                // again, and it used to be spent entirely on the receive side:
                // tabs held here waited out the ~5-minute poll tick (up to ~15 in
                // Doze) before anyone retried them, so a relay that came back
                // stayed "waiting to send" on screen for minutes after it had.
                //
                // Two coroutines rather than one after the other: the drain is the
                // latency this socket exists to buy, and it must not queue behind
                // a flush of however many tabs piled up during the outage.
                scope.launch { Deliverer.drain(context) }
                scope.launch { flushAndReport(context) }
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                lastHeardAt.set(SystemClock.elapsedRealtime())
                val type = try {
                    json.parseToJsonElement(text).jsonObject["type"]?.jsonPrimitive?.content
                } catch (_: Exception) {
                    null
                }
                // Any other type (and anything that does not parse) is ignored.
                when (type) {
                    // Never trust stream bytes; the drain loop pulls + verifies (PRD §6.1).
                    "message" -> scope.launch { Deliverer.drain(context) }
                    // The group's own state changed [P-18 item 12]: the event carries
                    // nothing, so ask the relay what it is now.
                    "group_updated" -> scope.launch { GroupResetWatcher.checkNow(context) }
                }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                Log.d(TAG, "stream dropped: ${t.message}")
                done.complete(Unit)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                done.complete(Unit)
            }
        }

        try {
            // A pinned registration (P-3) gets a WS client that trusts exactly that key.
            val ws = if (certFingerprint != null) Tls.pinnedClient(client, certFingerprint) else client
            val open = ws.newWebSocket(request, listener)
            socket = open
            // Ping until the socket dies, stops answering, or we're cancelled.
            val end = Heartbeat.run(
                now = SystemClock::elapsedRealtime,
                lastHeardAt = lastHeardAt::get,
                isClosed = { done.isCompleted },
                sendPing = { open.send("""{"type":"ping"}""") },
            )
            if (end == Heartbeat.End.SILENT) {
                Log.d(TAG, "stream silent: no answer to a ping, reconnecting")
                // No close handshake: there is nobody on the other end to answer it.
                open.cancel()
                socket = null
            }
        } finally {
            socket?.close(1000, null)
        }

        val lived = System.currentTimeMillis() - startedAt
        return if (lived > Heartbeat.PING_INTERVAL_MS) Outcome.CLEAN_LONG_SESSION else Outcome.FAILED_FAST
    }
}
