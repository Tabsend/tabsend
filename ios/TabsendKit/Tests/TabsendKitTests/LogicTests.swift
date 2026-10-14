import Testing
import Foundation
@testable import TabsendKit

private func makeEndpoint(
    _ id: String, label: String, kind: String = "extension",
    presence: String = "offline", lastSeenAt: String = "2026-07-28T00:00:00.000Z"
) throws -> Endpoint {
    let json = """
    {"id":"\(id)","groupId":"g","kind":"\(kind)","label":"\(label)","e2ePubkey":"PK\(id)",
     "presence":"\(presence)","lastSeenAt":"\(lastSeenAt)","createdAt":"2026-01-01T00:00:00.000Z"}
    """
    return try Wire.decoder.decode(Endpoint.self, from: Data(json.utf8))
}

struct ChooserTests {
    @Test func dropsSelfAndConsoles() throws {
        let rows = Chooser.build(
            endpoints: [
                try makeEndpoint("me", label: "Me"),
                try makeEndpoint("c", label: "Console", kind: "console"),
                try makeEndpoint("a", label: "Alpha"),
            ],
            selfEndpointId: "me",
            prefs: SourcePrefs()
        )
        #expect(rows.map(\.id) == ["a"])
    }

    @Test func orderPrimaryThenMruThenLabel() throws {
        let prefs = SourcePrefs(primaryTargetId: "p", primaryPinned: true, recentTargetIds: ["m2", "m1"])
        let rows = Chooser.build(
            endpoints: [
                try makeEndpoint("z", label: "zeta"),
                try makeEndpoint("m1", label: "mru-older"),
                try makeEndpoint("p", label: "primary"),
                try makeEndpoint("m2", label: "mru-newer"),
                try makeEndpoint("b", label: "Beta"),
            ],
            selfEndpointId: "self",
            prefs: prefs
        )
        #expect(rows.map(\.id) == ["p", "m2", "m1", "b", "z"])
    }

    @Test func staleness() throws {
        let now = try #require(WireDate.date(from: "2026-07-28T00:00:00.000Z"))
        let recent = Chooser.build(
            endpoints: [try makeEndpoint("a", label: "A", lastSeenAt: "2026-07-20T00:00:00.000Z")],
            selfEndpointId: "s", prefs: SourcePrefs(), now: now
        )[0]
        #expect(!recent.stale)
        let old = Chooser.build(
            endpoints: [try makeEndpoint("b", label: "B", lastSeenAt: "2026-01-01T00:00:00.000Z")],
            selfEndpointId: "s", prefs: SourcePrefs(), now: now
        )[0]
        #expect(old.stale)
        let online = Chooser.build(
            endpoints: [try makeEndpoint("c", label: "C", presence: "online", lastSeenAt: "2026-01-01T00:00:00.000Z")],
            selfEndpointId: "s", prefs: SourcePrefs(), now: now
        )[0]
        #expect(!online.stale)
    }

    // A cached list is a snapshot of unknown age: the relay may not have answered
    // in hours, so no row may claim to be online from it.
    @Test func presenceIsUnknownWhenTheListCameFromCache() throws {
        let now = try #require(WireDate.date(from: "2026-07-28T00:00:00.000Z"))
        let live = Chooser.build(
            endpoints: [try makeEndpoint("c", label: "C", presence: "online")],
            selfEndpointId: "s", prefs: SourcePrefs(), now: now
        )[0]
        #expect(live.presenceKnown)
        #expect(live.online)

        let cached = Chooser.build(
            endpoints: [try makeEndpoint("c", label: "C", presence: "online")],
            selfEndpointId: "s", prefs: SourcePrefs(), now: now, presenceKnown: false
        )[0]
        #expect(!cached.presenceKnown)
        #expect(!cached.online)
    }
}

/// Pinned "now", matching `makeEndpoint`'s default `lastSeenAt`. Not cosmetic:
/// the plan drops stale rows against a 30-day horizon, so a real clock would turn
/// every case below into a test that starts failing one month after it was written.
private let suggestionNow = WireDate.date(from: "2026-07-28T00:00:00.000Z")!

/// The share sheet's suggestions row is the chooser truncated, never a different
/// list — these pin the ways that could drift apart.
struct SuggestionPlanTests {
    private func rows(
        _ endpoints: [Endpoint], prefs: SourcePrefs = SourcePrefs(), now: Date = suggestionNow
    ) -> [Chooser.Row] {
        Chooser.build(endpoints: endpoints, selfEndpointId: "self", prefs: prefs, now: now)
    }

    @Test func takesTheChooserHeadInChooserOrder() throws {
        let prefs = SourcePrefs(primaryTargetId: "p", primaryPinned: true, recentTargetIds: ["m2", "m1"])
        let plan = SuggestionPlan.build(rows: rows([
            try makeEndpoint("z", label: "zeta"),
            try makeEndpoint("m1", label: "mru-older"),
            try makeEndpoint("p", label: "primary"),
            try makeEndpoint("m2", label: "mru-newer"),
            try makeEndpoint("b", label: "Beta"),
        ], prefs: prefs))
        #expect(plan.map(\.endpointId) == ["p", "m2", "m1", "b"])
        #expect(plan.map(\.rank) == [0, 1, 2, 3])
    }

    /// Self and consoles are excluded by the chooser itself, so the plan inherits
    /// it — a console is never a send target and must never be offered as one.
    @Test func inheritsChooserExclusions() throws {
        let plan = SuggestionPlan.build(rows: rows([
            try makeEndpoint("self", label: "This phone"),
            try makeEndpoint("c", label: "Console", kind: "console"),
            try makeEndpoint("a", label: "Alpha"),
        ]))
        #expect(plan.map(\.endpointId) == ["a"])
    }

    /// Stale endpoints stay selectable in the chooser (presence is non-gating,
    /// ADR-0001) but get no slot: the row cannot render the "(inactive)" qualifier
    /// and a month-dark device would cost a live one its place.
    @Test func staleEndpointsGetNoSlot() throws {
        let built = rows([
            try makeEndpoint("fresh", label: "Fresh", lastSeenAt: "2026-07-20T00:00:00.000Z"),
            try makeEndpoint("dark", label: "Dark", lastSeenAt: "2026-01-01T00:00:00.000Z"),
        ])
        #expect(built.count == 2)
        #expect(SuggestionPlan.build(rows: built).map(\.endpointId) == ["fresh"])
    }

    @Test func truncatesToTheCap() throws {
        let many = try (0..<9).map { try makeEndpoint("e\($0)", label: "Device \($0)") }
        #expect(SuggestionPlan.build(rows: rows(many)).count == SuggestionPlan.maxTargets)
        #expect(SuggestionPlan.build(rows: rows(many), max: 2).map(\.endpointId) == ["e0", "e1"])
        #expect(SuggestionPlan.build(rows: rows(many), max: 0).isEmpty)
    }

    @Test func conversationIdRoundTrips() {
        let id = SuggestionPlan.conversationId(for: "ep-1")
        #expect(SuggestionPlan.endpointId(ofConversation: id) == "ep-1")
    }

    /// A conversation id we didn't mint has to read as "no pick" and fall back to
    /// the chooser — never be spent as an endpoint id.
    @Test func foreignConversationIdIsNotAPick() {
        #expect(SuggestionPlan.endpointId(ofConversation: nil) == nil)
        #expect(SuggestionPlan.endpointId(ofConversation: "ep-1") == nil)
        #expect(SuggestionPlan.endpointId(ofConversation: "endpoint:") == nil)
        #expect(SuggestionPlan.endpointId(ofConversation: "someoneelse:ep-1") == nil)
    }

    /// The donor skips re-donating an unchanged set, so the signature has to move
    /// for everything a donation actually carries — a rename included.
    @Test func signatureTracksLabelAndOrder() throws {
        let base = SuggestionPlan.build(rows: rows([
            try makeEndpoint("a", label: "Alpha"),
            try makeEndpoint("b", label: "Beta"),
        ]))
        let renamed = SuggestionPlan.build(rows: rows([
            try makeEndpoint("a", label: "Alpha II"),
            try makeEndpoint("b", label: "Beta"),
        ]))
        let reordered = SuggestionPlan.build(rows: rows([
            try makeEndpoint("a", label: "Alpha"),
            try makeEndpoint("b", label: "Beta"),
        ], prefs: SourcePrefs(recentTargetIds: ["b"])))
        #expect(SuggestionPlan.signature(base) == SuggestionPlan.signature(base))
        #expect(SuggestionPlan.signature(base) != SuggestionPlan.signature(renamed))
        #expect(SuggestionPlan.signature(base) != SuggestionPlan.signature(reordered))
    }
}

struct SourcePrefsTests {
    @Test func recordSendMovesToFrontAndSetsPrimary() {
        var prefs = SourcePrefs()
        prefs.recordSend(to: "a")
        prefs.recordSend(to: "b")
        prefs.recordSend(to: "a")
        #expect(prefs.recentTargetIds == ["a", "b"])
        #expect(prefs.primaryTargetId == "a")
    }

    @Test func pinnedPrimaryDoesNotFollowMru() {
        var prefs = SourcePrefs(primaryTargetId: "keep", primaryPinned: true)
        prefs.recordSend(to: "other")
        #expect(prefs.primaryTargetId == "keep")
    }

    @Test func mruCapped() {
        var prefs = SourcePrefs()
        for i in 0..<30 { prefs.recordSend(to: "id\(i)") }
        #expect(prefs.recentTargetIds.count == SourcePrefs.maxRecents)
        #expect(prefs.recentTargetIds.first == "id29")
    }
}

struct SeenSetTests {
    @Test func markSeenAndPrune() {
        let store = MemoryStore()
        let now = Date()
        store.markSeen("old", at: now.addingTimeInterval(-15 * 24 * 60 * 60))
        store.markSeen("fresh", at: now)
        #expect(store.hasSeen("old"))
        store.pruneSeen(now: now)
        #expect(!store.hasSeen("old"))
        #expect(store.hasSeen("fresh"))
    }

    @Test func unmarkSeen() {
        let store = MemoryStore()
        store.markSeen("x")
        store.unmarkSeen("x")
        #expect(!store.hasSeen("x"))
    }
}

/// The locked §4 copy table. The three tones and the failure lines that replaced
/// `Feedback.line` are covered in SendFeedbackTests.
struct FeedbackTests {
    @Test func lines() {
        #expect(Feedback.sent(to: "MacBook") == "Sent to MacBook")
        #expect(Feedback.sentQueued(to: "MacBook") == "Sent to MacBook — opens when it wakes")
        #expect(Feedback.sourceOffline == "No connection — will send when you're back online")
        #expect(Feedback.noDevices == "No devices yet — pair one to start sending")
        #expect(Feedback.sendFailed == "Couldn't send — check Tabsend is still linked")
    }
}

struct SenderTests {
    @Test func extractUrl() {
        #expect(Sender.extractUrl(from: "Check this https://example.com/x out") == "https://example.com/x")
        #expect(Sender.extractUrl(from: "  just words  ") == "just words")
        #expect(Sender.extractUrl(from: "http://a.example") == "http://a.example")
    }
}

struct Base64XTests {
    @Test func urlNoPadRoundTrip() {
        let bytes: [UInt8] = [0xFF, 0xEF, 0x01, 0x02, 0x03]
        let encoded = Base64X.encodeUrlNoPad(bytes)
        #expect(!encoded.contains("="))
        #expect(!encoded.contains("+"))
        #expect(!encoded.contains("/"))
        #expect(Base64X.decodeUrl(encoded) == bytes)
    }

    @Test func standardBase64Padded() {
        #expect(Base64X.encode([1, 2]) == "AQI=")
        #expect(Base64X.decode("AQI=") == [1, 2])
    }
}
