import SwiftUI
import ImageIO
import TabsendKit
import Darwin

private struct WebsitePreview {
    var title: String?
    var description: String?
    var image: UIImage?
}

private final class PreviewRedirectPolicy: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

@MainActor
private enum HistoryPreviewLoader {
    static var cache: [URL: WebsitePreview] = [:]
    static var active = 0

    private static func remember(_ value: WebsitePreview, for url: URL) {
        if cache.count >= 48 { cache.removeAll(keepingCapacity: true) }
        cache[url] = value
    }

    private static func resolvesPublicly(_ host: String) async -> Bool {
        await Task.detached(priority: .utility) {
            var result: UnsafeMutablePointer<addrinfo>?
            guard getaddrinfo(host, nil, nil, &result) == 0, let first = result else { return false }
            defer { freeaddrinfo(first) }
            var cursor: UnsafeMutablePointer<addrinfo>? = first
            while let current = cursor {
                let info = current.pointee
                if info.ai_family == AF_INET {
                    let ip = info.ai_addr.withMemoryRebound(to: sockaddr_in.self, capacity: 1) {
                        UInt32(bigEndian: $0.pointee.sin_addr.s_addr)
                    }
                    let a = ip >> 24, b = (ip >> 16) & 255
                    if a == 0 || a == 10 || a == 127 || a >= 224 ||
                        (a == 169 && b == 254) || (a == 172 && (16...31).contains(b)) ||
                        (a == 192 && b == 168) || (a == 100 && (64...127).contains(b)) { return false }
                } else if info.ai_family == AF_INET6 {
                    var address = info.ai_addr.withMemoryRebound(to: sockaddr_in6.self, capacity: 1) { $0.pointee.sin6_addr }
                    let bytes = withUnsafeBytes(of: &address) { Array($0) }
                    if bytes[0] == 0xff || bytes[0] & 0xfe == 0xfc ||
                        (bytes[0] == 0xfe && bytes[1] & 0xc0 == 0x80) ||
                        bytes.prefix(12).allSatisfy({ $0 == 0 }) ||
                        (bytes.prefix(10).allSatisfy({ $0 == 0 }) && bytes[10] == 0xff && bytes[11] == 0xff) { return false }
                } else { return false }
                cursor = info.ai_next
            }
            return true
        }.value
    }

    private static func fetch(_ url: URL, session: URLSession, image: Bool) async throws -> Data {
        guard LinkPreviewMetadata.eligible(url), let host = url.host,
              await resolvesPublicly(host) else { throw URLError(.unsupportedURL) }
        try Task.checkCancellation()
        var request = URLRequest(url: url)
        request.timeoutInterval = 8
        request.setValue(image ? "image/*" : "text/html", forHTTPHeaderField: "Accept")
        let (bytes, response) = try await session.bytes(for: request)
        guard let response = response as? HTTPURLResponse, response.statusCode == 200,
              let type = response.mimeType,
              image ? type.hasPrefix("image/") : type == "text/html"
        else { throw URLError(.badServerResponse) }
        var data = Data()
        for try await byte in bytes {
            try Task.checkCancellation()
            if data.count >= (image ? 2_000_000 : 512_000) {
                if image { throw URLError(.dataLengthExceedsMaximum) }
                break
            }
            data.append(byte)
            if !image, data.count % 8192 == 0,
               String(decoding: data.suffix(16384), as: UTF8.self).lowercased().contains("</head>") { break }
        }
        return data
    }

    static func load(_ url: URL) async -> WebsitePreview? {
        if let value = cache[url] { return value }
        guard LinkPreviewMetadata.eligible(url) else { return nil }
        while active >= 3 {
            do { try await Task.sleep(nanoseconds: 100_000_000) } catch { return nil }
        }
        guard !Task.isCancelled else { return nil }
        if let value = cache[url] { return value }
        active += 1
        defer { active -= 1 }
        let config = URLSessionConfiguration.ephemeral
        config.httpShouldSetCookies = false
        config.httpCookieStorage = nil
        config.urlCredentialStorage = nil
        config.urlCache = nil
        config.timeoutIntervalForResource = 8
        let session = URLSession(configuration: config, delegate: PreviewRedirectPolicy(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        do {
            let html = try await fetch(url, session: session, image: false)
            let meta = LinkPreviewMetadata.parse(String(decoding: html, as: UTF8.self))
            var value = WebsitePreview(title: meta["og:title"], description: meta["og:description"] ?? meta["description"])
            if let raw = meta["og:image"], let imageURL = URL(string: raw, relativeTo: url)?.absoluteURL,
               let data = try? await fetch(imageURL, session: session, image: true),
               let source = CGImageSourceCreateWithData(data as CFData, nil),
               let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                    kCGImageSourceCreateThumbnailFromImageAlways: true,
                    kCGImageSourceThumbnailMaxPixelSize: 384,
                    kCGImageSourceCreateThumbnailWithTransform: true,
               ] as CFDictionary) {
                value.image = UIImage(cgImage: thumbnail)
            }
            try Task.checkCancellation()
            remember(value, for: url)
            return value
        } catch {
            if !Task.isCancelled { remember(WebsitePreview(), for: url) }
            return nil
        }
    }
}

struct HistoryLinkPreview: View {
    let url: URL
    let expanded: Bool
    let fallbackTitle: String
    @State private var preview: WebsitePreview?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(preview?.title.flatMap { $0.isEmpty ? nil : $0 } ?? fallbackTitle)
                .font(expanded ? .title3.weight(.semibold) : .body)
                .foregroundColor(.primary)
                .lineLimit(expanded ? 3 : 2)
            if let description = preview?.description, !description.isEmpty {
                Text(description)
                    .font(.subheadline)
                    .foregroundColor(Palette.muted)
                    .lineLimit(2)
            }
            if let image = preview?.image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
                    .frame(maxWidth: .infinity)
                    .frame(height: expanded ? 128 : 72)
                    .clipped()
                    .cornerRadius(8)
                    .accessibilityHidden(true)
            }
        }
        .task(id: url) { preview = await HistoryPreviewLoader.load(url) }
    }
}
