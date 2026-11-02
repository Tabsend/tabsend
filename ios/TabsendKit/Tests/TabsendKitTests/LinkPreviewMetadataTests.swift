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

    @Test func boundsTextAndAcceptsEmptyAttributes() {
        #expect(LinkPreviewMetadata.parse("<meta property='og:title' content=''>")["og:title"] == "")
        let result = LinkPreviewMetadata.parse("<meta property='og:title' content='\(String(repeating: "a", count: 2000))'>")
        #expect(result["og:title"]?.count == 500)
    }
}
