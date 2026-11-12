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

    // MARK: the phone's number (AL1, AL3)

    @Test func theNumberIsLongRandomAndTheShapeTheSiteTakes() throws {
        try withDefaults { defaults in
            let number = AccountSetup.phoneNumber(in: defaults)
            #expect(number.count == 43)
            #expect(AccountSetup.isPlausible(number: number))
            // Two phones, two numbers.
            let other = UserDefaults(suiteName: "io.tabsend.tests.account-setup.other.\(UUID().uuidString)")!
            #expect(AccountSetup.phoneNumber(in: other) != number)
        }
    }

    @Test func theSameNumberIsKeptForADayEvenIfAskedForAgain() throws {
        try withDefaults { defaults in
            let start = Date(timeIntervalSince1970: 1_800_000_000)
            let first = AccountSetup.phoneNumber(now: start, in: defaults)
            #expect(AccountSetup.phoneNumber(now: start.addingTimeInterval(3600), in: defaults) == first)
            #expect(AccountSetup.livePhoneNumber(now: start.addingTimeInterval(3600), in: defaults) == first)
        }
    }

    @Test func aNumberFromADayAgoIsReplacedAndNeverTakenForALink() throws {
        try withDefaults { defaults in
            let start = Date(timeIntervalSince1970: 1_800_000_000)
            let first = AccountSetup.phoneNumber(now: start, in: defaults)
            let late = start.addingTimeInterval(AccountSetup.pendingWindow + 1)
            // Too old for a link that arrives now.
            #expect(AccountSetup.livePhoneNumber(now: late, in: defaults) == nil)
            // A sheet that asks again gets a new one.
            #expect(AccountSetup.phoneNumber(now: late, in: defaults) != first)
        }
    }

    @Test func aNumberIsOnlyLiveAfterThePhoneMadeOne() throws {
        try withDefaults { defaults in
            // Nothing asked for a link: a link that arrives has no number to match.
            #expect(AccountSetup.livePhoneNumber(in: defaults) == nil)
            let made = AccountSetup.phoneNumber(in: defaults)
            #expect(AccountSetup.livePhoneNumber(in: defaults) == made)
        }
    }

    @Test func aClockSetBackDoesNotKeepANumberLive() throws {
        try withDefaults { defaults in
            let start = Date(timeIntervalSince1970: 1_800_000_000)
            _ = AccountSetup.phoneNumber(now: start, in: defaults)
            #expect(AccountSetup.livePhoneNumber(now: start.addingTimeInterval(-60), in: defaults) == nil)
        }
    }

    @Test func aStoredNumberThatIsNoNumberIsIgnored() throws {
        try withDefaults { defaults in
            defaults.set("short", forKey: "accountPhoneNumber")
            defaults.set(Date().timeIntervalSince1970, forKey: "accountPhoneNumberAt")
            #expect(AccountSetup.livePhoneNumber(in: defaults) == nil)
            let made = AccountSetup.phoneNumber(in: defaults)
            #expect(made != "short")
            #expect(AccountSetup.isPlausible(number: made))
        }
    }

    @Test func startingASignupMakesTheNumberItsLinkWillNeed() throws {
        try withDefaults { defaults in
            let start = Date(timeIntervalSince1970: 1_800_000_000)
            AccountSetup.markStarted(now: start, in: defaults)
            let number = try #require(AccountSetup.livePhoneNumber(now: start, in: defaults))
            // Still there, and the same, for as long as the sign-up is pending.
            let nearEnd = start.addingTimeInterval(AccountSetup.pendingWindow)
            #expect(AccountSetup.isPending(now: nearEnd, in: defaults))
            #expect(AccountSetup.livePhoneNumber(now: nearEnd, in: defaults) == number)
        }
    }

    @Test func aSignupOpenedLateReusesALiveNumberAndOutlastsIt() throws {
        try withDefaults { defaults in
            // A number made 20 hours ago for a sign-in; the sign-up that begins now must not lose
            // it in 4 hours while it is still pending for 24.
            let first = Date(timeIntervalSince1970: 1_800_000_000)
            let number = AccountSetup.phoneNumber(now: first, in: defaults)
            let later = first.addingTimeInterval(20 * 3600)
            AccountSetup.markStarted(now: later, in: defaults)
            let end = later.addingTimeInterval(AccountSetup.pendingWindow)
            #expect(AccountSetup.livePhoneNumber(now: end, in: defaults) == number)
        }
    }

    @Test func pairingAndUnpairingForgetTheNumber() throws {
        try withDefaults { defaults in
            AccountSetup.markStarted(in: defaults)
            AccountSetup.finishStarted(in: defaults)
            #expect(AccountSetup.livePhoneNumber(in: defaults) == nil)

            AccountSetup.markStarted(in: defaults)
            AccountSetup.clear(in: defaults)
            #expect(AccountSetup.livePhoneNumber(in: defaults) == nil)
        }
    }

    // MARK: the account site's pages

    @Test func theSheetsOpenTheAccountSitePages() {
        #expect(AccountSetup.url(for: .start)?.absoluteString == "https://account.tabsend.org/start?from=app")
        #expect(AccountSetup.url(for: .account)?.absoluteString == "https://account.tabsend.org/account?from=app")
        #expect(AccountSetup.url(for: .delete)?.absoluteString == "https://account.tabsend.org/account?from=app#danger")
        #expect(AccountSetup.url(for: .share)?.absoluteString == "https://account.tabsend.org/share?from=app")
    }

    @Test func everyPageThatCanLeadToASigninCarriesThePhonesNumberAfterTheHash() {
        let number = "Xo7q2mP0Zk4VbN9sT1wRfH6cYdEaLgJuIiKt3AnBvM8"
        let base = "https://account.tabsend.org"
        #expect(AccountSetup.url(for: .start, number: number)?.absoluteString == "\(base)/start?from=app#n=\(number)")
        #expect(AccountSetup.url(for: .account, number: number)?.absoluteString == "\(base)/account?from=app#n=\(number)")
        #expect(AccountSetup.url(for: .share, number: number)?.absoluteString == "\(base)/share?from=app#n=\(number)")
        // The delete page keeps its marker exactly as it was; the number follows it.
        #expect(AccountSetup.url(for: .delete, number: number)?.absoluteString
            == "\(base)/account?from=app#danger&n=\(number)")
    }

    @Test func aNumberTheSiteWouldRefuseIsNotPutInTheAddress() {
        for bad in ["", "short", "has spaces in it and is long enough!!", "a/b" + String(repeating: "x", count: 30)] {
            #expect(AccountSetup.url(for: .start, number: bad)?.absoluteString
                == "https://account.tabsend.org/start?from=app", "\(bad)")
        }
    }

    @Test func aDebugAddressWithATrailingSlashStillMakesAGoodURL() {
        #expect(AccountSetup.url(for: .start, site: "http://localhost:8790/")?.absoluteString
            == "http://localhost:8790/start?from=app")
    }
}
