import Testing
@testable import TabsendKit

struct LinkURLPolicyTests {
    @Test func acceptsAbsoluteWebLinks() throws {
        let https = try #require(LinkURLPolicy.openableURL(from: "https://example.com/path?q=1#part"))
        #expect(https.host == "example.com")

        let http = try #require(LinkURLPolicy.openableURL(from: "http://localhost:8787/health"))
        #expect(http.host == "localhost")

        let mixedCase = try #require(LinkURLPolicy.openableURL(from: "HTTPS://example.com"))
        #expect(mixedCase.scheme?.lowercased() == "https")
    }

    @Test func rejectsDangerousAndUnexpectedSchemes() {
        for value in [
            "javascript:alert(1)",
            "data:text/html,<script>alert(1)</script>",
            "file:///private/etc/passwd",
            "tabsend://pair/secret",
            "mailto:security@example.com",
        ] {
            #expect(LinkURLPolicy.openableURL(from: value) == nil)
        }
    }

    @Test func rejectsMalformedAndNonAbsoluteWebLinks() {
        for value in [
            "example.com",
            "//example.com/path",
            "https:path-without-a-host",
            "https://",
            "",
        ] {
            #expect(LinkURLPolicy.openableURL(from: value) == nil)
        }
    }
}
