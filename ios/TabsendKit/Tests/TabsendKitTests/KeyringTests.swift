import Testing
import Foundation
@testable import TabsendKit

/// The group history keyring [ADR-0028]. Mirrors `extension/src/lib/keyring.test.ts`
/// case for case: four clients converge on the same current key without talking to
/// each other, so a disagreement here would split a group's history in two.
private func record(_ keyId: String, _ createdAt: String, key: String = "AAAA") -> GroupKeyRecord {
    GroupKeyRecord(key: key, keyId: keyId, createdAt: createdAt)
}

private func endpoint(_ id: String, pubkey: String = "pk-\(UUID().uuidString)") -> Endpoint {
    Endpoint(
        id: id, groupId: "g", kind: "mobile", browser: nil, platform: "ios",
        label: "Device \(id)", deviceName: nil, e2ePubkey: pubkey,
        presence: "online", lastSeenAt: "2026-08-05T10:00:00.000Z",
        createdAt: "2026-08-05T10:00:00.000Z"
    )
}

struct KeyringOrderTests {
    @Test func newestCreatedAtWins() {
        let ring = [
            record("a", "2026-08-01T00:00:00.000Z"),
            record("b", "2026-08-03T00:00:00.000Z"),
            record("c", "2026-08-02T00:00:00.000Z"),
        ]
        #expect(Keyring.sorted(ring).map(\.keyId) == ["b", "c", "a"])
        #expect(Keyring.current(ring)?.keyId == "b")
    }

    @Test func keyIdBreaksATieDeterministically() {
        // Two devices minting in the same millisecond is the upgrade race the
        // ring exists to survive. Both keys stay; every device picks the same one.
        let ring = [record("aaa", "2026-08-01T00:00:00.000Z"), record("zzz", "2026-08-01T00:00:00.000Z")]
        #expect(Keyring.current(ring)?.keyId == "zzz")
        #expect(Keyring.current(ring.reversed())?.keyId == "zzz")
    }

    @Test func emptyRingHasNoCurrentKey() {
        #expect(Keyring.current([]) == nil)
    }

    @Test func lookupByIdFindsAnOlderKey() {
        let ring = [record("old", "2026-08-01T00:00:00.000Z"), record("new", "2026-08-09T00:00:00.000Z")]
        #expect(Keyring.key(ring, id: "old")?.keyId == "old")
        #expect(Keyring.key(ring, id: "absent") == nil)
    }
}

struct KeyringMergeTests {
    @Test func mergeKeepsOldKeysSoOldHistoryStaysReadable() {
        let ring = [record("old", "2026-08-01T00:00:00.000Z")]
        let merged = Keyring.merge(ring, [record("new", "2026-08-05T00:00:00.000Z")])
        #expect(merged.map(\.keyId) == ["new", "old"])
    }

    @Test func mergeDedupesByKeyIdAndKeepsWhatWeAlreadyHeld() {
        let held = record("k", "2026-08-01T00:00:00.000Z", key: "held")
        let merged = Keyring.merge([held], [record("k", "2026-08-09T00:00:00.000Z", key: "incoming")])
        #expect(merged.count == 1)
        #expect(merged[0].key == "held")
    }

    @Test func mergeIsIdempotent() {
        let ring = [record("a", "2026-08-01T00:00:00.000Z"), record("b", "2026-08-02T00:00:00.000Z")]
        #expect(Keyring.merge(ring, ring) == Keyring.sorted(ring))
    }
}

struct KeyringElectionTests {
    @Test func lowestEndpointIdMintsTheFirstKey() {
        let endpoints = [endpoint("c"), endpoint("a"), endpoint("b")]
        #expect(Keyring.shouldMintFirstKey(ring: [], endpoints: endpoints, selfEndpointId: "a"))
        #expect(!Keyring.shouldMintFirstKey(ring: [], endpoints: endpoints, selfEndpointId: "b"))
    }

    @Test func nobodyMintsOnceTheGroupHasAKey() {
        let ring = [record("k", "2026-08-01T00:00:00.000Z")]
        #expect(!Keyring.shouldMintFirstKey(ring: ring, endpoints: [endpoint("a")], selfEndpointId: "a"))
    }

    @Test func aDeviceMissingFromTheListNeverMints() {
        // A stale endpoint list, or a device that has just been removed: minting
        // from outside the group would hand a key to nobody.
        #expect(!Keyring.shouldMintFirstKey(ring: [], endpoints: [endpoint("b")], selfEndpointId: "a"))
    }

    @Test func theOnlyDeviceMintsForItself() {
        #expect(Keyring.shouldMintFirstKey(ring: [], endpoints: [endpoint("a")], selfEndpointId: "a"))
    }

    @Test func aConsoleWithTheLowestIdDoesNotWinTheElection() {
        // A console never mints, so letting it win would leave the group keyless.
        var console = endpoint("a")
        console.kind = "console"
        let endpoints = [console, endpoint("b"), endpoint("c")]
        #expect(Keyring.shouldMintFirstKey(ring: [], endpoints: endpoints, selfEndpointId: "b"))
        #expect(!Keyring.shouldMintFirstKey(ring: [], endpoints: endpoints, selfEndpointId: "c"))
    }
}

struct KeyringDeliveryTests {
    @Test func everyOtherMemberNeedsTheCurrentKey() {
        let ring = [record("k", "2026-08-01T00:00:00.000Z")]
        let endpoints = [endpoint("a", pubkey: "pa"), endpoint("b", pubkey: "pb"), endpoint("c", pubkey: "pc")]
        let pending = Keyring.pendingDeliveries(
            ring: ring, endpoints: endpoints, selfEndpointId: "a", delivered: []
        )
        #expect(pending.map(\.targetEndpointId) == ["b", "c"])
        #expect(pending.map(\.targetPubkey) == ["pb", "pc"])
        #expect(pending[0].id == "gk-k-b")
    }

    @Test func aKeyIsNeverHandedToADeviceItNamesAsGone() {
        var named = record("k2", "2026-08-02T00:00:00.000Z")
        named.departed = ["c"]
        let endpoints = [endpoint("a", pubkey: "pa"), endpoint("b", pubkey: "pb"), endpoint("c", pubkey: "pc")]
        let pending = Keyring.pendingDeliveries(
            ring: [named], endpoints: endpoints, selfEndpointId: "a", delivered: []
        )
        #expect(pending.map(\.targetEndpointId) == ["b"])
    }

    @Test func consolesAreIncluded() {
        // A console reads history like anything else. It is excluded from
        // CHOOSERS, not from the group.
        let ring = [record("k", "2026-08-01T00:00:00.000Z")]
        var console = endpoint("b")
        console.kind = "console"
        let pending = Keyring.pendingDeliveries(
            ring: ring, endpoints: [endpoint("a"), console], selfEndpointId: "a", delivered: []
        )
        #expect(pending.map(\.targetEndpointId) == ["b"])
    }

    @Test func alreadyDeliveredCopiesAreNotResent() {
        let ring = [record("k", "2026-08-01T00:00:00.000Z")]
        let pending = Keyring.pendingDeliveries(
            ring: ring, endpoints: [endpoint("a"), endpoint("b")],
            selfEndpointId: "a", delivered: ["gk-k-b"]
        )
        #expect(pending.isEmpty)
    }

    @Test func aNewKeyIsDeliveredEvenToDevicesThatHadTheOldOne() {
        let ring = [
            record("old", "2026-08-01T00:00:00.000Z"),
            record("new", "2026-08-05T00:00:00.000Z"),
        ]
        let pending = Keyring.pendingDeliveries(
            ring: ring, endpoints: [endpoint("a"), endpoint("b")],
            selfEndpointId: "a", delivered: ["gk-old-b"]
        )
        #expect(pending.map(\.id) == ["gk-new-b"])
    }

    @Test func nothingToDeliverWithoutAKey() {
        #expect(
            Keyring.pendingDeliveries(
                ring: [], endpoints: [endpoint("a"), endpoint("b")],
                selfEndpointId: "a", delivered: []
            ).isEmpty
        )
    }
}

struct KeyringGenerationTests {
    @Test func aMintedKeyIs32BytesAndFingerprintsItself() {
        let key = Keyring.generate()
        #expect(Base64X.decode(key.key)?.count == 32)
        #expect(key.keyId == Base64X.groupKeyId(ofKeyBase64: key.key))
    }

    @Test func twoMintedKeysDiffer() {
        #expect(Keyring.generate().key != Keyring.generate().key)
    }

    @Test func aRotatedKeyIsDatedNowWhenTheClockIsAhead() {
        let now = WireDate.date(from: "2026-10-13T12:00:00.000Z")!
        let ring = [record("old", "2026-10-01T00:00:00.000Z")]
        let rotated = Keyring.rotated(ring: ring, now: now)
        #expect(rotated.createdAt == "2026-10-13T12:00:00.000Z")
        #expect(Keyring.current(Keyring.merge(ring, [rotated]))?.keyId == rotated.keyId)
    }

    @Test func aRotatedKeyGoesOneMillisecondPastTheNewestWhenTheClockIsBehind() {
        // A key dated earlier than the one it replaces would leave the old one
        // current and silently un-rotate the group.
        let now = WireDate.date(from: "2026-10-13T12:00:00.000Z")!
        let ring = [record("ahead", "2026-10-13T12:30:00.999Z")]
        let rotated = Keyring.rotated(ring: ring, now: now)
        #expect(rotated.createdAt == "2026-10-13T12:30:01.000Z")
        #expect(Keyring.current(Keyring.merge(ring, [rotated]))?.keyId == rotated.keyId)
    }

    @Test func theFirstKeyIsDatedNow() {
        let now = WireDate.date(from: "2026-10-13T12:00:00.000Z")!
        #expect(Keyring.rotated(ring: [], now: now).createdAt == "2026-10-13T12:00:00.000Z")
    }
}

/// Which `createdAt` values a received key copy may carry. Runs every case in
/// `shared/vectors/group-key-records.json`, the same file the extension and Android
/// run, read from the repo for the reason `NewDevicesTests` gives.
private struct KeyRecordVectors: Decodable {
    struct Case: Decodable {
        var value: String
        var accept: Bool
        var why: String
    }
    struct VouchedCase: Decodable {
        var departed: [String]?
        var sender: String
        var expect: [String]?
        var why: String
    }
    var nowMs: Int64
    var nowIso: String
    var createdAt: [Case]
    var vouched: [VouchedCase]
}

/// The `departed` cases carry arbitrary JSON as their value, so they are read as plain
/// JSON and each value is decoded the way a record's field is: a value that is not a
/// list of strings fails to decode, and a record that fails to decode is refused.
private func loadDepartedCases() throws -> [(value: Any, accept: Bool, why: String)] {
    var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
    let relative = "shared/vectors/group-key-records.json"
    while dir.path != "/" {
        let candidate = dir.appendingPathComponent(relative)
        if FileManager.default.fileExists(atPath: candidate.path) {
            let root = try JSONSerialization.jsonObject(with: Data(contentsOf: candidate)) as? [String: Any]
            let cases = root?["departed"] as? [[String: Any]] ?? []
            return cases.map { ($0["value"] ?? NSNull(), $0["accept"] as? Bool ?? false, $0["why"] as? String ?? "") }
        }
        dir = dir.deletingLastPathComponent()
    }
    throw CocoaError(.fileNoSuchFile, userInfo: [NSFilePathErrorKey: relative])
}

private struct DepartedHolder: Decodable {
    var departed: [String]?
}

private func loadKeyRecordVectors() throws -> KeyRecordVectors {
    var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
    let relative = "shared/vectors/group-key-records.json"
    while dir.path != "/" {
        let candidate = dir.appendingPathComponent(relative)
        if FileManager.default.fileExists(atPath: candidate.path) {
            return try JSONDecoder().decode(KeyRecordVectors.self, from: Data(contentsOf: candidate))
        }
        dir = dir.deletingLastPathComponent()
    }
    throw CocoaError(.fileNoSuchFile, userInfo: [NSFilePathErrorKey: relative])
}

struct KeyRecordAcceptanceTests {
    @Test func theVectorClockAgreesWithItself() throws {
        let vectors = try loadKeyRecordVectors()
        #expect(KeyCreatedAt.string(millis: vectors.nowMs) == vectors.nowIso)
        #expect(KeyCreatedAt.millis(vectors.nowIso) == vectors.nowMs)
    }

    @Test func everyCreatedAtCase() throws {
        let vectors = try loadKeyRecordVectors()
        #expect(!vectors.createdAt.isEmpty)
        for c in vectors.createdAt {
            #expect(
                KeyCreatedAt.isAcceptable(c.value, nowMs: vectors.nowMs) == c.accept,
                "\(c.value): \(c.why)"
            )
        }
    }

    @Test func everyDepartedCase() throws {
        let cases = try loadDepartedCases()
        #expect(!cases.isEmpty)
        for c in cases {
            let data = try JSONSerialization.data(withJSONObject: ["departed": c.value])
            let accepted: Bool
            if let holder = try? JSONDecoder().decode(DepartedHolder.self, from: data) {
                accepted = Keyring.isAcceptableDeparted(holder.departed)
            } else {
                accepted = false
            }
            #expect(accepted == c.accept, "\(c.value): \(c.why)")
        }
        // An absent field is the same as null.
        #expect(Keyring.isAcceptableDeparted(nil))
    }

    @Test func everyVouchedCase() throws {
        let vectors = try loadKeyRecordVectors()
        #expect(!vectors.vouched.isEmpty)
        for c in vectors.vouched {
            #expect(Keyring.vouchedDeparted(c.departed, sender: c.sender) == c.expect, "\(c.why)")
        }
    }

    @Test func aRotationNamesTheDevicesItReplacesAndAFirstKeyNamesNobody() {
        let now = Date(timeIntervalSince1970: 1_791_892_800)
        #expect(Keyring.rotated(ring: [], now: now, departed: ["a", "b"]).departed == ["a", "b"])
        #expect(Keyring.rotated(ring: [], now: now).departed == nil)
    }

    @Test func aRecordWithARepeatedOrOversizedDepartedListIsRefused() {
        let now = Date(timeIntervalSince1970: 1_791_892_800)
        var record = Keyring.generate(now: now)
        let nowMs = Int64(1_791_892_800_000)
        record.departed = ["a", "b"]
        #expect(Keyring.isAcceptable(record, nowMs: nowMs))
        record.departed = ["a", "a"]
        #expect(!Keyring.isAcceptable(record, nowMs: nowMs))
        record.departed = (1...33).map { "id-\($0)" }
        #expect(!Keyring.isAcceptable(record, nowMs: nowMs))
    }

    @Test func millisAndStringAreInverses() {
        for text in ["1970-01-01T00:00:00.000Z", "2000-02-29T23:59:59.999Z",
                     "2026-10-13T12:00:00.001Z", "0000-01-01T00:00:00.000Z",
                     "1969-12-31T23:59:59.999Z", "9999-12-31T23:59:59.999Z"] {
            #expect(KeyCreatedAt.millis(text).map(KeyCreatedAt.string(millis:)) == text, "\(text)")
        }
        #expect(KeyCreatedAt.millis("1970-01-01T00:00:00.000Z") == 0)
    }

    @Test func aRecordMustBe32BytesAndFingerprintItself() throws {
        let vectors = try loadKeyRecordVectors()
        let good = Keyring.generate(now: Date(timeIntervalSince1970: 1_791_892_800))
        #expect(Keyring.isAcceptable(good, nowMs: vectors.nowMs))

        var wrongId = good
        wrongId.keyId = "not-its-fingerprint"
        #expect(!Keyring.isAcceptable(wrongId, nowMs: vectors.nowMs))

        let short = Base64X.encode([UInt8](repeating: 7, count: 16))
        let shortRecord = GroupKeyRecord(
            key: short, keyId: Base64X.groupKeyId(ofKeyBase64: short), createdAt: good.createdAt
        )
        #expect(!Keyring.isAcceptable(shortRecord, nowMs: vectors.nowMs))

        var future = good
        future.createdAt = "9999-12-31T23:59:59.999Z"
        #expect(!Keyring.isAcceptable(future, nowMs: vectors.nowMs))
    }
}
