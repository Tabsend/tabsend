import XCTest
@testable import TabsendKit

/// The words for a held tab whose device is gone (PLANS.md P-15 item 3),
/// pinned word for word as extension/src/lib/strings-gone-target.test.ts and
/// GoneTargetCopyTest.kt, so the three clients cannot drift apart.
final class GoneTargetCopyTests: XCTestCase {

    /// "Was removed" is said only when this phone removed the device itself;
    /// everything else it knows from the relay, which can say a device is gone
    /// when it is not (SECURITY_REVIEW L3).
    func testTheLineUnderTheHeldTabSaysRemovedOnlyWhenThisPhoneRemovedIt() {
        XCTAssertEqual(
            GoneTargetCopy.removedLine("Galaxy S24 Ultra", removedHere: true),
            "Galaxy S24 Ultra was removed from your group."
        )
        XCTAssertEqual(
            GoneTargetCopy.removedLine(nil, removedHere: true),
            "The device it was for was removed from your group."
        )
        XCTAssertEqual(
            GoneTargetCopy.removedLine("Galaxy S24 Ultra", removedHere: false),
            "Galaxy S24 Ultra is no longer in your group."
        )
        XCTAssertEqual(
            GoneTargetCopy.removedLine(" ", removedHere: false),
            "The device it was for is no longer in your group."
        )
    }

    func testSaysOnceAsAWaitNotAFailureThatATabNeedsANewDevice() {
        let one = GoneTargetCopy.banner(
            count: 1, firstTitle: "All workflows", targetLabel: "Galaxy S24 Ultra", removedHere: true
        )
        XCTAssertEqual(one.tone, .pending)
        XCTAssertEqual(one.headline, "“All workflows” is waiting for a new device")
        XCTAssertEqual(
            one.detail,
            "Galaxy S24 Ultra was removed from your group. Open Tabsend to send it to another device."
        )
        let several = GoneTargetCopy.banner(
            count: 3, firstTitle: "All workflows", targetLabel: nil, removedHere: true
        )
        XCTAssertEqual(several.headline, "3 tabs are waiting for a new device")
        XCTAssertEqual(
            several.detail,
            "The device they were for was removed from your group. Open Tabsend to send them to another device."
        )
        XCTAssertEqual(
            GoneTargetCopy.banner(count: 1, firstTitle: nil, targetLabel: nil, removedHere: false).headline,
            "A tab is waiting for a new device"
        )
    }

    func testTheBannerSaysNoLongerInTheGroupWhenTheRelayIsTheOnlyWitness() {
        XCTAssertEqual(
            GoneTargetCopy.banner(
                count: 1, firstTitle: "All workflows", targetLabel: "Galaxy S24 Ultra", removedHere: false
            ).detail,
            "Galaxy S24 Ultra is no longer in your group. Open Tabsend to send it to another device."
        )
        XCTAssertEqual(
            GoneTargetCopy.banner(count: 2, firstTitle: "T", targetLabel: nil, removedHere: false).detail,
            "The device they were for is no longer in your group. Open Tabsend to send them to another device."
        )
        XCTAssertEqual(
            GoneTargetCopy.banner(count: 1, firstTitle: "T", targetLabel: nil, removedHere: false).detail,
            "The device it was for is no longer in your group. Open Tabsend to send it to another device."
        )
    }

    func testUsesNoEmDashes() {
        var all = [GoneTargetCopy.sendToMenu, GoneTargetCopy.noOtherDevice]
        for removedHere in [true, false] {
            let banner = GoneTargetCopy.banner(count: 2, firstTitle: "T", targetLabel: "X", removedHere: removedHere)
            all += [
                GoneTargetCopy.removedLine("X", removedHere: removedHere),
                GoneTargetCopy.removedLine(nil, removedHere: removedHere),
                banner.headline,
                banner.detail ?? "",
            ]
        }
        for line in all { XCTAssertFalse(line.contains("—"), line) }
    }

    func testTheRelaysDeviceGoneAnswersAreRecognised() {
        XCTAssertTrue(Sender.isTargetGoneReason("unknown_target"))
        XCTAssertTrue(Sender.isTargetGoneReason("not_in_group"))
        XCTAssertFalse(Sender.isTargetGoneReason("expired_key"))
    }
}
