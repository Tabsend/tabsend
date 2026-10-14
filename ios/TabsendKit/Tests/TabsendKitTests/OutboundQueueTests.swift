import XCTest
@testable import TabsendKit

/// What bounds the source-side outbound queue.
///
/// The bug these pin: an item leaves the queue only on a definite answer from
/// the relay, which is right and stays — but nothing ever ENDED a wait, so a
/// relay that permanently 5xxes one envelope retried it on every flush and every
/// background refresh forever, and sharing through a long outage grew the queue
/// without bound. Mirrored by extension/src/lib/outbound.test.ts and by
/// OutboundQueueTest.kt.
final class OutboundQueueTests: XCTestCase {

    private let now = Date(timeIntervalSince1970: 1_776_000_000)
    private let day: TimeInterval = 24 * 60 * 60

    private struct Item: HeldItem {
        var id: String
        var createdAt: String
    }

    private func item(_ id: String, agoSeconds: TimeInterval = 0) -> Item {
        Item(id: id, createdAt: WireDate.string(from: now.addingTimeInterval(-agoSeconds)))
    }

    // MARK: the age cap

    /// Not a number of our own choosing: past this horizon the relay would have
    /// deleted the message anyway, so both sides hold one opinion about when a
    /// send is dead. Mirrors DEFAULT_MESSAGE_TTL_DAYS in shared/src/types.ts.
    func testAgeCapAgreesWithTheRelaysOwnMessageTTL() {
        XCTAssertEqual(OutboundQueue.maxAgeDays, 7)
        XCTAssertEqual(OutboundQueue.maxAge, 7 * day)
    }

    func testATabStillInsideTheWindowIsKept() {
        let plan = OutboundQueue.plan([item("a", agoSeconds: 6 * day)], now: now)
        XCTAssertEqual(plan.keep.map(\.id), ["a"])
        XCTAssertTrue(plan.expired.isEmpty)
    }

    /// THE failure this exists for. A relay that answers 5xx to one particular
    /// envelope keeps it queued by design — silence and "not now" must never cost
    /// a tab — so nothing but its own age can ever end the retrying.
    func testATabTheRelayNeverTookIsGivenUpOnAfterTheTTL() {
        let plan = OutboundQueue.plan(
            [item("poison", agoSeconds: 7 * day), item("fresh", agoSeconds: 60)],
            now: now
        )
        XCTAssertEqual(plan.expired.map(\.id), ["poison"])
        XCTAssertEqual(plan.keep.map(\.id), ["fresh"])
    }

    /// Age is measured from the send, never from the last retry. A queue that
    /// restamped its items on every failed flush would expire nothing at all.
    func testAgeIsMeasuredFromWhenTheUserHitSend() {
        let old = [item("a", agoSeconds: 8 * day)]
        XCTAssertEqual(OutboundQueue.plan(old, now: now).expired.count, 1)
        XCTAssertEqual(OutboundQueue.plan(old, now: now.addingTimeInterval(-2 * day)).expired.count, 0)
    }

    /// A formatting bug must not be allowed to delete somebody's tabs.
    func testAnUnreadableTimestampReadsAsNewNotAsAncient() {
        let plan = OutboundQueue.plan([Item(id: "a", createdAt: "not a date")], now: now)
        XCTAssertTrue(plan.expired.isEmpty)
        XCTAssertEqual(plan.keep.map(\.id), ["a"])
    }

    // MARK: the size cap

    func testNothingIsEvictedUntilTheCapIsReached() {
        let queue = (0..<OutboundQueue.maxItems).map { item("i\($0)", agoSeconds: TimeInterval($0)) }
        let plan = OutboundQueue.plan(queue, now: now)
        XCTAssertTrue(plan.evicted.isEmpty)
        XCTAssertEqual(plan.keep.count, OutboundQueue.maxItems)
    }

    /// Oldest-first, always: the newest item is the one the user just shared, and
    /// dropping THAT to make room would be the single worst choice available.
    func testTheOldestGoesNeverTheSendThatWasJustMade() {
        let queue = [item("oldest", agoSeconds: 5 * day), item("newest", agoSeconds: 1)]
            + (0..<(OutboundQueue.maxItems - 1)).map { item("f\($0)", agoSeconds: 2 * day) }
        let plan = OutboundQueue.plan(queue, now: now)
        XCTAssertEqual(plan.evicted.map(\.id), ["oldest"])
        XCTAssertTrue(plan.keep.contains { $0.id == "newest" })
    }

    func testItEvictsAsManyAsItTakesToGetBackUnderTheCap() {
        let total = OutboundQueue.maxItems + 5
        // i0 is the oldest here, so the first five are what should go.
        let queue = (0..<total).map { item("i\($0)", agoSeconds: TimeInterval(total - $0)) }
        let plan = OutboundQueue.plan(queue, now: now)
        XCTAssertEqual(plan.evicted.map(\.id), ["i0", "i1", "i2", "i3", "i4"])
        XCTAssertEqual(plan.keep.count, OutboundQueue.maxItems)
    }

    /// `keep` is what gets stored, so it has to come back in the order it went
    /// in; the eviction ranking is a separate question from the queue's order.
    func testTheSurvivorsKeepTheirOriginalOrder() {
        let queue = (0...OutboundQueue.maxItems).map { item("i\($0)", agoSeconds: TimeInterval($0)) }
        let plan = OutboundQueue.plan(queue, now: now)
        XCTAssertEqual(plan.evicted.map(\.id), ["i\(OutboundQueue.maxItems)"])
        XCTAssertEqual(plan.keep.map(\.id), queue.prefix(OutboundQueue.maxItems).map(\.id))
    }

    /// Expiry runs first, so a queue that is only over the cap because of tabs
    /// that were already dead does not evict a live one to make room.
    func testItAgesOutBeforeItEvicts() {
        let dead = (0..<5).map { item("d\($0)", agoSeconds: 8 * day) }
        let live = (0..<OutboundQueue.maxItems).map { item("l\($0)", agoSeconds: 1) }
        let plan = OutboundQueue.plan(dead + live, now: now)
        XCTAssertEqual(plan.expired.count, 5)
        XCTAssertTrue(plan.evicted.isEmpty)
        XCTAssertEqual(plan.keep.count, OutboundQueue.maxItems)
    }

    /// Identical in all three clients on purpose: a tab that dies on the phone at
    /// a different point than on the laptop is two different products.
    func testTheSizeCapIsTheNumberTheOtherClientsUse() {
        XCTAssertEqual(OutboundQueue.maxItems, 200)
    }

    // MARK: cancel

    func testCancelForgetsExactlyTheOneTab() {
        let queue = [item("a"), item("b"), item("c")]
        XCTAssertEqual(OutboundQueue.cancel(queue, id: "b").map(\.id), ["a", "c"])
    }

    /// Two swipes at the same row, or a cancel racing a flush that already
    /// settled the item: neither may throw, and neither may take anything else.
    func testCancellingSomethingAlreadyGoneIsANoOp() {
        let queue = [item("a"), item("b")]
        XCTAssertEqual(OutboundQueue.cancel(queue, id: "gone").map(\.id), ["a", "b"])
    }
}
