import XCTest
@testable import TabsendKit

/// The relay-move decision table, the same cases as Android's RelayMove tests.
final class RelayMoveTests: XCTestCase {
    private let url = "https://relay.example"

    func testMismatchedIdsAreDifferentBeforeAnyTokenIsSent() {
        XCTAssertEqual(
            RelayMove.byRelayId(relayUrl: url, storedId: "a", fetchedId: "b"),
            .different(relayUrl: url)
        )
    }

    func testMatchingOrMissingIdsLeaveItToTheTokenProbe() {
        XCTAssertNil(RelayMove.byRelayId(relayUrl: url, storedId: "a", fetchedId: "a"))
        XCTAssertNil(RelayMove.byRelayId(relayUrl: url, storedId: nil, fetchedId: "a"))
        XCTAssertNil(RelayMove.byRelayId(relayUrl: url, storedId: "a", fetchedId: nil))
    }

    func testRejectedTokenMeansDifferentRelay() {
        XCTAssertEqual(
            RelayMove.byTokenProbe(relayUrl: url, storedId: "a", fetchedId: "a", tokenRejected: true),
            .different(relayUrl: url)
        )
    }

    func testAcceptedTokenIsSameAndVerifiedOnlyWithBothIds() {
        XCTAssertEqual(
            RelayMove.byTokenProbe(relayUrl: url, storedId: "a", fetchedId: "a", tokenRejected: false),
            .same(relayUrl: url, verified: true)
        )
        XCTAssertEqual(
            RelayMove.byTokenProbe(relayUrl: url, storedId: nil, fetchedId: "a", tokenRejected: false),
            .same(relayUrl: url, verified: false)
        )
    }
}
