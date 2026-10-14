package io.tabsend.app

import io.tabsend.app.push.Forwarder
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.InetAddress
import java.net.ServerSocket
import kotlin.concurrent.thread

/**
 * The app's wake-up service client against a real socket [2026-10-02, SECURITY_REVIEW G8]:
 * what counts as "told" for a revoke, and what counts as a wake token for a register.
 */
class ForwarderClientTest {

    /** Answers one request with [status] and [body], and keeps what it was sent. */
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
                        var length = 0
                        while (true) {
                            val line = input.readLine() ?: break
                            if (line.isEmpty()) break
                            head.append(line).append('\n')
                            if (line.startsWith("Content-Length:", ignoreCase = true)) {
                                length = line.substringAfter(':').trim().toInt()
                            }
                        }
                        val chars = CharArray(length)
                        var read = 0
                        while (read < length) {
                            val n = input.read(chars, read, length - read)
                            if (n < 0) break
                            read += n
                        }
                        request = head.toString() + String(chars, 0, read)
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

    /** A port nothing listens on. */
    private fun nowhere(): String {
        val port = ServerSocket(0, 1, InetAddress.getLoopbackAddress()).use { it.localPort }
        return "http://127.0.0.1:$port"
    }

    /** 43 base64url characters: the shape the forwarder mints. */
    private val wakeToken = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLM-_01"

    @Test
    fun `a revoke the forwarder took is done, and the token rides a header, never the URL`() {
        assertEquals(43, wakeToken.length)
        OneShot(200).use { server ->
            assertTrue(Forwarder.revoke(server.url, wakeToken))
            val request = requireNotNull(server.request)
            assertTrue(request.startsWith("POST /v1/revoke "))
            assertTrue(request.contains("Authorization: Bearer $wakeToken"))
            assertFalse(request.lineSequence().first().contains(wakeToken))
        }
    }

    /** It used to count any answer as told, so a 429 or a restart lost the token for good. */
    @Test
    fun `a revoke the forwarder did not take stays queued`() {
        for (status in listOf(429, 500, 502, 503)) {
            OneShot(status).use { server ->
                assertFalse("HTTP $status is not told", Forwarder.revoke(server.url, wakeToken))
            }
        }
        assertFalse(Forwarder.revoke(nowhere(), wakeToken))
    }

    @Test
    fun `a token the forwarder could never have minted is dropped without being sent`() {
        // Nowhere to send it: a request would fail and return false.
        assertTrue(Forwarder.revoke(nowhere(), "not a wake token"))
        assertTrue(Forwarder.revoke(nowhere(), "$wakeToken\r\nX-Injected: 1"))
    }

    @Test
    fun `a registration returns only a wake token of the shape the forwarder mints`() {
        OneShot(200, """{"wakeToken":"$wakeToken"}""").use { server ->
            assertEquals(wakeToken, Forwarder.register(server.url, "push-1"))
            val request = requireNotNull(server.request)
            assertTrue(request.startsWith("POST /v1/register "))
            assertTrue(request.endsWith("""{"fcmToken":"push-1"}"""))
        }
        for (reply in listOf("""{"wakeToken":"short"}""", """{"wakeToken":"$wakeToken\nX"}""", "<html>", "{}")) {
            OneShot(200, reply).use { server ->
                assertNull(reply, Forwarder.register(server.url, "push-1"))
            }
        }
        OneShot(501, """{"error":"not_configured"}""").use { server ->
            assertNull(Forwarder.register(server.url, "push-1"))
        }
        assertNull(Forwarder.register(nowhere(), "push-1"))
    }
}
