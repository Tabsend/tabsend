import Testing
import Foundation
@testable import TabsendKit

/// A held tab whose device is gone (PLANS.md P-15 item 3), through the real send
/// code rather than the queue rule alone: the flush against a stubbed relay, and the
/// move to another device opened with real keys. Each test names one rule from
/// SECURITY_REVIEW L3 and L7 and fails if that rule is undone.
///
/// The phone's device watch is built the way the app builds it, by running the
/// new-device rule on device lists (`NewDevices.observe`), so "accepted" here means
/// what it means on a phone.

/// A device in the group, with the private key its envelopes are opened with.
private struct Device {
    var endpoint: Endpoint
    var identity: Identity

    init(_ id: String, kind: String = "extension") {
        identity = Identity.generate()
        endpoint = Endpoint(
            id: id, groupId: "g", kind: kind, browser: nil, platform: nil,
            label: "Device \(id)", deviceName: nil, e2ePubkey: identity.publicKey,
            presence: "online", lastSeenAt: "2026-10-15T00:00:00.000Z",
            createdAt: "2026-10-01T00:00:00.000Z"
        )
    }
}

/// A paired phone ("me") with a group key, whose watch has accepted `devices`: the
/// first list was its baseline, told once and stored settled (P-23).
private struct Phone {
    let store = MemoryStore()
    let me = Device("me")
    let groupKey = Keyring.generate()
    var devices: [String: Device] = [:]

    init(_ devices: [Device]) {
        store.identity = me.identity
        store.registration = Registration(
            endpointId: "me", groupId: "g", deviceToken: "tok",
            relayUrl: "https://relay.example", label: "Phone"
        )
        store.groupKeyring = [groupKey]
        for device in devices { self.devices[device.endpoint.id] = device }
        NewDevices.observe([me.endpoint] + devices.map(\.endpoint), store: store)
    }

    /// The relay lists `ids` next; the phone runs its rule on that list.
    func relayLists(_ ids: [String]) {
        NewDevices.observe([me.endpoint] + ids.compactMap { devices[$0]?.endpoint }, store: store)
    }

    /// A tab held for `target`, sealed to it as `Sender.send` seals one.
    func hold(
        _ target: String, url: String = "https://example.com/page",
        targetGone: Bool? = nil, goneFromList: Bool? = nil
    ) throws -> OutboundItem {
        let device = try #require(devices[target])
        // Sent an hour ago, never a fixed date: the queue gives up on a tab after
        // `OutboundQueue.maxAgeDays`, and a fixed stamp turned every flush test
        // here into a test of that expiry once the week had passed.
        let payload = SendPayload(
            url: url, title: "A page", sentAt: WireDate.string(from: Date().addingTimeInterval(-3600))
        )
        let envelope = try Sealer.seal(
            plaintext: Wire.encoder.encode(payload),
            targetPublicKeyBase64: device.endpoint.e2ePubkey,
            senderPrivateKeyBase64: me.identity.privateKey,
            senderKeyId: me.identity.keyId
        )
        let item = OutboundItem(
            id: UUID().uuidString.lowercased(), targetEndpointId: target, envelope: envelope,
            createdAt: payload.sentAt, title: payload.title, url: url,
            targetLabel: device.endpoint.label,
            history: Sender.historyBlob(payload: payload, target: device.endpoint, store: store),
            targetGone: targetGone, goneFromList: goneFromList
        )
        store.updateOutbound { $0 + [item] }
        return item
    }

    func queued(_ id: String) -> OutboundItem? {
        store.outboundQueue.first { $0.id == id }
    }
}

/// A relay that takes every tab, unless `rejecting` names one it refuses.
private func relay(rejecting id: String? = nil, reason: String = "unknown_target", status: Int = 200)
    -> (StubServer, ApiClient)
{
    let stub = StubServer()
    let rejected = id.map { #"[{"id":"\#($0)","reason":"\#(reason)"}]"# } ?? "[]"
    stub.stub("/v1/messages", status: status, json: status == 200
        ? #"{"accepted":[],"rejected":\#(rejected)}"#
        : #"{"error":{"code":"internal","message":"Try again"}}"#)
    return (stub, ApiClient(relayUrl: stub.baseURL, deviceToken: "tok", session: stub.session()))
}

/// The ids the relay was asked to take.
private func posted(_ stub: StubServer) -> [String] {
    stub.recorded
        .filter { $0.method == "POST" && $0.path == "/v1/messages" }
        .flatMap { ($0.body?["items"] as? [[String: Any]]) ?? [] }
        .compactMap { $0["id"] as? String }
}

/// The flush: which held tabs it posts, and the flag each is left with.
struct HeldTabFlushTests {
    @Test func aTabWhoseDeviceLeftTheListIsNotPostedAndCarriesTheListsFlag() async throws {
        let phone = Phone([Device("a"), Device("b")])
        let item = try phone.hold("b")
        phone.relayLists(["a"])
        let (stub, api) = relay()

        let report = await Sender.flushOutbound(store: phone.store, api: api)

        #expect(posted(stub).isEmpty)
        #expect(phone.queued(item.id)?.targetGone == true)
        #expect(phone.queued(item.id)?.goneFromList == true)
        #expect(report.newlyGone == 1)
        #expect(report.firstGoneRemovedHere == false, "the relay's list is not this phone removing it")
    }

    @Test func aTabTheRelayRefusedIsNotPostedEvenWhileItsDeviceIsListedAndAccepted() async throws {
        let phone = Phone([Device("a")])
        let item = try phone.hold("a", targetGone: true)
        let (stub, api) = relay()

        let report = await Sender.flushOutbound(store: phone.store, api: api)

        #expect(posted(stub).isEmpty)
        #expect(phone.queued(item.id)?.targetGone == true)
        #expect(phone.queued(item.id)?.goneFromList != true)
        #expect(report.newlyGone == 0, "announced when it was flagged, not again")
    }

    @Test func aListsFlagLiftsAndTheTabIsPostedOnceItsDeviceIsAcceptedAgain() async throws {
        let phone = Phone([Device("a")])
        let item = try phone.hold("a", targetGone: true, goneFromList: true)
        let (stub, api) = relay()

        let report = await Sender.flushOutbound(store: phone.store, api: api)

        #expect(posted(stub) == [item.id])
        #expect(report.sent == 1)
        #expect(phone.queued(item.id) == nil)
    }

    @Test func aLiftedFlagIsWrittenBackWhenTheRelayIsNotAnsweringYet() async throws {
        let phone = Phone([Device("a")])
        let item = try phone.hold("a", targetGone: true, goneFromList: true)
        let (stub, api) = relay(status: 503)

        let report = await Sender.flushOutbound(store: phone.store, api: api)

        #expect(posted(stub) == [item.id])
        #expect(report.stillHeld == 1)
        #expect(phone.queued(item.id)?.targetGone == nil)
        #expect(phone.queued(item.id)?.goneFromList == nil)
    }

    /// X13 and L3: a device this phone removed is gone, whatever the relay lists.
    @Test func aTabForADeviceThisPhoneRemovedIsNotPostedWhileTheRelayStillListsIt() async throws {
        let phone = Phone([Device("a"), Device("x")])
        let item = try phone.hold("x")
        NewDevices.recordRemoval(id: "x", store: phone.store)
        phone.relayLists(["a", "x"])
        #expect(phone.store.cachedEndpoints.contains { $0.id == "x" })
        let (stub, api) = relay()

        let report = await Sender.flushOutbound(store: phone.store, api: api)

        #expect(posted(stub).isEmpty)
        #expect(phone.queued(item.id)?.targetGone == true)
        #expect(phone.queued(item.id)?.goneFromList == true)
        #expect(report.newlyGone == 1)
        #expect(report.firstGoneRemovedHere == true)
    }

    /// Both answers mean "that device is not in the group": `not_in_group` is retired
    /// [0029], but an older relay still says it, and dropping the tab there is the
    /// bug P-15 item 3 fixed.
    @Test(arguments: ["unknown_target", "not_in_group"])
    func aRelayRefusalSetsTheRelaysFlagWhichNoListLifts(reason: String) async throws {
        let phone = Phone([Device("a")])
        let item = try phone.hold("a")
        let (stub, api) = relay(rejecting: item.id, reason: reason)

        let report = await Sender.flushOutbound(store: phone.store, api: api)

        #expect(posted(stub) == [item.id])
        #expect(report.newlyGone == 1)
        #expect(phone.queued(item.id)?.targetGone == true)
        #expect(phone.queued(item.id)?.goneFromList != true)

        // "a" is still listed and accepted, and the tab stays held.
        let (again, api2) = relay()
        await Sender.flushOutbound(store: phone.store, api: api2)
        #expect(posted(again).isEmpty)
        #expect(phone.queued(item.id)?.targetGone == true)
    }

    /// Only those two answers hold a tab for another device. Any other final refusal
    /// still ends it, out loud, rather than leaving it waiting for a device that is
    /// still in the group.
    @Test func anotherFinalRefusalDropsTheTabAndIsNotFlagged() async throws {
        let phone = Phone([Device("a")])
        let item = try phone.hold("a")
        let (_, api) = relay(rejecting: item.id, reason: "payload_too_large")

        let report = await Sender.flushOutbound(store: phone.store, api: api)

        #expect(phone.queued(item.id) == nil)
        #expect(report.dropped == 1)
        #expect(report.newlyGone == 0)
    }
}

/// The move to another device: what it is sealed to, what it may be moved to.
struct HeldTabRetargetTests {
    @Test func theTabIsSealedAfreshToTheNewDeviceUnderANewId() throws {
        let phone = Phone([Device("a"), Device("b")])
        let old = try phone.hold("a", targetGone: true)
        let a = try #require(phone.devices["a"])
        let b = try #require(phone.devices["b"])

        #expect(Sender.retargetHeld(id: old.id, to: b.endpoint, store: phone.store))

        #expect(phone.store.outboundQueue.count == 1)
        let moved = try #require(phone.store.outboundQueue.first)
        #expect(moved.id != old.id)
        #expect(moved.targetEndpointId == "b")
        #expect(moved.targetLabel == "Device b")
        #expect(moved.targetGone == nil && moved.goneFromList == nil)
        #expect(moved.createdAt == old.createdAt)

        // The new envelope opens with the new device's key, and not the old one's.
        let opened = try Sealer.open(
            envelope: moved.envelope, senderPublicKeyBase64: phone.me.identity.publicKey,
            recipientPrivateKeyBase64: b.identity.privateKey
        )
        #expect(try Wire.decoder.decode(SendPayload.self, from: opened).url == "https://example.com/page")
        #expect(throws: (any Error).self) {
            try Sealer.open(
                envelope: moved.envelope, senderPublicKeyBase64: phone.me.identity.publicKey,
                recipientPrivateKeyBase64: a.identity.privateKey
            )
        }

        // A fresh history copy, under the group key, naming the new device.
        let blob = try #require(moved.history)
        let record = try Wire.decoder.decode(
            HistoryRecord.self,
            from: Sealer.openGroup(blob, groupKeyBase64: phone.groupKey.key)
        )
        #expect(record.targetLabelAtSend == "Device b")
        #expect(record.payload.url == "https://example.com/page")
    }

    /// The caller's endpoint is a choice, not a key: the tab is sealed to the key the
    /// watch accepted for that id, whatever the object passed in says (L3).
    @Test func theKeyComesFromTheAcceptedListNotFromTheCaller() throws {
        let phone = Phone([Device("a"), Device("b")])
        let old = try phone.hold("a", targetGone: true)
        let b = try #require(phone.devices["b"])
        let impostor = Device("b")
        var offered = impostor.endpoint
        offered.label = "Someone else"

        #expect(Sender.retargetHeld(id: old.id, to: offered, store: phone.store))

        let moved = try #require(phone.store.outboundQueue.first)
        #expect(moved.targetLabel == "Device b")
        #expect(throws: (any Error).self) {
            try Sealer.open(
                envelope: moved.envelope, senderPublicKeyBase64: phone.me.identity.publicKey,
                recipientPrivateKeyBase64: impostor.identity.privateKey
            )
        }
        _ = try Sealer.open(
            envelope: moved.envelope, senderPublicKeyBase64: phone.me.identity.publicKey,
            recipientPrivateKeyBase64: b.identity.privateKey
        )

        // The history copy names the accepted device too, not the caller's label.
        let blob = try #require(moved.history)
        let record = try Wire.decoder.decode(
            HistoryRecord.self,
            from: Sealer.openGroup(blob, groupKeyBase64: phone.groupKey.key)
        )
        #expect(record.targetLabelAtSend == "Device b")
    }

    /// "The original device allowed" (L3): once it is accepted again it is a fair choice.
    @Test func theTabsOwnDeviceAcceptedAgainIsAllowed() throws {
        let phone = Phone([Device("a"), Device("b")])
        let old = try phone.hold("a", targetGone: true, goneFromList: true)
        let a = try #require(phone.devices["a"])

        #expect(Sender.retargetHeld(id: old.id, to: a.endpoint, store: phone.store))
        let moved = try #require(phone.store.outboundQueue.first)
        #expect(moved.targetEndpointId == "a")
        #expect(moved.id != old.id)
    }

    /// Each refusal leaves the queue, and the quick-send default, as they were.
    private func expectRefused(
        _ phone: Phone, _ old: OutboundItem, to target: Endpoint, _ why: Comment
    ) {
        let before = phone.store.outboundQueue
        let prefs = phone.store.sourcePrefs
        #expect(!Sender.retargetHeld(id: old.id, to: target, store: phone.store), why)
        #expect(phone.store.outboundQueue == before, why)
        #expect(phone.store.sourcePrefs == prefs, why)
    }

    @Test func refusedForThisPhone() throws {
        let phone = Phone([Device("a"), Device("b")])
        expectRefused(phone, try phone.hold("a", targetGone: true), to: phone.me.endpoint, "this phone")
    }

    @Test func refusedForAConsole() throws {
        let phone = Phone([Device("a"), Device("c", kind: "console")])
        let console = try #require(phone.devices["c"])
        expectRefused(phone, try phone.hold("a", targetGone: true), to: console.endpoint, "a console")
    }

    @Test func refusedForADeviceTheWatchHasNotAccepted() throws {
        let phone = Phone([Device("a")])
        let old = try phone.hold("a", targetGone: true)
        // Listed, but never run through the rule: the watch does not know it.
        let stranger = Device("stranger")
        phone.store.cachedEndpoints += [stranger.endpoint]
        expectRefused(phone, old, to: stranger.endpoint, "an id the watch has not accepted")
    }

    @Test func refusedForADeviceThisPhoneRemovedThatTheRelayStillLists() throws {
        let phone = Phone([Device("a"), Device("x")])
        let old = try phone.hold("a", targetGone: true)
        let x = try #require(phone.devices["x"])
        NewDevices.recordRemoval(id: "x", store: phone.store)
        phone.relayLists(["a", "x"])
        expectRefused(phone, old, to: x.endpoint, "a removed id still listed")
    }

    @Test func refusedForADeviceWithAPendingNotice() throws {
        // Since P-23 this phone stores no pending notice (`settleNotices`), but a record an
        // earlier build left can carry one, and the rule still honours it.
        var phone = Phone([Device("a")])
        let old = try phone.hold("a", targetGone: true)
        let newcomer = Device("n")
        phone.devices["n"] = newcomer
        phone.relayLists(["a", "n"])
        phone.store.updateNewDeviceWatch { prev in
            prev.map { watch in
                var pending = watch
                pending.unconfirmed = [
                    NewDeviceNotice(
                        id: "n", label: newcomer.endpoint.label, createdAt: newcomer.endpoint.createdAt
                    ),
                ]
                return pending
            }
        }
        expectRefused(phone, old, to: newcomer.endpoint, "a device with a pending notice")

        // The next list settles it: told once, it may be chosen.
        phone.relayLists(["a", "n"])
        #expect(phone.store.newDeviceWatch?.unconfirmed.isEmpty == true)
        #expect(Sender.retargetHeld(id: old.id, to: newcomer.endpoint, store: phone.store))
    }

    @Test func refusedForALinkThatIsNotAnOpenableWebAddress() throws {
        let phone = Phone([Device("a"), Device("b")])
        let b = try #require(phone.devices["b"])
        for url in ["javascript:alert(1)", "file:///etc/hosts", "https://"] {
            let old = try phone.hold("a", url: url, targetGone: true)
            expectRefused(phone, old, to: b.endpoint, "\(url)")
        }
    }
}

/// What the home screen reads (`HeldTargets`): the same answers as the flush.
struct HeldTargetsTests {
    @Test func aDeviceThisPhoneRemovedIsGoneAndSaidToBeRemovedHere() throws {
        let phone = Phone([Device("a"), Device("x")])
        let removed = try phone.hold("x")
        let other = try phone.hold("a", targetGone: true)
        NewDevices.recordRemoval(id: "x", store: phone.store)
        phone.relayLists(["a", "x"])

        let targets = HeldTargets(store: phone.store)
        #expect(targets.isGone(removed))
        #expect(targets.removedHere(removed))
        #expect(targets.isGone(other), "the relay's flag")
        #expect(!targets.removedHere(other))
        #expect(targets.choices.map(\.id) == ["a"])
    }

    @Test func aWatchFromAnotherPairingAcceptsAndOffersNothing() throws {
        let phone = Phone([Device("a")])
        let item = try phone.hold("a")
        phone.store.newDeviceWatch?.selfId = "someone-else"

        let targets = HeldTargets(store: phone.store)
        #expect(targets.acceptedIds.isEmpty)
        #expect(targets.choices.isEmpty)
        #expect(!targets.isGone(item), "an empty list proves nothing")
    }
}
