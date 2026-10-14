import Foundation

/// /v1/stream WebSocket client, mirroring android/.../net/Stream.kt.
///
/// The socket is LATENCY-ONLY; correctness never depends on it (ADR-0001).
/// On a `message` event the inlined envelope is deliberately ignored — it just
/// triggers the one idempotent drain loop. On any drop: reconnect with backoff
/// (1 s doubling to 60 s, reset after a session that outlived the ping interval)
/// and let the drain pull anything missed.
public actor StreamClient {
    public enum Event: Sendable {
        case messageWaiting
        case endpointsChanged
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

            do {
                // Auth is in-band: the first frame must be the hello.
                try await ws.send(.string(#"{"type":"hello","deviceToken":"\#(deviceToken)"}"#))
                await onEvent(.connected)
                // Catch anything queued while we were disconnected.
                await onEvent(.messageWaiting)

                let pingTask = Task { [weak ws] in
                    while !Task.isCancelled {
                        try await Task.sleep(nanoseconds: UInt64(Wire.wsClientPingIntervalSeconds) * 1_000_000_000)
                        try await ws?.send(.string(#"{"type":"ping"}"#))
                    }
                }
                defer { pingTask.cancel() }

                while running && epoch == connectionEpoch {
                    let frame = try await ws.receive()
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
        guard let data = text.data(using: .utf8),
              let event = try? Wire.decoder.decode(StreamEvent.self, from: data)
        else { return }
        switch event.type {
        case "message":
            // Never trust stream bytes; the drain pulls, verifies, dedupes.
            await onEvent(.messageWaiting)
        case "endpoint_added", "endpoint_removed", "endpoint_updated", "presence":
            await onEvent(.endpointsChanged)
        default:
            break // unknown types are ignored on purpose
        }
    }
}
