import Foundation

/// Target chooser ordering, mirroring android/.../logic/Chooser.kt:
/// drop self and consoles; sort primary -> MRU rank -> label; presence never
/// gates selectability, it only decorates.
public enum Chooser {
    public struct Row: Identifiable, Equatable, Sendable {
        public var endpoint: Endpoint
        public var isPrimary: Bool
        /// Online AND confirmed by a list we actually just fetched — see `presenceKnown`.
        public var online: Bool
        public var stale: Bool
        /// False when the list came from cache, so `presence` is a snapshot of
        /// unknown age and no dot may claim it (mirrors the extension's
        /// PRESENCE_TRUST_MS and Chooser.kt's presenceKnown).
        public var presenceKnown: Bool = true
        public var id: String { endpoint.id }
    }

    public static let staleHorizonSeconds: TimeInterval = 30 * 24 * 60 * 60

    /// - Parameter presenceKnown: pass `false` when `endpoints` came from the
    ///   cache rather than a live list. The relay only calls an endpoint online
    ///   for `Wire.presenceOnlineThresholdSeconds` after its last heartbeat, so a
    ///   cached verdict cannot be shown as fact — a green dot beside an
    ///   unreachable relay is a claim nobody can check (dogfood 2026-08-05).
    public static func build(
        endpoints: [Endpoint],
        selfEndpointId: String,
        prefs: SourcePrefs,
        now: Date = Date(),
        presenceKnown: Bool = true
    ) -> [Row] {
        let candidates = endpoints.filter { $0.id != selfEndpointId && $0.kind != "console" }
        let mruRank = Dictionary(
            uniqueKeysWithValues: prefs.recentTargetIds.enumerated().map { ($1, $0) }
        )
        let rows = candidates.map { endpoint -> Row in
            let online = endpoint.isOnline
            let lastSeen = WireDate.date(from: endpoint.lastSeenAt)
            let stale = !online && (lastSeen.map { now.timeIntervalSince($0) > staleHorizonSeconds } ?? true)
            return Row(
                endpoint: endpoint,
                isPrimary: endpoint.id == prefs.primaryTargetId,
                online: presenceKnown && online,
                stale: stale,
                presenceKnown: presenceKnown
            )
        }
        return rows.sorted { a, b in
            if a.isPrimary != b.isPrimary { return a.isPrimary }
            let ra = mruRank[a.endpoint.id] ?? Int.max
            let rb = mruRank[b.endpoint.id] ?? Int.max
            if ra != rb { return ra < rb }
            return a.endpoint.label.lowercased() < b.endpoint.label.lowercased()
        }
    }
}

/// User-facing feedback copy, mirroring android/.../logic/SendFeedback.kt (which
/// itself mirrors the extension). Keep these identical across clients.
///
/// This is the LOCKED §4 copy table, which predates the no-em-dash rule. The
/// failure lines added by the 2026-07-29 amendment live in SendFeedback.swift and
/// use short sentences instead.
public enum Feedback {
    public static func sent(to label: String) -> String { "Sent to \(label)" }
    public static func sentQueued(to label: String) -> String { "Sent to \(label) — opens when it wakes" }
    public static let sourceOffline = "No connection — will send when you're back online"
    public static let noDevices = "No devices yet — pair one to start sending"
    public static let sendFailed = "Couldn't send — check Tabsend is still linked"
}
