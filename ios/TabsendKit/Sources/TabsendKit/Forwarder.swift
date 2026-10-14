import Foundation

/// The client for the project's wake-up forwarder (`forwarder/PROTOCOL.md`,
/// HOSTED_PLAN §6, PLANS P-5 option 1, ADR-0032).
///
/// iOS freezes a backgrounded app, so the only reliable wake is APNs, and APNs takes
/// instructions only from a key Apple issues per developer account — a key that cannot
/// be handed to self-hosters. The forwarder is the one service that holds it. This app
/// hands it an APNs device token, gets a wake token back, and hands THAT to its own
/// relay. Nothing else passes: no content, no relay address, no account.
///
/// Metadata cost, in the same words as everywhere else this path is described: the
/// forwarder learns that a device received something, and when. Never what.
///
/// Two routes are used here. `POST /v1/wake` is the relay's, never this app's.
///
/// Logging discipline (`PROTOCOL.md` §8): a wake token and an APNs device token are
/// both credentials-shaped and neither may ever be printed. Nothing in this file logs.

/// Where the forwarder lives, for this build.
///
/// **There is no official forwarder instance deployed yet, so there is no default URL
/// and there deliberately is not one.** A default pointing at an address that cannot
/// answer would make every install look broken in a way nothing on the phone could
/// explain. With no URL the app behaves exactly as it did before this file existed:
/// `{transport:"none"}`, instant in the foreground, drain on open.
public enum ForwarderConfig {
    /// >>> BAKE THE OFFICIAL INSTANCE URL IN HERE BEFORE STORE PUBLICATION. <<<
    ///
    /// One line, e.g. `"https://wake.tabsend.io"`, and the wake path turns itself on
    /// for every user at their next pairing (P-5: instant delivery is on by default,
    /// with an explicit opt-out — never an opt-in that silently leaves a phone
    /// polling). Until then this stays nil and there is nothing to point at.
    public static let officialInstance: String? = nil

    /// `TabsendForwarderURL` in the app's Info.plist. This is how a development build,
    /// or somebody running their own forwarder alongside their own relay, points the
    /// app somewhere without editing code. Read once, at first use.
    static let infoPlistKey = "TabsendForwarderURL"

    private static let lock = NSLock()
    nonisolated(unsafe) private static var override: String??

    /// The forwarder this build talks to, or nil when it has none.
    public static var url: String? {
        lock.withLock {
            if let override { return override }
            let fromPlist = Bundle.main.object(forInfoDictionaryKey: infoPlistKey) as? String
            let resolved = fromPlist?.trimmingCharacters(in: .whitespacesAndNewlines)
            if let resolved, !resolved.isEmpty { return Pairing.normalizeRelayUrl(resolved) }
            return officialInstance.map(Pairing.normalizeRelayUrl)
        }
    }

    /// Point this build at a different forwarder. Exists for the tests and for a build
    /// configured at run time; the shipped app resolves the URL above and never calls it.
    public static func setOverride(_ url: String?) {
        lock.withLock {
            override = url.map { $0.isEmpty ? nil : Pairing.normalizeRelayUrl($0) }
        }
    }

    /// Reset to the resolved value, so one test cannot leak into the next.
    public static func clearOverride() {
        lock.withLock { override = nil }
    }
}

/// Which of Apple's two push environments issued this device token.
///
/// Apple's environments do not share device tokens, and the forwarder needs to know
/// which Apple host to call (`PROTOCOL.md` §3.1). Report the wrong one and Apple answers
/// `400 BadDeviceToken` to every wake for this phone.
///
/// What decides it is the SIGNING, not the build configuration. `aps-environment` in the
/// provisioning profile the binary was signed with is the whole answer, and a build
/// configuration only correlates with it: a Release build signed with a development
/// profile — which is what `project.yml` produces for anyone building locally — gets a
/// sandbox token, and a `#if DEBUG` test would have called it production. So the profile
/// is read, and the build configuration is only the last resort.
public enum ApnsEnvironment {
    public static let production = "production"
    public static let sandbox = "sandbox"

    /// Resolved once. Nothing about the signature of a running binary can change.
    public static var current: String { resolved }
    private static let resolved: String = resolve()

    static func resolve() -> String {
        #if targetEnvironment(simulator)
        // No signing, no profile, and no real APNs: a simulator token is only ever
        // usable against the sandbox.
        return sandbox
        #else
        // The app bundle carries the profile it was signed with — development, ad hoc,
        // enterprise or TestFlight. An App Store install has none, and an App Store
        // install is always production.
        guard let url = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision"),
              let profile = try? Data(contentsOf: url)
        else { return production }
        guard let entitlement = apsEnvironment(inProfile: profile) else {
            // A profile that could not be read, or one with no push capability at all.
            // Nothing better is left, so fall back to the build configuration.
            #if DEBUG
            return sandbox
            #else
            return production
            #endif
        }
        return environment(forEntitlement: entitlement)
        #endif
    }

    /// Apple writes exactly two values here. Anything else is a profile shape this app
    /// has never seen, and production is the safer guess: it is what every install a
    /// user can get from Apple carries.
    static func environment(forEntitlement raw: String) -> String {
        raw == "development" ? sandbox : production
    }

    /// Pull `Entitlements.aps-environment` out of an `embedded.mobileprovision`.
    ///
    /// The file is a CMS-signed blob wrapping an XML plist. Verifying that signature
    /// would prove nothing useful here — the binary is already running, so the profile
    /// beside it is as trustworthy as the app itself — so the plist is sliced out by its
    /// own delimiters and parsed. That is the long-standing shape of these files and the
    /// only part this app reads.
    static func apsEnvironment(inProfile data: Data) -> String? {
        // The closing tag is looked for AFTER the opening one, so a stray match in the
        // signature bytes ahead of the payload cannot produce a backwards range.
        guard let start = data.range(of: Data("<?xml".utf8)),
              let end = data.range(
                  of: Data("</plist>".utf8), options: .backwards,
                  in: start.lowerBound..<data.endIndex
              )
        else { return nil }
        // Copied out of the slice: a slice keeps the parent's indices, and not every
        // reader of one gets that right.
        let plist = Data(data[start.lowerBound..<end.upperBound])
        guard let root = try? PropertyListSerialization.propertyList(
            from: plist, options: [], format: nil
        ) as? [String: Any],
            let entitlements = root["Entitlements"] as? [String: Any],
            let value = entitlements["aps-environment"] as? String
        else { return nil }
        return value
    }
}

/// What this device holds for the wake path: Apple's doorbell address, which Apple
/// environment issued it, and the wake token the forwarder minted in exchange.
///
/// `wakeToken` is nil between "iOS handed us a device token" and "the forwarder
/// answered", which is a normal state — the app registers `{transport:"none"}` in the
/// meantime and rotates at the next heartbeat.
///
/// SECRET: the wake token is the only credential the forwarder has, so this whole
/// record lives in the Keychain beside the device token, never in App Group defaults.
public struct WakeRegistration: Codable, Sendable, Equatable {
    /// Hex, lowercase, as APNs providers expect it.
    public var apnsToken: String
    public var environment: String
    public var wakeToken: String?

    public init(apnsToken: String, environment: String, wakeToken: String? = nil) {
        self.apnsToken = apnsToken
        self.environment = environment
        self.wakeToken = wakeToken
    }
}

public enum ForwarderError: Error, Sendable {
    case notConfigured
    case badURL
    /// The forwarder answered with a refusal. `message` is its own wording.
    case api(status: Int, message: String)
    case malformedResponse
    /// Never reached the forwarder. Best-effort work stops here and retries later.
    case offline(Error)
}

/// REST client for the forwarder. Same shape as `ApiClient`: an actor over one
/// `URLSession`, JSON in and out, transport failures distinguished from refusals.
///
/// No certificate pinning, deliberately: `ApiClient` pins because a relay may be a
/// self-signed box on a LAN (ADR-0019). The forwarder is a public service on a public
/// name with a CA certificate, so ordinary ATS is the right and stricter answer.
public actor ForwarderClient {
    private let baseUrl: String
    private let session: URLSession

    /// `session` is injectable so the tests can drive a stub `URLProtocol`.
    public init(url: String, session: URLSession? = nil) {
        // Same normaliser the relay URLs go through: trim, drop trailing slashes. A URL
        // that came from `ForwarderConfig` has been through it already, and running it
        // twice changes nothing; a URL handed straight to this initialiser has not.
        self.baseUrl = Pairing.normalizeRelayUrl(url)
        if let session {
            self.session = session
        } else {
            let config = URLSessionConfiguration.default
            // Shorter than the relay's 20 s. This runs inside pairing and inside a
            // background wake, and a forwarder that is not answering must not hold
            // either open: the fallback is `{transport:"none"}`, which works.
            config.timeoutIntervalForRequest = 10
            config.waitsForConnectivity = false
            self.session = URLSession(configuration: config)
        }
    }

    /// Convenience over `ForwarderConfig.url`; nil when this build has no forwarder.
    public static func live() -> ForwarderClient? {
        guard let url = ForwarderConfig.url else { return nil }
        return ForwarderClient(url: url)
    }

    private struct RegisterBody: Encodable {
        var apnsToken: String
        var environment: String
    }

    private struct RegisterResult: Decodable {
        var wakeToken: String
    }

    /// Mint or REPLACE the wake token for this APNs device token (`PROTOCOL.md` §3.1).
    ///
    /// Replacement is the mechanism, not a side effect: re-registering the same device
    /// kills the previous wake token in the same transaction, which is what makes a
    /// leaked token stop working the moment the phone notices. So this is also the
    /// right call to make when Apple rotates the device token.
    public func register(apnsToken: String, environment: String) async throws -> String {
        let result: RegisterResult = try await post(
            "/v1/register",
            body: RegisterBody(apnsToken: apnsToken, environment: environment),
            bearer: nil
        )
        guard !result.wakeToken.isEmpty else { throw ForwarderError.malformedResponse }
        return result.wakeToken
    }

    private struct StatusResult: Decodable {
        var status: String
    }

    /// Retire a wake token (`PROTOCOL.md` §3.3). Fire-and-forget by contract: an
    /// unknown or already-revoked token answers 200 exactly like a live one, so there
    /// is nothing here for a caller to branch on and nothing worth retrying.
    public func revoke(wakeToken: String) async {
        struct Empty: Encodable {}
        let _: StatusResult? = try? await post("/v1/revoke", body: Empty(), bearer: wakeToken)
    }

    private func post<T: Decodable, B: Encodable>(
        _ path: String, body: B, bearer: String?
    ) async throws -> T {
        guard let url = URL(string: baseUrl + path) else { throw ForwarderError.badURL }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json; charset=utf-8", forHTTPHeaderField: "Content-Type")
        // The wake token rides a HEADER, never a path and never a query string
        // (`PROTOCOL.md` §6, ADR-0009 §3 for the same instinct): URLs are logged by
        // proxies and kept in histories, and this one is a credential.
        if let bearer {
            req.setValue("\(Wire.authScheme) \(bearer)", forHTTPHeaderField: "Authorization")
        }
        req.httpBody = try Wire.encoder.encode(body)

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: req)
        } catch {
            throw ForwarderError.offline(error)
        }
        guard let http = response as? HTTPURLResponse else {
            throw ForwarderError.malformedResponse
        }
        guard (200..<300).contains(http.statusCode) else {
            let parsed = try? Wire.decoder.decode(ApiErrorBody.self, from: data)
            throw ForwarderError.api(
                status: http.statusCode,
                message: parsed?.error.message ?? "The wake-up service refused that request."
            )
        }
        guard let decoded = try? Wire.decoder.decode(T.self, from: data) else {
            throw ForwarderError.malformedResponse
        }
        return decoded
    }
}

public extension Data {
    /// The APNs device token as APNs providers expect it: lowercase hex, no separators.
    ///
    /// Apple hands this over as raw `Data`, and every description-based shortcut for
    /// turning it into a string has broken at some point (iOS 13 changed `Data`'s
    /// `description` out from under apps that were scraping angle brackets off it).
    var apnsHexString: String {
        map { String(format: "%02x", $0) }.joined()
    }
}
