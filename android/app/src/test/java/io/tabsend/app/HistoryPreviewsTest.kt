package io.tabsend.app

import io.tabsend.app.ui.HistoryPreviews
import org.junit.Assert.*
import org.junit.Test

class HistoryPreviewsTest {
    @Test fun publicHttpsOnly() {
        assertTrue(HistoryPreviews.eligible("https://example.com/article"))
        for (url in listOf("http://example.com", "https://127.0.0.1", "https://[::1]", "https://printer.local", "https://user:pass@example.com", "https://example.com:8443")) {
            assertFalse(url, HistoryPreviews.eligible(url))
        }
    }
    @Test fun metadataHandlesAttributeOrderAndEntities() {
        val values = HistoryPreviews.metadata("""<meta content='A &amp; B' property='og:title'><meta property=og:image content='/cover.jpg'><meta name="description" content="Details">""")
        assertEquals("A & B", values["og:title"])
        assertEquals("/cover.jpg", values["og:image"])
        assertEquals("Details", values["description"])
    }
    @Test fun emptyAttributesAndLongTextAreSafe() {
        assertEquals("", HistoryPreviews.metadata("<meta property='og:title' content=''>")["og:title"])
        assertEquals(500, HistoryPreviews.metadata("<meta property='og:title' content='${"a".repeat(2000)}'>")["og:title"]?.length)
    }
}
