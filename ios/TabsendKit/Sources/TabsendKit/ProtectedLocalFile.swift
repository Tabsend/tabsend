import Foundation

/// Local sensitive history that must remain usable after first unlock for
/// background delivery, but must not travel in a device backup.
final class ProtectedLocalFile {
    let url: URL
    private let fileManager: FileManager

    init(url: URL, fileManager: FileManager = .default) {
        self.url = url
        self.fileManager = fileManager
    }

    func read<T: Decodable>(_ type: T.Type) -> T? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? Wire.decoder.decode(T.self, from: data)
    }

    /// Atomic replacement resets file attributes, so protection and backup
    /// exclusion are re-applied after every write. A partially hardened file is
    /// removed and reported as a failure; the caller can retain its old copy.
    @discardableResult
    func write<T: Encodable>(_ value: T) -> Bool {
        do {
            let data = try Wire.encoder.encode(value)
            try data.write(to: url, options: .atomic)

            #if os(iOS)
            try fileManager.setAttributes(
                [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
                ofItemAtPath: url.path
            )
            #endif

            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            var mutableUrl = url
            try mutableUrl.setResourceValues(values)
            return true
        } catch {
            try? fileManager.removeItem(at: url)
            return false
        }
    }

    func remove() {
        try? fileManager.removeItem(at: url)
    }
}
