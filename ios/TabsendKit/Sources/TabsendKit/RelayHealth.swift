import Foundation

/// The rolling verdict on "is our relay answering?", persisted so a surface the
/// user opens LATER (the paired screen, ten minutes into an outage) can say WHY
/// nothing is arriving, instead of rendering a healthy-looking device list from
/// cache while every send piles up in the outbound queue.
///
/// Mirrors `lib/health.ts` and `android/.../logic/RelayHealth.kt`. Fed by every
/// API call — heartbeat, poll, endpoint list, send — so it stays fresh with no
/// probe of its own, and correctness never depends on it: it is purely what the
/// UI is allowed to claim.
///
/// It lives in the App Group store, so a verdict recorded by the SHARE EXTENSION
/// (which is a separate process, and often the first thing to notice an outage,
/// since sending is what the user does first) is the same verdict the app reads.
public struct RelayHealth: Codable, Sendable, Equatable {
    /// The relay this verdict is about; a stale verdict for another URL is ignored.
    public var relayUrl: String
    /// Did the last call reach it? Any HTTP answer counts, even a rejection.
    public var reachable: Bool
    /// When this reachable/unreachable state began.
    public var since: Date
    /// The last time a call actually reached this relay, if ever.
    public var lastOkAt: Date?

    public init(relayUrl: String, reachable: Bool, since: Date, lastOkAt: Date? = nil) {
        self.relayUrl = relayUrl
        self.reachable = reachable
        self.since = since
        self.lastOkAt = lastOkAt
    }

    /// How long an outage must persist before surfaces call it out (no flapping).
    public static let outageGrace: TimeInterval = 30

    /// True when the relay has been unreachable long enough to be worth telling
    /// the user about. A single missed call during a radio handover or a container
    /// restart is noise; half a minute of silence is a fact.
    public static func isDown(_ health: RelayHealth?, now: Date) -> Bool {
        guard let health, !health.reachable else { return false }
        return now.timeIntervalSince(health.since) >= outageGrace
    }

    /// Whole minutes since the relay last answered, for `relayDownLine`.
    public func minutesSinceLastOk(now: Date) -> Int {
        let last = lastOkAt ?? since
        return Int(max(0, now.timeIntervalSince(last)) / 60)
    }

    /// Fold one call's outcome into the stored verdict, or nil when nothing needs
    /// writing. Pure so the throttle and the `since` rule are testable.
    ///
    /// `refresh` throttles same-state writes; transitions always write. `since`
    /// must survive a same-state refresh, or an outage would perpetually read as
    /// "started just now" and never clear the grace period that gates the
    /// warning — so the warning would never appear at all.
    public static func fold(
        previous: RelayHealth?,
        relayUrl: String,
        reachable: Bool,
        now: Date,
        lastWrite: Date?,
        refresh: TimeInterval = 20
    ) -> RelayHealth? {
        let sameState = previous?.relayUrl == relayUrl && previous?.reachable == reachable
        if sameState, let lastWrite, now.timeIntervalSince(lastWrite) < refresh { return nil }
        return RelayHealth(
            relayUrl: relayUrl,
            reachable: reachable,
            since: sameState ? (previous?.since ?? now) : now,
            lastOkAt: reachable ? now : previous?.lastOkAt
        )
    }
}

/// Relay reachability, recorded from ordinary traffic.
///
/// Installed by both the app and the share extension, each in its own process,
/// both writing the same App Group key. There is no probe: the poll/heartbeat
/// path already talks to the relay, so this is fresh for free.
public final class RelayHealthTracker: @unchecked Sendable {
    public static let shared = RelayHealthTracker()

    private let lock = NSLock()
    private var cached: RelayHealth?
    private var lastWrite: Date?
    private var store: TabsendStore?

    private init() {}

    /// Point the shared `ApiClient` transport hook at this tracker.
    public static func install(store: TabsendStore) {
        shared.lock.withLock { shared.store = store }
        ApiTransport.setHandler { relayUrl, reachable in
            shared.record(relayUrl: relayUrl, reachable: reachable, now: Date())
        }
    }

    /// Fold one call's outcome into the stored verdict. Calls aimed at a URL that
    /// ISN'T our registered relay (the /v1/config probe behind a relay move, a
    /// join attempt) are ignored: they say nothing about the relay we are
    /// actually registered to, and letting them write would make a typo in the
    /// address box look like an outage.
    public func record(relayUrl: String, reachable: Bool, now: Date) {
        lock.withLock {
            guard let store, store.registeredRelayUrl == relayUrl else { return }
            let previous = cached ?? store.relayHealth
            guard let folded = RelayHealth.fold(
                previous: previous, relayUrl: relayUrl, reachable: reachable,
                now: now, lastWrite: lastWrite
            ) else {
                // Warm the mirror even when the write is skipped, so a later
                // transition compares against the truth rather than re-reading.
                cached = previous
                return
            }
            cached = folded
            lastWrite = now
            store.relayHealth = folded
        }
    }

    /// The current verdict (storage-backed, so it survives process death).
    public func current() -> RelayHealth? {
        lock.withLock { cached ?? store?.relayHealth }
    }

    /// Drop the mirror — used when the registration changes underneath us.
    public func reset() {
        lock.withLock {
            cached = nil
            lastWrite = nil
        }
    }
}
