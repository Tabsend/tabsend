import Foundation

/// The phone's own words for an error the relay answered with.
///
/// The relay's `message` is written for a log, may change at any time, and is always
/// English (`shared/src/types.ts` §10b). So no screen shows it. A screen asks this type
/// instead, which looks only at the machine-readable `code` (docs/L10N.md, rule 8) and
/// answers with a catalog sentence. A code this app has never heard of reads as an
/// internal error, which is also what the relay means by `internal`.
///
/// The same code can mean different things in different places: `not_found` on a rename
/// is a device that is gone, on a new pairing link it is the whole group. That is the
/// only reason a caller says what it was doing.
public enum RelayErrorText {
    /// What the person was doing when the relay said no.
    public enum Action: Sendable, CaseIterable {
        case renameDevice, removeDevice, pairingLink, stopReset
        /// Pairing this phone with a setup link.
        case join
        /// Looking at another relay's address (moving to a different relay).
        case check
    }

    public static func line(_ error: ApiError, during action: Action) -> String {
        line(code: error.code, during: action)
    }

    public static func line(code: String, during action: Action) -> String {
        switch code {
        case "unauthorized", "endpoint_removed":
            return String(
                localized: "Your relay no longer accepts this phone. Set Tabsend up again here.",
                bundle: .module,
                comment: "Explanation after a request failed: the relay does not accept this phone's credentials. Setting up again means pairing again. The relay is the server."
            )
        case "forbidden":
            return String(
                localized: "Your relay wouldn't allow that. If your group is suspended, whoever runs the relay can lift the suspension.",
                bundle: .module,
                comment: "Explanation after a request failed: the relay refused permission. A group can be suspended on a relay, and only the person or company running the relay can lift that. The relay is the server."
            )
        case "not_found":
            switch action {
            case .renameDevice, .removeDevice:
                return String(
                    localized: "Your relay couldn't find that device. It may already be gone.",
                    bundle: .module,
                    comment: "Explanation after renaming or removing a device failed: the relay has no such device in the group. The relay is the server."
                )
            case .pairingLink, .stopReset:
                return String(
                    localized: "Your relay no longer has this group. Pair this phone again if you still have access.",
                    bundle: .module,
                    comment: "Explanation after a request failed: the group was deleted on the relay. Pairing again means joining with a new setup link. The relay is the server."
                )
            case .join, .check:
                return String(
                    localized: "That address didn't answer like a Tabsend relay. Check it and try again.",
                    bundle: .module,
                    comment: "Explanation when the address typed or pasted does not lead to a Tabsend relay (the server that passes tabs between devices)."
                )
            }
        case "invalid_request":
            return String(
                localized: "Your relay didn't understand that. It's most likely running an older version than this phone. Updating it should fix this.",
                bundle: .module,
                comment: "Explanation after a request failed: the relay could not read what the phone sent. The relay is the server, probably out of date."
            )
        case "invalid_pairing_code":
            return action == .join
                ? String(
                    localized: "That setup link is unknown, expired, or already used.",
                    bundle: .module,
                    comment: "Banner on the first-run screen when the relay refuses the pairing code in the setup link."
                )
                : Feedback.pairingCodeGoneLine
        case "group_exists":
            return Feedback.groupExistsLine
        case "limit_reached":
            switch action {
            case .join:
                return Feedback.deviceLimitLine
            case .pairingLink:
                return String(
                    localized: "This group already has the most unused pairing links it allows. Try again in a few minutes, when the oldest one expires.",
                    bundle: .module,
                    comment: "Explanation when making a new pairing link failed: too many links are waiting to be used, and each expires by itself after a few minutes."
                )
            default:
                return String(
                    localized: "Your relay has reached a limit for your group.",
                    bundle: .module,
                    comment: "Explanation after a request failed: some limit for this group was reached on the relay. The relay is the server."
                )
            }
        case "rate_limited":
            return String(
                localized: "Your relay is busy right now. Give it a moment and try again.",
                bundle: .module,
                comment: "Explanation after a request failed: the relay is limiting how fast requests may come. The relay is the server."
            )
        default:
            return Feedback.internalLine
        }
    }
}
