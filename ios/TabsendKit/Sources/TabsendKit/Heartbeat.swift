import Foundation

/// Is the relay still on the other end of the stream? [2026-10-27]
///
/// Mirrors android/.../logic/Heartbeat.kt. The app pings every 30 seconds and the relay
/// answers `pong` (shared §11), but nothing used to look at the answers, so a socket that
/// died without closing (a network switch, a NAT that forgot it) looked alive until a
/// later send failed or the system gave up, which can take minutes. Now every ping
/// expects a frame back, of any kind, within `Wire.wsClientPongTimeoutSeconds`; if none
/// comes, `run` returns `.silent` and the caller drops the socket and reconnects, which
/// drains. The cadence stays one ping per `Wire.wsClientPingIntervalSeconds`.
public enum Heartbeat {
    public static let pingIntervalMs = UInt64(Wire.wsClientPingIntervalSeconds) * 1_000
    public static let pongTimeoutMs = UInt64(Wire.wsClientPongTimeoutSeconds) * 1_000

    public enum End: Sendable, Equatable { case closed, silent }

    /// Milliseconds on a clock that only goes forward.
    public static func uptimeMs() -> UInt64 {
        DispatchTime.now().uptimeNanoseconds / 1_000_000
    }

    /// Ping until `sendPing` fails, the task is cancelled (`sleep` throws), or a ping
    /// goes unanswered. `now` and `lastHeardAt` share one clock; `lastHeardAt` is when the
    /// last frame of any kind arrived from the relay.
    public static func run(
        now: () -> UInt64,
        lastHeardAt: () async -> UInt64,
        sleep: (UInt64) async throws -> Void,
        sendPing: () async -> Bool
    ) async -> End {
        do {
            while true {
                try await sleep(pingIntervalMs - pongTimeoutMs)
                let pingAt = now()
                guard await sendPing() else { return .closed }
                try await sleep(pongTimeoutMs)
                if await lastHeardAt() < pingAt { return .silent }
            }
        } catch {
            return .closed
        }
    }
}
