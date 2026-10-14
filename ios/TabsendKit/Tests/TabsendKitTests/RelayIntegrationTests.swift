#if os(macOS)
import Testing
import Foundation
@testable import TabsendKit

/// End-to-end tests against a REAL relay. Skipped unless the environment
/// provides one:
///
///   TABSEND_RELAY_URL=https://127.0.0.1:18787 \
///   TABSEND_RELAY_FP=<pin from the relay boot log> \
///   ./test.sh --filter RelayIntegration
///
/// The relay under test must run with ALLOW_MULTIPLE_GROUPS=1. This test makes its
/// OWN group so it starts from a known-empty state, and a default relay now owns its
/// single group and refuses a second create ([0022], [0023]). That is a test-harness
/// need, not a hole in the app: the shipped iOS app never creates a group, it always
/// joins with a complete pairing link.
///
/// Exercises the full loop the iOS app performs: pinned TLS -> config ->
/// register (create group) -> mint a pairing link -> join -> send sealed -> drain ->
/// verify plaintext -> ack.
struct RelayIntegrationTests {
    private var relayUrl: String? { ProcessInfo.processInfo.environment["TABSEND_RELAY_URL"] }
    private var pin: String? { ProcessInfo.processInfo.environment["TABSEND_RELAY_FP"] }

    @Test func fullPairSendReceiveLoop() async throws {
        guard let relayUrl else { return } // no relay configured: skip silently

        // Device A creates the group.
        let storeA = MemoryStore()
        let outcomeA = try await Registrar.join(
            relayUrl: relayUrl, pairingCode: nil,
            label: "TestSender · Mac", deviceName: "Mac",
            certFingerprint: pin, store: storeA
        )
        // No recovery phrase comes back: pairing links are the only way in [0021].
        #expect(outcomeA.registration.groupId.isEmpty == false)
        #expect(outcomeA.registration.relayId != nil)

        let apiA = ApiClient(
            relayUrl: relayUrl,
            deviceToken: outcomeA.registration.deviceToken,
            certFingerprint: pin
        )

        // Mint a complete pairing link, join as device B (the "iPhone").
        let minted = try await apiA.createPairing()
        let parsed = try #require(Pairing.parse(minted.link))
        #expect(parsed.relayUrl == relayUrl)
        if pin != nil { #expect(parsed.certFingerprint == pin, "pairing link re-emits the pin") }

        let storeB = MemoryStore()
        let outcomeB = try await Registrar.join(
            relayUrl: parsed.relayUrl, pairingCode: parsed.code,
            label: "TestPhone · iPhone", deviceName: "iPhone",
            certFingerprint: parsed.certFingerprint, store: storeB
        )
        #expect(outcomeB.registration.groupId == outcomeA.registration.groupId)

        // A sees B in the endpoint list.
        let endpoints = try await apiA.listEndpoints()
        #expect(endpoints.count == 2)
        let targetB = try #require(endpoints.first { $0.id == outcomeB.registration.endpointId })
        #expect(targetB.kind == "mobile")
        #expect(targetB.platform == "ios")

        // A sends a sealed link to B.
        let payload = SendPayload(
            url: "https://example.com/a?b=c&d=e#frag",
            title: "Integration ✈️",
            sentAt: WireDate.string(from: Date())
        )
        let sendResult = await Sender.send(payload: payload, to: targetB, store: storeA, api: apiA)
        #expect(sendResult.ok, "send failed: \(sendResult.failure.map(String.init(describing:)) ?? "-")")
        // No classified failure is the ONLY proof a surface has that the relay
        // took it, so this is the assertion that "Sent" would be honest.
        #expect(sendResult.failure == nil)

        // B drains: verifies sender by keyId, opens, presents, acks.
        actor Received {
            var payloads: [SendPayload] = []
            func add(_ p: SendPayload) { payloads.append(p) }
        }
        let received = Received()
        let deliverer = Deliverer(store: storeB) { payload, _ in
            await received.add(payload)
            return true
        }
        let summary = await deliverer.drain()
        #expect(summary.delivered == 1, "drain summary: \(summary)")
        let got = try #require(await received.payloads.first)
        #expect(got.url == payload.url)
        #expect(got.title == payload.title)

        // Acked: a second drain delivers nothing and the queue is empty.
        let second = await deliverer.drain()
        #expect(second.delivered == 0)
        let apiB = ApiClient(
            relayUrl: relayUrl,
            deviceToken: outcomeB.registration.deviceToken,
            certFingerprint: pin
        )
        let pending = try await apiB.getPending()
        #expect(pending.isEmpty)

        // The relay has now DELETED the payload, so B's own record is the only
        // copy of that link left anywhere [P-7]. Before the inbox, a swiped
        // notification at this point lost the tab for good.
        let inbox = storeB.inbox
        #expect(inbox.count == 1)
        let kept = try #require(inbox.first)
        #expect(kept.url == payload.url)
        #expect(kept.title == payload.title)
        #expect(kept.sourceLabel == "TestSender · Mac", "the sender label is snapshotted at receipt")
        #expect(kept.openedAt == nil, "nothing has been opened yet")
        // A re-drain must not double the row, and marking it opened must stick.
        #expect(storeB.inbox.count == 1)
        storeB.updateInbox { Inbox.markOpened($0, id: kept.id, at: Date()) }
        #expect(storeB.inbox.first?.openedAt != nil)

        // Heartbeat + rename round-trip.
        let hb = try await apiB.heartbeat(endpointId: outcomeB.registration.endpointId)
        #expect(hb.presence == "online")
        let renamed = try await apiB.rename(
            endpointId: outcomeB.registration.endpointId, label: "TestPhone renamed"
        )
        #expect(renamed.label == "TestPhone renamed")

        // Clean up the group so repeated runs stay tidy.
        try await apiA.removeEndpoint(id: outcomeB.registration.endpointId)
        try await apiA.removeEndpoint(id: outcomeA.registration.endpointId)
    }

    @Test func wrongPinIsRejected() async throws {
        guard let relayUrl, pin != nil else { return } // needs a TLS relay: skip
        let badPin = String(repeating: "A", count: 43)
        let api = ApiClient(relayUrl: relayUrl, certFingerprint: badPin)
        await #expect(throws: Error.self, "a wrong pin must fail the TLS handshake") {
            _ = try await api.getConfig()
        }
    }

    @Test func streamHelloAndMessageEvent() async throws {
        guard let relayUrl else { return }

        let storeA = MemoryStore()
        let a = try await Registrar.join(
            relayUrl: relayUrl, pairingCode: nil,
            label: "StreamA · Mac", deviceName: "Mac",
            certFingerprint: pin, store: storeA
        )
        let apiA = ApiClient(relayUrl: relayUrl, deviceToken: a.registration.deviceToken, certFingerprint: pin)
        let minted = try await apiA.createPairing()
        let parsed = try #require(Pairing.parse(minted.link))
        let storeB = MemoryStore()
        let b = try await Registrar.join(
            relayUrl: parsed.relayUrl, pairingCode: parsed.code,
            label: "StreamB · iPhone", deviceName: "iPhone",
            certFingerprint: parsed.certFingerprint, store: storeB
        )

        // B holds the socket; A sends; B must get a messageWaiting tickle.
        actor Signal {
            var fired = false
            func fire() { fired = true }
        }
        let signal = Signal()
        let stream = StreamClient(
            relayUrl: relayUrl,
            deviceToken: b.registration.deviceToken,
            certFingerprint: pin
        ) { event in
            if case .messageWaiting = event { await signal.fire() }
        }
        await stream.start()
        try await Task.sleep(nanoseconds: 500_000_000) // hello + initial drain tickle

        let endpoints = try await apiA.listEndpoints()
        let targetB = try #require(endpoints.first { $0.id == b.registration.endpointId })
        // The hello marks B online via a live socket.
        #expect(targetB.presence == "online")

        let payload = SendPayload(url: "https://example.com/stream", sentAt: WireDate.string(from: Date()))
        let result = await Sender.send(payload: payload, to: targetB, store: storeA, api: apiA)
        #expect(result.ok)

        var woke = false
        for _ in 0..<20 {
            try await Task.sleep(nanoseconds: 250_000_000)
            if await signal.fired { woke = true; break }
        }
        #expect(woke, "expected a message event over the stream")
        await stream.stop()

        try await apiA.removeEndpoint(id: b.registration.endpointId)
        try await apiA.removeEndpoint(id: a.registration.endpointId)
    }

    /// The whole of ADR-0028 against a real relay: mint a key, hand it to the
    /// other device, seal a history blob on send, and read the group's history
    /// back from BOTH ends.
    ///
    /// Worth the round trips because the parts that can silently disagree are all
    /// on the wire: the shape `POST /v1/group-keys` accepts, the fingerprint the
    /// relay computes for `targetKeyId`, and whether `?history=1` returns rows to
    /// a device that was neither end of them.
    @Test func groupKeyDistributionAndHistory() async throws {
        guard let relayUrl else { return } // no relay configured: skip silently

        let storeA = MemoryStore()
        let a = try await Registrar.join(
            relayUrl: relayUrl, pairingCode: nil,
            label: "HistoryA · Mac", deviceName: "Mac", certFingerprint: pin, store: storeA
        )
        let apiA = ApiClient(
            relayUrl: relayUrl, deviceToken: a.registration.deviceToken, certFingerprint: pin
        )
        let minted = try await apiA.createPairing()
        let parsed = try #require(Pairing.parse(minted.link))
        let storeB = MemoryStore()
        let b = try await Registrar.join(
            relayUrl: parsed.relayUrl, pairingCode: parsed.code,
            label: "HistoryB · iPhone", deviceName: "iPhone",
            certFingerprint: parsed.certFingerprint, store: storeB
        )
        let apiB = ApiClient(
            relayUrl: relayUrl, deviceToken: b.registration.deviceToken, certFingerprint: pin
        )
        let endpoints = try await apiA.listEndpoints()
        storeA.cachedEndpoints = endpoints
        storeB.cachedEndpoints = endpoints

        // Exactly one of the two is elected to mint, so run the pass on both and
        // let the election decide — which is what actually happens in the field.
        _ = await GroupHistorySync.run(store: storeA, api: apiA, endpoints: endpoints)
        _ = await GroupHistorySync.run(store: storeB, api: apiB, endpoints: endpoints)
        // A second pass on each: the minter delivers, and the other one collects.
        _ = await GroupHistorySync.run(store: storeA, api: apiA, endpoints: endpoints)
        _ = await GroupHistorySync.run(store: storeB, api: apiB, endpoints: endpoints)

        let keyA = try #require(Keyring.current(storeA.groupKeyring))
        let keyB = try #require(Keyring.current(storeB.groupKeyring))
        #expect(keyA.keyId == keyB.keyId, "both devices converge on one current key")
        #expect(keyA.key == keyB.key)

        // A sends a tab to B. The history blob rides along.
        let target = try #require(endpoints.first { $0.id == b.registration.endpointId })
        let payload = SendPayload(
            url: "https://example.com/history?x=1",
            title: "Group history ✈️",
            sentAt: WireDate.string(from: Date())
        )
        let sent = await Sender.send(payload: payload, to: target, store: storeA, api: apiA)
        #expect(sent.ok)
        #expect(sent.failure == nil)

        // The SENDER can read it back, which is the case that did not exist before
        // ADR-0028: the tab is gone from its queue and it never received anything.
        let reportA = await GroupHistorySync.run(store: storeA, api: apiA, endpoints: endpoints)
        #expect(reportA.relayKeepsHistory)
        let rowA = try #require(storeA.history.first { $0.id == sent.messageId })
        #expect(rowA.payload?.url == payload.url)
        #expect(rowA.sourceLabel == "HistoryA · Mac", "labels are snapshotted at send")
        #expect(rowA.targetLabel == "HistoryB · iPhone")
        #expect(History.direction(rowA, selfEndpointId: a.registration.endpointId) == .sent)
        #expect(History.state(rowA) == .waiting, "accepted, not yet acked, inside its TTL")

        // And so can the target, before it has even drained.
        _ = await GroupHistorySync.run(store: storeB, api: apiB, endpoints: endpoints)
        let rowB = try #require(storeB.history.first { $0.id == sent.messageId })
        #expect(rowB.payload?.url == payload.url)
        #expect(History.direction(rowB, selfEndpointId: b.registration.endpointId) == .received)

        // After B drains, the same row reads as arrived on the SENDER's screen.
        let deliverer = Deliverer(store: storeB) { _, _ in true }
        _ = await deliverer.drain()
        _ = await GroupHistorySync.run(store: storeA, api: apiA, endpoints: endpoints)
        let acked = try #require(storeA.history.first { $0.id == sent.messageId })
        #expect(History.state(acked) == .arrived)

        try await apiA.removeEndpoint(id: b.registration.endpointId)
        try await apiA.removeEndpoint(id: a.registration.endpointId)
    }

    /// A relay that predates ADR-0028 has no `/v1/group-keys` and refuses
    /// `?history=1`. That is the NORMAL state for a while — an app updates itself,
    /// a self-hosted relay is updated by hand — so it must read as "this group has
    /// no history", never as an error, and it must not touch sending or receiving.
    ///
    /// Simulated by pointing the client at a path prefix the relay does not serve,
    /// which produces exactly what an older relay produces: a 404 for every route
    /// the client asks for.
    @Test func aRelayWithoutGroupHistoryDegradesQuietly() async throws {
        guard let relayUrl else { return } // no relay configured: skip silently

        let store = MemoryStore()
        let joined = try await Registrar.join(
            relayUrl: relayUrl, pairingCode: nil,
            label: "OldRelay · Mac", deviceName: "Mac", certFingerprint: pin, store: store
        )
        let api = ApiClient(
            relayUrl: relayUrl, deviceToken: joined.registration.deviceToken, certFingerprint: pin
        )
        let endpoints = try await api.listEndpoints()

        // Something that was already on the screen has to survive the pass.
        let cached = HistoryItem(
            id: "cached", sourceEndpointId: joined.registration.endpointId,
            targetEndpointId: "gone", createdAt: WireDate.string(from: Date()),
            payload: SendPayload(url: "https://example.com/cached", sentAt: "2026-08-05T10:00:00.000Z")
        )
        store.history = [cached]

        let pre0028 = ApiClient(
            relayUrl: relayUrl + "/pre0028",
            deviceToken: joined.registration.deviceToken,
            certFingerprint: pin
        )
        let report = await GroupHistorySync.run(store: store, api: pre0028, endpoints: endpoints)
        #expect(!report.relayKeepsHistory, "the screen must be able to say why it is empty")
        #expect(!report.offline, "the relay answered; this is not a connectivity problem")
        #expect(report.neverArrived.isEmpty)
        #expect(store.history == [cached], "the cache is kept, not wiped")
        #expect(store.deliveredGroupKeys.isEmpty, "nothing was handed to anybody")
        // A key IS minted, deliberately: it costs 32 bytes, it cannot go anywhere
        // until the relay can carry it, and it means history starts working on the
        // first wake after the relay is updated rather than the second.
        #expect(!store.groupKeyring.isEmpty)

        // Sending is completely unaffected. It now carries a blob the old relay
        // simply ignores, exactly as it ignores any field it does not know.
        let sent = await Sender.send(
            payload: SendPayload(
                url: "https://example.com/still-works", sentAt: WireDate.string(from: Date())
            ),
            to: endpoints[0], store: store, api: api
        )
        #expect(sent.ok)
        #expect(sent.failure == nil)

        try await api.removeEndpoint(id: joined.registration.endpointId)
    }
}
#endif
