import Foundation

/// A claim that succeeds exactly once, for the callbacks iOS wants answered exactly
/// once.
///
/// A background wake reports back to iOS — `setTaskCompleted(success:)` for a
/// `BGAppRefreshTask`, the fetch completion handler for a silent push — and there are
/// two ways to arrive at that report: the work finished, or the time ran out. Both can
/// happen within microseconds of each other, and neither can be dropped: reporting
/// twice is API misuse (iOS logs it and can terminate the app), reporting not at all is
/// how an app loses its background wakes. So both paths call, and the first one wins.
///
/// A lock rather than an actor, because a `BGAppRefreshTask` expiration handler is a
/// plain synchronous callback with nowhere to await.
public final class OnceLatch: @unchecked Sendable {
    private let lock = NSLock()
    private var claimed = false

    public init() {}

    /// True for the first caller, false for every caller after it.
    public func claim() -> Bool {
        lock.withLock {
            if claimed { return false }
            claimed = true
            return true
        }
    }
}
