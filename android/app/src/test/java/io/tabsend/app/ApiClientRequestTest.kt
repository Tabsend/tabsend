package io.tabsend.app

import io.tabsend.app.net.ApiClient
import io.tabsend.app.net.ApiException
import okio.Buffer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.net.InetAddress
import java.net.ServerSocket
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
