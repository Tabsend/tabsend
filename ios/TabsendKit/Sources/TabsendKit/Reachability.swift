import Foundation
import Network

/// Does the OS think this device has a network?
///
/// A weak signal by design — "there is a satisfied path", not "your relay works"
/// — so it is only ever used to DEMOTE a relay-unreachable diagnosis to a plain
/// offline one, never to skip a send attempt (mirrors the extension's use of
/// `navigator.onLine` and Android's ConnectivityManager check). Blaming the wifi
/// when the relay is the thing that's down is the bug this exists to stop.
///
/// Unknown counts as ONLINE. The monitor needs a moment to deliver its first
/// path, and a share extension may not live much longer than that; defaulting to
/// online means the fallback diagnosis names the relay address, which is the one
/// thing a self-hoster can act on. The URLError code (`isDefinitelyOffline`) is
/// the precise signal, and it needs no monitor at all — this is the backstop for
/// the vaguer transport errors.
public final class Reachability: @unchecked Sendable {
    public static let shared = Reachability()

    private let monitor = NWPathMonitor()
    private let queue = DispatchQueue(label: "io.tabsend.reachability")
    private let lock = NSLock()
    private var satisfied: Bool?
    private var started = false

    private init() {}

    /// Begin watching. Cheap, idempotent, and safe to call from an app extension.
    public func start() {
        lock.withLock {
            guard !started else { return }
            started = true
        }
        monitor.pathUpdateHandler = { [weak self] path in
            self?.lock.withLock { self?.satisfied = path.status == .satisfied }
        }
        monitor.start(queue: queue)
    }

    /// True unless the OS has actually told us there is no usable path.
    public var isOnline: Bool {
        lock.withLock { satisfied ?? true }
    }

    /// Test seam: pretend the OS said this.
    public func override(isOnline: Bool?) {
        lock.withLock { satisfied = isOnline }
    }
}

extension SendFailure {
    /// Split a transport failure into the two cases the user can act on.
    ///
    /// The relay never answered. With a network up that is a RELAY problem —
    /// wrong address, container down, TLS refused — and naming the URL is the
    /// only thing the user can act on. An `ApiError` means the relay DID answer
    /// and said no, which is a different conversation and never reaches here.
    public static func classifyTransport(
        _ error: Error,
        relayUrl: String,
        reachability: Reachability = .shared
    ) -> SendFailure {
        if error.isDefinitelyOffline { return .phoneOffline }
        if !reachability.isOnline { return .phoneOffline }
        return .relayUnreachable(relayUrl: relayUrl)
    }

    /// The relay DID answer, which is a different conversation from silence.
    ///
    /// What matters for whether we keep the tab is the STATUS, not the code: a
    /// proxy's HTML 502 has no error envelope at all and `ApiClient` can only
    /// label it `internal`, so switching on the code alone would read it as a
    /// permanent relay bug and throw the tab away.
    public static func classify(apiError: ApiError) -> SendFailure {
        if apiError.status == 401 { return .relayUnauthorized }
        if apiError.status == 429 || apiError.status >= 500 { return .relayBusy }
        return .relayError(code: apiError.code)
    }
}
