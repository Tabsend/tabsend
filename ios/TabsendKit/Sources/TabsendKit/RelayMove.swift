import Foundation

/// Classify a candidate relay address as "same relay, new address" or "a
/// different relay", the iOS mirror of android/.../logic/RelayMove.kt and the
/// extension's `probeRelay` (extension/src/background/identity.ts). Kept pure and
/// unit-tested; the network calls that feed it live in `AppModel`.
///
/// Split into two steps because the mismatch case must never send the device
/// token: a relayId mismatch is decided BEFORE any authenticated call, so a
/// relay already proven not to be ours never sees the token at all.
public enum RelayMove {
    public enum Verdict: Equatable, Sendable {
        /// Our relay, reached at `relayUrl`. `verified` false means one side
        /// predates relayId, so the token check alone carries the claim.
        case same(relayUrl: String, verified: Bool)
        /// No record of this phone here. Moving means every device pairs again.
        case different(relayUrl: String)
        /// Nothing answered.
        case unreachable(relayUrl: String)
        /// Answered, but unusable as-is (protocol mismatch, relay-side error).
        case error(relayUrl: String, detail: String)
    }

    /// Step 1, before any token leaves the phone: do the relayIds already
    /// disagree? `.different` only when BOTH sides have an id and they differ;
    /// nil when the comparison can't decide, so the token probe must still run.
    public static func byRelayId(relayUrl: String, storedId: String?, fetchedId: String?) -> Verdict? {
        if let storedId, let fetchedId, storedId != fetchedId {
            return .different(relayUrl: relayUrl)
        }
        return nil
    }

    /// Step 2: the token probe ran because step 1 was inconclusive. A rejected
    /// token (401) means this relay has never heard of this phone.
    public static func byTokenProbe(
        relayUrl: String, storedId: String?, fetchedId: String?, tokenRejected: Bool
    ) -> Verdict {
        if tokenRejected { return .different(relayUrl: relayUrl) }
        return .same(relayUrl: relayUrl, verified: storedId != nil && fetchedId != nil)
    }

    // MARK: copy, word for word as android/.../res/values/strings.xml (relay_move_*)

    public static var button: String {
        String(
            localized: "Move to another relay\u{2026}",
            bundle: .module,
            comment: "Settings row on the home screen that opens the move-to-another-relay sheet. Ends with an ellipsis because it opens a sheet."
        )
    }
    public static var title: String {
        String(
            localized: "Move to another relay",
            bundle: .module,
            comment: "Title of the move-to-another-relay sheet."
        )
    }
    public static var hint: String {
        String(
            localized: "Where is your relay now?",
            bundle: .module,
            comment: "Heading above the address field on the move-to-another-relay sheet. The relay is the server that passes tabs between devices."
        )
    }
    public static var check: String {
        String(
            localized: "Check",
            bundle: .module,
            comment: "Button on the move-to-another-relay sheet that checks the address typed in the field. Keep it to one word."
        )
    }
    public static var checking: String {
        String(
            localized: "Checking\u{2026}",
            bundle: .module,
            comment: "Status line on the move-to-another-relay sheet while the address is being checked."
        )
    }
    public static var empty: String {
        String(
            localized: "Enter the relay address.",
            bundle: .module,
            comment: "Message on the move-to-another-relay sheet when Check is pressed with an empty field."
        )
    }
    public static var same: String {
        String(
            localized: "Same relay. Your devices stay paired.",
            bundle: .module,
            comment: "Result on the move-to-another-relay sheet: the new address is the same relay as before, so nothing needs to be paired again."
        )
    }
    public static var sameUnverified: String {
        String(
            localized: "Probably the same relay. It's too old to confirm, but it accepted this phone's login.",
            bundle: .module,
            comment: "Result on the move-to-another-relay sheet: the relay is too old to confirm its identity, but it accepted this phone's credentials."
        )
    }
    public static var different: String {
        String(
            localized: "This is a different relay. It doesn't know your devices, so each one will need to pair again.",
            bundle: .module,
            comment: "Result on the move-to-another-relay sheet: the address is a different relay, so every device has to be paired again."
        )
    }
    public static var switchAddress: String {
        String(
            localized: "Switch to this address",
            bundle: .module,
            comment: "Button on the move-to-another-relay sheet, shown when the address is the same relay. It switches the app to the new address."
        )
    }
    public static var switchRelay: String {
        String(
            localized: "Switch to this relay",
            bundle: .module,
            comment: "Destructive button on the move-to-another-relay sheet and in its confirmation dialog, shown when the address is a different relay."
        )
    }
    public static var startFreshBody: String {
        String(
            localized: "This phone leaves its current device group. Every device you want to keep has to pair again on the new relay.",
            bundle: .module,
            comment: "Body of the confirmation dialog before switching to a different relay. The device group is the set of devices that send tabs to each other."
        )
    }
    public static var afterStartFresh: String {
        String(
            localized: "Paste or scan a setup link created by that relay.",
            bundle: .module,
            comment: "Message on the first-run screen after switching to a different relay. A setup link is the pairing link a device already using Tabsend shows."
        )
    }

    public static func unreachable(_ relayUrl: String) -> String {
        String(
            localized: "Couldn't reach \(relayUrl). Check the address and that it's running.",
            bundle: .module,
            comment: "Result on the move-to-another-relay sheet when the relay did not answer. %@ is the address that was checked."
        )
    }

    public static func refused(_ detail: String) -> String {
        String(
            localized: "The relay refused the check: \(detail)",
            bundle: .module,
            comment: "Result on the move-to-another-relay sheet when the relay answered with an error. %@ is a full sentence saying why, such as \"Your relay is busy right now. Give it a moment and try again.\""
        )
    }

    public static func startFreshTitle(_ relayUrl: String) -> String {
        String(
            localized: "Start fresh on \(relayUrl)?",
            bundle: .module,
            comment: "Title of the confirmation dialog before switching to a different relay. %@ is the relay address."
        )
    }

    public static func done(_ relayUrl: String) -> String {
        String(
            localized: "Now using \(relayUrl).",
            bundle: .module,
            comment: "Banner on the home screen after the relay address was changed. %@ is the new address."
        )
    }

    public static func commitFailed(_ detail: String) -> String {
        String(
            localized: "\(detail) Nothing was changed.",
            bundle: .module,
            comment: "Message on the move-to-another-relay sheet when switching failed. %@ is the reason, a full sentence. Nothing was changed: the app still uses the old relay."
        )
    }
}
