import Testing
import Foundation
@testable import TabsendKit

/// "Is this phone replacing iPhone?" (PLANS.md P-31 item 2). Runs every case in
/// `shared/vectors/replacing-devices.json`, the same file `shared/src/replacing.test.ts`
/// and Android's `ReplacingTest.kt` run, so the three clients give the same answer (L6).
/// Read from the repo, not copied, so drift is caught.

private struct ReplacingVectors: Decodable {
    struct Entry: Decodable {
        var id: String
        var label: String
        var kind: String
        var presence: String
        var lastSeenAt: String
        var createdAt: String
    }
    struct Case: Decodable {
        var name: String
        var selfId: String
        var removed: [String]
        var now: String
        var list: [Entry]
        var expect: String?
    }
    var cases: [Case]
}

private func loadReplacingVectors() throws -> ReplacingVectors {
    var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
    let relative = "shared/vectors/replacing-devices.json"
    while dir.path != "/" {
        let candidate = dir.appendingPathComponent(relative)
        if FileManager.default.fileExists(atPath: candidate.path) {
            return try JSONDecoder().decode(ReplacingVectors.self, from: Data(contentsOf: candidate))
        }
        dir = dir.deletingLastPathComponent()
    }
    throw CocoaError(.fileNoSuchFile, userInfo: [NSFilePathErrorKey: relative])
}

/// The real `Endpoint`, so the vectors test the type the app passes in.
private func endpoint(_ e: ReplacingVectors.Entry) -> Endpoint {
    Endpoint(
        id: e.id, groupId: "g", kind: e.kind, browser: nil, platform: nil,
        label: e.label, deviceName: nil, e2ePubkey: "pk",
        presence: e.presence, lastSeenAt: e.lastSeenAt, createdAt: e.createdAt
    )
}

private func ep(
    _ id: String, _ label: String, presence: String = "offline",
    seen: String = "2026-10-30T08:00:00.000Z", created: String = "2026-08-01T10:00:00.000Z"
) -> Endpoint {
    Endpoint(
        id: id, groupId: "g", kind: "mobile", browser: nil, platform: nil, label: label,
        deviceName: nil, e2ePubkey: "pk", presence: presence, lastSeenAt: seen, createdAt: created
    )
}

private let now = Replacing.strictIsoMillis("2026-11-09T12:00:00.000Z")!
private let me = ep("me", "iPhone 2", presence: "online", seen: "2026-11-09T11:59:00.000Z", created: "2026-11-09T11:50:00.000Z")
private let old = ep("old", "iPhone")

struct ReplacingVectorTests {
    @Test func everyCase() throws {
        let vectors = try loadReplacingVectors()
        #expect(vectors.cases.count > 30)
        for c in vectors.cases {
            let nowMs = try #require(Replacing.strictIsoMillis(c.now), "\(c.name): now")
            let found = Replacing.findReplacedSelf(
                selfId: c.selfId, list: c.list.map(endpoint), removed: c.removed, nowMs: nowMs
            )
            #expect(found?.id == c.expect, "\(c.name)")
        }
    }

    @Test func lowercasesAsciiOnlyAndCollapsesAsciiSpaces() {
        #expect(Replacing.normalizeName("  Dia\t2 \n") == "dia 2")
        #expect(Replacing.normalizeName("ÄΣ") == "ÄΣ")
        // U+00A0 is not collapsed.
        #expect(Replacing.normalizeName("a\u{00A0} b") == "a\u{00A0} b")
    }

    @Test func stripsOnlyTheRelaysCounter() {
        #expect(Replacing.withoutCounter("dia 2") == "dia")
        #expect(Replacing.withoutCounter("dia 99") == "dia")
        #expect(Replacing.withoutCounter("dia 1") == "dia 1")
        #expect(Replacing.withoutCounter("dia 02") == "dia 02")
        #expect(Replacing.withoutCounter("dia 100") == "dia 100")
        #expect(Replacing.withoutCounter("7") == "7")
        #expect(Replacing.withoutCounter(" 7") == " 7")
    }

    @Test func readsOnlyCanonicalTimes() {
        #expect(Replacing.strictIsoMillis("2026-10-30T08:00:00.000Z") == 1_793_347_200_000)
        #expect(Replacing.strictIsoMillis("2026-10-30T08:00:00Z") == nil)
    }

    @Test func namesTheAppHalf() {
        #expect(Replacing.appNameOf("Dia · MacBook Pro") == "Dia")
        #expect(Replacing.appNameOf("Pixel 8") == "Pixel 8")
        let key = Replacing.replacingKey("Dia 2 · MacBook  Pro")
        #expect(key.app == "dia" && key.computer == "macbook pro")
    }

    /// Swift's `==` would call these equal (canonical equivalence); the rule must not.
    @Test func composedAndDecomposedIdsAreDifferent() {
        let composed = ep("caf\u{00E9}", "iPhone")
        let removedDecomposed = ["cafe\u{0301}"]
        let found = Replacing.findReplacedSelf(
            selfId: "me", list: [me, composed], removed: removedDecomposed, nowMs: now
        )
        #expect(found?.id == "caf\u{00E9}")
    }
}

/// Replace's steps: re-check, remove, then rename; nothing else.
struct ReplaceStepsTests {
    final class Log: @unchecked Sendable {
        var steps: [String] = []
    }

    private func run(
        list: [Endpoint], offered: String = "old", removeWorks: Bool = true, fetchFails: Bool = false,
        removed: [String] = [], log: Log
    ) async -> Replacing.Outcome {
        await Replacing.replace(
            selfId: "me", offeredId: offered,
            fetchList: {
                log.steps.append("list")
                if fetchFails { throw URLError(.notConnectedToInternet) }
                return list
            },
            removed: { removed },
            nowMs: { now },
            remove: { id in log.steps.append("remove \(id)"); return removeWorks },
            rename: { label in log.steps.append("rename \(label)") }
        )
    }

    @Test func removesThenRenamesToTheOldExactLabel() async {
        let log = Log()
        let outcome = await run(list: [me, old], log: log)
        #expect(outcome == .replaced(label: "iPhone"))
        #expect(log.steps == ["list", "remove old", "rename iPhone"])
    }

    @Test func noRenameWhenRemovalFails() async {
        let log = Log()
        let outcome = await run(list: [me, old], removeWorks: false, log: log)
        #expect(outcome == .removeFailed)
        #expect(log.steps == ["list", "remove old"])
    }

    @Test func closesQuietlyWhenTheOldOneCameBack() async {
        let log = Log()
        let back = ep("old", "iPhone", presence: "online", seen: "2026-11-09T11:59:30.000Z")
        let outcome = await run(list: [me, back], log: log)
        #expect(outcome == .noLongerOffered)
        #expect(log.steps == ["list"])
    }

    @Test func closesQuietlyWhenTheMatchNamesAnotherEntry() async {
        let log = Log()
        let newer = ep("other", "iPhone", seen: "2026-11-01T08:00:00.000Z")
        let outcome = await run(list: [me, old, newer], log: log)
        #expect(outcome == .noLongerOffered)
        #expect(log.steps == ["list"])
    }

    @Test func closesQuietlyWhenRemovedHereSinceTheOffer() async {
        let log = Log()
        let outcome = await run(list: [me, old], removed: ["old"], log: log)
        #expect(outcome == .noLongerOffered)
        #expect(log.steps == ["list"])
    }

    @Test func changesNothingWhenTheListCannotBeFetched() async {
        let log = Log()
        let outcome = await run(list: [me, old], fetchFails: true, log: log)
        #expect(outcome == .listFailed)
        #expect(log.steps == ["list"])
    }
}

/// The offer's words. English only here; the catalog holds the German.
struct ReplacingCopyTests {
    @Test func phoneWording() {
        let utc = TimeZone(identifier: "UTC")!
        #expect(ReplacingCopy.title(oldLabel: "iPhone") == "Is this phone replacing iPhone?")
        #expect(
            ReplacingCopy.body(oldLabel: "iPhone", lastSeenAt: "2026-10-30T08:00:00.000Z", timeZone: utc)
                == "“iPhone” hasn't been online since Oct 30. If Tabsend was reinstalled here, replace it so links come to this phone."
        )
        #expect(ReplacingCopy.replaceButton(oldLabel: "iPhone") == "Replace iPhone")
        #expect(ReplacingCopy.keepBoth == "Keep both")
        #expect(
            ReplacingCopy.smallLine(oldLabel: "iPhone")
                == "This phone takes the name iPhone. The old one is removed from your devices."
        )
    }
}

/// P-31 item 2: the Keychain can outlive a deleted app, so a pairing must not inherit
/// the group keys of the old install.
struct LeftoverKeysTests {
    @Test func unregisteredDeviceLosesOldKeys() {
        let store = MemoryStore()
        store.groupKeyring = [GroupKeyRecord(key: "AAAA", keyId: "old", createdAt: "2026-08-01T00:00:00.000Z")]
        Registrar.dropLeftoverKeys(store: store)
        #expect(store.groupKeyring.isEmpty)
    }

    @Test func registeredDeviceKeepsItsKeys() {
        let store = MemoryStore()
        store.registration = Registration(
            endpointId: "e", groupId: "g", deviceToken: "tok",
            relayUrl: "https://relay.example", label: "iPhone"
        )
        let ring = [GroupKeyRecord(key: "AAAA", keyId: "k", createdAt: "2026-08-01T00:00:00.000Z")]
        store.groupKeyring = ring
        Registrar.dropLeftoverKeys(store: store)
        #expect(store.groupKeyring == ring)
    }
}
