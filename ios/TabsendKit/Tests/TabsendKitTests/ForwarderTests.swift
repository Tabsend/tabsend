import Testing
import Foundation
@testable import TabsendKit

/// A canned HTTP server for one `URLSession`, recording what was sent so a test can
/// assert the wire shape. Neither the forwarder nor a relay is reachable from here.
///
/// One instance per test, each on its own hostname, so nothing is shared: swift-testing
/// runs suites in parallel and a single global route table produced tests that passed or
/// failed depending on what else was running.
final class StubServer: @unchecked Sendable {
    struct Call: Sendable {
        var url: String
        var method: String
        var authorization: String?
        var body: [String: Any]?

        var path: String { URL(string: url)?.path ?? url }
    }

    let host: String
    private var routes: [String: (Int, String)] = [:]
    private var calls: [Call] = []
    private let lock = NSLock()

    init() {
        host = StubURLProtocol.nextHost()
        StubURLProtocol.attach(self, to: host)
    }

    var baseURL: String { "https://\(host)" }

    func stub(_ path: String, status: Int = 200, json: String) {
        lock.withLock { routes[path] = (status, json) }
    }

    var recorded: [Call] { lock.withLock { calls } }

    var beats: [Call] { recorded.filter { $0.path.hasSuffix("/heartbeat") } }

    func session() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubURLProtocol.self]
        return URLSession(configuration: config)
    }

    fileprivate func handle(_ call: Call) -> (Int, String) {
        lock.withLock {
            calls.append(call)
            return routes[call.path] ?? (404, #"{"error":{"code":"not_found","message":"no stub"}}"#)
        }
    }
}

final class StubURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) private static var servers: [String: StubServer] = [:]
    nonisolated(unsafe) private static var counter = 0
    private static let lock = NSLock()

    static func nextHost() -> String {
        lock.withLock {
            counter += 1
            return "stub-\(counter).test"
        }
    }

    static func attach(_ server: StubServer, to host: String) {
        lock.withLock { servers[host] = server }
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        // URLSession moves an httpBody onto a stream, so the body has to be read back
        // out of it rather than off the request.
        var bodyData = request.httpBody
        if bodyData == nil, let stream = request.httpBodyStream {
            stream.open()
            var buffer = [UInt8](repeating: 0, count: 8192)
            var collected = Data()
            while stream.hasBytesAvailable {
                let read = stream.read(&buffer, maxLength: buffer.count)
                if read <= 0 { break }
                collected.append(contentsOf: buffer[0..<read])
            }
            stream.close()
            bodyData = collected
        }
        let call = StubServer.Call(
            url: request.url?.absoluteString ?? "",
            method: request.httpMethod ?? "",
            authorization: request.value(forHTTPHeaderField: "Authorization"),
            body: bodyData.flatMap {
                try? JSONSerialization.jsonObject(with: $0) as? [String: Any]
            }
        )
        let server = Self.lock.withLock { Self.servers[request.url?.host ?? ""] }
        let (status, json) = server?.handle(call)
            ?? (500, #"{"error":{"code":"internal","message":"no stub server"}}"#)
        let response = HTTPURLResponse(
            url: request.url!, statusCode: status,
            httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(json.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

/// The wake-up forwarder path: the client, the advertise/fallback matrix, token
/// rotation, and the heartbeat that carries the result (ADR-0032, PLANS P-5).
///
/// Serialized because `ForwarderConfig` is one setting for the whole process, exactly
/// as it is in the app.
@Suite(.serialized)
struct ForwarderTests {
    /// Every test starts from the shipped default: no forwarder URL anywhere.
    init() { ForwarderConfig.clearOverride() }

    private func enabled() { ForwarderConfig.setOverride("https://wake.test") }

    private func paired(
        _ store: TabsendStore, relay: String, advertises: Bool? = nil
    ) {
        store.registration = Registration(
            endpointId: "e1", groupId: "g1", deviceToken: "tok",
            relayUrl: relay, label: "iPhone",
            wakeForwarderAdvertised: advertises
        )
    }

    private func holdingToken(_ store: TabsendStore, wake: String? = "WAKE") {
        store.wakeRegistration = WakeRegistration(
            apnsToken: "aaaa", environment: "production", wakeToken: wake
        )
    }

    // MARK: the client

    @Test func hexEncodesTheWayApnsProvidersExpect() {
        #expect(Data([0x00, 0x0f, 0xa1, 0xff]).apnsHexString == "000fa1ff")
        #expect(Data().apnsHexString == "")
        // 32 bytes is the classic device token width.
        #expect(Data(repeating: 0x05, count: 32).apnsHexString.count == 64)
    }

    @Test func registerPostsTheTokenAndReturnsTheWakeToken() async throws {
        let stub = StubServer()
        stub.stub("/v1/register", json: #"{"wakeToken":"WAKE-1"}"#)
        // Trailing slash on purpose: it must not become a double slash on the wire.
        let client = ForwarderClient(url: stub.baseURL + "/", session: stub.session())

        let token = try await client.register(apnsToken: "abc123", environment: "sandbox")

        #expect(token == "WAKE-1")
        let call = try #require(stub.recorded.first)
        #expect(call.method == "POST")
        #expect(call.url == stub.baseURL + "/v1/register")
        #expect(call.body?["apnsToken"] as? String == "abc123")
        #expect(call.body?["environment"] as? String == "sandbox")
        // Registration is unauthenticated: there is no credential to send yet.
        #expect(call.authorization == nil)
    }

    @Test func registerSurfacesARefusal() async {
        let stub = StubServer()
        stub.stub(
            "/v1/register", status: 400,
            json: #"{"error":{"code":"invalid_request","message":"bad token"}}"#
        )
        let client = ForwarderClient(url: stub.baseURL, session: stub.session())

        await #expect(throws: ForwarderError.self) {
            _ = try await client.register(apnsToken: "abc", environment: "production")
        }
    }

    @Test func revokeCarriesTheTokenInAHeaderAndNeverInTheUrl() async {
        let stub = StubServer()
        stub.stub("/v1/revoke", json: #"{"status":"ok"}"#)
        let client = ForwarderClient(url: stub.baseURL, session: stub.session())

        await client.revoke(wakeToken: "SECRET-WAKE")

        let call = stub.recorded.first
        #expect(call?.authorization == "Bearer SECRET-WAKE")
        // PROTOCOL.md §6: a wake token rides a header, never a path or query string.
        #expect(call?.url == stub.baseURL + "/v1/revoke")
        #expect(call?.url.contains("SECRET-WAKE") == false)
    }

    @Test func revokeSwallowsEverything() async {
        // No stub for the path, so it 404s. Revocation is fire-and-forget by contract:
        // the forwarder answers 200 to a live, revoked or invented token alike, so
        // there is nothing to branch on.
        let stub = StubServer()
        let client = ForwarderClient(url: stub.baseURL, session: stub.session())
        await client.revoke(wakeToken: "GONE")
        #expect(stub.recorded.count == 1)
    }

    @Test func theConfiguredUrlIsTrimmedOfSlashesBeforeAnythingUsesIt() {
        ForwarderConfig.setOverride("  https://wake.test///  ")
        // One normaliser for every base URL in the app (`Pairing.normalizeRelayUrl`),
        // so a pasted trailing slash cannot reach the wire as `//v1/register`.
        #expect(ForwarderConfig.url == "https://wake.test")
    }

    @Test func nothingIsConfiguredUntilAUrlIsKnown() {
        // The shipped default: no official instance is deployed, nothing is baked in,
        // and the whole path is off.
        #expect(ForwarderConfig.officialInstance == nil)
        #expect(!WakePath.isConfigured)
        #expect(ForwarderClient.live() == nil)
        enabled()
        #expect(WakePath.isConfigured)
    }

    // MARK: which Apple environment issued the device token

    /// An `embedded.mobileprovision` in the shape the parser meets on a phone: a
    /// CMS-signed blob with the XML plist somewhere in the middle of it.
    private func signedProfile(entitlements: String) -> Data {
        var data = Data([0x30, 0x82, 0x0d, 0x9c, 0x06, 0x09])  // DER header bytes
        data.append(Data("""
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" \
        "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0"><dict>
        <key>Name</key><string>Tabsend</string>
        <key>Entitlements</key><dict>\(entitlements)</dict>
        </dict></plist>
        """.utf8))
        data.append(Data([0x00, 0x01, 0x02, 0xff]))  // the signature that trails it
        return data
    }

    @Test func readsTheApsEnvironmentOutOfASignedProfile() {
        let development = signedProfile(
            entitlements: "<key>aps-environment</key><string>development</string>"
        )
        #expect(ApnsEnvironment.apsEnvironment(inProfile: development) == "development")

        let distribution = signedProfile(
            entitlements: "<key>aps-environment</key><string>production</string>"
        )
        #expect(ApnsEnvironment.apsEnvironment(inProfile: distribution) == "production")
    }

    @Test func aProfileWithoutPushHasNoEnvironmentToRead() {
        let noPush = signedProfile(entitlements: "<key>get-task-allow</key><true/>")
        #expect(ApnsEnvironment.apsEnvironment(inProfile: noPush) == nil)
        #expect(ApnsEnvironment.apsEnvironment(inProfile: Data("not a profile".utf8)) == nil)
        #expect(ApnsEnvironment.apsEnvironment(inProfile: Data()) == nil)
    }

    /// The bug this replaced: a Release build signed with a DEVELOPMENT profile, which
    /// is what `project.yml` gives anyone building locally. Apple issues it a sandbox
    /// token, the old `#if DEBUG` test called it production, and the forwarder then
    /// asked the production host about a sandbox token — `400 BadDeviceToken`.
    @Test func aDevelopmentProfileMeansSandboxWhateverTheBuildConfigurationSays() {
        #expect(ApnsEnvironment.environment(forEntitlement: "development") == "sandbox")
        #expect(ApnsEnvironment.environment(forEntitlement: "production") == "production")
        // Nothing else exists today. Production is the safer guess for a shape this app
        // has never seen: it is what every install a user can get from Apple carries.
        #expect(ApnsEnvironment.environment(forEntitlement: "") == "production")
    }

    // MARK: the advertise / fallback matrix

    @Test func noForwarderUrlMeansNoneWhateverElseIsTrue() {
        let store = MemoryStore()
        holdingToken(store)
        #expect(WakePath.subscription(store: store, relayAdvertisesForwarder: true) == .none)
    }

    @Test func optedOutMeansNone() {
        enabled()
        let store = MemoryStore()
        holdingToken(store)
        store.instantDeliveryOptOut = true
        #expect(WakePath.subscription(store: store, relayAdvertisesForwarder: true) == .none)
    }

    @Test func noWakeTokenYetMeansNone() {
        enabled()
        let store = MemoryStore()
        holdingToken(store, wake: nil)
        #expect(WakePath.subscription(store: store, relayAdvertisesForwarder: true) == .none)
    }

    /// The row that matters: a relay with no forwarder REFUSES `forwarder` with a 400,
    /// so it must never be offered one.
    @Test func relayWithoutAForwarderIsNeverSentForwarder() {
        enabled()
        let store = MemoryStore()
        holdingToken(store)
        #expect(WakePath.subscription(store: store, relayAdvertisesForwarder: false) == .none)
    }

    @Test func everythingInPlaceMeansForwarder() {
        enabled()
        let store = MemoryStore()
        holdingToken(store)
        #expect(
            WakePath.subscription(store: store, relayAdvertisesForwarder: true)
                == .forwarder(wakeToken: "WAKE")
        )
    }

    // MARK: minting and rotation

    @Test func mintsOnceAndOnlyForARelayThatCanRing() async {
        enabled()
        let stub = StubServer()
        stub.stub("/v1/register", json: #"{"wakeToken":"WAKE-1"}"#)
        let client = ForwarderClient(url: stub.baseURL, session: stub.session())
        let store = MemoryStore()
        paired(store, relay: "https://relay.invalid")

        // No relay forwarder: nothing is enrolled at all, so the forwarder never learns
        // about a device it would have no reason to ring.
        await WakePath.deviceTokenArrived(
            "aabb", environment: "production", store: store, client: client
        )
        #expect(store.wakeRegistration?.apnsToken == "aabb")
        #expect(store.wakeRegistration?.wakeToken == nil)
        #expect(stub.recorded.isEmpty)

        // The relay gains one.
        WakePath.remember(true, store: store)
        let minted = await WakePath.mintIfNeeded(
            store: store, relayAdvertisesForwarder: true, client: client
        )
        #expect(minted)
        #expect(store.wakeRegistration?.wakeToken == "WAKE-1")
        #expect(stub.recorded.count == 1)

        // Already holding one: no second registration.
        let again = await WakePath.mintIfNeeded(
            store: store, relayAdvertisesForwarder: true, client: client
        )
        #expect(!again)
        #expect(stub.recorded.count == 1)
    }

    @Test func aChangedApnsTokenIsRegisteredAgain() async {
        enabled()
        let stub = StubServer()
        stub.stub("/v1/register", json: #"{"wakeToken":"WAKE-1"}"#)
        let client = ForwarderClient(url: stub.baseURL, session: stub.session())
        let store = MemoryStore()
        paired(store, relay: "https://relay.invalid", advertises: true)

        await WakePath.deviceTokenArrived("aaaa", store: store, client: client)
        #expect(store.wakeRegistration?.wakeToken == "WAKE-1")

        // Same token again: Apple redelivers on every launch, and that is not a change.
        let unchanged = await WakePath.deviceTokenArrived("aaaa", store: store, client: client)
        #expect(!unchanged)
        #expect(stub.recorded.count == 1)

        // Apple rotated it. The old wake token is dropped and a new one minted, which
        // is what replaces it at the forwarder too (PROTOCOL.md §3.1).
        stub.stub("/v1/register", json: #"{"wakeToken":"WAKE-2"}"#)
        let rotated = await WakePath.deviceTokenArrived("bbbb", store: store, client: client)
        #expect(rotated)
        #expect(store.wakeRegistration?.apnsToken == "bbbb")
        #expect(store.wakeRegistration?.wakeToken == "WAKE-2")
        #expect(stub.recorded.count == 2)
        #expect(stub.recorded.last?.body?["apnsToken"] as? String == "bbbb")
    }

    @Test func aChangedEnvironmentCountsAsAChangedToken() async {
        enabled()
        let stub = StubServer()
        stub.stub("/v1/register", json: #"{"wakeToken":"WAKE-SANDBOX"}"#)
        let client = ForwarderClient(url: stub.baseURL, session: stub.session())
        let store = MemoryStore()
        paired(store, relay: "https://relay.invalid", advertises: true)

        await WakePath.deviceTokenArrived(
            "aaaa", environment: "sandbox", store: store, client: client
        )
        #expect(store.wakeRegistration?.wakeToken == "WAKE-SANDBOX")

        // Apple's two environments do not share device tokens, so the same hex string
        // under a different environment is a different doorbell.
        stub.stub("/v1/register", json: #"{"wakeToken":"WAKE-PROD"}"#)
        await WakePath.deviceTokenArrived(
            "aaaa", environment: "production", store: store, client: client
        )
        #expect(store.wakeRegistration?.environment == "production")
        #expect(store.wakeRegistration?.wakeToken == "WAKE-PROD")
    }

    @Test func mintingSurvivesAForwarderThatIsDown() async {
        enabled()
        let stub = StubServer()  // no /v1/register stub: the call 404s
        let client = ForwarderClient(url: stub.baseURL, session: stub.session())
        let store = MemoryStore()
        paired(store, relay: "https://relay.invalid", advertises: true)

        await WakePath.deviceTokenArrived("aaaa", store: store, client: client)

        #expect(store.wakeRegistration?.wakeToken == nil)
        // Degrades to exactly the pre-forwarder behaviour (PROTOCOL.md §7).
        #expect(WakePath.subscription(store: store, relayAdvertisesForwarder: true) == .none)
    }

    @Test func revokeRetiresTheTokenAndForgetsItLocally() async {
        enabled()
        let stub = StubServer()
        stub.stub("/v1/revoke", json: #"{"status":"ok"}"#)
        let client = ForwarderClient(url: stub.baseURL, session: stub.session())
        let store = MemoryStore()
        holdingToken(store, wake: "WAKE-1")

        await WakePath.revoke(store: store, client: client)

        #expect(store.wakeRegistration == nil)
        #expect(stub.recorded.first?.authorization == "Bearer WAKE-1")
    }

    @Test func unpairKeepsTheOptOutAndDropsTheCredentials() {
        let store = MemoryStore()
        store.instantDeliveryOptOut = true
        holdingToken(store)
        store.clear()
        #expect(store.wakeRegistration == nil)
        // A standing choice about background activity is not group data, so re-pairing
        // must not quietly switch the wake path back on.
        #expect(store.instantDeliveryOptOut)
    }

    // MARK: the heartbeat, against a stubbed relay

    private func relayApi(_ stub: StubServer) -> ApiClient {
        ApiClient(relayUrl: stub.baseURL, deviceToken: "tok", session: stub.session())
    }

    private static let okBeat = #"{"presence":"online","serverTime":"2026-08-20T00:00:00.000Z"}"#

    @Test func heartbeatCarriesForwarderWhereTheRelayAdvertisesIt() async {
        enabled()
        let stub = StubServer()
        stub.stub("/v1/config", json: #"{"protocol":3,"wakeForwarder":true}"#)
        stub.stub("/v1/register", json: #"{"wakeToken":"WAKE-1"}"#)
        stub.stub("/v1/endpoints/e1/heartbeat", json: Self.okBeat)
        let store = MemoryStore()
        paired(store, relay: stub.baseURL)
        holdingToken(store, wake: nil)

        await WakePath.heartbeat(
            store: store, api: relayApi(stub),
            client: ForwarderClient(url: stub.baseURL, session: stub.session())
        )

        #expect(store.registration?.wakeForwarderAdvertised == true)
        // Minted late, on the beat, because the relay only just said it could ring.
        #expect(store.wakeRegistration?.wakeToken == "WAKE-1")
        let sub = stub.beats.last?.body?["pushSubscription"] as? [String: Any]
        #expect(sub?["transport"] as? String == "forwarder")
        #expect(sub?["wakeToken"] as? String == "WAKE-1")
    }

    @Test func heartbeatFallsBackToNoneWhenTheRelayLosesItsForwarder() async {
        enabled()
        let stub = StubServer()
        stub.stub("/v1/config", json: #"{"protocol":3}"#)  // no wakeForwarder any more
        stub.stub("/v1/endpoints/e1/heartbeat", json: Self.okBeat)
        let store = MemoryStore()
        paired(store, relay: stub.baseURL, advertises: true)
        holdingToken(store, wake: "WAKE-1")

        await WakePath.heartbeat(store: store, api: relayApi(stub))

        #expect(store.registration?.wakeForwarderAdvertised == false)
        let sub = stub.beats.last?.body?["pushSubscription"] as? [String: Any]
        #expect(sub?["transport"] as? String == "none")
        #expect(sub?["wakeToken"] == nil)
    }

    /// The race the hint cannot close: the forwarder went away between the config read
    /// and the beat. The relay answers `invalid_request`; the device must fall back
    /// rather than sit there claiming a transport its relay cannot honour.
    @Test func heartbeatRetriesAsNoneWhenTheRelayRefusesTheTransport() async {
        enabled()
        let stub = StubServer()
        stub.stub("/v1/config", json: #"{"protocol":3,"wakeForwarder":true}"#)
        stub.stub(
            "/v1/endpoints/e1/heartbeat", status: 400,
            json: #"{"error":{"code":"invalid_request","message":"This relay has no wake-up forwarder."}}"#
        )
        let store = MemoryStore()
        paired(store, relay: stub.baseURL, advertises: true)
        holdingToken(store, wake: "WAKE-1")

        await WakePath.heartbeat(store: store, api: relayApi(stub))

        #expect(stub.beats.count == 2)
        #expect(
            (stub.beats.first?.body?["pushSubscription"] as? [String: Any])?["transport"] as? String
                == "forwarder"
        )
        #expect(
            (stub.beats.last?.body?["pushSubscription"] as? [String: Any])?["transport"] as? String
                == "none"
        )
        #expect(store.registration?.wakeForwarderAdvertised == false)
    }

    @Test func aBuildWithNoForwarderAsksTheRelayNothingExtra() async {
        let stub = StubServer()
        stub.stub("/v1/endpoints/e1/heartbeat", json: Self.okBeat)
        let store = MemoryStore()
        paired(store, relay: stub.baseURL)

        await WakePath.heartbeat(store: store, api: relayApi(stub))

        // No /v1/config call: today's app makes byte-for-byte the traffic it always did.
        #expect(stub.recorded.count == 1)
        #expect(stub.recorded.first?.path.hasSuffix("/heartbeat") == true)
        let sub = stub.recorded.first?.body?["pushSubscription"] as? [String: Any]
        #expect(sub?["transport"] as? String == "none")
    }

    // MARK: the wire

    @Test func forwarderSubscriptionEncodesTokenAndNoUrl() throws {
        let body = PushSubscriptionBody.forwarder(wakeToken: "WAKE")
        let json = try #require(
            try JSONSerialization.jsonObject(with: Wire.encoder.encode(body)) as? [String: Any]
        )
        #expect(json["transport"] as? String == "forwarder")
        #expect(json["wakeToken"] as? String == "WAKE")
        // There is no url field in this variant and there never will be: a
        // client-supplied URL would make every register call an SSRF lever [0032].
        #expect(json.count == 2)
    }

    @Test func registerRequestStillDefaultsToNone() throws {
        let request = RegisterRequest(label: "iPhone", deviceName: "iPhone", e2ePubkey: "PUB")
        let json = try #require(
            try JSONSerialization.jsonObject(with: Wire.encoder.encode(request)) as? [String: Any]
        )
        #expect((json["pushSubscription"] as? [String: Any])?["transport"] as? String == "none")
    }

    @Test func configWakeForwarderIsAbsentNotFalseOnOlderRelays() throws {
        let old = try Wire.decoder.decode(
            ServerConfigResponse.self, from: Data(#"{"protocol":3}"#.utf8)
        )
        #expect(old.wakeForwarder == nil)
        let new = try Wire.decoder.decode(
            ServerConfigResponse.self, from: Data(#"{"protocol":3,"wakeForwarder":true}"#.utf8)
        )
        #expect(new.wakeForwarder == true)
    }
}
