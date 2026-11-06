import Foundation
import Testing
@testable import TabsendKit

/// What the relay says about the plan, and the words the phone shows for it
/// (docs/PLANS.md P-19). The phone never works the plan out for itself.
struct GroupServiceTests {
    private func withDefaults(_ body: (UserDefaults) async throws -> Void) async throws {
        let suite = "io.tabsend.tests.group-service.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        try await body(defaults)
    }

    private let ends = "2026-11-18T10:00:00.000Z"
    private let utc = TimeZone(identifier: "UTC")!

    // MARK: the three words

    @Test func theThreeWordsAreReadAsTheyAreSaid() {
        #expect(GroupService.plan(GroupServiceState(state: "trial", trialEndsAt: ends))
            == .trial(endsAt: Date(timeIntervalSince1970: 1_794_996_000)))
        #expect(GroupService.plan(GroupServiceState(state: "trial_ended", trialEndsAt: ends)) == .trialEnded)
        #expect(GroupService.plan(GroupServiceState(state: "account")) == .account)
    }

    @Test func aTrialWithADateTheAppCannotReadStillShowsAsATrial() {
        #expect(GroupService.plan(GroupServiceState(state: "trial", trialEndsAt: "soon")) == .trial(endsAt: nil))
    }

    @Test func silenceAndWordsThisBuildDoesNotKnowAreNoPlan() {
        #expect(GroupService.plan(nil) == nil)
        #expect(GroupService.plan(GroupServiceState(state: "premium")) == nil)
        #expect(GroupService.plan(GroupServiceState(state: "")) == nil)
    }

    // MARK: what the phone remembers

    @Test func nothingIsKnownUntilTheRelaySaysSomething() async throws {
        try await withDefaults { defaults in
            #expect(GroupService.current(in: defaults) == nil)
        }
    }

    @Test func aWordIsKeptThenReplacedThenClearedBySilence() async throws {
        try await withDefaults { defaults in
            GroupService.save(GroupServiceState(state: "trial", trialEndsAt: ends), in: defaults)
            #expect(GroupService.current(in: defaults) == .trial(endsAt: Date(timeIntervalSince1970: 1_794_996_000)))
            GroupService.save(GroupServiceState(state: "account"), in: defaults)
            #expect(GroupService.current(in: defaults) == .account)
            GroupService.save(nil, in: defaults)
            #expect(GroupService.current(in: defaults) == nil)
        }
    }

    @Test func unpairingForgetsIt() async throws {
        try await withDefaults { defaults in
            GroupService.save(GroupServiceState(state: "account"), in: defaults)
            GroupService.clear(in: defaults)
            #expect(GroupService.current(in: defaults) == nil)
        }
    }

    // MARK: asking the relay

    private func paired(_ store: MemoryStore) {
        store.registration = Registration(
            endpointId: "e1", groupId: "g1", deviceToken: "tok",
            relayUrl: "https://relay.invalid", label: "iPhone"
        )
    }

    @Test func theAnswerToTheGroupQuestionCarriesTheWordsAndRefreshKeepsThem() async throws {
        try await withDefaults { defaults in
            let stub = StubServer()
            stub.stub("/v1/group", json: #"{"reset":null,"service":{"state":"trial","trialEndsAt":"2026-11-18T10:00:00.000Z"}}"#)
            let api = ApiClient(relayUrl: stub.baseURL, deviceToken: "tok", session: stub.session())
            let store = MemoryStore()
            paired(store)
            _ = await GroupReset.refresh(api: api, store: store, defaults: defaults)
            #expect(GroupService.current(in: defaults) == .trial(endsAt: Date(timeIntervalSince1970: 1_794_996_000)))
        }
    }

    @Test func aRelayWithNoAccountSiteClearsWhatWasThere() async throws {
        try await withDefaults { defaults in
            GroupService.save(GroupServiceState(state: "account"), in: defaults)
            let stub = StubServer()
            stub.stub("/v1/group", json: #"{"reset":null}"#)
            let api = ApiClient(relayUrl: stub.baseURL, deviceToken: "tok", session: stub.session())
            let store = MemoryStore()
            paired(store)
            _ = await GroupReset.refresh(api: api, store: store, defaults: defaults)
            #expect(GroupService.current(in: defaults) == nil)
        }
    }

    @Test func anOlderRelaysMissingRouteClearsItToo() async throws {
        try await withDefaults { defaults in
            GroupService.save(GroupServiceState(state: "account"), in: defaults)
            let stub = StubServer()  // 404 not_found everywhere
            let api = ApiClient(relayUrl: stub.baseURL, deviceToken: "tok", session: stub.session())
            let store = MemoryStore()
            paired(store)
            _ = await GroupReset.refresh(api: api, store: store, defaults: defaults)
            #expect(GroupService.current(in: defaults) == nil)
        }
    }

    @Test func aFailedFetchKeepsWhatThePhoneKnew() async throws {
        try await withDefaults { defaults in
            GroupService.save(GroupServiceState(state: "trial_ended", trialEndsAt: ends), in: defaults)
            let stub = StubServer()
            stub.stub("/v1/group", status: 500, json: #"{"error":{"code":"internal","message":"boom"}}"#)
            let api = ApiClient(relayUrl: stub.baseURL, deviceToken: "tok", session: stub.session())
            let store = MemoryStore()
            paired(store)
            _ = await GroupReset.refresh(api: api, store: store, defaults: defaults)
            #expect(GroupService.current(in: defaults) == .trialEnded)
        }
    }

    // MARK: the words (English, as the design sheet has them)

    @Test func theEnglishMatchesTheDesignSheet() {
        let end = Date(timeIntervalSince1970: 1_794_996_000)  // 2026-11-18T10:00:00Z
        #expect(GroupService.sectionTitle == "Tabsend service")
        #expect(GroupService.trialLabel == "Free trial")
        #expect(GroupService.trialValue(endsAt: end, timeZone: utc) == "Until Nov 18")
        #expect(GroupService.trialValue(endsAt: nil, timeZone: utc) == "")
        #expect(GroupService.trialFooter == "We email you before it ends.")
        #expect(GroupService.trialEndedTitle == "Your free trial has ended")
        #expect(GroupService.trialEndedBody == "Sending is paused. We emailed you what to do next.")
        #expect(GroupService.startedNotice(endsAt: end, timeZone: utc)
            == "Your account is ready, and your 14-day free trial has started. It runs until Nov 18.")
        #expect(GroupService.startedNotice(endsAt: nil, timeZone: utc)
            == "Your account is ready, and your 14-day free trial has started.")
    }

    @Test func theDateIsTheDayInThePersonsOwnTimeZone() {
        // 23:30 UTC on Nov 18 is already Nov 19 in Tokyo.
        let late = Date(timeIntervalSince1970: 1_794_996_000 + 13.5 * 3600)
        #expect(GroupService.trialValue(endsAt: late, timeZone: utc) == "Until Nov 18")
        #expect(GroupService.trialValue(endsAt: late, timeZone: TimeZone(identifier: "Asia/Tokyo")!) == "Until Nov 19")
    }

    // MARK: the paused device rows (design sheet, screen 8)

    @Test func whenTheTrialEndedThePhoneAndTheOtherDevicesSayPaused() {
        #expect(GroupService.pausedLine(.trialEnded, kind: "iPhone", isThisPhone: true) == "This phone · Paused")
        #expect(GroupService.pausedLine(.trialEnded, kind: "Chrome", isThisPhone: false) == "Chrome · Paused")
        #expect(GroupService.pausedLine(.trialEnded, kind: "Android phone", isThisPhone: false) == "Android phone · Paused")
    }

    @Test func noRowSaysPausedUnlessTheRelayEndedTheTrial() {
        let longAgo = Date(timeIntervalSince1970: 1_000_000_000)
        for plan: GroupService.Plan? in [nil, .account, .trial(endsAt: nil), .trial(endsAt: longAgo)] {
            #expect(GroupService.pausedLine(plan, kind: "Chrome", isThisPhone: false) == nil)
            #expect(GroupService.pausedLine(plan, kind: "iPhone", isThisPhone: true) == nil)
        }
    }

    @Test func aTrialWhoseDatePassedIsStillNotPausedUntilTheRelaySaysSo() {
        // The relay said "trial" and the date is in the past: the phone does not conclude anything.
        let said = GroupService.plan(GroupServiceState(state: "trial", trialEndsAt: "2020-01-01T00:00:00.000Z"))
        #expect(GroupService.pausedLine(said, kind: "Chrome", isThisPhone: false) == nil)
    }

    @Test func theRelaysTrialEndedWordIsWhatMakesTheRowsSayPaused() async throws {
        try await withDefaults { defaults in
            GroupService.save(GroupServiceState(state: "trial_ended", trialEndsAt: ends), in: defaults)
            let plan = GroupService.current(in: defaults)
            #expect(GroupService.pausedLine(plan, kind: "Chrome", isThisPhone: false) == "Chrome · Paused")
            // A relay with no account site stops saying it, and the rows go back to normal.
            GroupService.save(nil, in: defaults)
            #expect(GroupService.pausedLine(GroupService.current(in: defaults), kind: "Chrome", isThisPhone: false) == nil)
        }
    }

    @Test func theCopyFollowsTheOwnersRules() {
        let all = [
            GroupService.sectionTitle, GroupService.trialLabel, GroupService.trialFooter,
            GroupService.trialEndedTitle, GroupService.trialEndedBody,
            GroupService.startedNotice(endsAt: nil), GroupService.trialValue(endsAt: Date()),
            GroupService.pausedLine(.trialEnded, kind: "Chrome", isThisPhone: false) ?? "",
            GroupService.pausedLine(.trialEnded, kind: "iPhone", isThisPhone: true) ?? "",
        ].joined(separator: " ")
        #expect(!all.contains("—"))
        #expect(!all.contains("$"))  // no price in the app outside the sign-up sheet (PLANS P-25)
        #expect(!all.localizedCaseInsensitiveContains("relay"))  // the first-run words say "server"
    }
}
