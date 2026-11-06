import Foundation
import Testing
@testable import TabsendKit

struct LinkPreviewMetadataTests {
    @Test func eligibleWebsites() {
        #expect(LinkPreviewMetadata.eligible(URL(string: "https://example.com/article")!))
        #expect(LinkPreviewMetadata.eligible(URL(string: "HTTPS://example.com:443/article")!))
        for raw in ["http://example.com", "https://127.0.0.1", "https://[::1]", "https://printer.local", "https://user:pass@example.com", "https://example.com:8443"] {
            #expect(!LinkPreviewMetadata.eligible(URL(string: raw)!))
        }
    }

    // A page address with a query string or a fragment may hold a one-time token; the phone must
    // not request it just to find a picture (security review v0.11.0, HP3).
    @Test func aPageWithAQueryOrFragmentIsNotRequested() {
        #expect(LinkPreviewMetadata.mayRequestPage(URL(string: "https://example.com/article")!))
        #expect(LinkPreviewMetadata.mayRequestPage(URL(string: "https://example.com/")!))
        for raw in [
            "https://example.com/confirm?token=abc", "https://example.com/a?", "https://example.com/a#section",
            "https://example.com/#/inbox", "https://example.com/a?b=1#c",
        ] {
            #expect(!LinkPreviewMetadata.mayRequestPage(URL(string: raw)!), "\(raw)")
        }
        // An address that is not eligible at all stays out too.
        #expect(!LinkPreviewMetadata.mayRequestPage(URL(string: "http://example.com/article")!))
    }

    @Test func parsesMetadataInEitherAttributeOrder() {
        let result = LinkPreviewMetadata.parse("""
            <script>ignored()</script>
            <meta content='A &amp; B' property='og:title'>
            <meta property=og:image content='/cover.jpg'>
            <meta name="description" content="Details">
            """)
        #expect(result["og:title"] == "A & B")
        #expect(result["og:image"] == "/cover.jpg")
        #expect(result["description"] == "Details")
    }

    // A hostile page must not keep the phone busy (security review v0.11.0, HP1). Before the fix,
    // one 16,000-character attribute name took about 10 seconds and 240 KB of `<meta ` over a minute.
    @Test func aHostileHeadIsReadQuickly() {
        let started = Date()
        let longName = LinkPreviewMetadata.parse("<meta " + String(repeating: "a", count: 600_000))
        let unclosed = LinkPreviewMetadata.parse(String(repeating: "<meta ", count: 100_000))
        let manyAttributes = LinkPreviewMetadata.parse("<meta " + String(repeating: "x=1 ", count: 1000) + ">")
        let nameRun = LinkPreviewMetadata.parse("<meta " + String(repeating: "a", count: 4000) + ">")
        #expect(longName.isEmpty && unclosed.isEmpty && manyAttributes.isEmpty && nameRun.isEmpty)
        #expect(Date().timeIntervalSince(started) < 2, "took \(Date().timeIntervalSince(started)) seconds")
    }

    @Test func realTagsStillCountAfterManyBrokenOnes() {
        let page = String(repeating: "<meta ", count: 50) + "<metadata x='1'>\n<META PROPERTY=\"og:title\" CONTENT=\"Hello\">"
        #expect(LinkPreviewMetadata.parse(page)["og:title"] == "Hello")
    }

    @Test func boundsTextAndAcceptsEmptyAttributes() {
        #expect(LinkPreviewMetadata.parse("<meta property='og:title' content=''>")["og:title"] == "")
        let result = LinkPreviewMetadata.parse("<meta property='og:title' content='\(String(repeating: "a", count: 2000))'>")
        #expect(result["og:title"]?.count == 500)
    }

    @Test func pictureAddressPrefersOpenGraphAndResolvesAgainstThePage() {
        let page = URL(string: "https://example.com/articles/one")!
        #expect(LinkPreviewMetadata.pictureAddress(
            in: ["og:image": "/cover.jpg", "twitter:image": "https://cdn.example.com/t.jpg"], page: page
        ) == "https://example.com/cover.jpg")
        #expect(LinkPreviewMetadata.pictureAddress(
            in: ["twitter:image": "https://cdn.example.com/t.jpg"], page: page
        ) == "https://cdn.example.com/t.jpg")
        // An address that fails the rule falls through to the next, then to nothing.
        #expect(LinkPreviewMetadata.pictureAddress(
            in: ["og:image": "http://example.com/a.jpg", "twitter:image": "https://cdn.example.com/t.jpg"], page: page
        ) == "https://cdn.example.com/t.jpg")
        #expect(LinkPreviewMetadata.pictureAddress(in: ["og:image": "https://192.168.1.2/a.jpg"], page: page) == nil)
        #expect(LinkPreviewMetadata.pictureAddress(in: [:], page: page) == nil)
    }

    @Test func aPictureAddressFromAPayloadIsCheckedLikeAnyOther() {
        #expect(LinkPreviewMetadata.usableImage("https://cdn.example.com/a.jpg") != nil)
        for raw in ["http://cdn.example.com/a.jpg", "javascript:alert(1)", "https://127.0.0.1/a.jpg", "https://printer.local/a.jpg", ""] {
            #expect(LinkPreviewMetadata.usableImage(raw) == nil)
        }
        #expect(LinkPreviewMetadata.usableImage(nil) == nil)
        let long = "https://cdn.example.com/" + String(repeating: "a", count: 2048)
        #expect(LinkPreviewMetadata.usableImage(long) == nil)
    }

    @Test func aLongPictureAddressIsNotCutShortAndTheFirstTagWins() {
        let long = "https://cdn.example.com/" + String(repeating: "a", count: 1000)
        let result = LinkPreviewMetadata.parse("""
            <meta property="og:image" content="\(long)">
            <meta property="og:image" content="https://cdn.example.com/second.jpg">
            """)
        #expect(result["og:image"] == long)
    }
}
