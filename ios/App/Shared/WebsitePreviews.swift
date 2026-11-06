import Foundation
import UIKit
import ImageIO
import TabsendKit
import Darwin

// Reading websites for pictures, compiled into both the app (to show them) and the
// share extension (to pass the address along). Requests go straight to the site, never
// through the relay, with no cookies, no credentials and no redirects
// (docs/HISTORY_PREVIEWS_PLAN.md).

struct WebsitePreview: @unchecked Sendable {
    var title: String?
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

private enum PreviewRequests {
    static func session() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.httpShouldSetCookies = false
        config.httpCookieStorage = nil
        config.urlCredentialStorage = nil
        config.urlCache = nil
        config.timeoutIntervalForResource = 8
        return URLSession(configuration: config, delegate: PreviewRedirectPolicy(), delegateQueue: nil)
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

    static func fetch(_ url: URL, session: URLSession, image: Bool) async throws -> Data {
        guard LinkPreviewMetadata.eligible(url), let host = url.host,
              await resolvesPublicly(host) else { throw URLError(.unsupportedURL) }
        try Task.checkCancellation()
        var request = URLRequest(url: url)
        request.timeoutInterval = 8
        request.setValue(image ? "image/*" : "text/html", forHTTPHeaderField: "Accept") // l10n-ignore: HTTP header
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
}

/// The address of a page's picture, for a sender to seal into the tab.
enum PictureLookup {
    /// What a send may wait for it. Past this the tab goes without a picture.
    static let budget: TimeInterval = 1.5

    /// Never throws and never outlasts `budget`: a slow, broken or missing page is
    /// simply nil, and a send carries on as if it had asked for nothing.
    static func address(forPage raw: String, within budget: TimeInterval = budget) async -> String? {
        guard let page = URL(string: raw), LinkPreviewMetadata.mayRequestPage(page) else { return nil }
        return await withCheckedContinuation { continuation in
            // Not a task group: a group waits for every child, and a DNS lookup cannot
            // be cancelled, so it could hold the send past the budget.
            let answer = FirstAnswer(continuation)
            let fetch = Task.detached(priority: .userInitiated) {
                let session = PreviewRequests.session()
                defer { session.invalidateAndCancel() }
                let html = try? await PreviewRequests.fetch(page, session: session, image: false)
                answer.give(html.flatMap {
                    LinkPreviewMetadata.pictureAddress(
                        in: LinkPreviewMetadata.parse(String(decoding: $0, as: UTF8.self)), page: page
                    )
                })
            }
            Task.detached {
                try? await Task.sleep(nanoseconds: UInt64(budget * 1_000_000_000))
                answer.give(nil)
                fetch.cancel()
            }
        }
    }

    private final class FirstAnswer: @unchecked Sendable {
        private let lock = NSLock()
        private var continuation: CheckedContinuation<String?, Never>?

        init(_ continuation: CheckedContinuation<String?, Never>) {
            self.continuation = continuation
        }

        func give(_ answer: String?) {
            lock.lock()
            let waiting = continuation
            continuation = nil
            lock.unlock()
            waiting?.resume(returning: answer)
        }
    }
}

/// Pictures to show, at most three requests at a time, kept in memory only.
actor WebsitePreviewLoader {
    static let shared = WebsitePreviewLoader()

    private var cache: [URL: WebsitePreview] = [:]
    private var active = 0
    private var waiting: [CheckedContinuation<Void, Never>] = []

    private func remember(_ value: WebsitePreview, for url: URL) {
        if cache.count >= 48 { cache.removeAll(keepingCapacity: true) }
        cache[url] = value
    }

    private func acquire() async {
        if active < 3 {
            active += 1
            return
        }
        await withCheckedContinuation { waiting.append($0) }
    }

    private func release() {
        if waiting.isEmpty {
            active -= 1
        } else {
            waiting.removeFirst().resume()
        }
    }

    /// `knownImage` is the sender's address. With it, and a title already in hand, the
    /// page itself is never asked for: only the picture.
    func load(page: URL, knownImage: URL?, hasTitle: Bool) async -> WebsitePreview? {
        if let value = cache[page] { return value }
        guard LinkPreviewMetadata.eligible(page) else { return nil }
        await acquire()
        defer { release() }
        guard !Task.isCancelled else { return nil }
        if let value = cache[page] { return value }
        do {
            let value = try await Self.fetch(page: page, knownImage: knownImage, hasTitle: hasTitle)
            try Task.checkCancellation()
            remember(value, for: page)
            return value
        } catch {
            if !Task.isCancelled { remember(WebsitePreview(), for: page) }
            return nil
        }
    }

    /// A picture of more pixels than this is not decoded. The byte cap says nothing about pixels:
    /// a 1.5 MB interlaced PNG made ImageIO ask for 1.6 GB, enough for iOS to end the app, again on
    /// every launch while the row is on Home (security review v0.11.0, HP2). The size is read from
    /// the picture's header, which decodes nothing.
    private static let maxPixels = 16_000_000

    private static func withinPixelLimit(_ source: CGImageSource) -> Bool {
        guard let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Int,
              let height = properties[kCGImagePropertyPixelHeight] as? Int,
              width > 0, height > 0
        else { return false }
        return width <= maxPixels && height <= maxPixels && width * height <= maxPixels
    }

    private static func fetch(page: URL, knownImage: URL?, hasTitle: Bool) async throws -> WebsitePreview {
        let session = PreviewRequests.session()
        defer { session.invalidateAndCancel() }
        var value = WebsitePreview()
        var imageURL = knownImage
        if (knownImage == nil || !hasTitle), LinkPreviewMetadata.mayRequestPage(page) {
            let html = try await PreviewRequests.fetch(page, session: session, image: false)
            let meta = LinkPreviewMetadata.parse(String(decoding: html, as: UTF8.self))
            value.title = meta["og:title"]
            if imageURL == nil {
                imageURL = LinkPreviewMetadata.pictureAddress(in: meta, page: page).flatMap(URL.init(string:))
            }
        }
        if let imageURL,
           let data = try? await PreviewRequests.fetch(imageURL, session: session, image: true),
           let source = CGImageSourceCreateWithData(data as CFData, nil),
           withinPixelLimit(source),
           let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceThumbnailMaxPixelSize: 512,
                kCGImageSourceCreateThumbnailWithTransform: true,
           ] as CFDictionary) {
            value.image = UIImage(cgImage: thumbnail)
        }
        return value
    }
}
