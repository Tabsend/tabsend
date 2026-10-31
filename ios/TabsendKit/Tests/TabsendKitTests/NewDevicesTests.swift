import Testing
import Foundation
@testable import TabsendKit

/// The "new device joined" rule (PLANS.md P-10). Runs every case in
/// `shared/vectors/new-devices.json`, the same file `shared/src/newdevices.test.ts`
/// and Android's `NewDevicesTest.kt` run, so the three clients cannot drift apart.
///
/// The file is read from the repo rather than copied into Resources on purpose: a
/// copy would be one more thing to keep in step, and drift is what this test exists
/// to catch.

private struct Vectors: Decodable {
    struct ListEntry: Decodable {
        var id: String
        var label: String
        var createdAt: String
        var e2ePubkey: String?
        var kind: String?
        /// Defaults to `createdAt`, as the vector file says.
        var lastSeenAt: String?
    }
    struct WatchCase: Decodable {
        var name: String
        var selfId: String
        var now: String
        var currentKeyCreatedAt: String?
        var prev: NewDeviceWatch?
        var seed: [ListEntry]?
        var list: [ListEntry]
        var vouched: [String]?
        var watch: NewDeviceWatch?
        var joined: [NewDeviceNotice]
    }
    struct ConfirmCase: Decodable {
        var name: String
        var id: String
        var watch: NewDeviceWatch
        var expect: NewDeviceWatch
    }
    struct ConfirmReviewCase: Decodable {
        var name: String
        var watch: NewDeviceWatch
        var expect: NewDeviceWatch
    }
    struct DismissVanishedCase: Decodable {
        var name: String
        var id: String
        var watch: NewDeviceWatch
        var expect: NewDeviceWatch
    }
    struct RemoveCase: Decodable {
        var name: String
        var watch: NewDeviceWatch
        var id: String
        var now: String
        var currentKeyCreatedAt: String?
        var expect: NewDeviceWatch
    }
    struct RotationDueCase: Decodable {
        var name: String
        var watch: NewDeviceWatch
        var newest: String?
        var newestDeparted: [String]?
        var due: Bool
    }
    struct DepartedCase: Decodable {
        var name: String
        var watch: NewDeviceWatch?
        var expect: [String]
    }
    struct RotationDoneCase: Decodable {
        var name: String
        var owedAt: String
        var watch: NewDeviceWatch
        var expect: NewDeviceWatch
    }
    var watch: [WatchCase]
    var confirm: [ConfirmCase]
    struct KnownToCase: Decodable {
        var name: String
        var watch: NewDeviceWatch?
        var list: [ListEntry]
        var expect: [String]
    }
    struct HeldTabChoicesCase: Decodable {
        var name: String
        var selfId: String
        var watch: NewDeviceWatch?
        var list: [ListEntry]
        var expect: [String]
    }
    var confirmReview: [ConfirmReviewCase]
    var dismissVanished: [DismissVanishedCase]
    var remove: [RemoveCase]
    var rotationDue: [RotationDueCase]
    var rotationDeparted: [DepartedCase]
    var rotationDone: [RotationDoneCase]
    var knownTo: [KnownToCase]
    var heldTabChoices: [HeldTabChoicesCase]
    // The pairing link vouches for the first list (P-23).
    struct VouchTagCase: Decodable {
        var name: String
        var key: String
        var expect: String
    }
    struct VouchTagsCase: Decodable {
        var name: String
        var selfId: String
        var watch: NewDeviceWatch?
        var list: [ListEntry]
        var expect: [String]
    }
    struct WithVouchCase: Decodable {
        var name: String
        var link: String
        var tags: [String]
        var expect: String
    }
    struct ParseVouchCase: Decodable {
        var name: String
        var link: String
        /// Null in the file means "none".
        var expect: [String]?
    }
    var vouchTag: [VouchTagCase]
    var vouchTags: [VouchTagsCase]
    var withVouch: [WithVouchCase]
    var parseVouch: [ParseVouchCase]
    // Told once, as information (P-23).
    struct AnnouncesCase: Decodable {
        var name: String
        var selfId: String
        /// Epoch milliseconds.
        var now: Double
        var prev: NewDeviceWatch?
        var list: [ListEntry]
        var expect: Bool
    }
    struct SettleCase: Decodable {
        var name: String
        var watch: NewDeviceWatch
        var expect: NewDeviceWatch
    }
    var announces: [AnnouncesCase]
    var settle: [SettleCase]
}

private func loadVectors() throws -> Vectors {
    var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
    let relative = "shared/vectors/new-devices.json"
    while dir.path != "/" {
        let candidate = dir.appendingPathComponent(relative)
        if FileManager.default.fileExists(atPath: candidate.path) {
            return try JSONDecoder().decode(Vectors.self, from: Data(contentsOf: candidate))
        }
        dir = dir.deletingLastPathComponent()
    }
    throw CocoaError(.fileNoSuchFile, userInfo: [NSFilePathErrorKey: relative])
}

/// The vectors carry only the fields the rule reads; the rest is filler. The key is
/// "pk", the kind "extension" and `lastSeenAt` the `createdAt` unless the entry names
/// one, as the vector file says.
private func endpoint(_ entry: Vectors.ListEntry) -> Endpoint {
    Endpoint(
        id: entry.id, groupId: "g", kind: entry.kind ?? "extension", browser: nil, platform: nil,
        label: entry.label, deviceName: nil, e2ePubkey: entry.e2ePubkey ?? "pk",
        presence: "online", lastSeenAt: entry.lastSeenAt ?? entry.createdAt, createdAt: entry.createdAt
    )
}

struct NewDevicesVectorTests {
    @Test func everyWatchCase() throws {
        let vectors = try loadVectors()
        #expect(!vectors.watch.isEmpty)
        for c in vectors.watch {
            let result = NewDevices.watch(
                prev: c.prev, list: c.list.map(endpoint), selfId: c.selfId, now: c.now,
                currentKeyCreatedAt: c.currentKeyCreatedAt, seed: c.seed?.map(endpoint),
                vouched: c.vouched
            )
            #expect(result.watch == c.watch, "\(c.name): watch")
            #expect(result.joined == c.joined, "\(c.name): joined")
        }
    }

    @Test func everyConfirmCase() throws {
        let vectors = try loadVectors()
        #expect(!vectors.confirm.isEmpty)
        for c in vectors.confirm {
            #expect(NewDevices.confirm(c.watch, id: c.id) == c.expect, "\(c.name)")
        }
    }

    @Test func everyConfirmReviewCase() throws {
        let vectors = try loadVectors()
        #expect(!vectors.confirmReview.isEmpty)
        for c in vectors.confirmReview {
            #expect(NewDevices.confirmReview(c.watch) == c.expect, "\(c.name)")
        }
    }

    @Test func everyDismissVanishedCase() throws {
        let vectors = try loadVectors()
        #expect(!vectors.dismissVanished.isEmpty)
        for c in vectors.dismissVanished {
            #expect(NewDevices.dismissVanished(c.watch, id: c.id) == c.expect, "\(c.name)")
        }
    }

    @Test func everyRemoveCase() throws {
        let vectors = try loadVectors()
        #expect(!vectors.remove.isEmpty)
        for c in vectors.remove {
            #expect(
                NewDevices.removeDevice(
                    c.watch, id: c.id, now: c.now, currentKeyCreatedAt: c.currentKeyCreatedAt
                ) == c.expect,
                "\(c.name)"
            )
        }
    }

    @Test func everyRotationDueCase() throws {
        let vectors = try loadVectors()
        #expect(!vectors.rotationDue.isEmpty)
        for c in vectors.rotationDue {
            #expect(
                NewDevices.rotationDue(
                    c.watch, newestKeyCreatedAt: c.newest, newestKeyDeparted: c.newestDeparted
                ) == c.due,
                "\(c.name)"
            )
        }
    }

    @Test func everyRotationDepartedCase() throws {
        let vectors = try loadVectors()
        #expect(!vectors.rotationDeparted.isEmpty)
        for c in vectors.rotationDeparted {
            #expect(NewDevices.rotationDeparted(c.watch) == c.expect, "\(c.name)")
        }
    }

    @Test func everyRotationDoneCase() throws {
        let vectors = try loadVectors()
        #expect(!vectors.rotationDone.isEmpty)
        for c in vectors.rotationDone {
            #expect(NewDevices.rotationDone(c.watch, owedAt: c.owedAt) == c.expect, "\(c.name)")
        }
    }

    @Test func everyKnownToCase() throws {
        let vectors = try loadVectors()
        #expect(!vectors.knownTo.isEmpty)
        for c in vectors.knownTo {
            #expect(
                NewDevices.endpointsKnownTo(c.watch, c.list.map(endpoint)).map(\.id) == c.expect,
                "\(c.name)"
            )
        }
    }

    @Test func everyHeldTabChoicesCase() throws {
        let vectors = try loadVectors()
        #expect(!vectors.heldTabChoices.isEmpty)
        for c in vectors.heldTabChoices {
            #expect(
                NewDevices.heldTabChoices(c.watch, c.list.map(endpoint), selfId: c.selfId).map(\.id)
                    == c.expect,
                "\(c.name)"
            )
        }
    }

    @Test func everyVouchTagCase() throws {
        let vectors = try loadVectors()
        #expect(!vectors.vouchTag.isEmpty)
        for c in vectors.vouchTag {
            #expect(NewDevices.vouchTag(c.key) == c.expect, "\(c.name)")
        }
    }

    @Test func everyVouchTagsCase() throws {
        let vectors = try loadVectors()
        #expect(!vectors.vouchTags.isEmpty)
        for c in vectors.vouchTags {
            #expect(
                NewDevices.vouchTags(c.watch, c.list.map(endpoint), selfId: c.selfId) == c.expect,
                "\(c.name)"
            )
        }
    }

    @Test func everyWithVouchCase() throws {
        let vectors = try loadVectors()
        #expect(!vectors.withVouch.isEmpty)
        for c in vectors.withVouch {
            #expect(NewDevices.withVouch(c.link, c.tags) == c.expect, "\(c.name)")
        }
    }

    @Test func everyParseVouchCase() throws {
        let vectors = try loadVectors()
        #expect(!vectors.parseVouch.isEmpty)
        for c in vectors.parseVouch {
            #expect(NewDevices.parseVouch(c.link) == c.expect, "\(c.name)")
        }
    }

    @Test func everyAnnouncesCase() throws {
        let vectors = try loadVectors()
        #expect(!vectors.announces.isEmpty)
        for c in vectors.announces {
            #expect(
                NewDevices.announcesNewDevices(c.prev, c.list.map(endpoint), selfId: c.selfId, now: c.now)
                    == c.expect,
                "\(c.name)"
            )
        }
    }

    @Test func everySettleCase() throws {
        let vectors = try loadVectors()
        #expect(!vectors.settle.isEmpty)
        for c in vectors.settle {
            #expect(NewDevices.settleNotices(c.watch) == c.expect, "\(c.name)")
        }
    }

    @Test func aRecordWithAnUnknownFieldStillDecodes() throws {
        // A record written by a later build must not wipe the baseline here.
        let json = #"{"selfId":"me","known":["me"],"unconfirmed":[],"somethingNew":1}"#
        let watch = try Wire.decoder.decode(NewDeviceWatch.self, from: Data(json.utf8))
        #expect(watch == NewDeviceWatch(selfId: "me", known: ["me"], unconfirmed: []))
    }
}

struct NewDevicesStoreTests {
    private func registered(_ selfId: String) -> MemoryStore {
        let store = MemoryStore()
        store.registration = Registration(
            endpointId: selfId, groupId: "g", deviceToken: "t",
            relayUrl: "https://relay.example", label: "iPhone"
        )
        return store
    }

    private func list(_ ids: [String]) -> [Endpoint] {
        ids.map { endpoint(.init(id: $0, label: "Device \($0)", createdAt: "2026-10-08T14:00:00Z")) }
    }

    @Test func observeBaselinesThenAnnouncesOnce() {
        let store = registered("me")
        #expect(NewDevices.observe(list(["me", "a"]), store: store).joined.isEmpty)
        let told = NewDevices.observe(list(["me", "a", "x"]), store: store)
        #expect(told.joined.map(\.id) == ["x"])
        #expect(told.announcement == NewDevices.Announcement(kind: .joined, devices: told.joined))
        // The same list again announces nothing, and nothing waits for an answer (P-23).
        let again = NewDevices.observe(list(["me", "a", "x"]), store: store)
        #expect(again.joined.isEmpty)
        #expect(again.announcement == nil)
        #expect(NewDevices.current(store: store)?.unconfirmed.isEmpty == true)
    }

    /// P-23: the record is stored settled, and the one notification follows
    /// `announcesNewDevices`, read against the record from before the list.
    @Test func theRecordIsStoredSettledAndOnlyTheDeviceThatTellsAnnounces() {
        let now = WireDate.date(from: "2026-10-30T12:00:00Z")!
        func device(_ id: String, _ kind: String) -> Endpoint {
            endpoint(.init(
                id: id, label: "Device \(id)", createdAt: "2026-10-01T00:00:00Z", kind: kind,
                lastSeenAt: "2026-10-30T11:00:00Z"
            ))
        }

        // A phone always tells, and keeps nothing waiting for an answer.
        let phone = registered("me")
        NewDevices.observe([device("me", "mobile"), device("a", "extension")], store: phone, now: now)
        let told = NewDevices.observe(
            [device("me", "mobile"), device("a", "extension"), device("x", "extension")],
            store: phone, now: now
        )
        #expect(told.announcement?.kind == .joined)
        #expect(told.announcement?.devices.map(\.id) == ["x"])
        #expect(phone.newDeviceWatch?.unconfirmed.isEmpty == true)
        #expect(phone.newDeviceWatch?.review == nil)
        #expect(phone.newDeviceWatch?.known == ["me", "a", "x"])

        // A browser whose group has a phone it accepted and saw lately stays quiet; the
        // record moves on all the same.
        let browser = registered("me")
        let group = [device("me", "extension"), device("p", "mobile")]
        NewDevices.observe(group, store: browser, now: now)
        let quiet = NewDevices.observe(group + [device("x", "extension")], store: browser, now: now)
        #expect(quiet.joined.map(\.id) == ["x"])
        #expect(quiet.announcement == nil)
        #expect(browser.newDeviceWatch?.unconfirmed.isEmpty == true)
        #expect(browser.newDeviceWatch?.known == ["me", "p", "x"])

        // A phone that arrives in the same list as the newcomer silences nobody.
        let lone = registered("me")
        NewDevices.observe([device("me", "extension")], store: lone, now: now)
        let loud = NewDevices.observe(
            [device("me", "extension"), device("p", "mobile"), device("x", "extension")],
            store: lone, now: now
        )
        #expect(loud.announcement?.devices.map(\.id) == ["p", "x"])
    }

    @Test func unregisteredStoreDoesNothing() {
        let store = MemoryStore()
        let observed = NewDevices.observe(list(["me", "x"]), store: store)
        #expect(observed.joined.isEmpty)
        #expect(observed.accepted == nil)
        #expect(store.newDeviceWatch == nil)
        #expect(store.cachedEndpoints.isEmpty)
    }

    @Test func anAcceptedListIsCachedAfterTheRuleRuns() {
        let store = registered("me")
        let observed = NewDevices.observe(list(["me", "a"]), store: store)
        #expect(observed.accepted?.map(\.id) == ["me", "a"])
        #expect(store.cachedEndpoints.map(\.id) == ["me", "a"])
    }

    @Test func aListWithoutThisPhoneIsTreatedAsAFailedFetch() {
        // A relay serving [fake device, the others, not this phone]: the rule
        // ignores it, so it must not be cached or handed to anything either.
        let store = registered("me")
        NewDevices.observe(list(["me", "a"]), store: store)
        let before = store.newDeviceWatch
        let observed = NewDevices.observe(list(["fake", "a"]), store: store)
        #expect(observed.accepted == nil)
        #expect(observed.joined.isEmpty)
        #expect(store.cachedEndpoints.map(\.id) == ["me", "a"], "the cache keeps the last accepted list")
        #expect(store.newDeviceWatch == before)
    }

    @Test func aDepartureRecordsTheKeyThatWasCurrent() {
        let store = registered("me")
        let key = Keyring.generate(now: WireDate.date(from: "2026-10-01T00:00:00.000Z")!)
        store.groupKeyring = [key]
        NewDevices.observe(list(["me", "a", "b"]), store: store)
        NewDevices.observe(list(["me", "a"]), store: store)
        #expect(NewDevices.current(store: store)?.rotateFrom == key.createdAt)
    }

    @Test func aDepartureOwesARotationAndMarkingItDoneKeepsALaterOne() {
        let store = registered("me")
        let t1 = WireDate.date(from: "2026-10-12T08:00:00.000Z")!
        let t2 = WireDate.date(from: "2026-10-13T12:00:00.000Z")!
        NewDevices.observe(list(["me", "a", "b"]), store: store)
        NewDevices.observe(list(["me", "a"]), store: store, now: t1)
        #expect(NewDevices.current(store: store)?.rotateOwedAt == "2026-10-12T08:00:00.000Z")
        // Another device leaves before the rotation for the first one is marked done.
        NewDevices.observe(list(["me"]), store: store, now: t2)
        NewDevices.markRotationDone(owedAt: "2026-10-12T08:00:00.000Z", store: store)
        #expect(NewDevices.current(store: store)?.rotateOwedAt == "2026-10-13T12:00:00.000Z")
        NewDevices.markRotationDone(owedAt: "2026-10-13T12:00:00.000Z", store: store)
        #expect(NewDevices.current(store: store)?.rotateOwedAt == nil)
    }

    @Test func clearForgetsTheRecord() {
        let store = registered("me")
        NewDevices.observe(list(["me"]), store: store)
        #expect(store.newDeviceWatch != nil)
        store.clear()
        #expect(store.newDeviceWatch == nil)
    }
}

struct NewDevicesCopyTests {
    private let now = WireDate.date(from: "2026-10-08T14:05:00Z")!
    private let x = NewDeviceNotice(id: "x", label: "Firefox · Linux", createdAt: "2026-10-08T14:02:00Z")
    private let y = NewDeviceNotice(id: "y", label: "Console", createdAt: "2026-10-08T14:03:00Z")
    private let z = NewDeviceNotice(id: "z", label: "Edge · Windows", createdAt: "2026-10-08T14:04:00Z")

    private func joined(_ devices: [NewDeviceNotice]) -> NewDevices.Announcement {
        NewDevices.Announcement(kind: .joined, devices: devices)
    }

    private func firstList(_ devices: [NewDeviceNotice]) -> NewDevices.Announcement {
        NewDevices.Announcement(kind: .firstList, devices: devices)
    }

    // Information only (P-23): the same words on every client.

    @Test func oneDeviceJoined() {
        #expect(NewDevices.alertTitle(joined([x])) == "Firefox · Linux was added")
        #expect(NewDevices.alertBody(joined([x]), now: now)
            == "It joined your Tabsend devices 3m ago. If that wasn't you, remove it in Tabsend.")
    }

    @Test func severalDevicesJoined() {
        #expect(NewDevices.alertTitle(joined([x, y, z])) == "3 devices were added")
        #expect(NewDevices.alertBody(joined([x, y, z]), now: now)
            == "Firefox · Linux, Console and Edge · Windows joined your Tabsend devices. If any wasn't you, remove it in Tabsend.")
        #expect(NewDevices.alertBody(joined([x, y]), now: now)
            == "Firefox · Linux and Console joined your Tabsend devices. If any wasn't you, remove it in Tabsend.")
    }

    @Test func anUnreadableTimeIsLeftOut() {
        let odd = NewDeviceNotice(id: "o", label: "Odd", createdAt: "not a date")
        #expect(NewDevices.alertBody(joined([odd]), now: now)
            == "It joined your Tabsend devices. If that wasn't you, remove it in Tabsend.")
    }

    @Test func theFirstList() {
        #expect(NewDevices.alertTitle(firstList([x])) == "Firefox · Linux is in your group")
        #expect(NewDevices.alertBody(firstList([x]), now: now)
            == "The device you paired with didn't list it. If it isn't yours, remove it in Tabsend.")
        #expect(NewDevices.alertTitle(firstList([x, y])) == "2 devices are in your group")
        #expect(NewDevices.alertBody(firstList([x, y]), now: now)
            == "Firefox · Linux and Console. The device you paired with didn't list them. If any isn't yours, remove it in Tabsend.")
    }

    @Test func noEmDashesInCopy() {
        let all = [joined([x]), joined([x, y]), firstList([x]), firstList([x, y])].flatMap {
            [NewDevices.alertTitle($0), NewDevices.alertBody($0, now: now)]
        }
        #expect(all.allSatisfy { !$0.contains("\u{2014}") })
    }
}

/// X13: a removal this phone made is written into the watch, through the store.
struct RemovalRecordTests {
    private func store(known: [String]) -> MemoryStore {
        let store = MemoryStore()
        store.registration = Registration(
            endpointId: "me", groupId: "g", deviceToken: "tok",
            relayUrl: "https://relay.example", label: "Phone"
        )
        store.newDeviceWatch = NewDeviceWatch(
            selfId: "me", known: known, unconfirmed: [], keys: Dictionary(uniqueKeysWithValues: known.map { ($0, "pk") })
        )
        return store
    }

    @Test func aRemovalIsRecordedAtOnceAgainstTheKeyCurrentNow() {
        let store = store(known: ["me", "a", "x"])
        store.groupKeyring = [GroupKeyRecord(key: "k", keyId: "id", createdAt: "2026-10-01T00:00:00.000Z")]

        NewDevices.recordRemoval(id: "x", store: store, now: WireDate.date(from: "2026-10-13T12:00:00.000Z")!)

        let watch = store.newDeviceWatch
        #expect(watch?.known == ["me", "a"])
        #expect(watch?.removed == ["x"])
        #expect(watch?.rotateFor == ["x"])
        #expect(watch?.rotateOwedAt == "2026-10-13T12:00:00.000Z")
        #expect(watch?.rotateFrom == "2026-10-01T00:00:00.000Z")
    }

    @Test func aRelayThatKeepsTheDeviceListedAnnouncesItAgainAndKeepsItOutOfKeyHandoff() {
        let store = store(known: ["me", "a", "x"])
        NewDevices.recordRemoval(id: "x", store: store)
        let list = ["me", "a", "x"].map {
            Endpoint(
                id: $0, groupId: "g", kind: "extension", browser: nil, platform: nil,
                label: $0, deviceName: nil, e2ePubkey: "pk", presence: "online",
                lastSeenAt: "2026-10-13T11:00:00.000Z", createdAt: "2026-10-01T10:00:00.000Z"
            )
        }
        let first = NewDevices.observe(list, store: store)
        #expect(first.joined.map(\.id) == ["x"])
        let trusted = NewDevices.endpointsKnownTo(store.newDeviceWatch, list)
        #expect(trusted.map(\.id) == ["me", "a"])
        // Announced once, not on every fetch.
        #expect(NewDevices.observe(list, store: store).joined.isEmpty)
    }

    @Test func aRecordFromAnotherPairingIsLeftAlone() {
        let store = store(known: ["me", "a"])
        store.newDeviceWatch?.selfId = "someone-else"
        let before = store.newDeviceWatch
        NewDevices.recordRemoval(id: "a", store: store)
        #expect(store.newDeviceWatch == before)
    }

    @Test func removingThroughTheRelayRecordsItOnlyOnceTheRelayHasAccepted() async throws {
        let stub = StubServer()
        let store = store(known: ["me", "a", "x"])
        stub.stub("/v1/endpoints/x", json: #"{"ok":true}"#)
        let api = ApiClient(relayUrl: stub.baseURL, deviceToken: "tok", session: stub.session())

        try await NewDevices.removeFromGroup(id: "x", api: api, store: store)

        #expect(stub.recorded.contains { $0.method == "DELETE" && $0.path == "/v1/endpoints/x" })
        #expect(store.newDeviceWatch?.removed == ["x"])
        #expect(store.newDeviceWatch?.known == ["me", "a"])
    }

    @Test func aRelayThatSaysNotFoundHasAlreadyDoneIt() async throws {
        let stub = StubServer()
        let store = store(known: ["me", "a", "x"])
        stub.stub(
            "/v1/endpoints/x", status: 404,
            json: #"{"error":{"code":"not_found","message":"No such device"}}"#
        )
        let api = ApiClient(relayUrl: stub.baseURL, deviceToken: "tok", session: stub.session())

        try await NewDevices.removeFromGroup(id: "x", api: api, store: store)
        #expect(store.newDeviceWatch?.removed == ["x"])
    }

    @Test func aRefusalRecordsNothing() async {
        let stub = StubServer()
        let store = store(known: ["me", "a", "x"])
        stub.stub(
            "/v1/endpoints/x", status: 500,
            json: #"{"error":{"code":"internal","message":"Try again"}}"#
        )
        let api = ApiClient(relayUrl: stub.baseURL, deviceToken: "tok", session: stub.session())
        let before = store.newDeviceWatch

        await #expect(throws: ApiError.self) {
            try await NewDevices.removeFromGroup(id: "x", api: api, store: store)
        }
        #expect(store.newDeviceWatch == before)
    }
}

/// GH6 and GH7 through the store: the first look, the cached baseline, and a device
/// that joined and then disappeared. Since P-23 the first look is told once, by the
/// one notification (`Observation.announcement`), and the record keeps none of it.
struct FirstLookAndVanishedTests {
    private func list(_ ids: [String]) -> [Endpoint] {
        ids.map {
            Endpoint(
                id: $0, groupId: "g", kind: "extension", browser: nil, platform: nil,
                label: $0, deviceName: nil, e2ePubkey: "pk-\($0)", presence: "online",
                lastSeenAt: "2026-10-13T11:00:00.000Z", createdAt: "2026-10-01T10:00:00.000Z"
            )
        }
    }

    private func store() -> MemoryStore {
        let store = MemoryStore()
        store.registration = Registration(
            endpointId: "me", groupId: "g", deviceToken: "tok",
            relayUrl: "https://relay.example", label: "Phone"
        )
        return store
    }

    /// A record an earlier build left with a notice still waiting for an answer.
    private func leavePending(_ id: String, in store: MemoryStore) {
        store.updateNewDeviceWatch { prev in
            prev.map { watch in
                var pending = watch
                pending.unconfirmed = [
                    NewDeviceNotice(id: id, label: id, createdAt: "2026-10-01T10:00:00.000Z"),
                ]
                return pending
            }
        }
    }

    @Test func theFirstListIsToldOnce() {
        let store = store()
        let first = NewDevices.observe(list(["me", "a", "b"]), store: store)
        #expect(first.joined.isEmpty)
        #expect(first.announcement?.kind == .firstList)
        #expect(first.announcement?.devices.map(\.id) == ["a", "b"])
        #expect(NewDevices.current(store: store)?.review == nil, "nothing waits for an answer (P-23)")
        #expect(NewDevices.observe(list(["me", "a", "b"]), store: store).announcement == nil)
    }

    /// The same list with a full-length key per device, so a link can vouch for each.
    private func vouchedList(_ ids: [String]) -> [Endpoint] {
        list(ids).map { endpoint in
            var keyed = endpoint
            keyed.e2ePubkey = "Key0\(endpoint.id)".padding(toLength: 44, withPad: "0", startingAt: 0)
            return keyed
        }
    }

    @Test func thePairingLinkVouchesForTheFirstListAndIsUsedOnce() {
        // P-23: the tags ride on the registration until the first list is checked.
        let store = store()
        let devices = vouchedList(["me", "a", "x"])
        store.registration?.vouched = NewDevices.vouchTags(
            NewDeviceWatch(
                selfId: "a", known: ["me", "a"], unconfirmed: [],
                keys: Dictionary(uniqueKeysWithValues: devices.prefix(2).map { ($0.id, $0.e2ePubkey) })
            ),
            Array(devices.prefix(2)), selfId: "a"
        )
        #expect(store.registration?.vouched?.count == 2)
        let observed = NewDevices.observe(devices, store: store)
        #expect(observed.joined.isEmpty)
        // "a" was vouched for; "x" was not, so it alone is told about.
        #expect(observed.announcement?.kind == .firstList)
        #expect(observed.announcement?.devices.map(\.id) == ["x"])
        #expect(NewDevices.current(store: store)?.review == nil)
        #expect(store.registration?.vouched == nil, "the tags are cleared once the record is stored")
    }

    @Test func aLinkWithoutTagsTellsAboutEveryone() {
        let store = store()
        let observed = NewDevices.observe(vouchedList(["me", "a"]), store: store)
        #expect(observed.announcement?.kind == .firstList)
        #expect(observed.announcement?.devices.map(\.id) == ["a"])
        #expect(store.registration?.vouched == nil)
    }

    @Test func theListAnEarlierBuildCachedIsTheBaseline() {
        let store = store()
        store.cachedEndpoints = list(["me", "a"])
        let observed = NewDevices.observe(list(["me", "a", "x"]), store: store)
        #expect(observed.joined.map(\.id) == ["x"])
        // What joined is told; the cached list's own devices are not told on top of it.
        #expect(observed.announcement == NewDevices.Announcement(kind: .joined, devices: observed.joined))
        #expect(NewDevices.current(store: store)?.review == nil)
    }

    @Test func aCacheFromAnotherPairingIsNotUsed() {
        let store = store()
        store.cachedEndpoints = list(["other", "old"])
        let observed = NewDevices.observe(list(["me", "a"]), store: store)
        #expect(observed.joined.isEmpty)
        #expect(observed.announcement?.kind == .firstList)
        #expect(observed.announcement?.devices.map(\.id) == ["a"])
    }

    @Test func aPendingDeviceThatDisappearedStaysUntilDismissedUnlessThisPhoneRemovedIt() {
        // Since P-23 this phone stores no pending notice, but a record an earlier build
        // left can carry one, and such a device leaving is still reported (GH7).
        let store = store()
        NewDevices.observe(list(["me", "a", "x"]), store: store)
        leavePending("x", in: store)
        NewDevices.observe(list(["me", "a"]), store: store)
        #expect(NewDevices.vanished(store: store).map(\.id) == ["x"])
        #expect(NewDevices.current(store: store)?.unconfirmed.isEmpty == true)

        NewDevices.dismissVanished(id: "x", store: store)
        #expect(NewDevices.vanished(store: store).isEmpty)

        NewDevices.observe(list(["me", "a", "y"]), store: store)
        leavePending("y", in: store)
        NewDevices.recordRemoval(id: "y", store: store)
        NewDevices.observe(list(["me", "a"]), store: store)
        #expect(NewDevices.vanished(store: store).isEmpty)
    }
}
