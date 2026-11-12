import XCTest
@testable import TabsendKit

/// The "More" menu on a device row, with the same rule as the browsers' list.
final class DeviceRowActionsTests: XCTestCase {
    func testOtherDevicesCanBeRenamedAndRemoved() {
        XCTAssertEqual(DeviceRowActions.actions(isThisPhone: false), [.rename, .remove])
    }

    func testThisPhoneCanOnlyBeRenamed() {
        XCTAssertEqual(DeviceRowActions.actions(isThisPhone: true), [.rename])
    }

    func testBlankNamesAreNotSent() {
        XCTAssertNil(DeviceRowActions.cleanedName("   \n"))
        XCTAssertNil(DeviceRowActions.cleanedName(""))
        XCTAssertEqual(DeviceRowActions.cleanedName("  Work laptop "), "Work laptop")
    }
}
