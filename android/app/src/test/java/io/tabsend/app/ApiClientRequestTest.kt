package io.tabsend.app

import io.tabsend.app.net.ApiClient
import io.tabsend.app.net.ApiException
import io.tabsend.app.net.Registrar
import io.tabsend.app.store.Registration
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.runBlocking
import okio.Buffer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.net.InetAddress
import java.net.ServerSocket
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

class ApiClientRequestTest {
    @Test
    fun `bodyless post uses a valid empty JSON object`() {
        val body = ApiClient("https://relay.example").emptyJsonBody()
        val buffer = Buffer()

        body.writeTo(buffer)

        assertEquals("application/json; charset=utf-8", body.contentType().toString())
        assertEquals("{}", buffer.readUtf8())
    }

    /** Answers one request with [status] and [body], and keeps the request head. */
    private class OneShot(private val status: Int, private val body: String = "{}") : AutoCloseable {
        private val socket = ServerSocket(0, 1, InetAddress.getLoopbackAddress())
        val url = "http://127.0.0.1:${socket.localPort}"

        @Volatile
        var request: String? = null

        init {
            thread(isDaemon = true) {
                try {
                    socket.accept().use { conn ->
                        val input = conn.getInputStream().bufferedReader()
                        val head = StringBuilder()
                        while (true) {
                            val line = input.readLine() ?: break
                            if (line.isEmpty()) break
                            head.append(line).append('\n')
                        }
                        request = head.toString()
                        // Read the body too, so closing never resets a POST mid-answer.
                        val length = Regex("(?i)content-length: *(\\d+)").find(head)?.groupValues?.get(1)?.toInt() ?: 0
                        repeat(length) { input.read() }
                        val bytes = body.toByteArray()
                        conn.getOutputStream().apply {
                            write(
                                ("HTTP/1.1 $status Status\r\nContent-Type: application/json\r\n" +
                                    "Content-Length: ${bytes.size}\r\nConnection: close\r\n\r\n").toByteArray(),
                            )
                            write(bytes)
                            flush()
                        }
                    }
                } catch (_: Exception) {
                    // Closed by the test.
                }
            }
        }

        override fun close() = socket.close()
    }

    @Test
    fun `removing a device is a bodyless DELETE of that endpoint with the device token`() {
        OneShot(200, """{"ok":true}""").use { server ->
            ApiClient(server.url).deleteEndpoint("tok-1", "ep/x")
            val request = requireNotNull(server.request)
            assertTrue(request, request.startsWith("DELETE /v1/endpoints/ep%2Fx "))
            assertTrue(request.contains("Authorization: Bearer tok-1"))
            assertFalse(request.contains("Content-Type: application/json"))
        }
    }

    @Test
    fun `a device that is already gone counts as removed`() {
        OneShot(404, """{"error":{"code":"not_found","message":"Endpoint not found in your group."}}""").use { server ->
            ApiClient(server.url).deleteEndpoint("tok-1", "x") // no throw
        }
    }

    // --- leaving the group (PLANS P-28) ---------------------------------------

    private val leaving = Registration(
        endpointId = "ep-1",
        groupId = "g-1",
        deviceToken = "tok-1",
        relayUrl = "",
        label = "Phone",
    )

    @Test
    fun `leaving removes this phone's own entry with its own token`() = runBlocking {
        OneShot(200, """{"ok":true}""").use { server ->
            Registrar.leaveRelay(leaving.copy(relayUrl = server.url), CoroutineScope(SupervisorJob()))
            val request = requireNotNull(server.request) { "the relay was never asked" }
            assertTrue(request, request.startsWith("DELETE /v1/endpoints/ep-1 "))
            assertTrue(request.contains("Authorization: Bearer tok-1"))
        }
    }

    @Test
    fun `leaving does not depend on what the relay answers`() = runBlocking {
        // Refused, and already removed (a tombstoned token answers 401): neither throws.
        for (status in listOf(500, 401)) {
            OneShot(status, """{"error":{"code":"x","message":"no"}}""").use { server ->
                Registrar.leaveRelay(leaving.copy(relayUrl = server.url), CoroutineScope(SupervisorJob()))
            }
        }
        // Nobody there at all: this port was just closed.
        val closed = OneShot(200).let { it.close(); it.url }
        Registrar.leaveRelay(leaving.copy(relayUrl = closed), CoroutineScope(SupervisorJob()))
    }

    @Test
    fun `a slow relay does not hold up leaving, and still gets the request`() = runBlocking {
        val release = CountDownLatch(1)
        val finished = CountDownLatch(1)
        Registrar.leaveRelay(leaving, CoroutineScope(SupervisorJob()), patienceMs = 50) {
            release.await()
            finished.countDown()
        }
        assertEquals("returned while the relay was still silent", 1L, finished.count)
        release.countDown()
        assertTrue(finished.await(5, TimeUnit.SECONDS))
    }

    // --- the reset that waits (P-18 item 12) ---------------------------------

    @Test
    fun `the group state is a GET of the group with the device token`() {
        OneShot(200, """{"reset":{"requestedAt":"2026-10-27T14:00:00.000Z","resetsAt":"2026-10-30T14:00:00.000Z"}}""").use { server ->
            val reset = ApiClient(server.url).getGroupState("tok-1").reset
            assertEquals("2026-10-27T14:00:00.000Z", reset?.requestedAt)
            assertEquals("2026-10-30T14:00:00.000Z", reset?.resetsAt)
            val request = requireNotNull(server.request)
            assertTrue(request, request.startsWith("GET /v1/group "))
            assertTrue(request.contains("Authorization: Bearer tok-1"))
        }
    }

    @Test
    fun `no reset pending reads as null`() {
        OneShot(200, """{"reset":null}""").use { server ->
            assertNull(ApiClient(server.url).getGroupState("tok-1").reset)
        }
    }

    @Test
    fun `an older relay without the route counts as no reset and no plan, quietly`() {
        OneShot(404, """{"error":{"code":"not_found","message":"Route GET:/v1/group not found"}}""").use { server ->
            val state = ApiClient(server.url).getGroupState("tok-1") // no throw
            assertNull(state.reset)
            assertNull(state.service)
        }
    }

    @Test
    fun `the plan words ride on the group state (P-19)`() {
        OneShot(200, """{"reset":null,"service":{"state":"trial","trialEndsAt":"2026-11-18T14:00:00.000Z"}}""").use { server ->
            val service = ApiClient(server.url).getGroupState("tok-1").service
            assertEquals("trial", service?.state)
            assertEquals("2026-11-18T14:00:00.000Z", service?.trialEndsAt)
        }
    }

    @Test
    fun `any other refusal of the group state is thrown, so the last answer stands`() {
        OneShot(500, """{"error":{"code":"internal","message":"boom"}}""").use { server ->
            try {
                ApiClient(server.url).getGroupState("tok-1")
                fail("expected ApiException")
            } catch (e: ApiException) {
                assertEquals(500, e.status)
            }
        }
    }

    @Test
    fun `stopping the reset is a JSON POST with the device token`() {
        OneShot(200, """{"reset":null}""").use { server ->
            ApiClient(server.url).stopGroupReset("tok-1")
            val request = requireNotNull(server.request)
            assertTrue(request, request.startsWith("POST /v1/group/reset/stop "))
            assertTrue(request.contains("Authorization: Bearer tok-1"))
            assertTrue(request, request.contains("Content-Type: application/json"))
        }
    }

    @Test
    fun `any other refusal is reported with its code`() {
        OneShot(401, """{"error":{"code":"endpoint_removed","message":"This endpoint was removed from its group."}}""").use { server ->
            try {
                ApiClient(server.url).deleteEndpoint("tok-1", "x")
                fail("expected ApiException")
            } catch (e: ApiException) {
                assertEquals(401, e.status)
                assertEquals("endpoint_removed", e.code)
            }
        }
    }
}
