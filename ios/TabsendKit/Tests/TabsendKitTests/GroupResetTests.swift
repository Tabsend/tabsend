import Testing
import Foundation
@testable import TabsendKit

/// The reset that waits (PLANS.md P-18 item 12): which reset the card shows, which
/// one is announced, the older relay's 404, Stop, and the stream event.
struct GroupResetTests {
    private let first = GroupResetState(
        requestedAt: "2026-10-27T14:05:00.000Z", resetsAt: "2026-10-30T14:05:00.000Z"
    )
    private let second = GroupResetState(
        requestedAt: "2026-11-02T09:00:00.000Z", resetsAt: "2026-11-05T09:00:00.000Z"
    )

    private func paired(_ store: TabsendStore) {
        store.registration = Registration(
            endpointId: "e1", groupId: "g1", deviceToken: "tok",
            relayUrl: "https://relay.invalid", label: "iPhone"
        )
    }

    // MARK: the rule

    @Test func aNewResetIsShownAndAnnouncedOnce() {
        let seen = GroupReset.observe(nil, fetched: first)
        #expect(seen.announce == first)
        #expect(GroupReset.shown(seen.watch) == first)

        // The same reset fetched again: still shown, not announced again.
        let again = GroupReset.observe(seen.watch, fetched: first)
        #expect(again.announce == nil)
        #expect(GroupReset.shown(again.watch) == first)
        #expect(again.watch.notified == [first.requestedAt])
    }

    @Test func noResetPendingShowsNothingAndAnnouncesNothing() {
        let seen = GroupReset.observe(nil, fetched: nil)
        #expect(seen.announce == nil)
        #expect(GroupReset.shown(seen.watch) == nil)
        #expect(GroupReset.shown(nil) == nil)
    }

    @Test func aStoppedResetTakesTheCardDownButIsStillRemembered() {
        let seen = GroupReset.observe(nil, fetched: first).watch
        let gone = GroupReset.observe(seen, fetched: nil)
        #expect(GroupReset.shown(gone.watch) == nil)
        #expect(gone.announce == nil)
        // Back again with the same requestedAt (a relay that flaps): shown, not re-announced.
        let back = GroupReset.observe(gone.watch, fetched: first)
        #expect(GroupReset.shown(back.watch) == first)
        #expect(back.announce == nil)
    }

    @Test func itWasMeHidesThatResetOnly() {
        let seen = GroupReset.observe(nil, fetched: first).watch
        let answered = GroupReset.dismiss(seen, requestedAt: first.requestedAt)
        #expect(GroupReset.shown(answered) == nil)
        // Still hidden on the next fetch of the same reset, and not announced.
        let refetched = GroupReset.observe(answered, fetched: first)
        #expect(GroupReset.shown(refetched.watch) == nil)
        #expect(refetched.announce == nil)
        // A new reset is a new question: shown and announced.
        let next = GroupReset.observe(refetched.watch, fetched: second)
        #expect(GroupReset.shown(next.watch) == second)
        #expect(next.announce == second)
    }

    @Test func aResetAnsweredBeforeItWasAnnouncedIsNeverAnnounced() {
        let answered = GroupReset.dismiss(nil, requestedAt: first.requestedAt)
        let seen = GroupReset.observe(answered, fetched: first)
        #expect(seen.announce == nil)
        #expect(GroupReset.shown(seen.watch) == nil)
    }

    @Test func stoppedClearsThePendingResetAndKeepsTheAnswers() {
        let seen = GroupReset.observe(nil, fetched: first).watch
        let stopped = GroupReset.stopped(seen)
        #expect(stopped.reset == nil)
        #expect(stopped.notified == [first.requestedAt])
        #expect(GroupReset.shown(stopped) == nil)
    }

    @Test func theRecordCannotGrowWithoutLimit() {
        var watch: GroupResetWatch?
        for day in 0..<(GroupReset.maxRemembered + 5) {
            let reset = GroupResetState(requestedAt: "r\(day)", resetsAt: "x")
            watch = GroupReset.observe(watch, fetched: reset).watch
            watch = GroupReset.dismiss(watch, requestedAt: reset.requestedAt)
        }
        #expect(watch?.notified.count == GroupReset.maxRemembered)
        #expect(watch?.dismissed.count == GroupReset.maxRemembered)
        // The newest are kept.
        #expect(watch?.notified.last == "r\(GroupReset.maxRemembered + 4)")
    }

    // MARK: an older relay

    @Test func onlyAMissingRouteReadsAsNoReset() {
        #expect(GroupReset.readsAsNoReset(ApiError(status: 404, code: "not_found", message: "")))
        #expect(GroupReset.readsAsNoReset(ApiError(status: 404, code: "internal", message: "")))
        #expect(!GroupReset.readsAsNoReset(ApiError(status: 500, code: "internal", message: "")))
        #expect(!GroupReset.readsAsNoReset(ApiError(status: 401, code: "endpoint_removed", message: "")))
    }

    @Test func anOlderRelaysNotFoundIsNoReset() async throws {
        let stub = StubServer()  // no route stubbed: every path answers 404 not_found
        let api = ApiClient(relayUrl: stub.baseURL, deviceToken: "tok", session: stub.session())
        #expect(try await GroupReset.fetch(api: api) == nil)
        #expect(stub.recorded.first?.method == "GET")
        #expect(stub.recorded.first?.path == "/v1/group")
        #expect(stub.recorded.first?.authorization?.hasSuffix(" tok") == true)
    }

    @Test func aPendingResetIsReadOffTheWire() async throws {
        let stub = StubServer()
        stub.stub("/v1/group", json: #"{"reset":{"requestedAt":"2026-10-27T14:05:00.000Z","resetsAt":"2026-10-30T14:05:00.000Z"}}"#)
        let api = ApiClient(relayUrl: stub.baseURL, deviceToken: "tok", session: stub.session())
        #expect(try await GroupReset.fetch(api: api) == first)
    }

    @Test func aNullResetIsNone() async throws {
        let stub = StubServer()
        stub.stub("/v1/group", json: #"{"reset":null}"#)
        let api = ApiClient(relayUrl: stub.baseURL, deviceToken: "tok", session: stub.session())
        #expect(try await GroupReset.fetch(api: api) == nil)
    }

    @Test func anyOtherRefusalKeepsWhatThePhoneKnew() async {
        let stub = StubServer()
        stub.stub("/v1/group", status: 500, json: #"{"error":{"code":"internal","message":"boom"}}"#)
        let api = ApiClient(relayUrl: stub.baseURL, deviceToken: "tok", session: stub.session())
        let store = MemoryStore()
        paired(store)
        store.groupResetWatch = GroupReset.observe(nil, fetched: first).watch
        let announce = await GroupReset.refresh(api: api, store: store)
        #expect(announce == nil)
        #expect(GroupReset.current(store: store) == first)
    }

    // MARK: the store helpers

    @Test func refreshAnnouncesOnceThroughTheStore() async {
        let stub = StubServer()
        stub.stub("/v1/group", json: #"{"reset":{"requestedAt":"2026-10-27T14:05:00.000Z","resetsAt":"2026-10-30T14:05:00.000Z"}}"#)
        let api = ApiClient(relayUrl: stub.baseURL, deviceToken: "tok", session: stub.session())
        let store = MemoryStore()
        paired(store)
        #expect(await GroupReset.refresh(api: api, store: store) == first)
        #expect(await GroupReset.refresh(api: api, store: store) == nil)
        #expect(GroupReset.current(store: store) == first)

        GroupReset.dismiss(requestedAt: first.requestedAt, store: store)
        #expect(GroupReset.current(store: store) == nil)
    }

    @Test func stopPostsAnEmptyBodyAndTakesTheCardDown() async throws {
        let stub = StubServer()
        stub.stub("/v1/group/reset/stop", json: #"{"reset":null}"#)
        let api = ApiClient(relayUrl: stub.baseURL, deviceToken: "tok", session: stub.session())
        let store = MemoryStore()
        paired(store)
        store.groupResetWatch = GroupReset.observe(nil, fetched: first).watch
        try await GroupReset.stop(api: api, store: store)
        #expect(GroupReset.current(store: store) == nil)
        let call = try #require(stub.recorded.first)
        #expect(call.method == "POST")
        #expect(call.body?.isEmpty == true)
    }

    @Test func aRefusedStopKeepsTheCard() async {
        let stub = StubServer()
        stub.stub("/v1/group/reset/stop", status: 401, json: #"{"error":{"code":"endpoint_removed","message":"This endpoint was removed from its group."}}"#)
        let api = ApiClient(relayUrl: stub.baseURL, deviceToken: "tok", session: stub.session())
        let store = MemoryStore()
        paired(store)
        store.groupResetWatch = GroupReset.observe(nil, fetched: first).watch
        await #expect(throws: ApiError.self) {
            try await GroupReset.stop(api: api, store: store)
        }
        #expect(GroupReset.current(store: store) == first)
    }

    @Test func unpairForgetsTheRecord() {
        let store = MemoryStore()
        paired(store)
        store.groupResetWatch = GroupReset.observe(nil, fetched: first).watch
        store.clear()
        #expect(store.groupResetWatch == nil)
    }

    // MARK: the stream

    @Test func groupUpdatedAsksAgainAndUnknownEventsAreIgnored() {
        #expect(StreamClient.event(for: #"{"type":"group_updated"}"#) == .groupUpdated)
        #expect(StreamClient.event(for: #"{"type":"message"}"#) == .messageWaiting)
        #expect(StreamClient.event(for: #"{"type":"endpoint_added"}"#) == .endpointsChanged)
        #expect(StreamClient.event(for: #"{"type":"acked","messageId":"m1"}"#) == nil)
        #expect(StreamClient.event(for: #"{"type":"something_new","extra":{"a":1}}"#) == nil)
        #expect(StreamClient.event(for: #"{"type":"pong"}"#) == nil)
        #expect(StreamClient.event(for: "not json") == nil)
        #expect(StreamClient.event(for: #"{"no":"type"}"#) == nil)
    }

    // MARK: copy

    @Test func theCardAndNoticeNameTheDaysInLocalTime() throws {
        let chicago = try #require(TimeZone(identifier: "America/Chicago"))
        #expect(
            GroupReset.cardBody(first, timeZone: chicago)
                == "From your account page on October 27. On October 30 at 9:05 AM, every device is removed, this one too. If it wasn't you, stop it now, then change your email password."
        )
        #expect(
            GroupReset.notificationBody(first, timeZone: chicago)
                == "Someone asked to remove all your devices on October 27. Open Tabsend to stop it."
        )
        // Late evening UTC is still the day before in Chicago.
        let late = GroupResetState(requestedAt: "2026-10-28T02:00:00Z", resetsAt: "2026-10-31T02:00:00Z")
        #expect(GroupReset.notificationBody(late, timeZone: chicago).contains("on October 27."))
    }

    @Test func unreadableDatesStillMakeASentence() {
        let odd = GroupResetState(requestedAt: "?", resetsAt: "?")
        #expect(
            GroupReset.cardBody(odd)
                == "From your account page. Soon, every device is removed, this one too. If it wasn't you, stop it now, then change your email password."
        )
        #expect(GroupReset.notificationBody(odd) == "Someone asked to remove all your devices. Open Tabsend to stop it.")
    }

    @Test func noEmDashesInTheCopy() {
        let all = [
            GroupReset.cardTitle, GroupReset.stopButton, GroupReset.itWasMeButton,
            GroupReset.stoppedLine, GroupReset.notificationTitle,
            GroupReset.cardBody(first), GroupReset.notificationBody(first),
        ]
        for line in all { #expect(!line.contains("\u{2014}")) }
    }
}
