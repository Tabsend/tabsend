package io.tabsend.app

import io.tabsend.app.logic.noticeIdOf
import io.tabsend.app.logic.stalePendingNoticeIds
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The rule that takes a "Waiting to send" notice down again.
 *
 * The bug this pins: the relay came back, the queue drained, and the notice that
 * had promised exactly that stayed in the shade claiming the relay was still
 * unreachable. Mirrored by SendNoticesTests.swift on iOS.
 */
class SendNoticesTest {

    private val a = "11111111-1111-1111-1111-111111111111"
    private val b = "22222222-2222-2222-2222-222222222222"
    private val c = "33333333-3333-3333-3333-333333333333"

    @Test
    fun `a notice whose tab is still queued stays up`() {
        val posted = listOf(noticeIdOf(a), noticeIdOf(b))
        assertTrue(stalePendingNoticeIds(posted, listOf(a, b)).isEmpty())
    }

    @Test
    fun `a notice whose tab has left the queue comes down`() {
        val posted = listOf(noticeIdOf(a), noticeIdOf(b))
        assertEquals(listOf(noticeIdOf(a)), stalePendingNoticeIds(posted, listOf(b)))
    }

    @Test
    fun `an emptied queue takes every notice with it`() {
        val posted = listOf(noticeIdOf(a), noticeIdOf(b), noticeIdOf(c))
        assertEquals(posted, stalePendingNoticeIds(posted, emptyList()))
    }

    /**
     * The ordinary case: the flush worker sweeping has no idea which sends were
     * ever announced, and the queue may well hold tabs that never got a notice
     * (notifications denied, or the share sheet died before it could post). A
     * held tab with nothing on screen must not manufacture a cancellation.
     */
    @Test
    fun `held tabs that were never announced are not cancellations`() {
        assertTrue(stalePendingNoticeIds(emptyList(), listOf(a, b)).isEmpty())
        assertEquals(listOf(noticeIdOf(c)), stalePendingNoticeIds(listOf(noticeIdOf(c)), listOf(a, b)))
    }

    /** The id is what the OS hands back, so it has to be derivable from the queue. */
    @Test
    fun `the notice id is a pure function of the message id`() {
        assertEquals(noticeIdOf(a), noticeIdOf(a))
        assertTrue(noticeIdOf(a) != noticeIdOf(b))
    }
}
