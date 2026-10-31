import Foundation

/// /v1/stream WebSocket client, mirroring android/.../net/Stream.kt.
///
/// The socket is LATENCY-ONLY; correctness never depends on it (ADR-0001).
/// On a `message` event the inlined envelope is deliberately ignored — it just
/// triggers the one idempotent drain loop. On any drop: reconnect with backoff
/// (1 s doubling to 60 s, reset after a session that outlived the ping interval)
/// and let the drain pull anything missed. A socket that stops answering pings is
/// a drop too (`Heartbeat`).
public actor StreamClient {
    public enum Event: Sendable, Equatable {
        case messageWaiting
        case endpointsChanged
        /// The group's own state changed (a reset was scheduled or stopped):
        /// re-fetch GET /v1/group. The event carries nothing itself.
        case groupUpdated
        case connected
        case disconnected
    }

    private let relayUrl: String
    private let deviceToken: String
    private let session: URLSession
    private let onEvent: @Sendable (Event) async -> Void

    private var task: URLSessionWebSocketTask?
    private var running = false
    private var backoffMs: UInt64 = 1_000
    private var connectionEpoch = 0
    /// When the current socket last delivered a frame, on `Heartbeat.uptimeMs()`.
    private var lastHeardAt: UInt64 = 0

    private static let backoffStartMs: UInt64 = 1_000
    private static let backoffMaxMs: UInt64 = 60_000

    public init(
        relayUrl: String,
        deviceToken: String,
        certFingerprint: String?,
        onEvent: @escaping @Sendable (Event) async -> Void
    ) {
        self.relayUrl = Pairing.normalizeRelayUrl(relayUrl)
        self.deviceToken = deviceToken
        self.onEvent = onEvent
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 30
        self.session = URLSession(
            configuration: config,
            delegate: PinningDelegate(pin: certFingerprint),
            delegateQueue: nil
        )
    }

    public func start() {
        guard !running else { return }
        running = true
        connectionEpoch += 1
        Task { await runLoop(epoch: connectionEpoch) }
    }

    public func stop() {
        running = false
        connectionEpoch += 1
        task?.cancel(with: .normalClosure, reason: nil)
        task = nil
    }

    private var streamUrl: URL? {
        var raw = relayUrl
        if raw.lowercased().hasPrefix("https://") {
            raw = "wss://" + raw.dropFirst("https://".count)
        } else if raw.lowercased().hasPrefix("http://") {
            raw = "ws://" + raw.dropFirst("http://".count)
        }
        return URL(string: raw + "/v1/stream")
    }

    private func runLoop(epoch: Int) async {
        while running && epoch == connectionEpoch {
            guard let url = streamUrl else { return }
            let ws = session.webSocketTask(with: url)
            task = ws
            ws.resume()
            let openedAt = Date()
            lastHeardAt = Heartbeat.uptimeMs()

            do {
                // Auth is in-band: the first frame must be the hello.
                try await ws.send(.string(#"{"type":"hello","deviceToken":"\#(deviceToken)"}"#))
                await onEvent(.connected)
                // Catch anything queued while we were disconnected.
                await onEvent(.messageWaiting)

                let pingTask = Task { [weak self, weak ws] in
                    let end = await Heartbeat.run(
                        now: Heartbeat.uptimeMs,
                        lastHeardAt: { await self?.lastHeardAt ?? 0 },
                        sleep: { try await Task.sleep(nanoseconds: $0 * 1_000_000) },
                        sendPing: {
                            guard let ws else { return false }
                            do {
                                try await ws.send(.string(#"{"type":"ping"}"#))
                                return true
                            } catch {
                                return false
                            }
                        }
                    )
                    // Nobody is answering: cancelling makes `receive()` throw, which
                    // is the ordinary drop-and-reconnect path below.
                    if end == .silent { ws?.cancel(with: .goingAway, reason: nil) }
                }
                defer { pingTask.cancel() }

                while running && epoch == connectionEpoch {
                    let frame = try await ws.receive()
                    // Any frame is an answer, not only `pong`.
                    lastHeardAt = Heartbeat.uptimeMs()
                    guard case let .string(text) = frame else { continue }
                    await handle(text)
                }
            } catch {
                // fall through to reconnect
            }
            task = nil
            await onEvent(.disconnected)

            guard running && epoch == connectionEpoch else { return }
            // A session that outlived the ping interval earns a fresh backoff.
            if Date().timeIntervalSince(openedAt) > TimeInterval(Wire.wsClientPingIntervalSeconds) {
                backoffMs = Self.backoffStartMs
            }
            try? await Task.sleep(nanoseconds: backoffMs * 1_000_000)
            backoffMs = min(backoffMs * 2, Self.backoffMaxMs)
        }
    }

    private func handle(_ text: String) async {
        guard let event = Self.event(for: text) else { return }
        await onEvent(event)
    }

    /// What one frame means, or nil to ignore it. Pure, so the mapping is tested.
    /// Unknown types (and frames that are not JSON) are ignored on purpose: a newer
    /// relay may send events this build has never heard of.
    static func event(for text: String) -> Event? {
        guard let data = text.data(using: .utf8),
              let event = try? Wire.decoder.decode(StreamEvent.self, from: data)
        else { return nil }
        switch event.type {
        case "message":
            // Never trust stream bytes; the drain pulls, verifies, dedupes.
            return .messageWaiting
        case "endpoint_added", "endpoint_removed", "endpoint_updated", "presence":
            return .endpointsChanged
        case "group_updated":
            // Carries nothing: the client pulls GET /v1/group, as with every other event.
            return .groupUpdated
        default:
            return nil // unknown types are ignored on purpose
        }
    }
}
