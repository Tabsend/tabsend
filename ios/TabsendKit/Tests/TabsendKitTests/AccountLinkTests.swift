import Foundation
import Testing
@testable import TabsendKit

/// The way back into the app after the account site's email link (docs/PLANS.md P-19).
struct AccountLinkTests {
    private let token = "4KdfBlkSe2LuSNYTjnD_HXxaM78HDKiyIsAg_v5KfJY"

    private func parse(_ link: String, site: String = AccountSetup.defaultSite) -> AccountLink? {
        URL(string: link).flatMap { AccountLink.parse($0, site: site) }
    }

    // MARK: which links are the app's

    @Test func anAddressOnTheAccountSiteIsRecognisedWhateverItsPath() {
        let site = AccountSetup.defaultSite
        let onSite = [
            "https://account.tabsend.org/app-start#c=ABCD2345&native=https%3A%2F%2Fevil.example",
            "https://ACCOUNT.tabsend.org/anything",
            "https://account.tabsend.org/",
        ]
        for link in onSite { #expect(URL(string: link).map { AccountLink.isOnSite($0, site: site) } == true, "\(link)") }
        let elsewhere = [
            "https://app.tabsend.org/pair#c=ABCD2345",
            "https://account.tabsend.org.evil.example/app-start",
            "http://account.tabsend.org/app-start",
            "https://account.tabsend.org:8443/app-start",
        ]
        for link in elsewhere { #expect(URL(string: link).map { AccountLink.isOnSite($0, site: site) } == false, "\(link)") }
    }

    @Test func aMadeUpPairingLinkOnTheSiteIsNotAnAccountLinkEither() {
        // The shape from the review: no token, a relay hint in the fragment. The app must drop it.
        #expect(parse("https://account.tabsend.org/app-start#c=ABCD2345&native=https%3A%2F%2Fevil.example") == nil)
    }

    @Test func aSignUpLinkIsRecognised() {
        #expect(parse("https://account.tabsend.org/app-start#t=\(token)") == .newAccount(token: token))
    }

    @Test func aSignInLinkIsRecognised() {
        #expect(parse("https://account.tabsend.org/app-signin#t=\(token)") == .signIn(token: token))
    }

    @Test func aTrailingSlashAndAnUpperCaseHostStillCount() {
        #expect(parse("https://ACCOUNT.tabsend.org/app-start/#t=\(token)") == .newAccount(token: token))
    }

    @Test func theTokenMayShareTheFragmentWithOtherFields() {
        #expect(parse("https://account.tabsend.org/app-start#x=1&t=\(token)") == .newAccount(token: token))
    }

    @Test func anyOtherPathOnTheSiteIsNotTheApps() {
        for path in ["/signin", "/start", "/account", "/app-start/extra", "/app-startx", "/", "/app", "/pair"] {
            #expect(parse("https://account.tabsend.org\(path)#t=\(token)") == nil, "\(path)")
        }
    }

    @Test func anotherHostSchemePortOrPasswordIsNotTheApps() {
        let bad = [
            "https://tabsend.org/app-start#t=\(token)",
            "https://account.tabsend.org.evil.example/app-start#t=\(token)",
            "https://evil.example/account.tabsend.org/app-start#t=\(token)",
            "http://account.tabsend.org/app-start#t=\(token)",
            "https://account.tabsend.org:8443/app-start#t=\(token)",
            "https://user:pw@account.tabsend.org/app-start#t=\(token)",
            "tabsend://account.tabsend.org/app-start#t=\(token)",
        ]
        for link in bad { #expect(parse(link) == nil, "\(link)") }
    }

    @Test func aLinkWithoutAUsableTokenIsNotTheApps() {
        let bad = [
            "https://account.tabsend.org/app-start",
            "https://account.tabsend.org/app-start#",
            "https://account.tabsend.org/app-start#t=",
            "https://account.tabsend.org/app-start#u=\(token)",
            "https://account.tabsend.org/app-start?t=\(token)",
            "https://account.tabsend.org/app-start#t=a%2Fb",
            "https://account.tabsend.org/app-start#t=a b",
            "https://account.tabsend.org/app-start#t=\(String(repeating: "a", count: 201))",
        ]
        for link in bad { #expect(parse(link) == nil, "\(link)") }
    }

    @Test func aDebugSiteIsMatchedOnItsOwnSchemeHostAndPort() {
        let site = "http://localhost:8790"
        #expect(parse("http://localhost:8790/app-start#t=\(token)", site: site) == .newAccount(token: token))
        #expect(parse("https://account.tabsend.org/app-start#t=\(token)", site: site) == nil)
        #expect(parse("http://localhost:9999/app-start#t=\(token)", site: site) == nil)
    }

    @Test func theSignInPageCarriesTheTokenInTheFragmentAndStaysInTheAppLook() {
        let link = AccountLink.signIn(token: token)
        #expect(link.signInPage()?.absoluteString == "https://account.tabsend.org/signin?from=app#t=\(token)")
        #expect(link.signInPage(site: "http://localhost:8790/")?.absoluteString
            == "http://localhost:8790/signin?from=app#t=\(token)")
        // A sign-up link has no sign-in page: the app finishes that one itself.
        #expect(AccountLink.newAccount(token: token).signInPage() == nil)
    }

    // MARK: using a sign-up link

    private func response(_ status: Int, _ json: String) -> AccountSiteClient.Send {
        { request in
            let http = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
            return (Data(json.utf8), http)
        }
    }

    @Test func aNewAccountAnswersItsSetupLinkAndTheTrialEnd() async throws {
        let sent = SentRequest()
        let handBack = try await AccountSiteClient.redeem(token: token) { request in
            sent.record(request)
            let http = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            return (Data(#"{"ok":true,"created":true,"setupLink":"https://app.tabsend.org/pair#c=66AS8CJJ","trialEndsAt":"2026-11-18T10:00:00.000Z"}"#.utf8), http)
        }
        #expect(handBack.created)
        #expect(handBack.setupLink == "https://app.tabsend.org/pair#c=66AS8CJJ")
        #expect(handBack.trialEndsAt == Date(timeIntervalSince1970: 1_794_996_000))
        // One JSON POST with the token and nothing else: no cookie, no account detail.
        let request = try #require(sent.last)
        #expect(request.httpMethod == "POST")
        #expect(request.url?.absoluteString == "https://account.tabsend.org/api/app/redeem")
        #expect(request.value(forHTTPHeaderField: "Content-Type") == "application/json")
        #expect(String(data: request.httpBody ?? Data(), encoding: .utf8) == #"{"token":"\#(token)"}"#)
    }

    @Test func aReturningPersonIsNotToldATrialStarted() async throws {
        let handBack = try await AccountSiteClient.redeem(
            token: token,
            send: response(200, #"{"ok":true,"created":false,"setupLink":null,"trialEndsAt":null}"#)
        )
        #expect(!handBack.created)
        #expect(handBack.setupLink == nil)
        #expect(handBack.trialEndsAt == nil)
    }

    @Test func anOldOrUsedLinkIsExpired() async {
        await #expect(throws: AccountSiteError.linkExpired) {
            try await AccountSiteClient.redeem(
                token: token,
                send: response(410, #"{"error":"expired","code":"link_expired"}"#)
            )
        }
    }

    @Test func aSiteThatCannotBeReachedIsUnreachable() async {
        await #expect(throws: AccountSiteError.unreachable) {
            try await AccountSiteClient.redeem(token: token) { _ in throw URLError(.notConnectedToInternet) }
        }
    }

    @Test func anAnswerTheAppDoesNotUnderstandIsUnexpected() async {
        for (status, json) in [(200, "not json"), (200, #"{"ok":true}"#), (500, "{}"),
                               (200, #"{"created":true,"setupLink":"not a setup link"}"#)] {
            await #expect(throws: AccountSiteError.unexpected, "\(status) \(json)") {
                try await AccountSiteClient.redeem(token: token, send: response(status, json))
            }
        }
    }

    @Test func aTokenThatCannotBeOneIsNeverSent() async {
        let sent = SentRequest()
        await #expect(throws: AccountSiteError.unexpected) {
            try await AccountSiteClient.redeem(token: "a b\"c") { request in
                sent.record(request)
                throw URLError(.cancelled)
            }
        }
        #expect(sent.last == nil)
    }
}

/// Records the request the client made, from inside a `@Sendable` closure.
private final class SentRequest: @unchecked Sendable {
    private let lock = NSLock()
    private var request: URLRequest?
    func record(_ r: URLRequest) { lock.withLock { request = r } }
    var last: URLRequest? { lock.withLock { request } }
}
