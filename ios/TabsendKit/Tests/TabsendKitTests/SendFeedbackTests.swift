import XCTest
@testable import TabsendKit

/// The copy rules from ADR-0008's 2026-07-29 amendment, mirroring
/// extension/src/lib/strings.test.ts and android SendFeedbackTest.kt. These are
/// the tests that make the hand-mirrored copy safe: `shared/` is TypeScript, so
/// nothing else stops the Swift and Kotlin tables drifting from it or each other.
final class SendFeedbackTests: XCTestCase {

    private let label = "Arc · Mac mini"
    private let title = "Setting up a LAN relay"

    // MARK: what a surface is allowed to claim

    func testSaysSentOnlyWhenTheRelayActuallyTookIt() {
        let banner = Feedback.banner(ok: true, queued: false, targetLabel: label, title: title)
        XCTAssertEqual(banner.tone, .success)
        XCTAssertEqual(banner.headline, "Sent to Arc · Mac mini")
        XCTAssertEqual(banner.title, title)
        XCTAssertNil(banner.detail)
    }

    func testAnAsleepTargetIsStillASuccess() {
        let banner = Feedback.banner(ok: true, queued: true, targetLabel: label)
        XCTAssertEqual(banner.tone, .success)
        XCTAssertEqual(banner.detail, "Opens when it wakes")
    }

    /// THE regression: a dead relay used to return ok=true and render as "Sent".
    func testATabMerelyHeldOnThisPhoneIsPendingNeverSent() {
        let banner = Feedback.banner(
            ok: true, queued: false, targetLabel: label, title: title,
            failure: .relayUnreachable(relayUrl: "http://192.168.1.50:8787")
        )
        XCTAssertEqual(banner.tone, .pending)
        XCTAssertEqual(banner.headline, "Waiting to send to Arc · Mac mini")
        XCTAssertFalse(banner.headline.hasPrefix("Sent"))
        XCTAssertTrue(banner.detail!.contains("http://192.168.1.50:8787"))
    }

    func testARefusalReadsAsAnError() {
        let banner = Feedback.banner(
            ok: false, queued: false, targetLabel: label,
            failure: .relayRejected(reason: "unknown_target")
        )
        XCTAssertEqual(banner.tone, .error)
        XCTAssertEqual(banner.headline, "Couldn't send to Arc · Mac mini")
        // The device name reaches the status line, not just the headline.
        XCTAssertTrue(banner.detail!.contains(label))
    }

    func testCarriesTheTabTitle() {
        XCTAssertEqual(Feedback.banner(ok: true, queued: false, targetLabel: label, title: title).title, title)
        XCTAssertNil(Feedback.banner(ok: true, queued: false, targetLabel: label).title)
    }

    // MARK: the diagnosis

    func testNamesTheRelayAddressASelfHosterHasToFix() {
        let line = Feedback.failureLine(.relayUnreachable(relayUrl: "http://192.168.1.50:8787"))
        XCTAssertTrue(line.contains("http://192.168.1.50:8787"))
    }

    func testNeverBlamesTheConnectionForARelayOutage() {
        let line = Feedback.failureLine(.relayUnreachable(relayUrl: "http://mini-pc:8787")).lowercased()
        XCTAssertFalse(line.contains("you're offline"), line)
        XCTAssertFalse(line.contains("no connection"), line)
    }

    /// Every member of BOTH closed wire sets gets a sentence, plus the fallback:
    /// a relay a version ahead will send codes we have no copy for, and those
    /// must fold to the generic line rather than render nothing.
    func testEveryMemberOfBothWireSetsProducesALine() {
        for failure in allFailures + futureFailures {
            XCTAssertFalse(Feedback.failureLine(failure, targetLabel: label).isEmpty, "\(failure)")
        }
    }

    /// No user-facing line may contain a wire code. "Your relay refused the send:
    /// Unknown target." was the bug, and the port carried the raw enum instead.
    func testNeverLeaksAMachineCode() {
        let codes = Set(
            SendFailure.allApiErrorCodes + SendFailure.allRejectionReasons
                + SendFailure.allGroupLimits
        ).union(["nonsense_code", "nonsense_reason"])
        for failure in allFailures + futureFailures {
            let line = Feedback.failureLine(failure, targetLabel: label)
            for code in codes {
                XCTAssertFalse(line.contains(code), "\(failure) leaked \(code): \(line)")
            }
        }
    }

    /// The no-label fallback ("that device") is not a proper noun, so no line may
    /// open with it — that reads as a lowercase sentence. This caught a real bug
    /// in the extension.
    func testNeverOpensASentenceWithTheDeviceName() {
        for failure in allFailures {
            let line = Feedback.failureLine(failure) // no label → the fallback
            XCTAssertFalse(line.hasPrefix(Feedback.thatDevice), "\(failure): \(line)")
            XCTAssertTrue(line.first!.isUppercase, "\(failure): \(line)")
        }
    }

    func testNamesTheDeviceRatherThanTheCode() {
        XCTAssertEqual(
            Feedback.failureLine(.relayRejected(reason: "unknown_target"), targetLabel: "Arc"),
            "Your relay doesn't know Arc any more. Pair it again, then send this tab a second time."
        )
    }

    /// Owner preference: no em dashes in the copy added since the locked §4 table.
    func testNoEmDashesInTheNewerFailureCopy() {
        for failure in allFailures {
            XCTAssertFalse(Feedback.failureLine(failure, targetLabel: "Arc").contains("—"), "\(failure)")
        }
        XCTAssertFalse(Feedback.relayDownLine(relayUrl: "http://x", sinceMinutes: 12).contains("—"))
        XCTAssertFalse(Feedback.heldTabsHeading(3).contains("—"))
        XCTAssertFalse(Feedback.recoveredLine(count: 2).contains("—"))
    }

    func testOnlyTheRetryThemselvesCasesAreRecoverable() {
        XCTAssertTrue(SendFailure.phoneOffline.isRecoverable)
        XCTAssertTrue(SendFailure.relayUnreachable(relayUrl: "http://x").isRecoverable)
        // A 429 or a 5xx is "not now", not "no". Treating it as a refusal
        // DISCARDED the tab, and in a flush discarded the whole queue.
        XCTAssertTrue(SendFailure.relayBusy.isRecoverable)
        XCTAssertFalse(SendFailure.relayRejected(reason: "unknown_target").isRecoverable)
        // A per-group cap [0030] is the same shape of answer as a 429: it clears
        // itself, so the tab stays queued instead of being thrown away over a
        // wait of about a minute.
        XCTAssertTrue(SendFailure.relayRejected(reason: "limit_reached").isRecoverable)
        for limit in SendFailure.allGroupLimits {
            XCTAssertTrue(
                SendFailure.relayRejected(reason: "limit_reached", limit: limit).isRecoverable,
                limit
            )
        }
        XCTAssertFalse(SendFailure.relayError(code: "internal").isRecoverable)
        XCTAssertFalse(SendFailure.relayUnauthorized.isRecoverable)
        XCTAssertFalse(SendFailure.nothingToSend.isRecoverable)
        // Giving up is what ENDS the retrying. Reading it as "will retry itself"
        // would put the tab back in the pending tone and re-make the promise the
        // queue has just stopped keeping.
        XCTAssertFalse(SendFailure.gaveUp(reason: .tooOld).isRecoverable)
        XCTAssertFalse(SendFailure.gaveUp(reason: .queueFull).isRecoverable)
    }

    /// The one failure Tabsend decides by itself (INTERACTION_FLOWS §4f).
    /// Everything else in this set is the relay's verdict or the network's; this
    /// is the client saying it has stopped holding a tab, so the sentence carries
    /// the number that decided it — "seven days" is the only part of the line a
    /// self-hoster can act on.
    func testGivingUpSaysHowLongItWaitedOrWhatTheCapIs() {
        let tooOld = Feedback.failureLine(.gaveUp(reason: .tooOld), targetLabel: label)
        XCTAssertTrue(tooOld.contains("\(OutboundQueue.maxAgeDays) days"), tooOld)
        XCTAssertTrue(tooOld.contains("Send it again"), tooOld)

        let full = Feedback.failureLine(.gaveUp(reason: .queueFull), targetLabel: label)
        XCTAssertTrue(full.contains("\(OutboundQueue.maxItems)"), full)
        XCTAssertTrue(full.contains("oldest"), full)
    }

    /// A given-up tab is finished, so it must never read as one still on its way.
    func testGivingUpReadsAsAnErrorNotATabStillOnItsWay() {
        let banner = Feedback.banner(
            ok: false, queued: false, targetLabel: label, title: title,
            failure: .gaveUp(reason: .tooOld)
        )
        XCTAssertEqual(banner.tone, .error)
    }

    /// A 5xx has no error envelope when it comes from a proxy, so `ApiClient`
    /// labels it `internal`. Switching on the code alone therefore read a
    /// restarting container as a permanent relay bug and threw the tab away.
    func testA5xxOr429KeepsTheTabRatherThanRefusingIt() {
        for status in [429, 500, 502, 503, 504] {
            let failure = SendFailure.classify(
                apiError: ApiError(status: status, code: "internal", message: "x")
            )
            XCTAssertEqual(failure, .relayBusy, "status \(status)")
            XCTAssertTrue(failure.isRecoverable, "status \(status)")
        }
        // A genuine refusal is still final.
        for status in [400, 403, 404, 409] {
            let failure = SendFailure.classify(
                apiError: ApiError(status: status, code: "invalid_request", message: "x")
            )
            XCTAssertFalse(failure.isRecoverable, "status \(status)")
        }
    }

    /// A per-group cap [0030] refuses one item at a time, inside a 200. Every one
    /// of those caps clears itself, so the refusal is a WAIT and the copy has to
    /// say so — the app is already holding the tab and retrying it. Before this,
    /// every cap refusal rendered "Something went wrong inside your relay", which
    /// named no cause and asked for the wrong action.
    ///
    /// Mirrors strings.test.ts / SendFeedbackTest.kt.
    func testACapRefusalNamesTheWaitRatherThanBlamingTheRelay() {
        XCTAssertEqual(
            Feedback.failureLine(
                .relayRejected(reason: "limit_reached", limit: "sends_per_window"),
                targetLabel: label
            ),
            "Your relay is pacing sends for your group right now. This tab is queued and "
                + "will send itself shortly."
        )
        for limit in ["queued_messages", "queued_bytes"] {
            XCTAssertEqual(
                Feedback.failureLine(
                    .relayRejected(reason: "limit_reached", limit: limit), targetLabel: label
                ),
                "Your relay is holding as much as your group's limit allows. This tab is queued "
                    + "and will send once the receiving device catches up.",
                limit
            )
        }
        // A relay that names no cap, or names a fifth one this build has never
        // heard of, still gets a true sentence and not the internal-error line.
        let general = "Your relay has reached a limit for your group. This tab is queued and "
            + "will send itself once there is room."
        XCTAssertEqual(
            Feedback.failureLine(.relayRejected(reason: "limit_reached"), targetLabel: label),
            general
        )
        XCTAssertEqual(
            Feedback.failureLine(
                .relayRejected(reason: "limit_reached", limit: "a_fifth_cap"), targetLabel: label
            ),
            general
        )
    }

    /// A cap-held tab is still on its way, so it must not read as a failure.
    func testACapRefusalReadsAsPendingAndPromisesTheRetry() {
        let banner = Feedback.banner(
            ok: true, queued: false, targetLabel: label, title: title,
            failure: .relayRejected(reason: "limit_reached", limit: "sends_per_window")
        )
        XCTAssertEqual(banner.tone, .pending)
        XCTAssertEqual(banner.headline, "Waiting to send to Arc · Mac mini")
        XCTAssertFalse(banner.headline.hasPrefix("Sent"))
        XCTAssertTrue(banner.detail!.contains("will send itself shortly"))
    }

    /// The OTHER half of [0030], and the opposite kind of answer: the endpoint
    /// cap refuses a whole register call, and a group that is full stays full
    /// until a person removes a device. So this line asks for an action where the
    /// cap lines above promise a retry, and it must never fold to the
    /// internal-error line — a relay enforcing its own cap is not a fault.
    ///
    /// Word-for-word the same sentence in `strings.ts` and `SendFeedback.kt`.
    func testTheDeviceCapNamesTheActionRatherThanBlamingTheRelay() {
        let line = Feedback.failureLine(.relayError(code: "limit_reached"), targetLabel: label)
        XCTAssertEqual(
            line,
            "Your relay has reached its device limit for your group. Remove a device you are not "
                + "using, then pair this one again."
        )
        XCTAssertEqual(line, Feedback.deviceLimitLine)
        XCTAssertFalse(line.contains("went wrong"))
        // A join is not a send: nothing was queued, so nothing may read as pending.
        XCTAssertFalse(SendFailure.relayError(code: "limit_reached").isRecoverable)
    }

    func testABusyRelayReadsAsPendingAndPromisesTheRetry() {
        let banner = Feedback.banner(
            ok: true, queued: false, targetLabel: label, title: title,
            failure: .relayBusy
        )
        XCTAssertEqual(banner.tone, .pending)
        XCTAssertEqual(banner.headline, "Waiting to send to Arc · Mac mini")
        XCTAssertTrue(banner.detail!.contains("sends itself"))
    }

    /// A whitespace-only title must be treated as absent on BOTH platforms;
    /// Android uses isNullOrBlank and iOS used isEmpty, so one quoted the spaces.
    func testABlankTitleIsTreatedAsAbsent() {
        XCTAssertEqual(Feedback.recoveredLine(count: 1, firstTitle: "   "), "Sent the tab that was waiting")
        XCTAssertEqual(Feedback.recoveredLine(count: 1, firstTitle: ""), "Sent the tab that was waiting")
    }

    /// Android and iOS must produce the SAME sentence for the same failure. The
    /// Kotlin side asserts these exact strings too; if either drifts, one of the
    /// two test files fails.
    func testMatchesTheAndroidWording() {
        XCTAssertEqual(
            Feedback.failureLine(.phoneOffline),
            "You're offline. This tab sends itself as soon as you're back."
        )
        XCTAssertEqual(
            Feedback.failureLine(.relayUnreachable(relayUrl: "http://r:1")),
            "Can't reach your relay at http://r:1. The tab is held here and sends itself once the relay answers again."
        )
        XCTAssertEqual(
            Feedback.failureLine(.relayRejected(reason: "not_in_group"), targetLabel: "Arc"),
            "Your relay says Arc has left your group of devices."
        )
        XCTAssertEqual(
            Feedback.failureLine(.relayError(code: "internal")),
            "Something went wrong inside your relay. It may be worth checking that it is healthy."
        )
        XCTAssertEqual(
            Feedback.failureLine(.relayUnauthorized),
            "Your relay doesn't recognise this phone any more. Set Tabsend up again here to start sending."
        )
    }

    // MARK: classification

    /// `isOffline` conflates "no network" with "host unreachable". The split is
    /// the whole point: a container that isn't listening must NOT be reported as
    /// the phone having no connection.
    func testARefusedConnectionIsARelayProblemNotAnOfflinePhone() {
        Reachability.shared.override(isOnline: true)
        defer { Reachability.shared.override(isOnline: nil) }
        for code in [URLError.cannotConnectToHost, .cannotFindHost, .timedOut, .secureConnectionFailed] {
            let failure = SendFailure.classifyTransport(URLError(code), relayUrl: "http://r:1")
            XCTAssertEqual(failure, .relayUnreachable(relayUrl: "http://r:1"), "\(code)")
        }
    }

    func testAGenuinelyOfflineDeviceSaysSo() {
        Reachability.shared.override(isOnline: true) // the OS hasn't noticed yet
        defer { Reachability.shared.override(isOnline: nil) }
        for code in [URLError.notConnectedToInternet, .networkConnectionLost] {
            XCTAssertEqual(
                SendFailure.classifyTransport(URLError(code), relayUrl: "http://r:1"),
                .phoneOffline, "\(code)"
            )
        }
    }

    /// The OS signal DEMOTES a relay diagnosis; it never promotes one, and it is
    /// never used to skip a send.
    func testTheOsSignalOnlyDemotes() {
        Reachability.shared.override(isOnline: false)
        defer { Reachability.shared.override(isOnline: nil) }
        XCTAssertEqual(
            SendFailure.classifyTransport(URLError(.cannotConnectToHost), relayUrl: "http://r:1"),
            .phoneOffline
        )
    }

    func testA401IsATokenProblemNotAGenericRelayError() {
        XCTAssertEqual(
            SendFailure.classify(apiError: ApiError(status: 401, code: "unauthorized", message: "x")),
            .relayUnauthorized
        )
        XCTAssertEqual(
            SendFailure.classify(apiError: ApiError(status: 400, code: "invalid_request", message: "x")),
            .relayError(code: "invalid_request")
        )
    }

    // MARK: the held-tab list

    func testHeldTabPrefersTitleThenSite() {
        XCTAssertEqual(Feedback.heldTabLabel(title: "An article", url: "https://example.com/a"), "An article")
        // A bare path tells nobody anything; the site at least places the tab.
        XCTAssertEqual(
            Feedback.heldTabLabel(title: nil, url: "https://developer.mozilla.org/en-US/docs/Web"),
            "developer.mozilla.org"
        )
        XCTAssertEqual(Feedback.heldTabLabel(title: "   ", url: "https://example.com/x"), "example.com")
        XCTAssertEqual(Feedback.heldTabLabel(title: nil, url: "https://example.com:8443/x?a=1"), "example.com")
        XCTAssertEqual(Feedback.heldTabLabel(title: nil, url: "not a url"), "not a url")
        XCTAssertEqual(Feedback.heldTabLabel(title: nil, url: nil), "Untitled tab")
    }

    func testHeldHeadingCountsAndReadsNaturallyAtOne() {
        XCTAssertEqual(Feedback.heldTabsHeading(1), "Waiting on this phone")
        XCTAssertEqual(Feedback.heldTabsHeading(3), "3 tabs waiting on this phone")
    }

    func testNamesTheTabWhenExactlyOneDrained() {
        XCTAssertEqual(Feedback.recoveredLine(count: 1, firstTitle: "An article"), "Sent “An article”")
        XCTAssertEqual(Feedback.recoveredLine(count: 1), "Sent the tab that was waiting")
        XCTAssertEqual(Feedback.recoveredLine(count: 4), "Sent 4 tabs that were waiting")
    }

    func testRelayDownLineNamesTheAddressAndHowLong() {
        let line = Feedback.relayDownLine(relayUrl: "http://192.168.1.50:8787", sinceMinutes: 12)
        XCTAssertTrue(line.contains("http://192.168.1.50:8787"))
        XCTAssertTrue(line.contains("12m ago"))
        XCTAssertTrue(Feedback.relayDownLine(relayUrl: "http://x", sinceMinutes: 125).contains("2h ago"))
        XCTAssertTrue(Feedback.relayDownLine(relayUrl: "http://x", sinceMinutes: 0).contains("just now"))
    }

    // P-15 item 4: away from home, a home-network relay is silent for a reason the
    // bare outage line did not give, and it read as a refresh bug.
    func testRelayDownLineSaysWhyAHomeNetworkRelayIsOutOfReach() {
        let line = Feedback.relayDownLine(relayUrl: "http://192.168.1.20:8786", sinceMinutes: 19)
        XCTAssertTrue(line.contains("19m ago"))
        XCTAssertTrue(line.hasSuffix(HomeNetwork.hint))
        XCTAssertFalse(line.contains("—"))
        XCTAssertTrue(
            Feedback.relayDownLine(relayUrl: "http://minipc.local:8786", sinceMinutes: 5)
                .hasSuffix(HomeNetwork.hint)
        )
    }

    func testRelayDownLineAddsNothingForPublicHostedTailscaleOrSameDeviceRelays() {
        for url in [
            "https://app.tabsend.org",
            "https://relay.example.com",
            "http://100.101.102.103:8787",
            "http://localhost:8787",
            "http://127.0.0.1:8787",
        ] {
            XCTAssertFalse(
                Feedback.relayDownLine(relayUrl: url, sinceMinutes: 19).contains(HomeNetwork.hint),
                url
            )
        }
    }

    // MARK: relay health

    func testAnOutageIsOnlyAnnouncedAfterTheGracePeriod() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let health = RelayHealth(relayUrl: "http://x", reachable: false, since: now.addingTimeInterval(-15))
        // 15s in: a container restart, not a fact worth telling anyone.
        XCTAssertFalse(RelayHealth.isDown(health, now: now))
        XCTAssertTrue(RelayHealth.isDown(health, now: now.addingTimeInterval(RelayHealth.outageGrace)))
        var up = health
        up.reachable = true
        XCTAssertFalse(RelayHealth.isDown(up, now: now.addingTimeInterval(600)))
        XCTAssertFalse(RelayHealth.isDown(nil, now: now))
    }

    /// `since` must survive a same-state refresh. If each report reset it, an
    /// outage would perpetually read as "started just now" and never clear the
    /// grace period that gates the warning — so the warning would never appear.
    func testSameStateRefreshKeepsWhenTheStateBegan() {
        let t0 = Date(timeIntervalSince1970: 1_800_000_000)
        let first = RelayHealth.fold(previous: nil, relayUrl: "http://x", reachable: false, now: t0, lastWrite: nil)
        XCTAssertEqual(first?.since, t0)

        // Within the throttle: nothing to write at all.
        XCTAssertNil(RelayHealth.fold(
            previous: first, relayUrl: "http://x", reachable: false,
            now: t0.addingTimeInterval(5), lastWrite: t0
        ))
        // Past it: written, but `since` still points at when the outage began.
        let refreshed = RelayHealth.fold(
            previous: first, relayUrl: "http://x", reachable: false,
            now: t0.addingTimeInterval(30), lastWrite: t0
        )
        XCTAssertEqual(refreshed?.since, first?.since)
        XCTAssertTrue(RelayHealth.isDown(refreshed, now: t0.addingTimeInterval(30)))

        // A transition always writes, and restamps.
        let back = RelayHealth.fold(
            previous: refreshed, relayUrl: "http://x", reachable: true,
            now: t0.addingTimeInterval(31), lastWrite: t0.addingTimeInterval(30)
        )
        XCTAssertEqual(back?.reachable, true)
        XCTAssertEqual(back?.since, t0.addingTimeInterval(31))
        XCTAssertEqual(back?.lastOkAt, t0.addingTimeInterval(31))
    }

    func testAnUnreachableVerdictRemembersWhenTheRelayLastAnswered() {
        let t0 = Date(timeIntervalSince1970: 1_800_000_000)
        let ok = RelayHealth.fold(previous: nil, relayUrl: "http://x", reachable: true, now: t0, lastWrite: nil)!
        let down = RelayHealth.fold(
            previous: ok, relayUrl: "http://x", reachable: false,
            now: t0.addingTimeInterval(60), lastWrite: t0
        )!
        XCTAssertEqual(down.lastOkAt, ok.lastOkAt)
        XCTAssertEqual(down.minutesSinceLastOk(now: t0.addingTimeInterval(60)), 1)
        XCTAssertEqual(down.minutesSinceLastOk(now: t0.addingTimeInterval(75 * 60)), 75)
    }

    /// A verdict about a relay we are NOT registered to must never be recorded:
    /// otherwise a typo in the relay-move address box reads as an outage.
    func testOnlyTheRegisteredRelayFeedsTheVerdict() {
        let store = MemoryStore()
        store.registration = Registration(
            endpointId: "e1", groupId: "g1", deviceToken: "t",
            relayUrl: "http://ours:8787", label: "iPhone"
        )
        RelayHealthTracker.install(store: store)
        RelayHealthTracker.shared.reset()

        RelayHealthTracker.shared.record(relayUrl: "http://typo:8787", reachable: false, now: Date())
        XCTAssertNil(store.relayHealth)

        RelayHealthTracker.shared.record(relayUrl: "http://ours:8787", reachable: false, now: Date())
        XCTAssertEqual(store.relayHealth?.reachable, false)

        ApiTransport.setHandler(nil)
    }

    // MARK: fixtures

    private var allFailures: [SendFailure] {
        SendFailure.allApiErrorCodes.map { SendFailure.relayError(code: $0) }
            + SendFailure.allRejectionReasons.map { SendFailure.relayRejected(reason: $0) }
            + SendFailure.allGroupLimits.map {
                SendFailure.relayRejected(reason: "limit_reached", limit: $0)
            }
            + [
                .phoneOffline, .relayUnreachable(relayUrl: "http://x"),
                .relayBusy, .relayUnauthorized,
                // Tabsend's own two verdicts. Not wire codes, and the only
                // failures the client decides by itself, but a person still has
                // to be told about them in words.
                .gaveUp(reason: .tooOld), .gaveUp(reason: .queueFull),
                .nothingToSend,
            ]
    }

    /// A relay running a version ahead of this app.
    private var futureFailures: [SendFailure] {
        [
            .relayError(code: "nonsense_code"),
            .relayRejected(reason: "nonsense_reason"),
            .relayRejected(reason: "limit_reached", limit: "a_cap_from_the_future"),
        ]
    }
}
