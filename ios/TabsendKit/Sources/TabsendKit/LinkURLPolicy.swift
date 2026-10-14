import Foundation

/// The links Tabsend is willing to hand to the operating system for opening.
///
/// Received payloads are untrusted even after decryption: another paired device,
/// or a relay that can inject directory keys, may supply them. Requiring a web
/// scheme and host prevents dangerous schemes such as `javascript:`, `data:`,
/// `file:`, and application deep links from crossing the OS-open boundary.
public enum LinkURLPolicy {
    private static let allowedSchemes: Set<String> = ["http", "https"]

    public static func openableURL(from value: String) -> URL? {
        guard
            let components = URLComponents(string: value),
            let scheme = components.scheme?.lowercased(),
            allowedSchemes.contains(scheme),
            let host = components.host,
            !host.isEmpty,
            let url = components.url
        else {
            return nil
        }

        return url
    }
}
