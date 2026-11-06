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

    /// Whether a phone may request the linked page itself to find its picture or title. Not when
    /// the address carries a query string or a fragment: that is where one-time tokens live
    /// ("confirm your email", sign-in and "view once" links), and the request would use them up
    /// before the person taps (security review v0.11.0, HP3). The picture address a sender passes
    /// along is still fetched; only the page is left alone.
    public static func mayRequestPage(_ url: URL) -> Bool {
        let text = url.absoluteString
        return eligible(url) && !text.contains("?") && !text.contains("#")
    }

    /// The longest picture address a sender passes along or a receiver accepts.
    public static let maxImageAddressLength = 2048

    /// A picture address from a sealed payload, checked like any preview address.
    /// A paired device wrote it, so it is no more trusted than a received link.
    public static func usableImage(_ raw: String?) -> URL? {
        guard let raw, raw.count <= maxImageAddressLength, let url = URL(string: raw), eligible(url)
        else { return nil }
        return url
    }

    /// The page's picture: `og:image`, then `twitter:image`, as an absolute address
    /// that passes `usableImage`. Nil when the page names none that does.
    public static func pictureAddress(in meta: [String: String], page: URL) -> String? {
        for key in ["og:image", "twitter:image"] {
            guard let raw = meta[key]?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty,
                  let address = URL(string: raw, relativeTo: page)?.absoluteString,
                  usableImage(address) != nil
            else { continue }
            return address
        }
        return nil
    }

    /// A page is hostile until shown otherwise: these limits keep the reading of one fast, whatever
    /// it holds (security review v0.11.0, HP1). A meta tag longer than this is skipped, and only
    /// this many `<meta` openings are looked at.
    static let maxMetaTagLength = 4096
    static let maxMetaOpenings = 200

    /// The `<meta ...>` tags of `html`, found by plain search. A pattern like `<meta[^>]*>` runs
    /// to the end of the page from every `<meta` that has no `>`, which is quadratic.
    static func metaTags(in html: String) -> [String] {
        let source = html as NSString
        var tags: [String] = []
        var seen = 0
        var from = 0
        while seen < maxMetaOpenings, from < source.length {
            let open = source.range(
                of: "<meta", options: .caseInsensitive,
                range: NSRange(location: from, length: source.length - from)
            )
            if open.location == NSNotFound { break }
            seen += 1
            from = NSMaxRange(open)
            guard from < source.length else { break }
            // "<metadata" is not a meta tag.
            let next = source.character(at: from)
            if next == 0x5F || Unicode.Scalar(next).map({ CharacterSet.alphanumerics.contains($0) }) == true { continue }
            let window = min(maxMetaTagLength, source.length - from)
            let close = source.range(of: ">", options: [], range: NSRange(location: from, length: window))
            if close.location == NSNotFound { continue }
            tags.append(source.substring(with: NSRange(location: open.location, length: NSMaxRange(close) - open.location)))
            from = NSMaxRange(close)
        }
        return tags
    }

    public static func parse(_ html: String) -> [String: String] {
        // The key may only start where a run of name characters starts: without that, a long run
        // with no `=` is tried from every position in it, which is quadratic.
        guard let attributes = try? NSRegularExpression(pattern: #"(?<![\w:-])([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))"#)
        else { return [:] }
        var result: [String: String] = [:]
        for tagText in metaTags(in: html) {
            let text = tagText as NSString
            var attrs: [String: String] = [:]
            for match in attributes.matches(in: tagText, range: NSRange(location: 0, length: text.length)) {
                let key = text.substring(with: match.range(at: 1)).lowercased()
                for index in 2...4 where match.range(at: index).location != NSNotFound {
                    attrs[key] = text.substring(with: match.range(at: index))
                }
            }
            if let key = (attrs["property"] ?? attrs["name"])?.lowercased(), let value = attrs["content"],
               result[key] == nil {
                // Cutting an address short would only break it, so pictures keep theirs.
                let limit = key.hasSuffix(":image") ? maxImageAddressLength + 1 : 500
                result[key] = String(value.prefix(limit))
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
