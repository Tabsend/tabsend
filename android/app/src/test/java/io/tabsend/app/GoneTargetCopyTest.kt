package io.tabsend.app

import io.tabsend.app.logic.GoneTargetCopy
import io.tabsend.app.logic.SendTone
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

/**
 * The words for a held tab whose device is gone (PLANS.md P-15 item 3),
 * pinned word for word as extension/src/lib/strings-gone-target.test.ts and
 * GoneTargetCopyTests.swift, so the three clients cannot drift apart.
 */
class GoneTargetCopyTest {

    @Test
    fun `says it was removed only for a device this phone removed`() {
        assertEquals(
            "Galaxy S24 Ultra was removed from your group.",
            GoneTargetCopy.removedLine("Galaxy S24 Ultra", removedHere = true),
        )
        assertEquals(
            "The device it was for was removed from your group.",
            GoneTargetCopy.removedLine(null, removedHere = true),
        )
    }

    @Test
    fun `claims no removal nobody here made (L3)`() {
        assertEquals(
            "Galaxy S24 Ultra is no longer in your group.",
            GoneTargetCopy.removedLine("Galaxy S24 Ultra", removedHere = false),
        )
        assertEquals(
            "The device it was for is no longer in your group.",
            GoneTargetCopy.removedLine(null, removedHere = false),
        )
    }

    @Test
    fun `says once, as a wait and not a failure, that a tab needs a new device`() {
        val one = GoneTargetCopy.banner(1, "All workflows", "Galaxy S24 Ultra", removedHere = true)
        assertEquals(SendTone.PENDING, one.tone)
        assertEquals("“All workflows” is waiting for a new device", one.headline)
        assertEquals(
            "Galaxy S24 Ultra was removed from your group. Open Tabsend to send it to another device.",
            one.detail,
        )
        val several = GoneTargetCopy.banner(3, "All workflows", null, removedHere = false)
        assertEquals("3 tabs are waiting for a new device", several.headline)
        assertEquals(
            "The device they were for is no longer in your group. Open Tabsend to send them to another device.",
            several.detail,
        )
        assertEquals(
            "A tab is waiting for a new device",
            GoneTargetCopy.banner(1, null, null, removedHere = false).headline,
        )
        assertEquals(
            "Pixel 8 is no longer in your group. Open Tabsend to send it to another device.",
            GoneTargetCopy.banner(1, "T", "Pixel 8", removedHere = false).detail,
        )
        assertEquals(
            "The device they were for was removed from your group. Open Tabsend to send them to another device.",
            GoneTargetCopy.banner(2, "T", null, removedHere = true).detail,
        )
    }

    @Test
    fun `uses no em dashes`() {
        val all = listOf(
            GoneTargetCopy.removedLine("X", removedHere = true),
            GoneTargetCopy.removedLine(null, removedHere = false),
            GoneTargetCopy.SEND_TO_MENU,
            GoneTargetCopy.NO_OTHER_DEVICE,
            GoneTargetCopy.banner(2, "T", "X", removedHere = true).headline,
            GoneTargetCopy.banner(2, "T", "X", removedHere = true).detail.orEmpty(),
            GoneTargetCopy.banner(2, "T", "X", removedHere = false).detail.orEmpty(),
        )
        for (line in all) assertFalse(line, line.contains('—'))
    }
}
