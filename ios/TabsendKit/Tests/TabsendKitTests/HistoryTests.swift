import Testing
import Foundation
@testable import TabsendKit

/// The merged group history [ADR-0028]. The rules under test are the ones all four
/// clients have to agree on: which key opens a blob, what "never arrived" means,
/// and how sent and received rows share one timeline.
private let selfId = "ep-self"

private func payload(
    _ url: String = "https://example.com/a",
    title: String? = "A tab",
    sentAt: String = "2026-08-05T10:00:00.000Z",
    batch: SendPayload.Batch? = nil
) -> SendPayload {
    SendPayload(url: url, title: title, sentAt: sentAt, batch: batch)
}

private func sealedEntry(
    id: String,
    from source: String,
    to target: String,
    key: GroupKeyRecord,
    createdAt: String = "2026-08-05T10:00:00.000Z",
    expiresAt: String = "2026-08-12T10:00:00.000Z",
    ackedAt: String? = nil,
    record: HistoryRecord = HistoryRecord(
        payload: payload(), sourceLabelAtSend: "iPhone", targetLabelAtSend: "Chrome · Work"
    )
) throws -> HistoryEntry {
    HistoryEntry(
        id: id,
        sourceEndpointId: source,
        targetEndpointId: target,
        createdAt: createdAt,
        expiresAt: expiresAt,
        ackedAt: ackedAt,
        blob: try Sealer.sealGroup(
            plaintext: Wire.encoder.encode(record), groupKeyBase64: key.key, keyId: key.keyId
        )
    )
}

private func inboxItem(
    _ id: String,
    sentAt: String = "2026-08-05T09:00:00.000Z",
    openedAt: Date? = nil,
    batch: SendPayload.Batch? = nil
) -> InboxItem {
    InboxItem(
        id: id, url: "https://example.com/\(id)", title: "Tab \(id)",
        sourceLabel: "Chrome · Work", sentAt: sentAt,
        receivedAt: Date(timeIntervalSince1970: 1), batch: batch, openedAt: openedAt
    )
}

struct HistoryProjectionTests {
    @Test func aBlobOpensWhenTheRingHoldsTheKeyItNames() throws {
        let key = Keyring.generate()
        let entry = try sealedEntry(id: "m1", from: selfId, to: "ep-b", key: key)
        let item = History.project(entry, ring: [Keyring.generate(), key])
        #expect(item.payload?.url == "https://example.com/a")
        #expect(item.sourceLabel == "iPhone")
        #expect(item.targetLabel == "Chrome · Work")
        #expect(!item.isMetadataOnly)
    }

    @Test func aBlobUnderAKeyWeLackStaysAsARowRatherThanVanishing() throws {
        // A transfer really happened. The relay's routing facts about it are true
        // whether or not this phone can read what moved.
        let entry = try sealedEntry(id: "m1", from: "ep-a", to: "ep-b", key: Keyring.generate())
        let item = History.project(
            entry, ring: [], labels: ["ep-a": "Pixel", "ep-b": "Mac"]
        )
        #expect(item.isMetadataOnly)
        #expect(item.id == "m1")
        // Falls back to the CURRENT labels, since the ones from send time were
        // sealed inside the blob along with everything else.
        #expect(item.sourceLabel == "Pixel")
        #expect(item.targetLabel == "Mac")
    }

    @Test func labelsFromInsideTheBlobBeatTheCurrentEndpointList() throws {
        // The point of snapshotting: a row still reads correctly after a rename.
        let key = Keyring.generate()
        let entry = try sealedEntry(
            id: "m1", from: "ep-a", to: "ep-b", key: key,
            record: HistoryRecord(
                payload: payload(), sourceLabelAtSend: "Pixel (old name)",
                targetLabelAtSend: "Mac (old name)"
            )
        )
        let item = History.project(entry, ring: [key], labels: ["ep-a": "Pixel", "ep-b": "Mac"])
        #expect(item.sourceLabel == "Pixel (old name)")
    }

    @Test func aReceivedTabWithNoHistoryRowIsStillAHistoryRow() {
        // A sender that predates ADR-0028, or a relay that does. Dropping these
        // would make the new screen show less than the one it replaces.
        let item = History.project(
            inboxItem: inboxItem("m1"), selfEndpointId: selfId, selfLabel: "iPhone"
        )
        #expect(History.direction(item, selfEndpointId: selfId) == .received)
        #expect(History.state(item) == .arrived)
        #expect(item.payload?.url == "https://example.com/m1")
    }
}

struct HistoryStateTests {
    private func item(ackedAt: String?, expiresAt: String?) -> HistoryItem {
        HistoryItem(
            id: "m", sourceEndpointId: selfId, targetEndpointId: "ep-b",
            createdAt: "2026-08-05T10:00:00.000Z", expiresAt: expiresAt, ackedAt: ackedAt
        )
    }

    private let now = WireDate.date(from: "2026-08-13T10:00:00.000Z")!

    @Test func ackedMeansArrived() {
        #expect(
            History.state(
                item(ackedAt: "2026-08-05T10:00:01.000Z", expiresAt: "2026-08-12T10:00:00.000Z"),
                now: now
            ) == .arrived
        )
    }

    @Test func unackedPastTheTtlMeansItNeverArrived() {
        #expect(
            History.state(item(ackedAt: nil, expiresAt: "2026-08-12T10:00:00.000Z"), now: now)
                == .neverArrived
        )
    }

    @Test func unackedInsideTheTtlIsStillWaiting() {
        #expect(
            History.state(item(ackedAt: nil, expiresAt: "2026-08-20T10:00:00.000Z"), now: now)
                == .waiting
        )
    }

    @Test func aRowWithNoExpiryIsNeverDeclaredLost() {
        // Nothing here can say the tab is gone, and guessing would put "Never
        // arrived" on a screen with nothing behind it.
        #expect(History.state(item(ackedAt: nil, expiresAt: nil), now: now) == .waiting)
    }

    @Test func onlyOurOwnExpiredSendsAreAnnounced() {
        let mine = HistoryItem(
            id: "mine", sourceEndpointId: selfId, targetEndpointId: "ep-b",
            createdAt: "2026-08-05T10:00:00.000Z", expiresAt: "2026-08-12T10:00:00.000Z"
        )
        let theirs = HistoryItem(
            id: "theirs", sourceEndpointId: "ep-a", targetEndpointId: "ep-b",
            createdAt: "2026-08-05T10:00:00.000Z", expiresAt: "2026-08-12T10:00:00.000Z"
        )
        let found = History.unannouncedNeverArrived(
            [mine, theirs], selfEndpointId: selfId, announced: [], now: now
        )
        #expect(found.map(\.id) == ["mine"])
    }

    @Test func announcedSendsAreNotAnnouncedAgain() {
        let mine = HistoryItem(
            id: "mine", sourceEndpointId: selfId, targetEndpointId: "ep-b",
            createdAt: "2026-08-05T10:00:00.000Z", expiresAt: "2026-08-12T10:00:00.000Z"
        )
        #expect(
            History.unannouncedNeverArrived(
                [mine], selfEndpointId: selfId, announced: ["mine"], now: now
            ).isEmpty
        )
    }
}

struct HistoryMergeTests {
    @Test func relayRowsAndInboxRowsShareOneTimelineNewestFirst() throws {
        let key = Keyring.generate()
        let sent = History.project(
            try sealedEntry(
                id: "sent", from: selfId, to: "ep-b", key: key,
                createdAt: "2026-08-05T12:00:00.000Z"
            ),
            ring: [key]
        )
        let merged = History.merge(
            relay: [sent], inbox: [inboxItem("recv", sentAt: "2026-08-05T09:00:00.000Z")],
            selfEndpointId: selfId, selfLabel: "iPhone"
        )
        #expect(merged.map(\.id) == ["sent", "recv"])
        #expect(History.direction(merged[0], selfEndpointId: selfId) == .sent)
        #expect(History.direction(merged[1], selfEndpointId: selfId) == .received)
    }

    @Test func theRelayRowWinsButTheInboxStillSuppliesOpenedAt() throws {
        // Whether the user opened a tab is a fact only this phone has; the relay
        // holds the delivery state the inbox knows nothing about.
        let key = Keyring.generate()
        let opened = Date(timeIntervalSince1970: 90_000)
        let entry = try sealedEntry(
            id: "m1", from: "ep-a", to: selfId, key: key, ackedAt: "2026-08-05T10:00:01.000Z"
        )
        let merged = History.merge(
            relay: [History.project(entry, ring: [key])],
            inbox: [inboxItem("m1", openedAt: opened)],
            selfEndpointId: selfId, selfLabel: "iPhone"
        )
        #expect(merged.count == 1)
        #expect(merged[0].openedAt == opened)
        #expect(merged[0].ackedAt != nil)
    }

    @Test func aStaleOpenedAtInTheCacheIsNotTrusted() throws {
        // The cache is re-merged on every read, so a row the user has NOT opened
        // cannot stay dimmed because an older write said otherwise.
        let cached = HistoryItem(
            id: "m1", sourceEndpointId: "ep-a", targetEndpointId: selfId,
            createdAt: "2026-08-05T10:00:00.000Z", openedAt: Date(timeIntervalSince1970: 5)
        )
        let merged = History.merge(
            relay: [cached], inbox: [inboxItem("m1", openedAt: nil)],
            selfEndpointId: selfId, selfLabel: "iPhone"
        )
        #expect(merged[0].openedAt == nil)
    }

    @Test func theCacheIsCappedAtTheNewest() {
        let rows = (0..<60).map { i in
            HistoryItem(
                id: "m\(i)", sourceEndpointId: selfId, targetEndpointId: "ep-b",
                createdAt: String(format: "2026-08-05T10:%02d:00.000Z", i)
            )
        }
        let merged = History.merge(relay: rows, inbox: [], selfEndpointId: selfId, selfLabel: nil)
        #expect(merged.count == History.maxItems)
        #expect(merged.first?.id == "m59")
    }

    @Test func groupingWorksTheSameWayItDoesForReceivedTabs() {
        // Same implementation, deliberately: the screen shows sent and received
        // rows side by side, so two ideas of what a batch is would be visible.
        let batch = SendPayload.Batch(id: "b1", count: 3)
        let rows = (0..<2).map { i in
            HistoryItem(
                id: "m\(i)", sourceEndpointId: selfId, targetEndpointId: "ep-b",
                createdAt: "2026-08-05T10:0\(i):00.000Z",
                payload: payload(batch: batch)
            )
        }
        let groups = Inbox.group(History.merge(
            relay: rows, inbox: [], selfEndpointId: selfId, selfLabel: nil
        ))
        #expect(groups.count == 1)
        #expect(Inbox.batchHeading(groups[0]) == "2 of 3 tabs")
    }
}

struct HistoryCopyTests {
    private func item(
        source: String, target: String, payload: SendPayload? = payload()
    ) -> HistoryItem {
        HistoryItem(
            id: "m", sourceEndpointId: source, targetEndpointId: target,
            createdAt: "2026-08-05T10:00:00.000Z",
            expiresAt: "2026-08-12T10:00:00.000Z",
            payload: payload, sourceLabel: "Pixel", targetLabel: "Mac"
        )
    }

    @Test func directionPicksMailImageryNeverABareArrow() {
        #expect(History.symbol(.sent) == "paperplane")
        #expect(History.symbol(.received) == "tray.and.arrow.down")
        #expect(History.symbol(.between) == "arrow.left.arrow.right")
    }

    @Test func aRowBetweenTwoOtherDevicesNamesBothEnds() {
        // Where a preposition has nothing to attach to, an arrow finally earns its
        // place: between two device names (ADR-0028 decision 9).
        let row = item(source: "ep-a", target: "ep-b")
        #expect(History.route(row, direction: .between) == "Pixel → Mac")
        #expect(History.route(row, direction: .sent) == "to Mac")
        #expect(History.route(row, direction: .received) == "from Pixel")
    }

    @Test func anUnreadableRowSaysWhyRatherThanShowingABlank() {
        let row = item(source: "ep-a", target: "ep-b", payload: nil)
        #expect(History.displayTitle(row) == "A tab this phone can't read")
        #expect(History.subtitle(row, direction: .between).contains("group key this phone doesn't have"))
    }

    @Test func aTitlelessTabFallsBackToItsHost() {
        let row = item(source: selfId, target: "ep-b", payload: payload(title: nil))
        #expect(History.displayTitle(row) == "example.com")
    }

    @Test func aGroupedRowLeavesTheRouteAndAgeToItsHeader() {
        let row = item(source: selfId, target: "ep-b")
        #expect(History.subtitle(row, direction: .sent, grouped: true) == "example.com")
    }

    @Test func everyStateHasASentence() {
        let now = WireDate.date(from: "2026-08-13T10:00:00.000Z")!
        var row = item(source: selfId, target: "ep-b")
        #expect(History.stateLine(row, now: now) == "Never arrived")
        row.ackedAt = "2026-08-05T10:00:01.000Z"
        #expect(History.stateLine(row, now: now) == "Arrived")
        row.ackedAt = nil
        row.expiresAt = "2026-08-20T10:00:00.000Z"
        #expect(History.stateLine(row, now: now) == "Waiting for Mac")
    }

    @Test func shippedCopyCarriesNoEmDash() {
        // House rule, enforced rather than remembered.
        let lines = [
            History.retentionLine(relayKeepsHistory: true),
            History.retentionLine(relayKeepsHistory: false),
            History.displayTitle(item(source: "ep-a", target: "ep-b", payload: nil)),
            History.subtitle(item(source: selfId, target: "ep-b"), direction: .sent),
            History.stateLine(item(source: selfId, target: "ep-b")) ?? "",
        ]
        for line in lines {
            #expect(!line.contains("—"), "em dash in: \(line)")
            #expect(!line.lowercased().contains("please"), "'please' in: \(line)")
        }
    }
}

struct HistorySendAgainTests {
    private func row(_ url: String?, batch: SendPayload.Batch? = nil) -> HistoryItem {
        HistoryItem(
            id: "m1", sourceEndpointId: selfId, targetEndpointId: "ep-target",
            createdAt: "2026-08-05T10:00:00.000Z", expiresAt: "2026-08-12T10:00:00.000Z",
            payload: url.map { payload($0, batch: batch) }
        )
    }

    @Test func aWebLinkIsOfferedAsAFreshSend() throws {
        let now = WireDate.date(from: "2026-10-13T12:00:00.000Z")!
        let again = try #require(
            History.sendAgainPayload(row("https://example.com/a", batch: .init(id: "b", count: 3)), now: now)
        )
        #expect(again.url == "https://example.com/a")
        #expect(again.title == "A tab")
        #expect(again.sentAt == "2026-10-13T12:00:00.000Z")
        #expect(again.batch == nil, "one re-sent tab is a send of one")
    }

    @Test func aLinkThatCouldNotBeOpenedIsNotOffered() {
        // The link came out of a history blob any group member can write, so it
        // gets the same check as a received link before it goes anywhere.
        for url in ["javascript:alert(1)", "data:text/html,hi", "file:///etc/passwd",
                    "tabsend://pair", "https://", "not a url"] {
            #expect(History.sendAgainPayload(row(url)) == nil, "\(url)")
        }
    }

    @Test func aRowWithNoPlaintextIsNotOffered() {
        #expect(History.sendAgainPayload(row(nil)) == nil)
    }
}
