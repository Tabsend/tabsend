import Foundation

/// Relay REST client, mirroring android/.../net/ApiClient.kt.
///
/// Error conventions (identical to Android):
///  - `ApiError` (relay answered with an error) is HARD — surface it.
///  - `URLError`/transport failures mean OFFLINE — queue and retry, never
///    treat as a hard failure.
public struct ApiError: Error, Sendable {
    public let status: Int
    public let code: String
    public let message: String

    /// Only `endpoint_removed` proves removal and may un-pair; a bare
    /// `unauthorized` must not (a restored/empty relay says the same thing).
    public var isDefinitiveRemoval: Bool { code == "endpoint_removed" }

    /// This relay does not know the route we asked for, so the FEATURE is absent
    /// rather than broken [0028].
    ///
    /// An app updates itself and a self-hosted relay is updated by hand, so a new
    /// client against an old relay is the normal state for a while, not an edge
    /// case. A pre-0028 relay has no `/v1/group-keys` at all (404) and refuses an
    /// unknown query on `/v1/messages` with `invalid_request` — neither is
    /// something to show the user or to keep retrying.
    public var isUnsupportedRoute: Bool {
        status == 404 || code == "not_found" || code == "invalid_request"
    }
}

public actor ApiClient {
    private let baseUrl: String
    private let deviceToken: String?
    private let session: URLSession

    public init(relayUrl: String, deviceToken: String? = nil, certFingerprint: String? = nil) {
        self.baseUrl = Pairing.normalizeRelayUrl(relayUrl)
        self.deviceToken = deviceToken
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 20
        config.waitsForConnectivity = false
        self.session = URLSession(
            configuration: config,
            delegate: PinningDelegate(pin: certFingerprint),
            delegateQueue: nil
        )
    }

    /// Test seam: the same client over a caller-supplied session, so the wire shape of
    /// a request can be asserted without a relay. Not public, and not pinned — a
    /// stub `URLProtocol` never presents a certificate.
    init(relayUrl: String, deviceToken: String?, session: URLSession) {
        self.baseUrl = Pairing.normalizeRelayUrl(relayUrl)
        self.deviceToken = deviceToken
        self.session = session
    }

    // MARK: endpoints

    public func getConfig() async throws -> ServerConfigResponse {
        try await request("GET", "/v1/config", authenticated: false)
    }

    public func register(_ body: RegisterRequest) async throws -> RegisterResponse {
        try await request("POST", "/v1/endpoints/register", body: body, authenticated: false)
    }

    public func listEndpoints() async throws -> [Endpoint] {
        try await request("GET", "/v1/endpoints")
    }

    /// A heartbeat also ROTATES the stored push subscription, which is how a device
    /// follows a relay that gained or lost a wake-up forwarder [0032]. Callers that
    /// hold a store should go through `WakePath.heartbeat`, which picks the transport
    /// and handles the refusal; the default keeps the pre-forwarder behaviour for the
    /// paths that only want a presence ping.
    public func heartbeat(
        endpointId: String,
        pushSubscription: PushSubscriptionBody = .none
    ) async throws -> HeartbeatResponse {
        try await request(
            "POST", "/v1/endpoints/\(escape(endpointId))/heartbeat",
            body: HeartbeatRequest(pushSubscription: pushSubscription)
        )
    }

    public func rename(endpointId: String, label: String) async throws -> Endpoint {
        try await request("PATCH", "/v1/endpoints/\(escape(endpointId))", body: RenameRequest(label: label))
    }

    public func removeEndpoint(id: String) async throws {
        let _: OkResponse = try await request("DELETE", "/v1/endpoints/\(escape(id))")
    }

    public func createPairing() async throws -> CreatePairingResponse {
        try await request("POST", "/v1/pairing", body: EmptyBody())
    }

    // MARK: messages

    public func send(_ body: SendRequest) async throws -> SendResponse {
        try await request("POST", "/v1/messages", body: body)
    }

    public func getPending() async throws -> [Message] {
        try await request("GET", "/v1/messages?pending=1")
    }

    public func ack(messageId: String) async throws -> AckResponse {
        try await request("POST", "/v1/messages/\(escape(messageId))/ack", body: EmptyBody())
    }

    /// Ack where failure must never break a drain: ApiError is swallowed
    /// (logged upstream if desired), transport errors rethrow as offline.
    public func ackQuietly(messageId: String) async {
        _ = try? await ack(messageId: messageId)
    }

    // MARK: group history [0028]

    /// The whole group's history, newest first. 400 `invalid_request` from a relay
    /// that predates ADR-0028 — it knows only `?pending=1` and `?outbox=1`.
    public func getHistory() async throws -> [HistoryEntry] {
        try await request("GET", "/v1/messages?history=1")
    }

    /// Every copy of a group key sealed TO this endpoint. Not consumed on read: a
    /// device that fetches and then dies before persisting must be able to fetch
    /// again. 404 on a relay that predates ADR-0028.
    public func getGroupKeys() async throws -> [GroupKeyDelivery] {
        try await request("GET", "/v1/group-keys")
    }

    /// Hand the group key to endpoints that lack it.
    public func postGroupKeys(_ body: GroupKeyRequest) async throws -> GroupKeyResponse {
        try await request("POST", "/v1/group-keys", body: body)
    }

    // MARK: group state [P-18 item 12]

    /// Whether a reset of this phone's group is waiting. 404 on a relay that predates
    /// the route; `GroupReset.fetch` turns that into "no reset".
    public func getGroup() async throws -> GroupStateResponse {
        try await request("GET", "/v1/group")
    }

    /// Stop a pending reset. Any device in the group may; the answer is always
    /// `{ "reset": null }`, also when nothing was pending.
    public func stopGroupReset() async throws -> StopGroupResetResponse {
        try await request("POST", "/v1/group/reset/stop", body: EmptyBody())
    }

    // MARK: plumbing

    private struct EmptyBody: Encodable {}

    private func request<T: Decodable>(
        _ method: String, _ path: String,
        authenticated: Bool = true
    ) async throws -> T {
        try await perform(method, path, bodyData: nil, authenticated: authenticated)
    }

    private func request<T: Decodable, B: Encodable>(
        _ method: String, _ path: String, body: B,
        authenticated: Bool = true
    ) async throws -> T {
        let data = try Wire.encoder.encode(body)
        return try await perform(method, path, bodyData: data, authenticated: authenticated)
    }

    private func perform<T: Decodable>(
        _ method: String, _ path: String, bodyData: Data?,
        authenticated: Bool
    ) async throws -> T {
        guard let url = URL(string: baseUrl + path) else {
            throw URLError(.badURL)
        }
        var req = URLRequest(url: url)
        req.httpMethod = method
        if authenticated, let deviceToken {
            req.setValue("\(Wire.authScheme) \(deviceToken)", forHTTPHeaderField: "Authorization")
        }
        if let bodyData {
            req.setValue("application/json; charset=utf-8", forHTTPHeaderField: "Content-Type")
            req.httpBody = bodyData
        }
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: req)
        } catch {
            ApiTransport.report(relayUrl: baseUrl, reachable: false)
            throw error
        }
        // The relay ANSWERED, so it is reachable — even when the answer is a
        // refusal. Reported before the throw below for exactly that reason:
        // recording a working relay as down every time it refuses something
        // would turn a rejected send into a fake outage.
        ApiTransport.report(relayUrl: baseUrl, reachable: true)
        guard let http = response as? HTTPURLResponse else {
            throw URLError(.badServerResponse)
        }
        guard (200..<300).contains(http.statusCode) else {
            if let parsed = try? Wire.decoder.decode(ApiErrorBody.self, from: data) {
                throw ApiError(status: http.statusCode, code: parsed.error.code, message: parsed.error.message)
            }
            throw ApiError(status: http.statusCode, code: "internal", message: "Request failed (\(http.statusCode)).")
        }
        return try Wire.decoder.decode(T.self, from: data)
    }

    private func escape(_ id: String) -> String {
        id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
    }
}

/// Where reachability is reported from.
///
/// Deliberately dumb: it reports every URL, including candidates typed into a
/// relay-move box. Deciding which of those say anything about the relay we are
/// registered to is `RelayHealthTracker`'s job. Mirrors the extension's
/// `setTransportHandler` in lib/api.ts.
public enum ApiTransport {
    public typealias Handler = @Sendable (_ relayUrl: String, _ reachable: Bool) -> Void

    private static let lock = NSLock()
    nonisolated(unsafe) private static var handler: Handler?

    public static func setHandler(_ handler: Handler?) {
        lock.withLock { Self.handler = handler }
    }

    static func report(relayUrl: String, reachable: Bool) {
        let handler = lock.withLock { Self.handler }
        handler?(relayUrl, reachable)
    }
}

extension Error {
    /// True when the failure means the relay never answered, so the work stays
    /// queued rather than being treated as a hard failure.
    ///
    /// This says nothing about WHY. It used to be the whole diagnosis, which is
    /// how "no connection" ended up on screen for a relay that was simply down —
    /// see `isDefinitelyOffline` for the split that matters to the user.
    public var isOffline: Bool {
        if self is URLError { return true }
        let ns = self as NSError
        return ns.domain == NSURLErrorDomain || ns.domain == NSPOSIXErrorDomain
    }

    /// True only when the failure means THIS DEVICE has no network.
    ///
    /// `isOffline` conflates "no network" with "host unreachable", and the
    /// difference is the entire point: `.cannotConnectToHost`, `.cannotFindHost`,
    /// `.timedOut` and TLS failures are RELAY problems, and telling a self-hoster
    /// their connection is down sends them to check a wifi that is working fine.
    /// Only the codes below are genuinely about this device's own connectivity.
    public var isDefinitelyOffline: Bool {
        let ns = self as NSError
        guard ns.domain == NSURLErrorDomain else { return false }
        switch ns.code {
        case NSURLErrorNotConnectedToInternet,
             NSURLErrorNetworkConnectionLost,
             NSURLErrorInternationalRoamingOff,
             NSURLErrorDataNotAllowed:
            return true
        default:
            return false
        }
    }
}
