import XCTest
@testable import TabsendKit

/// The rule that takes a "Waiting to send" notice down again.
///
/// The bug this pins: the relay came back, the queue drained, and the notice that
/// had promised exactly that stayed in Notification Center claiming the relay was
/// still unreachable. Mirrored by SendNoticesTest.kt on Android.
final class SendNoticesTests: XCTestCase {

    private let a = "11111111-1111-1111-1111-111111111111"
    private let b = "22222222-2222-2222-2222-222222222222"
    private let c = "33333333-3333-3333-3333-333333333333"

    func testNoticeWhoseTabIsStillQueuedStaysUp() {
        let posted = [SendNotices.pendingIdentifier(a), SendNotices.pendingIdentifier(b)]
        XCTAssertTrue(SendNotices.stalePending(posted: posted, held: [a, b]).isEmpty)
    }

    func testNoticeWhoseTabHasLeftTheQueueComesDown() {
        let posted = [SendNotices.pendingIdentifier(a), SendNotices.pendingIdentifier(b)]
        XCTAssertEqual(
            SendNotices.stalePending(posted: posted, held: [b]),
            [SendNotices.pendingIdentifier(a)]
        )
    }

    func testEmptiedQueueTakesEveryNoticeWithIt() {
        let posted = [a, b, c].map(SendNotices.pendingIdentifier)
        XCTAssertEqual(SendNotices.stalePending(posted: posted, held: []), posted)
    }

    /// The sweep sees the whole of Notification Center, and most of it belongs to
    /// somebody else: a settled verdict is the ONLY record that a send finished
    /// (iOS notices never self-dismiss), and an arriving tab is not ours at all.
    func testOnlyStandingPromisesAreSwept() {
        let posted = [
            SendNotices.pendingIdentifier(a),
            SendNotices.outcomeIdentifier(b),
            "send.recovered",
            "send.dropped",
            c, // an arriving tab: link notices key on the bare message id
        ]
        XCTAssertEqual(
            SendNotices.stalePending(posted: posted, held: []),
            [SendNotices.pendingIdentifier(a)]
        )
    }

    /// The ordinary case: the background refresh sweeping has no idea which sends
    /// were ever announced, and the queue may well hold tabs that never got a
    /// notice (notifications denied, or the share extension killed before it could
    /// post). A held tab with nothing on screen must not manufacture a removal.
    func testHeldTabsThatWereNeverAnnouncedAreNotRemovals() {
        XCTAssertTrue(SendNotices.stalePending(posted: [], held: [a, b]).isEmpty)
    }
}
