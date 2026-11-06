import XCTest
@testable import TabsendKit

/// Every English sentence TabsendKit builds from names, counts, times and codes,
/// pinned in `Resources/english-copy-golden.json` (docs/L10N.md, iOS).
///
/// Moving the app's text into String Catalogs must not change one character of the
/// English output. This test is how that is proved: the file was recorded from the
/// code as it stood BEFORE the text moved into `Localizable.xcstrings`, and every
/// run compares today's output with it, word for word.
///
/// A deliberate wording change updates the golden file in the same commit:
///
///     TABSEND_RECORD_GOLDEN=$PWD/Tests/TabsendKitTests/Resources/english-copy-golden.json \
///       ./test.sh --filter EnglishCopyGoldenTests
///
/// then run `pnpm exec biome format --write` on the file (the repository's lint wants its
/// layout) and read the diff. Times are fixed (`now`, UTC) so the file is stable.
final class EnglishCopyGoldenTests: XCTestCase {

    // MARK: fixed inputs

    private static let now = Date(timeIntervalSince1970: 1_793_700_000) // 2026-11-03T09:20:00Z

    private static func iso(_ secondsAgo: TimeInterval) -> String {
        WireDate.string(from: now.addingTimeInterval(-secondsAgo))
    }

    private func item(
        _ id: String = "m1", source: String = "e1", target: String = "self",
        created: TimeInterval = 120, expires: TimeInterval? = nil, acked: Bool = false,
        title: String? = "Page", url: String = "https://example.com/a?b=c",
        hasPayload: Bool = true,
        sourceLabel: String? = "Work laptop", targetLabel: String? = "Ben's iPhone",
        batch: SendPayload.Batch? = nil
    ) -> HistoryItem {
        HistoryItem(
            id: id, sourceEndpointId: source, targetEndpointId: target,
            createdAt: Self.iso(created),
            expiresAt: expires.map { Self.iso($0) },
            ackedAt: acked ? Self.iso(created - 5) : nil,
            payload: hasPayload
                ? SendPayload(url: url, title: title, sentAt: Self.iso(created), batch: batch)
                : nil,
            sourceLabel: sourceLabel, targetLabel: targetLabel
        )
    }

    // MARK: the cases

    /// name -> text, in a stable order so the recorded file diffs cleanly.
    private func allCases() -> [String: String] {
        var out: [String: String] = [:]
        func put(_ name: String, _ text: String) { out[name] = text }
        let now = Self.now

        // Feedback (Chooser.swift): the share-sheet lines.
        put("chooser.sent", Feedback.sent(to: "Work laptop"))
        put("chooser.sentQueued", Feedback.sentQueued(to: "Work laptop"))
        put("chooser.sourceOffline", Feedback.sourceOffline)
        put("chooser.noDevices", Feedback.noDevices)
        put("chooser.sendFailed", Feedback.sendFailed)
        put("feedback.thatDevice", Feedback.thatDevice)

        // Feedback.failureLine, every failure, with and without a device name.
        let failures: [(String, SendFailure)] = [
            ("phoneOffline", .phoneOffline),
            ("relayUnreachable", .relayUnreachable(relayUrl: "https://relay.example.org")),
            ("relayBusy", .relayBusy),
            ("relayUnauthorized", .relayUnauthorized),
            ("gaveUp.tooOld", .gaveUp(reason: .tooOld)),
            ("gaveUp.queueFull", .gaveUp(reason: .queueFull)),
            ("nothingToSend", .nothingToSend),
        ]
        for (name, failure) in failures {
            put("failure.\(name)", Feedback.failureLine(failure))
            put("failure.\(name).named", Feedback.failureLine(failure, targetLabel: "Work laptop"))
        }
        for reason in SendFailure.allRejectionReasons + ["something_new"] {
            if reason == "limit_reached" {
                for limit in SendFailure.allGroupLimits + ["a_new_cap"] {
                    put("rejected.\(reason).\(limit)",
                        Feedback.failureLine(.relayRejected(reason: reason, limit: limit), targetLabel: "Work laptop"))
                }
                put("rejected.\(reason).none",
                    Feedback.failureLine(.relayRejected(reason: reason, limit: nil), targetLabel: "Work laptop"))
            } else {
                put("rejected.\(reason)",
                    Feedback.failureLine(.relayRejected(reason: reason), targetLabel: "Work laptop"))
                put("rejected.\(reason).unnamed",
                    Feedback.failureLine(.relayRejected(reason: reason)))
            }
        }
        for code in SendFailure.allApiErrorCodes + ["something_new"] {
            put("error.\(code)", Feedback.failureLine(.relayError(code: code), targetLabel: "Work laptop"))
            put("error.\(code).unnamed", Feedback.failureLine(.relayError(code: code)))
        }
        put("deviceLimitLine", Feedback.deviceLimitLine)

        // Feedback.banner
        func describe(_ b: SendBanner) -> String {
            "\(b.tone)|\(b.headline)|\(b.title ?? "<nil>")|\(b.detail ?? "<nil>")"
        }
        put("banner.sent", describe(Feedback.banner(ok: true, queued: false, targetLabel: "Work laptop", title: "Page")))
        put("banner.sent.unnamed", describe(Feedback.banner(ok: true, queued: false, targetLabel: nil)))
        put("banner.notOk", describe(Feedback.banner(ok: false, queued: false, targetLabel: "Work laptop", title: "Page")))
        put("banner.recoverable", describe(Feedback.banner(
            ok: true, queued: true, targetLabel: "Work laptop", title: "Page", failure: .phoneOffline)))
        put("banner.final", describe(Feedback.banner(
            ok: false, queued: false, targetLabel: nil, title: nil, failure: .relayUnauthorized)))

        for count in [1, 2, 7] { put("heldTabsHeading.\(count)", Feedback.heldTabsHeading(count)) }
        put("heldTabLabel.title", Feedback.heldTabLabel(title: "A page", url: "https://example.com/x"))
        put("heldTabLabel.blankTitle", Feedback.heldTabLabel(title: "  ", url: "https://example.com/x"))
        put("heldTabLabel.badUrl", Feedback.heldTabLabel(title: nil, url: "not a url"))
        put("heldTabLabel.none", Feedback.heldTabLabel(title: nil, url: nil))
        put("heldTabLabel.emptyUrl", Feedback.heldTabLabel(title: nil, url: ""))
        put("recovered.one.titled", Feedback.recoveredLine(count: 1, firstTitle: "Page"))
        put("recovered.one.untitled", Feedback.recoveredLine(count: 1))
        put("recovered.one.blank", Feedback.recoveredLine(count: 1, firstTitle: "   "))
        put("recovered.many", Feedback.recoveredLine(count: 3, firstTitle: "Page"))
        for minutes in [0, 1, 5, 59, 60, 89, 90, 125, 600] {
            put("relayDown.\(minutes)m", Feedback.relayDownLine(relayUrl: "https://relay.example.org", sinceMinutes: minutes))
        }
        put("relayDown.home", Feedback.relayDownLine(relayUrl: "http://192.168.1.5:8787", sinceMinutes: 5))

        // GoneTargetCopy
        for removedHere in [true, false] {
            put("gone.line.\(removedHere).named", GoneTargetCopy.removedLine("Galaxy S24", removedHere: removedHere))
            put("gone.line.\(removedHere).unnamed", GoneTargetCopy.removedLine(nil, removedHere: removedHere))
            put("gone.line.\(removedHere).blank", GoneTargetCopy.removedLine("  ", removedHere: removedHere))
            for count in [1, 2, 5] {
                for title in [Optional("Page"), nil, Optional("  ")] {
                    for label in [Optional("Galaxy S24"), nil] {
                        let b = GoneTargetCopy.banner(
                            count: count, firstTitle: title, targetLabel: label, removedHere: removedHere)
                        put("gone.banner.\(removedHere).\(count).\(title ?? "nil").\(label ?? "nil")", describe(b))
                    }
                }
            }
        }
        put("gone.sendToMenu", GoneTargetCopy.sendToMenu)
        put("gone.noOtherDevice", GoneTargetCopy.noOtherDevice)

        // GroupReset
        put("reset.cardTitle", GroupReset.cardTitle)
        put("reset.stopButton", GroupReset.stopButton)
        put("reset.itWasMe", GroupReset.itWasMeButton)
        put("reset.stoppedLine", GroupReset.stoppedLine)
        put("reset.notificationTitle", GroupReset.notificationTitle)
        let utc = TimeZone(identifier: "UTC")!
        let berlin = TimeZone(identifier: "Europe/Berlin")!
        let la = TimeZone(identifier: "America/Los_Angeles")!
        for (zoneName, zone) in [("utc", utc), ("berlin", berlin), ("la", la)] {
            let state = GroupResetState(requestedAt: "2026-10-27T14:05:00.000Z", resetsAt: "2026-10-30T14:05:00.000Z")
            put("reset.body.\(zoneName)", GroupReset.cardBody(state, timeZone: zone))
            put("reset.notification.\(zoneName)", GroupReset.notificationBody(state, timeZone: zone))
        }
        let morning = GroupResetState(requestedAt: "2026-11-01T00:30:00Z", resetsAt: "2026-11-04T00:00:00Z")
        let noon = GroupResetState(requestedAt: "2026-12-09T12:00:00Z", resetsAt: "2026-12-12T23:59:00Z")
        put("reset.body.midnight", GroupReset.cardBody(morning, timeZone: utc))
        put("reset.body.noon", GroupReset.cardBody(noon, timeZone: utc))
        let broken = GroupResetState(requestedAt: "garbage", resetsAt: "garbage")
        put("reset.body.broken", GroupReset.cardBody(broken, timeZone: utc))
        put("reset.notification.broken", GroupReset.notificationBody(broken, timeZone: utc))

        // GroupService (docs/PLANS.md P-19): the plan words, with the trial's end in each zone
        let trialEnd = Date(timeIntervalSince1970: 1_794_996_000) // 2026-11-18T10:00:00Z
        put("service.sectionTitle", GroupService.sectionTitle)
        put("service.trialLabel", GroupService.trialLabel)
        put("service.trialFooter", GroupService.trialFooter)
        put("service.trialEndedTitle", GroupService.trialEndedTitle)
        put("service.trialEndedBody", GroupService.trialEndedBody)
        put("service.trialValue.utc", GroupService.trialValue(endsAt: trialEnd, timeZone: utc))
        put("service.trialValue.la", GroupService.trialValue(endsAt: trialEnd, timeZone: la))
        put("service.startedNotice.utc", GroupService.startedNotice(endsAt: trialEnd, timeZone: utc))
        put("service.startedNotice.undated", GroupService.startedNotice(endsAt: nil, timeZone: utc))
        put("service.pausedLine.thisPhone", GroupService.pausedLine(.trialEnded, kind: "iPhone", isThisPhone: true) ?? "")
        put("service.pausedLine.other", GroupService.pausedLine(.trialEnded, kind: "Chrome", isThisPhone: false) ?? "")

        // History
        put("history.title.titled", History.displayTitle(item(title: "A page")))
        put("history.title.host", History.displayTitle(item(title: nil)))
        put("history.title.blank", History.displayTitle(item(title: "  ")))
        put("history.title.sealed", History.displayTitle(item(hasPayload: false)))
        for (name, direction) in [("sent", HistoryDirection.sent), ("received", .received), ("between", .between)] {
            put("history.route.\(name)", History.route(item(), direction: direction))
            put("history.route.\(name).unnamed", History.route(item(sourceLabel: nil, targetLabel: nil), direction: direction))
            put("history.subtitle.\(name)", History.subtitle(item(), direction: direction, now: now))
            put("history.subtitle.\(name).grouped", History.subtitle(item(), direction: direction, grouped: true, now: now))
            put("history.subtitle.\(name).sealed", History.subtitle(item(hasPayload: false), direction: direction, now: now))
            put("history.subtitle.\(name).sealedGrouped",
                History.subtitle(item(hasPayload: false), direction: direction, grouped: true, now: now))
        }
        put("history.state.arrived", History.stateLine(item(acked: true), now: now) ?? "<nil>")
        put("history.state.waiting", History.stateLine(item(expires: -600), now: now) ?? "<nil>")
        put("history.state.waiting.unnamed", History.stateLine(item(expires: -600, targetLabel: nil), now: now) ?? "<nil>")
        put("history.state.never", History.stateLine(item(expires: 60), now: now) ?? "<nil>")
        put("history.retention.group", History.retentionLine(relayKeepsHistory: true))
        put("history.retention.old", History.retentionLine(relayKeepsHistory: false))

        // Inbox
        let batch = { (count: Int) in SendPayload.Batch(id: "b", count: count) }
        func inboxGroup(here: Int, sent: Int) -> InboxGroup {
            let items = (0..<here).map {
                InboxItem(id: "i\($0)", url: "https://example.com", sourceLabel: "x",
                          sentAt: Self.iso(10), receivedAt: now, batch: batch(sent))
            }
            return BatchGroup(batchId: "b", sentCount: sent, items: items)
        }
        put("inbox.batch.3of3", Inbox.batchHeading(inboxGroup(here: 3, sent: 3)))
        put("inbox.batch.2of3", Inbox.batchHeading(inboxGroup(here: 2, sent: 3)))
        put("inbox.batch.2of2", Inbox.batchHeading(inboxGroup(here: 2, sent: 2)))
        put("inbox.batch.1of12", Inbox.batchHeading(inboxGroup(here: 1, sent: 12)))
        put("inbox.batch.11of12", Inbox.batchHeading(inboxGroup(here: 11, sent: 12)))
        put("inbox.batch.21of21", Inbox.batchHeading(inboxGroup(here: 21, sent: 21)))
        let day: TimeInterval = 86_400
        for (name, ago) in [
            ("0s", 0), ("59s", 59), ("60s", 60), ("119s", 119), ("59m59s", 3599), ("1h", 3600),
            ("2h", 7200), ("23h59m", day - 1), ("1d", day), ("2d", 2 * day), ("29d", 29 * day),
            ("30d", 30 * day), ("59d", 59 * day), ("60d", 60 * day), ("364d", 364 * day),
            ("365d", 365 * day), ("800d", 800 * day), ("future", -300),
        ] as [(String, TimeInterval)] {
            put("inbox.age.\(name)", Inbox.relativeTime(Self.iso(ago), now: now))
        }
        put("inbox.age.unreadable", Inbox.relativeTime("not a date", now: now))
        put("inbox.title.host", Inbox.displayTitle(
            InboxItem(id: "i", url: "https://example.com/x", title: nil, sourceLabel: "x", sentAt: Self.iso(1), receivedAt: now)))

        // NewDevices
        func device(_ label: String, _ ago: TimeInterval = 180) -> NewDeviceNotice {
            NewDeviceNotice(id: "id-\(label)", label: label, createdAt: Self.iso(ago))
        }
        let sets: [(String, [NewDeviceNotice])] = [
            ("one", [device("Pixel 9")]),
            ("oneNoDate", [NewDeviceNotice(id: "x", label: "Pixel 9", createdAt: "garbage")]),
            ("two", [device("Pixel 9"), device("Home Firefox")]),
            ("three", [device("Pixel 9"), device("Home Firefox"), device("Work laptop")]),
        ]
        for (name, devices) in sets {
            for (kindName, kind) in [("joined", NewDevices.Announcement.Kind.joined), ("firstList", .firstList)] {
                let announcement = NewDevices.Announcement(kind: kind, devices: devices)
                put("newdevice.title.\(kindName).\(name)", NewDevices.alertTitle(announcement))
                put("newdevice.body.\(kindName).\(name)", NewDevices.alertBody(announcement, now: now))
            }
        }
        put("newdevice.vanished.title", NewDevices.vanishedTitle(device("Pixel 9")))
        put("newdevice.vanished.body", NewDevices.vanishedBody(device("Pixel 9"), now: now))
        put("newdevice.vanished.body.nodate",
            NewDevices.vanishedBody(NewDeviceNotice(id: "x", label: "Pixel 9", createdAt: "garbage"), now: now))
        put("newdevice.vanished.dismiss", NewDevices.vanishedDismiss)
        put("newdevice.when.recent", NewDevices.when(Self.iso(30), now: now))
        put("newdevice.when.unreadable", NewDevices.when("garbage", now: now))
        put("newdevice.list.1", NewDevices.listLabels(["A"]))
        put("newdevice.list.2", NewDevices.listLabels(["A", "B"]))
        put("newdevice.list.3", NewDevices.listLabels(["A", "B", "C"]))
        put("newdevice.list.4", NewDevices.listLabels(["A", "B", "C", "D"]))

        // ProtocolCheck, RelayMove, HomeNetwork
        put("protocol.outdated", ProtocolCheck.message(.outdated(clientProtocol: 2, recommended: 3)) ?? "<nil>")
        put("protocol.clientTooOld", ProtocolCheck.message(.clientTooOld(clientProtocol: 2, relayRequires: 4)) ?? "<nil>")
        put("protocol.relayTooOld", ProtocolCheck.message(.relayTooOld(relayProtocol: 1, clientRequires: 2)) ?? "<nil>")
        put("protocol.ok", ProtocolCheck.message(.ok) ?? "<nil>")
        put("relayMove.button", RelayMove.button)
        put("relayMove.title", RelayMove.title)
        put("relayMove.hint", RelayMove.hint)
        put("relayMove.check", RelayMove.check)
        put("relayMove.checking", RelayMove.checking)
        put("relayMove.empty", RelayMove.empty)
        put("relayMove.same", RelayMove.same)
        put("relayMove.sameUnverified", RelayMove.sameUnverified)
        put("relayMove.different", RelayMove.different)
        put("relayMove.switchAddress", RelayMove.switchAddress)
        put("relayMove.switchRelay", RelayMove.switchRelay)
        put("relayMove.startFreshBody", RelayMove.startFreshBody)
        put("relayMove.afterStartFresh", RelayMove.afterStartFresh)
        put("relayMove.unreachable", RelayMove.unreachable("https://relay.example.org"))
        put("relayMove.refused", RelayMove.refused("Unknown pairing link."))
        put("relayMove.startFreshTitle", RelayMove.startFreshTitle("https://relay.example.org"))
        put("relayMove.done", RelayMove.done("https://relay.example.org"))
        put("relayMove.commitFailed", RelayMove.commitFailed("The relay refused the check: x"))
        put("homeNetwork.hint", HomeNetwork.hint)

        // RelayErrorText: the phone's own words for every code the relay can answer with, on
        // every screen that shows one, and for a code this app has never heard of.
        for action in RelayErrorText.Action.allCases {
            for code in SendFailure.allApiErrorCodes + ["from_a_newer_relay"] {
                put("relayError.\(action).\(code)", RelayErrorText.line(code: code, during: action))
            }
        }
        return out
    }

    // MARK: the comparison

    private static let goldenName = "english-copy-golden"

    func testEnglishOutputMatchesTheGoldenFile() throws {
        let cases = allCases()
        if let path = ProcessInfo.processInfo.environment["TABSEND_RECORD_GOLDEN"] {
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
            try encoder.encode(cases).write(to: URL(fileURLWithPath: path))
            return
        }
        let url = try XCTUnwrap(Bundle.module.url(forResource: Self.goldenName, withExtension: "json"))
        let golden = try JSONDecoder().decode([String: String].self, from: Data(contentsOf: url))

        XCTAssertEqual(Set(cases.keys), Set(golden.keys), "the cases and the golden file list different names")
        for (name, expected) in golden.sorted(by: { $0.key < $1.key }) {
            XCTAssertEqual(cases[name], expected, "\(name)")
        }
    }
}
