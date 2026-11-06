import Foundation

/// Why a send didn't land, and the sentence to say about it.
///
/// Hand-mirrored from `extension/src/lib/strings.ts` + `lib/health.ts` and kept
/// word-for-word in step with `android/.../logic/SendFeedback.kt`
/// (INTERACTION_FLOWS §4a, ADR-0008 amendment 2026-07-29). `shared/` is
/// TypeScript and can't be consumed from Swift, so the copy lives three times;
/// what MUST stay in step are the two closed wire sets it switches on —
/// `ApiErrorCode` and `SendResponse.rejected[].reason` — pinned down by
/// `SendFailure.allApiErrorCodes` / `allRejectionReasons` for the tests.
///
/// Two bugs this replaces, both inherited when the app was ported from the
/// extension's pre-amendment send path:
///
/// 1. `"Relay rejected the send (\(rejection.reason))."` put a wire code in
///    front of a person. `unknown_target` is a string for a program.
/// 2. Any transport failure rendered "No connection — will send when you're back
///    online", which for a self-hosted relay is a WRONG diagnosis: the phone's
///    network is fine, the relay isn't answering, and the user checks their wifi
///    and finds nothing wrong (dogfood 2026-07-29).
public enum SendFailure: Sendable, Equatable {
    /// This phone has no network at all. Nothing to fix but the wifi.
    case phoneOffline
    /// Network is up; the relay never answered. Names the address it tried.
    case relayUnreachable(relayUrl: String)
    /// The relay took the request but refused this item (per-item reason set).
    ///
    /// `limit` rides along with `limit_reached` and names WHICH per-group cap
    /// said no [0030], which is what lets the copy describe the wait instead of
    /// a generic refusal. That one reason is also the only refusal here that is
    /// NOT final: every cap clears itself, so the tab stays queued and is
    /// retried by the ordinary flush, exactly like a `.relayBusy` answer. The
    /// rest stay final.
    case relayRejected(reason: String, limit: String? = nil)
    /// The relay answered the whole request with an error envelope.
    case relayError(code: String)
    /// The relay answered, but with "not now" rather than "no": a 429, or any 5xx
    /// — including the HTML 502/504 a reverse proxy or a restarting container
    /// returns, which `ApiClient` can only map to the generic `internal` code.
    ///
    /// Recoverable, and that is the whole point of separating it from
    /// `relayError`: treating a 502 as a definite refusal DISCARDED the tab, and
    /// in a queue flush discarded every queued tab in one pass.
    case relayBusy
    /// The relay no longer accepts this phone's token.
    case relayUnauthorized
    /// Tabsend itself stopped holding the tab. Not a thing the relay said — this
    /// is the ONE failure the client decides on its own, which is why it is a
    /// classification and not a wire code, and why `shared/src/types.ts` grows
    /// no member for it.
    ///
    /// Final, and deliberately so: the queue kept the tab through every 429,
    /// every 5xx and every silence, and this is what eventually ends that.
    /// `.tooOld` is the relay's own message TTL running out; `.queueFull` is the
    /// size cap making room for the send the user just made. Told apart because
    /// they are told to the user differently, and one sentence for both would be
    /// false half the time.
    case gaveUp(reason: GaveUpReason)
    /// Nothing sendable in what was shared.
    case nothingToSend

    /// True when the tab is safely queued and will retry itself (no user action).
    ///
    /// `.gaveUp` is deliberately NOT here. It is the thing that ENDS the
    /// retrying; reading it as "will retry itself" would put the tab back in the
    /// pending tone and re-make the promise the queue has just stopped keeping.
    public var isRecoverable: Bool {
        switch self {
        case .phoneOffline, .relayUnreachable, .relayBusy: return true
        // A per-group cap [0030] is the same shape of answer as a 429: it clears
        // itself, so the tab stays queued rather than being thrown away over a
        // wait of about a minute. Every other refusal is still final.
        case .relayRejected(let reason, _): return Self.isCapRefusal(reason)
        case .relayError, .relayUnauthorized, .gaveUp, .nothingToSend: return false
        }
    }

    /// The one per-item refusal that is not final [0030].
    ///
    /// A cap refusal is the relay saying "not this minute", not "no": the send
    /// window rolls over on its own, and the queue caps drain as the target
    /// reads its tabs. Treating it as final threw the tab away over a wait of
    /// about a minute, which is the same mistake `.relayBusy` exists to prevent
    /// for a 429.
    ///
    /// Keyed on the REASON and never on the limit: a relay that names no cap has
    /// still said the same thing, and `capHeldLine` has a sentence for that.
    public static func isCapRefusal(_ reason: String) -> Bool { reason == "limit_reached" }

    /// Mirrored from `shared/src/types.ts` so a test can assert every member
    /// produces a sentence. When the relay grows a code, adding it here fails the
    /// test until it has copy — which is how `group_exists` was caught.
    ///
    /// `limit_reached` is a per-group limit refusing a whole call: the endpoint cap
    /// on a register [0030], or the live-link limit on a pairing mint [0031 amended].
    public static let allApiErrorCodes = [
        "unauthorized", "endpoint_removed", "forbidden", "not_found",
        "invalid_request", "invalid_pairing_code", "group_exists",
        "limit_reached", "rate_limited", "internal",
    ]

    /// `SendResponse.rejected[].reason` — its own set, and NOT errors (still 200).
    public static let allRejectionReasons = [
        "unknown_target", "expired_key", "not_in_group", "limit_reached",
    ]

    /// `SendResponse.rejected[].limit` — which per-group cap refused the item [0030].
    ///
    /// Rides with `limit_reached` only. `endpoints` can refuse a join but never
    /// a send; it is listed anyway so a test covers the line it would get if one
    /// ever arrived, which is the same general line an unnamed or future cap gets.
    public static let allGroupLimits = [
        "endpoints", "queued_messages", "queued_bytes", "sends_per_window",
    ]
}

/// Why Tabsend stopped holding a tab. See `OutboundQueue` for the two bounds.
public enum GaveUpReason: Sendable, Equatable {
    case tooOld, queueFull
}

/// Three tones. The tone is a promise about where the tab actually is.
public enum SendTone: Sendable {
    case success, pending, error
}

/// What to show for one completed send.
///
/// `title` is the shared page's title, so a user with several sends in flight
/// knows WHICH one is being reported — the thing a bare "Sent to Arc" never said.
public struct SendBanner: Sendable, Equatable {
    public var tone: SendTone
    public var headline: String
    public var title: String?
    public var detail: String?

    public init(tone: SendTone, headline: String, title: String? = nil, detail: String? = nil) {
        self.tone = tone
        self.headline = headline
        self.title = title
        self.detail = detail
    }
}

extension SendTone: Equatable {}

extension Feedback {
    /// The no-label fallback. NOT a proper noun, hence the mid-sentence rule.
    public static var thatDevice: String {
        String(
            localized: "that device",
            bundle: .module,
            comment: "Stands in for a device's name when the name is unknown. It sits inside a sentence, where %@ is a device name: \"Your relay couldn't find %@.\", \"Waiting for %@\", \"%@ never picked it up...\". Not capitalized: it never starts a sentence. A language with cases or genders may need those sentences reworded when this phrase is used."
        )
    }

    /// One sentence saying what happened and, where there is one, what to do.
    ///
    /// Nothing here may leak a wire code, and every line places the device label
    /// MID-sentence: a real label ("Arc · Mac mini") is a proper noun but
    /// `thatDevice` is not, so a line opening with it would read as a lowercase
    /// sentence. Both rules are enforced by SendFeedbackTests.
    public static func failureLine(_ failure: SendFailure, targetLabel: String? = nil) -> String {
        let device = targetLabel ?? thatDevice
        switch failure {
        case .phoneOffline:
            return String(
                localized: "You're offline. This tab sends itself as soon as you're back.",
                bundle: .module,
                comment: "Explanation under a failed or waiting send: this phone has no internet connection. The tab is kept and sent later."
            )
        case .relayUnreachable(let relayUrl):
            return String(
                localized: "Can't reach your relay at \(relayUrl). The tab is held here and sends itself once the relay answers again.",
                bundle: .module,
                comment: "Explanation under a waiting send: the relay (the server that passes tabs between devices) did not answer. %@ is the relay address."
            )
        case .relayRejected(let reason, let limit):
            return rejectionLine(reason, device, limit)
        case .relayError(let code):
            return relayErrorLine(code, device)
        case .relayBusy:
            return String(
                localized: "Your relay is having trouble right now. The tab is held here and sends itself once the relay is answering properly again.",
                bundle: .module,
                comment: "Explanation under a waiting send: the relay answered with a server error. The relay is the server that passes tabs between devices."
            )
        case .relayUnauthorized:
            return unauthorizedLine
        case .gaveUp(let reason):
            return givenUpLine(reason)
        case .nothingToSend:
            return String(
                localized: "There's no link in what you shared.",
                bundle: .module,
                comment: "Message in the share sheet when the shared item contains no web address that could be sent."
            )
        }
    }

    /// The two ways Tabsend gives up on a tab it was holding.
    ///
    /// Both name the number that decided it, because the number is the only
    /// thing that makes the sentence answerable: "seven days" tells a
    /// self-hoster their relay has been down for a week, and "at most 200" tells
    /// someone who shared all evening exactly what happened to the rest. Neither
    /// line names a device, so all three clients say them verbatim and the §4c
    /// "this phone" / "this browser" rule does not bite.
    private static func givenUpLine(_ reason: GaveUpReason) -> String {
        switch reason {
        case .tooOld:
            let days = OutboundQueue.maxAgeDays
            return String(
                localized: "This tab waited \(days) days for your relay and was never taken, so Tabsend has stopped holding it. Send it again once the relay is answering.",
                bundle: .module,
                comment: "Explanation under a failed send: the tab waited too long for the relay and was dropped. %lld is the number of days, such as 7. The relay is the server."
            )
        case .queueFull:
            let tabs = OutboundQueue.maxItems
            return String(
                localized: "Tabsend holds at most \(tabs) tabs while your relay isn't taking them, and this one was the oldest. Send it again once the relay is answering.",
                bundle: .module,
                comment: "Explanation under a failed send: too many tabs were waiting and this, the oldest, was dropped. %lld is the most tabs kept, such as 200. The relay is the server."
            )
        }
    }

    /// Per-item refusals [SendResponse.rejected] — always about ONE target. An
    /// unrecognised reason folds to the generic line rather than leaking: a relay
    /// newer than this app will send reasons we have no copy for.
    private static func rejectionLine(
        _ reason: String, _ device: String, _ limit: String? = nil
    ) -> String {
        switch reason {
        case "unknown_target":
            return String(
                localized: "Your relay doesn't know \(device) any more. Pair it again, then send this tab a second time.",
                bundle: .module,
                comment: "Explanation under a failed send: the relay no longer knows the receiving device. %@ is the device name, or \"that device\". The relay is the server."
            )
        case "expired_key":
            return String(
                localized: "The keys on \(device) have changed since this phone last saw them. Open Tabsend once to pick up the new ones, then send again.",
                bundle: .module,
                comment: "Explanation under a failed send: the receiving device has new encryption keys. %@ is the device name, or \"that device\"."
            )
        case "not_in_group":
            return String(
                localized: "Your relay says \(device) has left your group of devices.",
                bundle: .module,
                comment: "Explanation under a failed send: the receiving device is no longer in the group. %@ is the device name, or \"that device\". The relay is the server."
            )
        case "limit_reached":
            return capHeldLine(limit)
        default:
            return internalLine
        }
    }

    /// A per-group cap refused the item [0030]. Said as a wait, not as a failure,
    /// because every one of these caps clears itself: the send window rolls over
    /// within a minute of the relay's own clock, and the queue caps drain as the
    /// receiving device reads what is already waiting for it. The tab stays in
    /// the same outbound queue that holds tabs through an outage, and the same
    /// flush sends it.
    ///
    /// Named per cap because the two waits end for different reasons, and
    /// "shortly" would be a lie about a queue that only moves when someone picks
    /// up their phone. `endpoints` cannot refuse a send (it refuses a join), and
    /// a fifth cap added later has no literal here, so both take the general line
    /// — which is true of every cap, and is why the relay may omit the field.
    ///
    /// Word-for-word the same sentences as `lib/strings.ts` and
    /// `SendFeedback.kt`; only the extension can pluralize them, because only it
    /// can send several tabs at once.
    private static func capHeldLine(_ limit: String?) -> String {
        switch limit {
        case "sends_per_window":
            return String(
                localized: "Your relay is pacing sends for your group right now. This tab is queued and will send itself shortly.",
                bundle: .module,
                comment: "Explanation under a waiting send: the relay limits how fast this group may send. The wait clears within about a minute. The relay is the server."
            )
        case "queued_messages", "queued_bytes":
            return String(
                localized: "Your relay is holding as much as your group's limit allows. This tab is queued and will send once the receiving device catches up.",
                bundle: .module,
                comment: "Explanation under a waiting send: the relay holds the most it may for this group. The tab goes when the receiving device collects what is already waiting. The relay is the server."
            )
        default:
            return String(
                localized: "Your relay has reached a limit for your group. This tab is queued and will send itself once there is room.",
                bundle: .module,
                comment: "Explanation under a waiting send: the relay reached some limit for this group. The relay is the server."
            )
        }
    }

    /// Whole-request errors [ApiError.code]. The relay answered, and said no.
    private static func relayErrorLine(_ code: String, _ device: String) -> String {
        switch code {
        case "not_found":
            return String(
                localized: "Your relay couldn't find \(device).",
                bundle: .module,
                comment: "Explanation under a failed send: the relay has no such device. %@ is the device name, or \"that device\". The relay is the server."
            )
        case "forbidden":
            return String(
                localized: "Your relay wouldn't let this phone send to \(device).",
                bundle: .module,
                comment: "Explanation under a failed send: the relay refused permission. %@ is the device name, or \"that device\". The relay is the server."
            )
        case "invalid_request":
            return String(
                localized: "Your relay didn't understand this send. It's most likely running an older version than this phone. Updating it should fix this.",
                bundle: .module,
                comment: "Explanation under a failed send: the relay could not read the request. The relay is the server, probably out of date."
            )
        // classify() routes a 429 to .relayBusy, which DOES retry itself, so this
        // is belt-and-braces for a relay that sends the code with another status.
        case "rate_limited":
            return String(
                localized: "Your relay is busy right now. Give it a moment and send again.",
                bundle: .module,
                comment: "Explanation under a failed send: the relay is rate limiting requests. The relay is the server."
            )
        // Both mean "your token is no good"; classify() routes them to
        // .relayUnauthorized before they get here, so this is belt-and-braces.
        case "unauthorized", "endpoint_removed":
            return unauthorizedLine
        case "invalid_pairing_code":
            return pairingCodeGoneLine
        // Only ever answered to a register/create call [ADR-0022], never to a send;
        // it has a line so the wire set stays fully covered as it grows.
        case "group_exists":
            return groupExistsLine
        // Not reachable on a send either: of the per-group caps, only the endpoint
        // one can refuse a whole call, and it does that to a join [0030]. A pairing
        // mint can also answer `limit_reached` [0031 amended]; `RelayErrorText` words
        // that one.
        case "limit_reached":
            return deviceLimitLine
        default:
            return internalLine
        }
    }

    /// Shared with `RelayErrorText`, the same words for the same code on every screen.
    static var pairingCodeGoneLine: String {
        String(
            localized: "That pairing code is no longer valid.",
            bundle: .module,
            comment: "Explanation under a failed request: the pairing code was used, expired or unknown."
        )
    }
    static var groupExistsLine: String {
        String(
            localized: "Your relay already hosts a group of devices.",
            bundle: .module,
            comment: "Explanation under a failed request: the relay already has a device group and allows only one. The relay is the server."
        )
    }

    private static var unauthorizedLine: String {
        String(
            localized: "Your relay doesn't recognise this phone any more. Set Tabsend up again here to start sending.",
            bundle: .module,
            comment: "Explanation under a failed send: the relay does not accept this phone's credentials. Setting up again means pairing again. The relay is the server."
        )
    }
    static var internalLine: String {
        String(
            localized: "Something went wrong inside your relay. It may be worth checking that it is healthy.",
            bundle: .module,
            comment: "Explanation under a failed request or send: the relay reported an unexpected internal error, or an error this app has no wording for. The relay is the server."
        )
    }

    /// The device cap turned this phone away at the door [0030]. Said in the
    /// client's own words rather than passing the relay's prose through:
    /// `message` is written for a log and is explicitly allowed to change
    /// (`shared/src/types.ts` §10b), and this is a banner a person reads.
    ///
    /// FINAL, which is what makes it read nothing like `capHeldLine` above. A
    /// group that is full stays full until a person removes a device, so there is
    /// no retry to promise and the only useful sentence names the action. Nothing
    /// is queued either: pairing never got as far as an identity on the relay.
    ///
    /// Word-for-word the same sentence as `lib/strings.ts` and `SendFeedback.kt`.
    public static var deviceLimitLine: String {
        String(
            localized: "Your relay has reached its device limit for your group. Remove a device you are not using, then pair this one again.",
            bundle: .module,
            comment: "Banner when pairing is refused because the group already has the most devices the relay allows. The relay is the server."
        )
    }

    /// The banner for a completed send. Only `.success` may say "Sent", and it
    /// means the relay ACCEPTED the tab — not that the row was tapped. A tab
    /// merely held in the outbound queue is `ok` (it isn't lost) but gets
    /// `.pending`; claiming "Sent" there is the exact lie that made a dead relay
    /// invisible.
    public static func banner(
        ok: Bool,
        queued: Bool,
        targetLabel: String?,
        title: String? = nil,
        failure: SendFailure? = nil
    ) -> SendBanner {
        let label = targetLabel ?? String(
            localized: "your device",
            bundle: .module,
            comment: "Stands in for a device's name when the name is unknown. It sits inside the headlines \"Sent to %@\", \"Waiting to send to %@\" and \"Couldn't send to %@\". A language with cases or genders may need those headlines reworded when this phrase is used."
        )
        if let failure {
            let recoverable = failure.isRecoverable
            return SendBanner(
                tone: recoverable ? .pending : .error,
                headline: recoverable ? waitingToSend(to: label) : couldntSend(to: label),
                title: title,
                detail: failureLine(failure, targetLabel: targetLabel)
            )
        }
        if !ok {
            return SendBanner(tone: .error, headline: couldntSend(to: label), title: title, detail: sendFailed)
        }
        return SendBanner(
            tone: .success,
            headline: String(
                localized: "Sent to \(label)",
                bundle: .module,
                comment: "Share-sheet confirmation that a tab was sent. %@ is the name of the receiving device, such as \"Work laptop\". Keep it short: it is a toast."
            ),
            title: title
        )
    }

    private static func waitingToSend(to label: String) -> String {
        String(
            localized: "Waiting to send to \(label)",
            bundle: .module,
            comment: "Headline of a toast or notification: the tab could not be sent yet and will go by itself. %@ is the name of the receiving device. Keep it short."
        )
    }

    private static func couldntSend(to label: String) -> String {
        String(
            localized: "Couldn't send to \(label)",
            bundle: .module,
            comment: "Headline of a toast or notification: the tab could not be sent. %@ is the name of the receiving device. Keep it short."
        )
    }

    /// Heading for the tabs still sitting on THIS phone because the relay hasn't
    /// taken them. Deliberately distinct from any "N waiting for <device>" count,
    /// which counts tabs the relay already HAS and is holding for a sleeping
    /// target — a different promise, and merging them lets an outage read as a
    /// normal sleeping device.
    public static func heldTabsHeading(_ count: Int) -> String {
        String(
            localized: "\(count) tabs waiting on this phone",
            bundle: .module,
            comment: "Heading of the list of tabs still on this phone because the relay has not taken them. %lld is how many. The singular form drops the number."
        )
    }

    /// What to call a held tab in a list. The title is what the user recognises;
    /// the site is the fallback, because a bare URL path tells nobody anything.
    public static func heldTabLabel(title: String?, url: String?) -> String {
        if let title, !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return title }
        guard let url, !url.isEmpty else {
            return String(
                localized: "Untitled tab",
                bundle: .module,
                comment: "Name of a waiting tab that has neither a title nor an address to show."
            )
        }
        return URL(string: url)?.host ?? url
    }

    /// Confirmation that the queue drained, naming the tab when there's just one.
    public static func recoveredLine(count: Int, firstTitle: String? = nil) -> String {
        if count == 1 {
            // Blank, not merely empty: Android uses isNullOrBlank, and a title of
            // spaces rendered as Sent “   ” on one platform and not the other.
            if let firstTitle,
               !firstTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                return String(
                    localized: "Sent “\(firstTitle)”",
                    bundle: .module,
                    comment: "Notification title: the one tab that was waiting has been sent. %@ is the page title, in curly quotes."
                )
            }
        }
        return String(
            localized: "Sent \(count) tabs that were waiting",
            bundle: .module,
            comment: "Notification title: tabs that were waiting have been sent. %lld is how many. The singular form is used when there is one tab and no title to show."
        )
    }

    /// The standing relay-outage line, for a surface the user opens LATER. Not
    /// tied to any one send: it answers "why did nothing arrive?" for someone who
    /// has already walked away from the sheet they shared from.
    ///
    /// A relay on a home-network address gets one more sentence (PLANS.md P-15
    /// item 4): away from home or on mobile data, that address cannot answer, and
    /// the bare outage line read as a refresh bug. Same rule and words as the
    /// extension, Android and the console.
    public static func relayDownLine(relayUrl: String, sinceMinutes: Int) -> String {
        let ago: String
        if sinceMinutes < 1 {
            ago = L10n.justNow
        } else if sinceMinutes < 60 {
            ago = L10n.minutesAgo(sinceMinutes)
        } else {
            ago = L10n.hoursAgo(Int((Double(sinceMinutes) / 60).rounded()))
        }
        let line = String(
            localized: "Can't reach your relay at \(relayUrl). It last answered \(ago), and sends are being held until it's back.",
            bundle: .module,
            comment: "Standing notice on the home screen: the relay (the server that passes tabs between devices) is not answering. The first %@ is the relay address, the second is how long ago it last answered, such as \"5m ago\"."
        )
        return HomeNetwork.isHomeNetworkRelay(relayUrl) ? hint(after: line) : line
    }

    /// The home-network sentence is appended as a second sentence, with a space.
    private static func hint(after line: String) -> String {
        [line, HomeNetwork.hint].joined(separator: " ")
    }
}
