import Foundation

/// The links the account site emails to the sheet inside the app, and what the app does with
/// them (docs/PLANS.md P-19).
///
/// iOS hands the app a link only when the account site names its path in
/// `/.well-known/apple-app-site-association` and the app lists the site in its Associated
/// Domains. Two paths do, and nothing else on the site:
///
/// - `/app-start#t=TOKEN`, emailed after "Set up an account". The app uses the token itself
///   (`AccountSiteClient.redeem`) and is handed the group's first setup link.
/// - `/app-signin#t=TOKEN`, emailed after a sign-in (Manage account, Delete account, "Sign in"
///   on the sheet). The app opens its sheet on the sign-in page with the token, so the page
///   signs in inside the sheet.
///
/// A link for any other host, port or path is not an account link, and neither is one without
/// a token. `tabsend://` is never an account link: any web page can open a custom scheme.
public enum AccountLink: Equatable, Sendable {
    case newAccount(token: String)
    case signIn(token: String)

    /// The account link in `url`, or nil. `site` is the account site's address (a debug build
    /// may point it at a local one); scheme, host and port must all match it.
    public static func parse(_ url: URL, site: String = AccountSetup.defaultSite) -> AccountLink? {
        guard let want = URLComponents(string: site),
              let got = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let wantHost = want.host?.lowercased(),
              got.scheme?.lowercased() == want.scheme?.lowercased(),
              got.host?.lowercased() == wantHost,
              got.port == want.port,
              got.user == nil, got.password == nil
        else { return nil }

        var path = got.path
        while path.hasSuffix("/") { path.removeLast() }

        guard let fragment = got.percentEncodedFragment else { return nil }
        var parameters = URLComponents()
        parameters.percentEncodedQuery = fragment
        guard let token = parameters.queryItems?.first(where: { $0.name == "t" })?.value,
              isPlausible(token: token)
        else { return nil }

        switch path {
        case "/app-start": return .newAccount(token: token)
        case "/app-signin": return .signIn(token: token)
        default: return nil
        }
    }

    /// True when `url` is on the account site itself (same scheme, host and port), whatever its
    /// path. Such an address is never a pairing link, even if its fragment looks like one: the
    /// site's universal links reach the app, and a made-up one must not name a relay of its own.
    public static func isOnSite(_ url: URL, site: String = AccountSetup.defaultSite) -> Bool {
        guard let want = URLComponents(string: site),
              let got = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let wantHost = want.host?.lowercased()
        else { return false }
        return got.scheme?.lowercased() == want.scheme?.lowercased()
            && got.host?.lowercased() == wantHost
            && got.port == want.port
    }

    /// The sign-in page the sheet opens for a `.signIn` link: the same token, in the fragment
    /// as the account site always carries it, so the page signs in inside the sheet.
    public func signInPage(site: String = AccountSetup.defaultSite) -> URL? {
        guard case let .signIn(token) = self else { return nil }
        var base = site
        while base.hasSuffix("/") { base.removeLast() }
        return URL(string: "\(base)/signin?from=app#t=\(token)")
    }

    /// The account site's tokens are long and made of letters, digits, `-` and `_`. Anything
    /// else is not one, and is not sent anywhere.
    static func isPlausible(token: String) -> Bool {
        !token.isEmpty && token.count <= 200 && token.utf8.allSatisfy { byte in
            (byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x5A)
                || (byte >= 0x61 && byte <= 0x7A) || byte == 0x2D || byte == 0x5F
        }
    }
}

/// What the account site hands the app after it used a `/app-start` link.
public struct AccountHandBack: Equatable, Sendable {
    /// This use made the account. False for a person who already had one (a new phone), who
    /// must not be told a trial has started.
    public var created: Bool
    /// The group's first setup link, ready for `Registrar.join`. Nil when the group already
    /// has a device: this phone is added from a device that is paired.
    public var setupLink: String?
    /// When the trial ends. Only for a `created` account.
    public var trialEndsAt: Date?

    public init(created: Bool, setupLink: String?, trialEndsAt: Date?) {
        self.created = created
        self.setupLink = setupLink
        self.trialEndsAt = trialEndsAt
    }
}

public enum AccountSiteError: Error, Equatable, Sendable {
    /// The link is old or was already used (the site answered 410).
    case linkExpired
    /// The site could not be reached.
    case unreachable
    /// The site answered something this app does not understand.
    case unexpected
}

/// The one call the app makes to the account site: use a sign-up link (`POST /api/app/redeem`).
/// No cookie, no sign-in: the token in the emailed link is the credential, single use and good
/// for 15 minutes, exactly as when a web page posts it.
public enum AccountSiteClient {
    public typealias Send = @Sendable (URLRequest) async throws -> (Data, URLResponse)

    public static func redeem(
        token: String,
        site: String = AccountSetup.defaultSite,
        send: Send = { try await URLSession.shared.data(for: $0) }
    ) async throws -> AccountHandBack {
        var base = site
        while base.hasSuffix("/") { base.removeLast() }
        guard AccountLink.isPlausible(token: token),
              let url = URL(string: "\(base)/api/app/redeem")
        else { throw AccountSiteError.unexpected }

        var request = URLRequest(url: url, timeoutInterval: 20)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONEncoder().encode(["token": token])

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await send(request)
        } catch {
            throw AccountSiteError.unreachable
        }
        guard let http = response as? HTTPURLResponse else { throw AccountSiteError.unexpected }
        if http.statusCode == 410 { throw AccountSiteError.linkExpired }
        guard http.statusCode == 200,
              let body = try? JSONDecoder().decode(Body.self, from: data)
        else { throw AccountSiteError.unexpected }
        // A setup link the app cannot read is no setup link; say so now, not at the join.
        if let link = body.setupLink, Pairing.parse(link) == nil { throw AccountSiteError.unexpected }
        return AccountHandBack(
            created: body.created,
            setupLink: body.setupLink,
            trialEndsAt: body.trialEndsAt.flatMap(WireDate.date(from:))
        )
    }

    private struct Body: Decodable {
        var created: Bool
        var setupLink: String?
        var trialEndsAt: String?
    }
}
