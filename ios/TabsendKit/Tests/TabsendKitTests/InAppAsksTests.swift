import Foundation
import Testing
@testable import TabsendKit

struct InAppAsksTests {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)
    private let day: TimeInterval = 86_400
    private func ago(_ days: Double) -> Date { now.addingTimeInterval(-days * day) }

    private func box(
        plan: GroupService.Plan? = nil, door: Bool = true, firstHome: Date? = nil, devices: Int = 2,
        handled: Date? = nil, lastReview: Date? = nil, reviewThisSession: Bool = false
    ) -> InAppAsks.Variant? {
        InAppAsks.shareBox(
            plan: plan, accountDoor: door, firstHomeAt: firstHome, deviceCount: devices,
            handledAt: handled, lastReviewAskAt: lastReview,
            reviewAskedThisSession: reviewThisSession, now: now
        )
    }

    private func review(
        sent: Date? = nil, firstHome: Date? = nil, devices: Int = 2, asks: [Date] = [],
        handled: Date? = nil, boxShown: Bool = false, askedThisSession: Bool = false, error: Bool = false
    ) -> Bool {
        InAppAsks.reviewAsk(
            lastSuccessfulSendAt: sent ?? now.addingTimeInterval(-60), firstHomeAt: firstHome ?? ago(10),
            deviceCount: devices, askDates: asks, shareBoxHandledAt: handled,
            shareBoxShownThisSession: boxShown, reviewAskedThisSession: askedThisSession,
            errorShowing: error, now: now
        )
    }

    // MARK: variant

    @Test func creditNeedsTheDoorAndAnAccount() {
        #expect(InAppAsks.variant(plan: .account, accountDoor: true) == .credit)
        #expect(InAppAsks.variant(plan: .account, accountDoor: false) == .plain)
        #expect(InAppAsks.variant(plan: nil, accountDoor: true) == .plain)
        #expect(InAppAsks.variant(plan: .trial(endsAt: nil), accountDoor: true) == .plain)
        #expect(InAppAsks.variant(plan: .trialEnded, accountDoor: true) == .plain)
    }

    // MARK: share box

    @Test func hostedAccountShowsAtOnce() {
        #expect(box(plan: .account, door: true) == .credit)
        #expect(box(plan: .account, door: false) == .plain)
    }

    @Test func trialAndTrialEndedNeverShow() {
        #expect(box(plan: .trial(endsAt: nil), firstHome: ago(100)) == nil)
        #expect(box(plan: .trialEnded, firstHome: ago(100)) == nil)
    }

    @Test func selfHostedWaitsThirtyDaysAndTwoDevices() {
        #expect(box(firstHome: ago(31)) == .plain)
        #expect(box(firstHome: ago(30)) == .plain)
        #expect(box(firstHome: ago(29)) == nil)
        #expect(box(firstHome: nil) == nil)
        #expect(box(firstHome: ago(60), devices: 1) == nil)
    }

    @Test func aDismissalHidesTheBoxForAYear() {
        #expect(box(plan: .account, handled: ago(364)) == nil)
        #expect(box(plan: .account, handled: ago(366)) == .credit)
    }

    @Test func theBoxKeepsFourteenDaysFromAReviewAsk() {
        #expect(box(plan: .account, lastReview: ago(13)) == nil)
        #expect(box(plan: .account, lastReview: ago(15)) == .credit)
        #expect(box(plan: .account, reviewThisSession: true) == nil)
    }

    // MARK: review ask

    @Test func aGoodMomentAsksOnce() {
        #expect(review())
    }

    @Test func needsAFreshSuccessfulSend() {
        #expect(!review(sent: now.addingTimeInterval(-16 * 60)))
        #expect(!InAppAsks.reviewAsk(
            lastSuccessfulSendAt: nil, firstHomeAt: ago(10), deviceCount: 2, askDates: [],
            shareBoxHandledAt: nil, shareBoxShownThisSession: false, reviewAskedThisSession: false,
            errorShowing: false, now: now
        ))
    }

    @Test func needsAWeekAndTwoDevices() {
        #expect(!review(firstHome: ago(6)))
        #expect(review(firstHome: ago(7)))
        #expect(!review(devices: 1))
    }

    @Test func keepsOneHundredTwentyDaysAndThreeAYear() {
        #expect(!review(asks: [ago(119)]))
        #expect(review(asks: [ago(121)]))
        #expect(!review(asks: [ago(121), ago(250), ago(360)]))
        #expect(review(asks: [ago(121), ago(250), ago(400)]))
    }

    @Test func neverWithAnErrorOrTheBoxOrTwiceInASession() {
        #expect(!review(error: true))
        #expect(!review(boxShown: true))
        #expect(!review(askedThisSession: true))
    }

    @Test func keepsFourteenDaysFromTheBox() {
        #expect(!review(handled: ago(13)))
        #expect(review(handled: ago(15)))
    }

    // MARK: memory

    private func withDefaults(_ body: (UserDefaults) throws -> Void) throws {
        let suite = "io.tabsend.tests.in-app-asks.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        try body(defaults)
    }

    @Test func theFirstHomeIsRememberedOnce() throws {
        try withDefaults { d in
            InAppAsks.noteHomeShown(now: ago(5), in: d)
            InAppAsks.noteHomeShown(now: now, in: d)
            #expect(InAppAsks.firstHomeAt(in: d) == ago(5))
        }
    }

    @Test func reviewAsksKeepOnlyTheLastYearAndSurviveUnpairing() throws {
        try withDefaults { d in
            InAppAsks.recordReviewAsk(now: ago(400), in: d)
            InAppAsks.recordReviewAsk(now: ago(10), in: d)
            #expect(InAppAsks.reviewAskDates(in: d).count == 1)
            InAppAsks.markShareBoxHandled(now: now, in: d)
            InAppAsks.noteHomeShown(now: now, in: d)
            InAppAsks.clear(in: d)
            #expect(InAppAsks.firstHomeAt(in: d) == nil)
            #expect(InAppAsks.shareBoxHandledAt(in: d) == nil)
            #expect(InAppAsks.reviewAskDates(in: d).count == 1)
        }
    }

    @Test func feedbackLinkIsAMailtoWithASubject() {
        #expect(InAppAsks.feedbackURL?.absoluteString == "mailto:contact@tabsend.org?subject=Tabsend%20feedback")
    }

    @Test func noReviewLinkIsShippedYet() {
        #expect(InAppAsks.reviewURL == nil)
    }

    @Test func hostedGroupWithNoPlanKnownGetsNoBox() {
        let now = Date()
        let old = now.addingTimeInterval(-400 * 86_400)
        func box(hosted: Bool) -> InAppAsks.Variant? {
            InAppAsks.shareBox(
                plan: nil, accountDoor: true, firstHomeAt: old, deviceCount: 3, handledAt: nil,
                lastReviewAskAt: nil, reviewAskedThisSession: false, relayIsHosted: hosted, now: now)
        }
        #expect(box(hosted: true) == nil)
        #expect(box(hosted: false) == .plain)
    }

    @Test func onlyTabsendsOwnRelayNamesCountAsHosted() {
        #expect(InAppAsks.isHostedRelay("https://app.tabsend.org"))
        #expect(InAppAsks.isHostedRelay("https://demo.tabsend.org/"))
        #expect(!InAppAsks.isHostedRelay("https://app.tabsend.org.evil.example"))
        #expect(!InAppAsks.isHostedRelay("https://relay.example.com"))
        #expect(!InAppAsks.isHostedRelay(""))
    }
}
