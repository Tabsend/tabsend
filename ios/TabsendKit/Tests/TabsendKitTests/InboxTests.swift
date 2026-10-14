import Testing
import Foundation
@testable import TabsendKit

/// The received-tabs inbox [P-7]. Mirrors extension/src/lib/inbox.test.ts and
/// android/.../InboxTest.kt case for case — three clients must not disagree
/// about what a batch is or about what the count line says.
private func item(
    _ id: String,
    batch: SendPayload.Batch? = nil,
    openedAt: Date? = nil,
    receivedAt: Date = Date(timeIntervalSince1970: 1),
    title: String? = nil
) -> InboxItem {
    InboxItem(
        id: id,
        url: "https://example.com/\(id)",
        title: title,
        sourceLabel: "Chrome · Work",
        sentAt: "2026-08-05T10:00:00.000Z",
        receivedAt: receivedAt,
        batch: batch,
        openedAt: openedAt
    )
}

/// Record a whole batch the way the drain does: one at a time, in order.
private func recordAll(_ start: [InboxItem], _ items: [InboxItem]) -> [InboxItem] {
    items.reduce(start) { Inbox.record($0, $1) }
}

struct InboxRecordTests {
    @Test func projectSnapshotsTheSenderLabelAndCarriesTheBatch() {
        let payload = SendPayload(
            url: "https://a.test/",
            title: "Roadmap",
            sentAt: "2026-08-05T10:00:00.000Z",
            batch: SendPayload.Batch(id: "b1", count: 3)
        )
        let result = Inbox.project(
            messageId: "m1", payload: payload,
            sourceLabel: "Firefox · Laptop", receivedAt: Date(timeIntervalSince1970: 5)
        )
        #expect(result.sourceLabel == "Firefox · Laptop")
        #expect(result.title == "Roadmap")
        #expect(result.batch == SendPayload.Batch(id: "b1", count: 3))
        #expect(result.openedAt == nil)
    }

    @Test func newestArrivalComesFirst() {
        #expect(recordAll([], [item("a"), item("b")]).map(\.id) == ["b", "a"])
    }

    @Test func recordingIsIdempotentOnTheMessageId() {
        let once = Inbox.record([], item("a"))
        #expect(Inbox.record(once, item("a")) == once)
    }

    @Test func aRedeliveryDoesNotResurrectAnOpenedTabAsUnopened() {
        let opened = [item("a", openedAt: Date(timeIntervalSince1970: 42))]
        #expect(Inbox.record(opened, item("a")).first?.openedAt == Date(timeIntervalSince1970: 42))
    }

    @Test func theOldestFallsOffPastTheCap() {
        let many = (0..<(Inbox.maxItems + 10)).map { item("m\($0)") }
        let list = recordAll([], many)
        #expect(list.count == Inbox.maxItems)
        #expect(list.first?.id == "m\(Inbox.maxItems + 9)")
        #expect(!list.contains { $0.id == "m0" })
    }
}

struct InboxOpenedTests {
    @Test func markingStampsTheTabOnce() {
        let first = Date(timeIntervalSince1970: 99)
        let list = Inbox.markOpened([item("a")], id: "a", at: first)
        #expect(list.first?.openedAt == first)
        // A second open keeps the FIRST time.
        let again = Inbox.markOpened(list, id: "a", at: Date(timeIntervalSince1970: 500))
        #expect(again.first?.openedAt == first)
    }

    @Test func markingIgnoresAnIdItDoesNotHold() {
        let list = [item("a")]
        #expect(Inbox.markOpened(list, id: "nope", at: Date()) == list)
    }

    @Test func aWholeBatchIsStampedAtOnce() {
        let at = Date(timeIntervalSince1970: 7)
        let list = Inbox.markOpened([item("a"), item("b")], ids: ["a", "b"], at: at)
        #expect(list.allSatisfy { $0.openedAt == at })
    }
}

struct InboxGroupingTests {
    @Test func singleSendsPassThroughAsGroupsOfOne() {
        let groups = Inbox.group([item("a"), item("b")])
        #expect(groups.count == 2)
        #expect(groups.first?.batchId == nil)
    }

    @Test func aGroupRestoresTheOrderTheSenderPickedItsTabsIn() {
        let batch = SendPayload.Batch(id: "b1", count: 3)
        let list = recordAll([], [item("one", batch: batch), item("two", batch: batch), item("three", batch: batch)])
        // Stored newest-first, so the raw list is reversed...
        #expect(list.map(\.id) == ["three", "two", "one"])
        // ...and the group puts them back.
        #expect(Inbox.group(list).first?.items.map(\.id) == ["one", "two", "three"])
    }

    @Test func aBatchSplitAcrossDrainsStillGroups() {
        let batch = SendPayload.Batch(id: "b1", count: 2)
        let list = recordAll([], [item("one", batch: batch), item("single"), item("two", batch: batch)])
        let groups = Inbox.group(list)
        #expect(groups.count == 2)
        // The group holds the position of its FIRST item in the newest-first list.
        #expect(groups[0].batchId == "b1")
        #expect(groups[0].items.map(\.id) == ["one", "two"])
        #expect(groups[1].items.map(\.id) == ["single"])
    }

    @Test func aGroupTrustsTheLargestCountAnyOfItsTabsCarries() {
        let list = [
            item("a", batch: SendPayload.Batch(id: "b", count: 2)),
            item("c", batch: SendPayload.Batch(id: "b", count: 5)),
        ]
        #expect(Inbox.group(list).first?.sentCount == 5)
    }

    @Test func theCountLineAdmitsAGapInsteadOfQuietlyShowingFewer() {
        #expect(Inbox.batchHeading(InboxGroup(batchId: "b", sentCount: 3, items: [item("a"), item("b"), item("c")])) == "3 tabs")
        #expect(Inbox.batchHeading(InboxGroup(batchId: "b", sentCount: 3, items: [item("a"), item("b")])) == "2 of 3 tabs")
        // And it never claims fewer tabs than it is showing.
        #expect(Inbox.batchHeading(InboxGroup(batchId: "b", sentCount: 1, items: [item("a"), item("b")])) == "2 tabs")
    }
}

struct InboxRowTests {
    @Test func aRowFallsBackToTheHostWhenTheTabHadNoTitle() {
        #expect(Inbox.displayTitle(item("a", title: "Roadmap")) == "Roadmap")
        #expect(Inbox.displayTitle(item("a")) == "example.com")
        #expect(Inbox.displayTitle(item("a", title: "   ")) == "example.com")
    }

    @Test func hostOfHandsBackWhatItCannotParse() {
        #expect(Inbox.hostOf("https://example.com/deep/path?q=1") == "example.com")
        #expect(Inbox.hostOf("not a url") == "not a url")
    }

    @Test func relativeTimeMatchesTheWordingTheOtherClientsUse() throws {
        let iso = "2026-08-05T10:00:00.000Z"
        let then = try #require(WireDate.date(from: iso))
        #expect(Inbox.relativeTime(iso, now: then.addingTimeInterval(30)) == "just now")
        #expect(Inbox.relativeTime(iso, now: then.addingTimeInterval(180)) == "3m ago")
        #expect(Inbox.relativeTime(iso, now: then.addingTimeInterval(7200)) == "2h ago")
        #expect(Inbox.relativeTime(iso, now: then.addingTimeInterval(5 * 86_400)) == "5d ago")
        #expect(Inbox.relativeTime("not a date") == "unknown")
    }
}
