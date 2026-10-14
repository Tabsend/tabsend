import Foundation
import Testing
@testable import TabsendKit

struct ProtectedLocalFileTests {
    @Test func roundTripsAndExcludesTheFileFromBackup() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }

        let file = ProtectedLocalFile(url: directory.appendingPathComponent("inbox.json"))
        #expect(file.write(["https://example.com/private"]))
        let stored: [String]? = file.read([String].self)
        #expect(stored == ["https://example.com/private"])

        let values = try file.url.resourceValues(forKeys: [.isExcludedFromBackupKey])
        #expect(values.isExcludedFromBackup == true)

        file.remove()
        #expect(!FileManager.default.fileExists(atPath: file.url.path))
    }

    @Test func appGroupAtomicInboxUpdatesStayInTheProtectedFile() throws {
        let id = UUID().uuidString
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(id, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }

        let suite = "io.tabsend.tests.\(id)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let file = ProtectedLocalFile(url: directory.appendingPathComponent("inbox.json"))
        let store = AppGroupStore(
            defaults: defaults,
            keychain: Keychain(service: suite, accessGroup: nil),
            inboxFile: file,
            historyFile: nil
        )
        let first = InboxItem(
            id: "first",
            url: "https://example.com/first",
            title: nil,
            sourceLabel: "Firefox",
            sentAt: "2026-08-10T12:00:00.000Z",
            receivedAt: Date(timeIntervalSince1970: 1),
            batch: nil,
            openedAt: nil
        )

        store.inbox = [first]
        store.updateInbox { items in
            items.map { item in
                var updated = item
                updated.openedAt = Date(timeIntervalSince1970: 2)
                return updated
            }
        }

        let stored: [InboxItem] = try #require(file.read([InboxItem].self))
        #expect(stored.first?.openedAt == Date(timeIntervalSince1970: 2))
        #expect(store.inbox == stored)
    }

    @Test func theHistoryCacheLivesInAProtectedFileNotInDefaults() throws {
        // Up to 30 days of the whole group's links: it gets the inbox's
        // protection, and App Group defaults (which travel in a backup) never
        // see it.
        let id = UUID().uuidString
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(id, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }

        let suite = "io.tabsend.tests.\(id)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let file = ProtectedLocalFile(url: directory.appendingPathComponent("group-history.json"))
        let store = AppGroupStore(
            defaults: defaults,
            keychain: Keychain(service: suite, accessGroup: nil),
            inboxFile: nil,
            historyFile: file
        )
        let row = HistoryItem(
            id: "m1", sourceEndpointId: "a", targetEndpointId: "b",
            createdAt: "2026-10-13T12:00:00.000Z",
            payload: SendPayload(url: "https://example.com/private", sentAt: "2026-10-13T12:00:00.000Z")
        )

        store.history = [row]
        let stored: [HistoryItem] = try #require(file.read([HistoryItem].self))
        #expect(stored == [row])
        #expect(store.history == [row])
        let values = try file.url.resourceValues(forKeys: [.isExcludedFromBackupKey])
        #expect(values.isExcludedFromBackup == true)
        #expect(defaults.data(forKey: "history.cache") == nil)
        #expect(!defaults.dictionaryRepresentation().values.contains {
            ($0 as? Data).map { String(decoding: $0, as: UTF8.self).contains("example.com/private") } ?? false
        })

        // A copy left in defaults by an older build is not read back: the cache
        // refills from the relay instead.
        file.remove()
        defaults.set(try Wire.encoder.encode([row]), forKey: "history.cache")
        #expect(store.history.isEmpty)

        store.history = [row]
        store.clear()
        #expect(!FileManager.default.fileExists(atPath: file.url.path))
        #expect(defaults.data(forKey: "history.cache") == nil)
    }
}
