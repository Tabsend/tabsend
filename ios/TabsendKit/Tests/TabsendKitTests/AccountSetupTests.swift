import Foundation
import Testing
@testable import TabsendKit

struct AccountSetupTests {
    /// A private defaults suite, so a test never touches the real app's settings.
    private func withDefaults(_ body: (UserDefaults) throws -> Void) throws {
        let suite = "io.tabsend.tests.account-setup.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        try body(defaults)
    }

    // MARK: the storefront rule

    @Test func onlyTheUnitedStatesStorefrontGetsTheAccountDoor() {
        #expect(AccountSetup.allowsAccountSetup(storefrontCountryCode: "USA"))
        #expect(AccountSetup.allowsAccountSetup(storefrontCountryCode: "usa"))
        for other in ["GBR", "DEU", "CAN", "AUS", "PRI", "USA ", "US", ""] {
            #expect(!AccountSetup.allowsAccountSetup(storefrontCountryCode: other), "\(other)")
        }
    }

    @Test func anUnknownStorefrontIsTreatedAsNotUS() {
        #expect(!AccountSetup.allowsAccountSetup(storefrontCountryCode: nil))
    }

    // MARK: a sign-up waiting for its link

    @Test func nothingIsPendingUntilTheSheetIsOpened() throws {
        try withDefaults { defaults in
            #expect(!AccountSetup.isPending(in: defaults))
        }
    }

    @Test func aSignupIsPendingForADayThenForgotten() throws {
        try withDefaults { defaults in
            let start = Date(timeIntervalSince1970: 1_800_000_000)
            AccountSetup.markStarted(now: start, in: defaults)
            #expect(AccountSetup.isPending(now: start, in: defaults))
            #expect(AccountSetup.isPending(now: start.addingTimeInterval(AccountSetup.pendingWindow), in: defaults))
            #expect(!AccountSetup.isPending(now: start.addingTimeInterval(AccountSetup.pendingWindow + 1), in: defaults))
        }
    }

    @Test func aClockSetBackDoesNotKeepASignupPendingForever() throws {
        try withDefaults { defaults in
            let start = Date(timeIntervalSince1970: 1_800_000_000)
            AccountSetup.markStarted(now: start, in: defaults)
            // "Now" before the start: the stored time cannot be trusted, so it is not pending.
            #expect(!AccountSetup.isPending(now: start.addingTimeInterval(-60), in: defaults))
        }
    }

    // MARK: when the sign-up is over

    @Test func pairingEndsThePendingSignup() throws {
        try withDefaults { defaults in
            AccountSetup.markStarted(in: defaults)
            AccountSetup.finishStarted(in: defaults)
            #expect(!AccountSetup.isPending(in: defaults))
        }
    }

    @Test func unpairingForgetsAPendingSignup() throws {
        try withDefaults { defaults in
            AccountSetup.markStarted(in: defaults)
            AccountSetup.clear(in: defaults)
            #expect(!AccountSetup.isPending(in: defaults))
        }
    }

    // MARK: the account site's pages

    @Test func theSheetsOpenTheAccountSitePages() {
        #expect(AccountSetup.url(for: .start)?.absoluteString == "https://account.tabsend.org/start?from=app")
        #expect(AccountSetup.url(for: .account)?.absoluteString == "https://account.tabsend.org/account?from=app")
        #expect(AccountSetup.url(for: .delete)?.absoluteString == "https://account.tabsend.org/account?from=app#danger")
    }

    @Test func aDebugAddressWithATrailingSlashStillMakesAGoodURL() {
        #expect(AccountSetup.url(for: .start, site: "http://localhost:8790/")?.absoluteString
            == "http://localhost:8790/start?from=app")
    }
}
