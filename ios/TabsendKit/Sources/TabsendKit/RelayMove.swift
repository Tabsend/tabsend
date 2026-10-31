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

    public static let button = "Move to another relay\u{2026}"
    public static let title = "Move to another relay"
    public static let hint = "Where is your relay now?"
    public static let check = "Check"
    public static let checking = "Checking\u{2026}"
    public static let empty = "Enter the relay address."
    public static let same = "Same relay. Your devices stay paired."
    public static let sameUnverified =
        "Probably the same relay. It's too old to confirm, but it accepted this phone's login."
    public static let different =
        "This is a different relay. It doesn't know your devices, so each one will need to pair again."
    public static let switchAddress = "Switch to this address"
    public static let switchRelay = "Switch to this relay"
    public static let startFreshBody =
        "This phone leaves its current device group. Every device you want to keep has to pair again on the new relay."
    public static let afterStartFresh = "Paste or scan a setup link created by that relay."

    public static func unreachable(_ relayUrl: String) -> String {
        "Couldn't reach \(relayUrl). Check the address and that it's running."
    }

    public static func refused(_ detail: String) -> String {
        "The relay refused the check: \(detail)"
    }

    public static func startFreshTitle(_ relayUrl: String) -> String {
        "Start fresh on \(relayUrl)?"
    }

    public static func done(_ relayUrl: String) -> String {
        "Now using \(relayUrl)."
    }

    public static func commitFailed(_ detail: String) -> String {
        "\(detail) Nothing was changed."
    }
}
