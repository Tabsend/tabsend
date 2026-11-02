import Foundation

/// Website preview policy and data-only OG parsing. Parsing never loads resources
/// or executes page scripts; the viewing app owns its bounded network requests.
public enum LinkPreviewMetadata {
    public static func eligible(_ url: URL) -> Bool {
        guard url.scheme?.lowercased() == "https", url.user == nil, url.password == nil,
              (url.port == nil || url.port == 443), let host = url.host?.lowercased(), host.contains("."),
              !host.contains(":"), host.rangeOfCharacter(from: .letters) != nil
        else { return false }
        return !["local", "localhost", "internal", "test", "invalid"].contains(host.components(separatedBy: ".").last ?? "")
    }

    public static func parse(_ html: String) -> [String: String] {
        guard let tags = try? NSRegularExpression(pattern: "<meta\\b[^>]*>", options: .caseInsensitive),
              let attributes = try? NSRegularExpression(pattern: #"([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))"#)
        else { return [:] }
        let source = html as NSString
        var result: [String: String] = [:]
        for tag in tags.matches(in: html, range: NSRange(location: 0, length: source.length)) {
            let text = source.substring(with: tag.range) as NSString
            var attrs: [String: String] = [:]
            for match in attributes.matches(in: text as String, range: NSRange(location: 0, length: text.length)) {
                let key = text.substring(with: match.range(at: 1)).lowercased()
                for index in 2...4 where match.range(at: index).location != NSNotFound {
                    attrs[key] = text.substring(with: match.range(at: index))
                }
            }
            if let key = attrs["property"] ?? attrs["name"], let value = attrs["content"] {
                result[key.lowercased()] = String(value.prefix(500))
                    .replacingOccurrences(of: "&amp;", with: "&")
                    .replacingOccurrences(of: "&quot;", with: "\"")
                    .replacingOccurrences(of: "&#39;", with: "'")
                    .replacingOccurrences(of: "&lt;", with: "<")
                    .replacingOccurrences(of: "&gt;", with: ">")
            }
        }
        return result
    }
}
