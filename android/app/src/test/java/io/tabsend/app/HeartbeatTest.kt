package io.tabsend.app

import io.tabsend.app.logic.Heartbeat
import io.tabsend.app.logic.Heartbeat.End
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.currentTime
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The stream's heartbeat [2026-10-27]: a connection the relay has stopped answering is
 * given up within one ping and its answer window, instead of looking alive until TCP
 * gives up. Runs on virtual time.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class HeartbeatTest {

    /** A fake socket: [answering] says whether the relay answers each ping at once. */
    private class FakeSocket(private val scope: TestScope) {
        var answering = true
        var closed = false
        var refusing = false
        var lastHeardAt = 0L
        val pings = mutableListOf<Long>()

        fun send(): Boolean {
            if (closed || refusing) return false
            pings += scope.currentTime
            if (answering) lastHeardAt = scope.currentTime + 50
            return true
        }
    }

    private suspend fun TestScope.beat(socket: FakeSocket) = Heartbeat.run(
        now = { currentTime },
        lastHeardAt = { socket.lastHeardAt },
        isClosed = { socket.closed },
        sendPing = socket::send,
    )

    @Test
    fun `an answering relay keeps the stream, one ping every 30 seconds`() = runTest {
        val socket = FakeSocket(this)
        var end: End? = null
        launch { end = beat(socket) }

        advanceTimeBy(10 * 60_000L)
        assertEquals(null, end)
        assertEquals(20, socket.pings.size)
        assertEquals(Heartbeat.PING_INTERVAL_MS, socket.pings[1] - socket.pings[0])

        socket.closed = true
        advanceTimeBy(Heartbeat.PING_INTERVAL_MS)
        assertEquals(End.CLOSED, end)
    }

    @Test
    fun `a relay that stops answering is given up within 40 seconds`() = runTest {
        val socket = FakeSocket(this)
        var end: End? = null
        var endedAt = 0L
        launch {
            end = beat(socket)
            endedAt = currentTime
        }

        advanceTimeBy(5 * 60_000L + 1)
        assertEquals(null, end)

        // The connection dies silently: pings still "send", nothing comes back.
        val diedAt = currentTime
        socket.answering = false
        advanceTimeBy(Heartbeat.PING_INTERVAL_MS + Heartbeat.PONG_TIMEOUT_MS)
        assertEquals(End.SILENT, end)
        assertTrue(endedAt - diedAt <= Heartbeat.PING_INTERVAL_MS + Heartbeat.PONG_TIMEOUT_MS)
    }

    @Test
    fun `any frame from the relay counts as an answer, not only pong`() = runTest {
        val socket = FakeSocket(this)
        socket.answering = false
        var end: End? = null
        launch { end = beat(socket) }

        // A tab notice arrives a few seconds after each ping, though no pong does.
        repeat(6) {
            advanceTimeBy(Heartbeat.PING_INTERVAL_MS - Heartbeat.PONG_TIMEOUT_MS + 3_000L)
            socket.lastHeardAt = currentTime
            advanceTimeBy(Heartbeat.PONG_TIMEOUT_MS - 3_000L)
        }
        assertEquals(null, end)

        socket.closed = true
        advanceTimeBy(Heartbeat.PING_INTERVAL_MS)
        assertEquals(End.CLOSED, end)
    }

    @Test
    fun `a socket that refuses the ping ends the loop as closed`() = runTest {
        val socket = FakeSocket(this)
        var end: End? = null
        launch { end = beat(socket) }

        advanceTimeBy(Heartbeat.PING_INTERVAL_MS + 1)
        // OkHttp's send() says false once the socket is closing, before any callback.
        socket.refusing = true
        advanceTimeBy(Heartbeat.PING_INTERVAL_MS)
        assertEquals(End.CLOSED, end)
    }
}
