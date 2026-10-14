import Testing
import Foundation
@testable import TabsendKit

/// The key sync and the drain against a canned relay (`StubServer`), for the rules
/// that only show up when the steps run together: which list they act on, which
/// key copies they keep, and when they replace the group key.

private struct Device {
    let identity: Identity
    let endpoint: Endpoint
}

private func device(_ id: String, kind: String = "mobile") -> Device {
    let identity = Identity.generate()
    return Device(
        identity: identity,
        endpoint: Endpoint(
            id: id, groupId: "g", kind: kind, browser: nil, platform: "ios",
            label: "Device \(id)", deviceName: nil, e2ePubkey: identity.publicKey,
            presence: "online", lastSeenAt: "2026-10-01T10:00:00.000Z",
            createdAt: "2026-10-01T10:00:00.000Z"
        )
    )
}

private func paired(_ me: Device, relay: String) -> MemoryStore {
    let store = MemoryStore()
    store.identity = me.identity
    store.registration = Registration(
        endpointId: me.endpoint.id, groupId: "g", deviceToken: "tok",
        relayUrl: relay, label: me.endpoint.label
    )
    return store
}

private func json<T: Encodable>(_ value: T) throws -> String {
    String(decoding: try Wire.encoder.encode(value), as: UTF8.self)
}

/// A key copy `from` sealed to `to`, as `GET /v1/group-keys` returns it.
private func copy(of record: GroupKeyRecord, from: Device, to: Device, id: String) throws -> GroupKeyDelivery {
    GroupKeyDelivery(
        id: id,
        sourceEndpointId: from.endpoint.id,
        envelope: try Sealer.seal(
            plaintext: Wire.encoder.encode(record),
            targetPublicKeyBase64: to.identity.publicKey,
            senderPrivateKeyBase64: from.identity.privateKey,
            senderKeyId: from.identity.keyId
        ),
        createdAt: record.createdAt
    )
}

private let now = WireDate.date(from: "2026-10-13T12:00:00.000Z")!

struct GroupKeySyncTests {
    @Test func aListWithoutThisPhoneTouchesNothing() async throws {
        // The backstop for a relay serving [fake device, the others, not this
        // phone]: no copy is trusted and, above all, no key is sealed to the fake.
        let stub = StubServer()
        let me = device("b"), other = device("c"), fake = device("a")
        let store = paired(me, relay: stub.baseURL)
        store.groupKeyring = [Keyring.generate(now: now)]
        let api = ApiClient(relayUrl: stub.baseURL, deviceToken: "tok", session: stub.session())

        _ = await GroupHistorySync.run(
            store: store, api: api, endpoints: [fake.endpoint, other.endpoint], now: now
        )
        #expect(stub.recorded.isEmpty)
        #expect(store.deliveredGroupKeys.isEmpty)
    }

    @Test func aCopyWithABadCreatedAtIsRefused() async throws {
        let stub = StubServer()
        let sender = device("a"), me = device("b")
        let store = paired(me, relay: stub.baseURL)
        let good = Keyring.generate(now: WireDate.date(from: "2026-10-10T00:00:00.000Z")!)
        var pinned = Keyring.generate(now: now)
        pinned.createdAt = "9999-12-31T23:59:59.999Z"
        store.newDeviceWatch = NewDeviceWatch(selfId: "b", known: ["a", "b"], unconfirmed: [])
        stub.stub("/v1/group-keys", json: try json([
            copy(of: pinned, from: sender, to: me, id: "d1"),
            copy(of: good, from: sender, to: me, id: "d2"),
        ]))
        stub.stub("/v1/messages", json: "[]")
        let api = ApiClient(relayUrl: stub.baseURL, deviceToken: "tok", session: stub.session())

        _ = await GroupHistorySync.run(
            store: store, api: api, endpoints: [sender.endpoint, me.endpoint], now: now
        )
        #expect(store.groupKeyring.map(\.keyId) == [good.keyId])
    }

    @Test func aDepartureRotatesTheKeyAndHandsItToEveryoneLeft() async throws {
        let stub = StubServer()
        let me = device("b"), other = device("a"), console = device("c", kind: "console")
        let store = paired(me, relay: stub.baseURL)
        let old = Keyring.generate(now: WireDate.date(from: "2026-10-01T00:00:00.000Z")!)
        store.groupKeyring = [old]
        // Delivered before: only a NEW key gives anyone a reason to get a copy.
        store.deliveredGroupKeys = [
            Keyring.deliveryId(keyId: old.keyId, endpointId: other.endpoint.id),
            Keyring.deliveryId(keyId: old.keyId, endpointId: console.endpoint.id),
        ]
        // A device left the list on the 12th, while `old` was the current key.
        store.newDeviceWatch = NewDeviceWatch(
            selfId: "b", known: ["a", "b", "c"], unconfirmed: [],
            rotateOwedAt: "2026-10-12T08:00:00.000Z", rotateFrom: old.createdAt
        )
        stub.stub("/v1/group-keys", json: "[]")
        stub.stub("/v1/messages", json: "[]")
        let api = ApiClient(relayUrl: stub.baseURL, deviceToken: "tok", session: stub.session())

        _ = await GroupHistorySync.run(
            store: store, api: api,
            endpoints: [other.endpoint, me.endpoint, console.endpoint], now: now
        )

        let current = try #require(Keyring.current(store.groupKeyring))
        #expect(store.groupKeyring.count == 2, "the old key stays, so old history stays readable")
        #expect(current.keyId != old.keyId)
        #expect(current.createdAt == "2026-10-13T12:00:00.000Z")
        #expect(NewDevices.current(store: store)?.rotateOwedAt == nil)

        let post = try #require(stub.recorded.first { $0.method == "POST" && $0.path == "/v1/group-keys" })
        let items = try #require(post.body?["items"] as? [[String: Any]])
        #expect(Set(items.compactMap { $0["targetEndpointId"] as? String }) == ["a", "c"])
        #expect(items.allSatisfy { ($0["id"] as? String)?.contains(current.keyId) == true })
    }

    @Test func aRotationAnotherDeviceAlreadyMadeIsSettledWithoutMinting() async throws {
        let stub = StubServer()
        let sender = device("a"), me = device("b")
        let store = paired(me, relay: stub.baseURL)
        let old = Keyring.generate(now: WireDate.date(from: "2026-10-01T00:00:00.000Z")!)
        let theirs = Keyring.generate(now: WireDate.date(from: "2026-10-12T09:00:00.000Z")!)
        store.groupKeyring = [old]
        store.newDeviceWatch = NewDeviceWatch(
            selfId: "b", known: ["a", "b"], unconfirmed: [],
            rotateOwedAt: "2026-10-12T08:00:00.000Z", rotateFrom: old.createdAt
        )
        stub.stub("/v1/group-keys", json: try json([copy(of: theirs, from: sender, to: me, id: "d1")]))
        stub.stub("/v1/messages", json: "[]")
        let api = ApiClient(relayUrl: stub.baseURL, deviceToken: "tok", session: stub.session())

        _ = await GroupHistorySync.run(
            store: store, api: api, endpoints: [sender.endpoint, me.endpoint], now: now
        )
        #expect(Set(store.groupKeyring.map(\.keyId)) == [old.keyId, theirs.keyId])
        #expect(Keyring.current(store.groupKeyring)?.keyId == theirs.keyId)
        // Settled either way, so this device does not mint later for the same
        // departure (every device minting once per departure was the defect).
        #expect(NewDevices.current(store: store)?.rotateOwedAt == nil)
        #expect(NewDevices.current(store: store)?.rotateFrom == nil)
    }

    @Test func aKeyPlantedADayAheadDoesNotBlockTheRotation() async throws {
        // A device about to be removed hands out a key dated 23 hours ahead, which
        // the createdAt check allows. Compared with the clock it would look like a
        // rotation that already happened; compared with the key it is the one to
        // replace.
        let stub = StubServer()
        let me = device("b"), other = device("a")
        let store = paired(me, relay: stub.baseURL)
        let planted = Keyring.generate(now: WireDate.date(from: "2026-10-14T11:00:00.000Z")!)
        store.groupKeyring = [planted]
        store.newDeviceWatch = NewDeviceWatch(
            selfId: "b", known: ["a", "b"], unconfirmed: [],
            rotateOwedAt: "2026-10-13T11:30:00.000Z", rotateFrom: planted.createdAt
        )
        stub.stub("/v1/group-keys", json: "[]")
        stub.stub("/v1/messages", json: "[]")
        let api = ApiClient(relayUrl: stub.baseURL, deviceToken: "tok", session: stub.session())

        _ = await GroupHistorySync.run(
            store: store, api: api, endpoints: [other.endpoint, me.endpoint], now: now
        )
        let current = try #require(Keyring.current(store.groupKeyring))
        #expect(current.keyId != planted.keyId)
        #expect(current.createdAt == "2026-10-14T11:00:00.001Z", "one millisecond past the planted key")
        #expect(NewDevices.current(store: store)?.rotateOwedAt == nil)
    }

    @Test func theNewKeyNeverGoesToADeviceTheRecordNoLongerAccepts() async throws {
        // The list still names the device that just left (read before the record
        // moved on). The rotated key must reach everyone else and not it.
        let stub = StubServer()
        let me = device("b"), other = device("a"), gone = device("c")
        let store = paired(me, relay: stub.baseURL)
        let old = Keyring.generate(now: WireDate.date(from: "2026-10-01T00:00:00.000Z")!)
        store.groupKeyring = [old]
        store.newDeviceWatch = NewDeviceWatch(
            selfId: "b", known: ["a", "b"], unconfirmed: [],
            keys: ["a": other.identity.publicKey, "b": me.identity.publicKey],
            rotateOwedAt: "2026-10-12T08:00:00.000Z", rotateFrom: old.createdAt
        )
        stub.stub("/v1/group-keys", json: "[]")
        stub.stub("/v1/messages", json: "[]")
        let api = ApiClient(relayUrl: stub.baseURL, deviceToken: "tok", session: stub.session())

        _ = await GroupHistorySync.run(
            store: store, api: api,
            endpoints: [other.endpoint, me.endpoint, gone.endpoint], now: now
        )
        let posts = stub.recorded.filter { $0.method == "POST" && $0.path == "/v1/group-keys" }
        let targets = posts.flatMap { ($0.body?["items"] as? [[String: Any]]) ?? [] }
            .compactMap { $0["targetEndpointId"] as? String }
        #expect(targets == ["a"])
    }

    @Test func ringUpdatesDoNotLoseAConcurrentWrite() async {
        // Foreground and background passes overlap. Each write is a locked
        // read-modify-write, so no key is dropped however they interleave.
        let store = MemoryStore()
        await withTaskGroup(of: Void.self) { group in
            for _ in 0..<200 {
                group.addTask {
                    store.updateGroupKeyring { Keyring.merge($0, [Keyring.generate()]) }
                }
            }
        }
        #expect(store.groupKeyring.count == 200)
    }
}

struct DelivererListTests {
    private func drainer(_ store: MemoryStore, _ stub: StubServer) -> Deliverer {
        Deliverer(store: store, present: { _, _ in true }) { _ in
            ApiClient(relayUrl: stub.baseURL, deviceToken: "tok", session: stub.session())
        }
    }

    @Test func aListWithoutThisPhoneIsNotCachedOrPassedOn() async throws {
        let stub = StubServer()
        let me = device("b"), other = device("c"), fake = device("a")
        let store = paired(me, relay: stub.baseURL)
        store.cachedEndpoints = [me.endpoint, other.endpoint]
        stub.stub("/v1/endpoints", json: try json([fake.endpoint, other.endpoint]))
        stub.stub("/v1/messages", json: "[]")

        let summary = await drainer(store, stub).drain()
        #expect(summary.endpoints == nil, "the key sync gets no list to act on")
        #expect(store.cachedEndpoints.map(\.id) == ["b", "c"], "the cache keeps the last accepted list")
        #expect(!stub.recorded.contains { $0.path == "/v1/messages" }, "treated as a failed fetch")
    }

    @Test func anAcceptedListIsCachedAndPassedOn() async throws {
        let stub = StubServer()
        let me = device("b"), other = device("c")
        let store = paired(me, relay: stub.baseURL)
        stub.stub("/v1/endpoints", json: try json([me.endpoint, other.endpoint]))
        stub.stub("/v1/messages", json: "[]")

        let summary = await drainer(store, stub).drain()
        #expect(summary.endpoints?.map(\.id) == ["b", "c"])
        #expect(store.cachedEndpoints.map(\.id) == ["b", "c"])
    }

    // MARK: X14, a newer key is not proof of a rotation

    /// This phone owes a rotation for "c", which left; "a" is a member.
    private func owing(
        _ me: Device, _ other: Device, old: GroupKeyRecord, for ids: [String] = ["c"]
    ) -> NewDeviceWatch {
        NewDeviceWatch(
            selfId: me.endpoint.id, known: [other.endpoint.id, me.endpoint.id], unconfirmed: [],
            keys: [other.endpoint.id: other.identity.publicKey, me.endpoint.id: me.identity.publicKey],
            rotateOwedAt: "2026-10-12T08:00:00.000Z", rotateFrom: old.createdAt, rotateFor: ids
        )
    }

    @Test func aNewerKeyThatDoesNotNameTheDepartedDeviceDoesNotSettleTheDebt() async throws {
        // The relay held this key back until now. It is newer than the key current
        // when "c" left, but it was minted before, and "c" may hold it.
        let stub = StubServer()
        let sender = device("a"), me = device("b")
        let store = paired(me, relay: stub.baseURL)
        let old = Keyring.generate(now: WireDate.date(from: "2026-10-01T00:00:00.000Z")!)
        let lagging = Keyring.generate(now: WireDate.date(from: "2026-10-12T07:59:00.000Z")!)
        store.groupKeyring = [old]
        store.newDeviceWatch = owing(me, sender, old: old)
        stub.stub("/v1/group-keys", json: try json([copy(of: lagging, from: sender, to: me, id: "d1")]))
        stub.stub("/v1/messages", json: "[]")
        let api = ApiClient(relayUrl: stub.baseURL, deviceToken: "tok", session: stub.session())

        _ = await GroupHistorySync.run(
            store: store, api: api, endpoints: [sender.endpoint, me.endpoint], now: now
        )

        let current = try #require(Keyring.current(store.groupKeyring))
        #expect(store.groupKeyring.count == 3)
        #expect(current.keyId != lagging.keyId && current.keyId != old.keyId)
        #expect(current.departed == ["c"])
        #expect(NewDevices.current(store: store)?.rotateOwedAt == nil)
        #expect(NewDevices.current(store: store)?.rotateFor == nil)
    }

    @Test func aNewerKeyThatNamesTheDepartedDeviceSettlesTheDebtWithoutMinting() async throws {
        let stub = StubServer()
        let sender = device("a"), me = device("b")
        let store = paired(me, relay: stub.baseURL)
        let old = Keyring.generate(now: WireDate.date(from: "2026-10-01T00:00:00.000Z")!)
        var theirs = Keyring.generate(now: WireDate.date(from: "2026-10-12T07:59:00.000Z")!)
        theirs.departed = ["c"]
        store.groupKeyring = [old]
        store.newDeviceWatch = owing(me, sender, old: old)
        stub.stub("/v1/group-keys", json: try json([copy(of: theirs, from: sender, to: me, id: "d1")]))
        stub.stub("/v1/messages", json: "[]")
        let api = ApiClient(relayUrl: stub.baseURL, deviceToken: "tok", session: stub.session())

        _ = await GroupHistorySync.run(
            store: store, api: api, endpoints: [sender.endpoint, me.endpoint], now: now
        )

        #expect(Set(store.groupKeyring.map(\.keyId)) == [old.keyId, theirs.keyId])
        #expect(Keyring.current(store.groupKeyring)?.keyId == theirs.keyId)
        #expect(Keyring.current(store.groupKeyring)?.departed == ["c"])
        #expect(NewDevices.current(store: store)?.rotateOwedAt == nil)
    }

    @Test func aSenderCannotVouchThatItHasLeftItself() async throws {
        let stub = StubServer()
        let sender = device("a"), me = device("b")
        let store = paired(me, relay: stub.baseURL)
        let old = Keyring.generate(now: WireDate.date(from: "2026-10-01T00:00:00.000Z")!)
        var selfNamed = Keyring.generate(now: WireDate.date(from: "2026-10-12T07:59:00.000Z")!)
        selfNamed.departed = ["a"]
        store.groupKeyring = [old]
        store.newDeviceWatch = owing(me, sender, old: old, for: ["a"])
        stub.stub("/v1/group-keys", json: try json([copy(of: selfNamed, from: sender, to: me, id: "d1")]))
        stub.stub("/v1/messages", json: "[]")
        let api = ApiClient(relayUrl: stub.baseURL, deviceToken: "tok", session: stub.session())

        _ = await GroupHistorySync.run(
            store: store, api: api, endpoints: [sender.endpoint, me.endpoint], now: now
        )

        let taken = try #require(store.groupKeyring.first { $0.keyId == selfNamed.keyId })
        #expect(taken.departed == nil)
        let current = try #require(Keyring.current(store.groupKeyring))
        #expect(current.keyId != selfNamed.keyId)
        #expect(current.departed == ["a"])
    }

    @Test func aRecordWhoseDepartedListIsNotStringsIsRefused() async throws {
        let stub = StubServer()
        let sender = device("a"), me = device("b")
        let store = paired(me, relay: stub.baseURL)
        let good = Keyring.generate(now: WireDate.date(from: "2026-10-12T07:59:00.000Z")!)
        let plain = String(decoding: try Wire.encoder.encode(good), as: UTF8.self)
        let withNumbers = String(plain.dropLast()) + ",\"departed\":[1]}"
        let bad = GroupKeyDelivery(
            id: "d1", sourceEndpointId: "a",
            envelope: try Sealer.seal(
                plaintext: Data(withNumbers.utf8),
                targetPublicKeyBase64: me.identity.publicKey,
                senderPrivateKeyBase64: sender.identity.privateKey,
                senderKeyId: sender.identity.keyId
            ),
            createdAt: good.createdAt
        )
        store.newDeviceWatch = NewDeviceWatch(selfId: "b", known: ["a", "b"], unconfirmed: [])
        stub.stub("/v1/group-keys", json: try json([bad]))
        stub.stub("/v1/messages", json: "[]")
        let api = ApiClient(relayUrl: stub.baseURL, deviceToken: "tok", session: stub.session())

        _ = await GroupHistorySync.run(
            store: store, api: api, endpoints: [sender.endpoint, me.endpoint], now: now
        )
        #expect(!store.groupKeyring.contains { $0.keyId == good.keyId })
    }

    // MARK: X13, a relay that keeps a removed device listed

    @Test func aRemovedDeviceTheRelayStillListsGetsNothingAndTheRotationHappensAtOnce() async throws {
        let stub = StubServer()
        let me = device("b"), other = device("a"), gone = device("c")
        let store = paired(me, relay: stub.baseURL)
        let old = Keyring.generate(now: WireDate.date(from: "2026-10-01T00:00:00.000Z")!)
        store.groupKeyring = [old]
        store.newDeviceWatch = NewDevices.removeDevice(
            NewDeviceWatch(
                selfId: "b", known: ["a", "b", "c"], unconfirmed: [],
                keys: [
                    "a": other.identity.publicKey, "b": me.identity.publicKey,
                    "c": gone.identity.publicKey,
                ]
            ),
            id: "c", now: "2026-10-12T08:00:00.000Z", currentKeyCreatedAt: old.createdAt
        )
        stub.stub("/v1/group-keys", json: "[]")
        stub.stub("/v1/messages", json: "[]")
        let api = ApiClient(relayUrl: stub.baseURL, deviceToken: "tok", session: stub.session())

        // The relay answered the removal and went on listing the device.
        _ = await GroupHistorySync.run(
            store: store, api: api,
            endpoints: [other.endpoint, me.endpoint, gone.endpoint], now: now
        )

        let current = try #require(Keyring.current(store.groupKeyring))
        #expect(current.keyId != old.keyId)
        #expect(current.departed == ["c"])
        let post = try #require(stub.recorded.first { $0.method == "POST" && $0.path == "/v1/group-keys" })
        let items = try #require(post.body?["items"] as? [[String: Any]])
        #expect(Set(items.compactMap { $0["targetEndpointId"] as? String }) == ["a"])
        #expect(NewDevices.current(store: store)?.rotateOwedAt == nil)
        #expect(NewDevices.current(store: store)?.removed == ["c"])
    }
}
