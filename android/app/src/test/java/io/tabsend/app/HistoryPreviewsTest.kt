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
    // A page address with a query string or a fragment may hold a one-time token; the phone must
    // not request it just to find a picture (security review v0.11.0, HP3).
    @Test fun aPageWithAQueryOrFragmentIsNotRequested() {
        assertTrue(HistoryPreviews.mayRequestPage("https://example.com/article"))
        assertTrue(HistoryPreviews.mayRequestPage("https://example.com/"))
        for (url in listOf("https://example.com/confirm?token=abc", "https://example.com/a?", "https://example.com/a#section", "https://example.com/#/inbox", "https://example.com/a?b=1#c")) {
            assertFalse(url, HistoryPreviews.mayRequestPage(url))
        }
        assertFalse(HistoryPreviews.mayRequestPage("http://example.com/article"))
    }
    @Test fun metadataHandlesAttributeOrderAndEntities() {
        val values = HistoryPreviews.metadata("""<meta content='A &amp; B' property='og:title'><meta property=og:image content='/cover.jpg'><meta name="description" content="Details">""")
        assertEquals("A & B", values["og:title"])
        assertEquals("/cover.jpg", values["og:image"])
        assertEquals("Details", values["description"])
    }
    // A hostile page must not keep the phone busy (security review v0.11.0, HP1).
    @Test fun aHostileHeadIsReadQuickly() {
        val started = System.nanoTime()
        val pages = listOf(
            "<meta " + "a".repeat(600_000),
            "<meta ".repeat(100_000),
            "<meta " + "x=1 ".repeat(1000) + ">",
            "<meta " + "a".repeat(4000) + ">",
        )
        for (page in pages) assertTrue(HistoryPreviews.metadata(page).isEmpty())
        val seconds = (System.nanoTime() - started) / 1e9
        assertTrue("took $seconds seconds", seconds < 2.0)
    }
    @Test fun realTagsStillCountAfterManyBrokenOnes() {
        val page = "<meta ".repeat(50) + "<metadata x='1'>\n<META PROPERTY=\"og:title\" CONTENT=\"Hello\">"
        assertEquals("Hello", HistoryPreviews.metadata(page)["og:title"])
    }
    @Test fun emptyAttributesAndLongTextAreSafe() {
        assertEquals("", HistoryPreviews.metadata("<meta property='og:title' content=''>")["og:title"])
        assertEquals(500, HistoryPreviews.metadata("<meta property='og:title' content='${"a".repeat(2000)}'>")["og:title"]?.length)
    }
    @Test fun aPictureAddressMustPassTheSameRuleAsAPage() {
        assertEquals("https://cdn.example.com/a.jpg", HistoryPreviews.usableImage("https://cdn.example.com/a.jpg"))
        assertNull(HistoryPreviews.usableImage(null))
        for (url in listOf("http://example.com/a.jpg", "https://127.0.0.1/a.jpg", "https://printer.local/a.jpg", "data:image/png;base64,AAAA", "https://example.com/" + "a".repeat(2048))) {
            assertNull(url, HistoryPreviews.usableImage(url))
        }
    }
    @Test fun thePagesPictureIsResolvedAndChecked() {
        val page = "https://example.com/story/1"
        assertEquals("https://example.com/cover.jpg", HistoryPreviews.imageFrom(mapOf("og:image" to "/cover.jpg"), page))
        assertEquals("https://example.com/t.jpg", HistoryPreviews.imageFrom(mapOf("twitter:image" to "/t.jpg"), page))
        assertEquals("https://example.com/og.jpg", HistoryPreviews.imageFrom(mapOf("og:image" to "/og.jpg", "twitter:image" to "/t.jpg"), page))
        assertNull(HistoryPreviews.imageFrom(mapOf("og:image" to "http://example.com/plain.jpg"), page))
        assertNull(HistoryPreviews.imageFrom(emptyMap(), page))
    }
    @Test fun aPictureAddressTooLongIsRefusedNotCutShort() {
        val long = "https://example.com/" + "a".repeat(3000)
        val meta = HistoryPreviews.metadata("<meta property='og:image' content='$long'>")
        assertNull(HistoryPreviews.imageFrom(meta, "https://example.com/"))
    }
}
