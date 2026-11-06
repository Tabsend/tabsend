import XCTest
@testable import TabsendKit

/// The phone's own words for what the relay says (`RelayErrorText`), and the two other
/// pieces that moved to the platform's formatters: compact ages and name lists.
/// The exact English is pinned in `EnglishCopyGoldenTests`; these are the rules.
final class RelayErrorTextTests: XCTestCase {

    func testEveryCodeHasWordsOnEveryScreen() {
        for action in RelayErrorText.Action.allCases {
            for code in SendFailure.allApiErrorCodes {
                let line = RelayErrorText.line(code: code, during: action)
                XCTAssertFalse(line.isEmpty, "\(code) during \(action)")
                XCTAssertFalse(line.contains("\u{2014}"), "\(code) during \(action): em dash")
            }
        }
    }

    /// The relay's own text is English and may change; it must not reach the screen.
    func testTheRelaysOwnMessageIsNeverShown() {
        for code in SendFailure.allApiErrorCodes {
            let error = ApiError(status: 400, code: code, message: "Relay wording that must not show up.")
            for action in RelayErrorText.Action.allCases {
                XCTAssertFalse(
                    RelayErrorText.line(error, during: action).contains("Relay wording"),
                    "\(code) during \(action)"
                )
            }
        }
    }

    func testNotFoundMeansADeviceOrTheGroupDependingOnTheScreen() {
        let device = RelayErrorText.line(code: "not_found", during: .removeDevice)
        XCTAssertEqual(device, RelayErrorText.line(code: "not_found", during: .renameDevice))
        let group = RelayErrorText.line(code: "not_found", during: .pairingLink)
        XCTAssertEqual(group, RelayErrorText.line(code: "not_found", during: .stopReset))
        XCTAssertNotEqual(device, group)
    }

    func testJoiningKeepsItsOwnWordsForAFullGroupAndAUsedLink() {
        XCTAssertEqual(RelayErrorText.line(code: "limit_reached", during: .join), Feedback.deviceLimitLine)
        XCTAssertTrue(RelayErrorText.line(code: "invalid_pairing_code", during: .join).contains("setup link"))
        XCTAssertNotEqual(
            RelayErrorText.line(code: "limit_reached", during: .pairingLink),
            Feedback.deviceLimitLine
        )
    }

    func testACodeFromANewerRelayReadsAsAnInternalError() {
        for action in RelayErrorText.Action.allCases {
            XCTAssertEqual(RelayErrorText.line(code: "from_a_newer_relay", during: action), Feedback.internalLine)
            XCTAssertEqual(RelayErrorText.line(code: "internal", during: action), Feedback.internalLine)
        }
    }

    // MARK: ages and lists, from the platform

    /// The platform's narrow English is the words every Tabsend client shares. If an
    /// operating system update ever changes them, this fails and the golden file is
    /// the place to look.
    func testEnglishAgesAreTheCompactWordsTheOtherClientsUse() {
        for n in 1...59 { XCTAssertEqual(L10n.minutesAgo(n), "\(n)m ago") }
        for n in 1...23 { XCTAssertEqual(L10n.hoursAgo(n), "\(n)h ago") }
        for n in 1...29 { XCTAssertEqual(L10n.daysAgo(n), "\(n)d ago") }
        for n in 1...12 { XCTAssertEqual(L10n.monthsAgo(n), "\(n)mo ago") }
        for n in 1...60 { XCTAssertEqual(L10n.yearsAgo(n), "\(n)y ago") }
    }

    /// No comma before "and": the wording the extension and Android use for the same notice.
    func testEnglishNameListsHaveNoCommaBeforeAnd() {
        XCTAssertEqual(L10n.list([]), "")
        XCTAssertEqual(L10n.list(["A"]), "A")
        XCTAssertEqual(L10n.list(["A", "B"]), "A and B")
        XCTAssertEqual(L10n.list(["A", "B", "C"]), "A, B and C")
        XCTAssertEqual(L10n.list(["A", "B", "C", "D"]), "A, B, C and D")
    }
}
