import Foundation

/// Complete pairing-link parsing, mirroring android/.../logic/Pairing.kt plus
/// the `fp` (certificate fingerprint) fragment parameter (ADR-0019).
///
/// Canonical link: `${relayUrl}/pair#c=CODE` or `${relayUrl}/pair#c=CODE&fp=FINGERPRINT`.
/// The complete link is the only user-facing pairing credential. Its secret rides
/// in the fragment so it never reaches a server access log.
/// Unknown fragment params must be ignored (forward compatibility).
public enum Pairing {
    public struct Parsed: Equatable, Sendable {
        public var code: String
        public var relayUrl: String
        public var certFingerprint: String?
    }

    public static func parse(_ input: String) -> Parsed? {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        guard let url = URLComponents(string: trimmed),
              let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https",
              let host = url.host, !host.isEmpty,
              let fragment = url.percentEncodedFragment
        else { return nil }

        var fragmentComponents = URLComponents()
        fragmentComponents.percentEncodedQuery = fragment
        let params = fragmentComponents.queryItems ?? []
        guard let rawCode = params.first(where: { $0.name == "c" })?.value?
            .trimmingCharacters(in: .whitespacesAndNewlines),
              !rawCode.isEmpty
        else { return nil }

        var path = url.path
        while path.hasSuffix("/") { path.removeLast() }
        if path.hasSuffix("/pair") { path.removeLast("/pair".count) }
        while path.hasSuffix("/") { path.removeLast() }

        let fingerprint = params.first(where: { $0.name == "fp" })?.value?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        var linkRelayUrl = "\(scheme)://\(host)"
        if let port = url.port { linkRelayUrl += ":\(port)" }
        linkRelayUrl += path
        let relayUrl = routeHint(params, named: "native")
            ?? legacyNativeRoute(linkRelayUrl, fingerprint: fingerprint)
        return Parsed(
            code: rawCode.uppercased(),
            relayUrl: relayUrl,
            certFingerprint: fingerprint?.isEmpty == false ? fingerprint : nil
        )
    }

    /// Canonical link for restoring a parsed QR/deep link into the join field.
    public static func link(relayUrl: String, code: String, certFingerprint: String?) -> String {
        var url = relayUrl
        while url.hasSuffix("/") { url = String(url.dropLast()) }
        var link = "\(url)/pair#c=\(code)"
        if let fp = certFingerprint, !fp.isEmpty {
            link += "&fp=\(fp)"
        }
        return link
    }

    /// Normalise a user-typed relay URL: trim whitespace and trailing slashes.
    ///
    /// The one normaliser for every base URL this app holds, the forwarder's included
    /// (`Forwarder.swift`). It used to be copied there, and a copy is a place for the
    /// two to drift apart while both look right.
    public static func normalizeRelayUrl(_ input: String) -> String {
        var url = input.trimmingCharacters(in: .whitespacesAndNewlines)
        while url.hasSuffix("/") { url = String(url.dropLast()) }
        return url
    }

    private static func routeHint(_ params: [URLQueryItem], named name: String) -> String? {
        guard let raw = params.first(where: { $0.name == name })?.value?
            .trimmingCharacters(in: .whitespacesAndNewlines),
              !raw.isEmpty,
              var components = URLComponents(string: raw),
              let scheme = components.scheme?.lowercased(),
              scheme == "http" || scheme == "https",
              components.host?.isEmpty == false,
              components.user == nil,
              components.password == nil,
              components.query == nil,
              components.fragment == nil
        else { return nil }
        while components.path.hasSuffix("/") { components.path.removeLast() }
        return components.string
    }

    private static func legacyNativeRoute(_ relayUrl: String, fingerprint: String?) -> String {
        guard fingerprint?.isEmpty == false,
              var components = URLComponents(string: relayUrl),
              components.scheme?.lowercased() == "http",
              components.port == 8786
        else { return relayUrl }
        components.scheme = "https"
        components.port = 8787
        return components.string ?? relayUrl
    }
}
