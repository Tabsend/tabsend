import Foundation

/// What Tabsend's own service has told this phone's group about its plan (docs/PLANS.md P-19):
/// the free trial and when it ends, the trial ended, or just "an account".
///
/// The words come from the relay (`GET /v1/group`, field `service`), which the account site
/// writes when a trial starts, a plan changes or a group is paused. A relay with no account
/// site (every self-hosted one) sends nothing, and then the phone shows no trial line, no
/// notice and no Account group. Nothing is ever worked out from a date or a tap: a guessed
/// "trial ended" would tell a person who just paid that their sending is paused.
public enum GroupService {
    public enum Plan: Equatable, Sendable {
        /// Sending runs on the free trial. `endsAt` is nil only if the relay's date cannot be read.
        case trial(endsAt: Date?)
        /// The trial ended and sending is paused for that reason.
        case trialEnded
        /// An account on the service with nothing to show: paid, lifetime, free time, or paused
        /// for another reason (which the send errors already explain).
        case account
    }

    // MARK: the words

    /// A state this build does not know is nil, not a guess.
    public static func plan(_ service: GroupServiceState?) -> Plan? {
        guard let service else { return nil }
        switch service.state {
        case "trial": return .trial(endsAt: service.trialEndsAt.flatMap(WireDate.date(from:)))
        case "trial_ended": return .trialEnded
        case "account": return .account
        default: return nil
        }
    }

    // MARK: what this phone remembers

    private static let key = "groupServiceState"

    /// Keeps what the relay just said, or forgets it when the relay says nothing (an older relay,
    /// or one with no account site). Call it only after a good answer: a failed fetch must keep
    /// what the phone knew.
    public static func save(_ service: GroupServiceState?, in defaults: UserDefaults = .standard) {
        guard let service, let data = try? JSONEncoder().encode(service) else {
            defaults.removeObject(forKey: key)
            return
        }
        defaults.set(data, forKey: key)
    }

    /// The plan as last said, or nil.
    public static func current(in defaults: UserDefaults = .standard) -> Plan? {
        guard let data = defaults.data(forKey: key),
              let service = try? JSONDecoder().decode(GroupServiceState.self, from: data)
        else { return nil }
        return plan(service)
    }

    /// Unpairing forgets it, like everything else this phone knew about its group.
    public static func clear(in defaults: UserDefaults = .standard) {
        defaults.removeObject(forKey: key)
    }

    // MARK: copy (design sheet first-run, screens 4, 5 and 8)

    /// "Nov 18", in the person's own time zone.
    public static func shortDay(_ date: Date, timeZone: TimeZone = .current) -> String {
        L10n.shortMonthAndDay(date, timeZone: timeZone)
    }

    public static var sectionTitle: String {
        String(
            localized: "Tabsend service",
            bundle: .module,
            comment: "Heading of the small group on the home screen that shows the free trial. \"Tabsend service\" is Tabsend's own hosted server, as opposed to a server the person runs."
        )
    }

    public static var trialLabel: String {
        String(
            localized: "Free trial",
            bundle: .module,
            comment: "Row label on the home screen while the free trial runs. The row's value, on the right, is the end date."
        )
    }

    public static func trialValue(endsAt: Date?, timeZone: TimeZone = .current) -> String {
        guard let endsAt else { return "" }
        let day = shortDay(endsAt, timeZone: timeZone)
        return String(
            localized: "Until \(day)",
            bundle: .module,
            comment: "Value on the right of the \"Free trial\" row. %@ is the date the trial ends, such as \"Nov 18\". Keep it short."
        )
    }

    public static var trialFooter: String {
        String(
            localized: "We email you before it ends.",
            bundle: .module,
            comment: "Small note under the \"Free trial\" row on the home screen. \"It\" is the free trial; the email is sent three days before."
        )
    }

    public static var trialEndedTitle: String {
        String(
            localized: "Your free trial has ended",
            bundle: .module,
            comment: "Heading of the amber card at the top of the home screen after the free trial ended."
        )
    }

    public static var trialEndedBody: String {
        String(
            localized: "Sending is paused. We emailed you what to do next.",
            bundle: .module,
            comment: "Text of the amber card after the free trial ended. Says what happened and that an email has the next step. Names no price and has no button to pay."
        )
    }

    /// The second line of a device row while sending is paused (design sheet, screen 8):
    /// "This phone · Paused" for this phone, "Chrome · Paused" for another device. Nil, so the
    /// row keeps its usual line, unless the relay said the trial ended: never from a date, and
    /// never for a relay that sends no `service` word (every self-hosted one). "Paused" takes
    /// the place of the online and offline words, which say nothing while nothing is sent.
    public static func pausedLine(_ plan: Plan?, kind: String, isThisPhone: Bool) -> String? {
        guard plan == .trialEnded else { return nil }
        if isThisPhone {
            return String(
                localized: "This phone · Paused",
                bundle: .module,
                comment: "Second line of this phone's own row in \"Your devices\" after the free trial ended and sending is paused. A dot separates the two parts. Keep it short."
            )
        }
        return String(
            localized: "\(kind) · Paused",
            bundle: .module,
            comment: "Second line of another device's row in \"Your devices\" after the free trial ended and sending is paused. %@ is the kind of device, such as \"Chrome\" or \"Android phone\". A dot separates the two parts. Keep it short."
        )
    }

    /// The notice above "Name this phone", for a person whose account this sign-up just made.
    public static func startedNotice(endsAt: Date?, timeZone: TimeZone = .current) -> String {
        guard let endsAt else {
            return String(
                localized: "Your account is ready, and your 14-day free trial has started.",
                bundle: .module,
                comment: "Notice above the \"Name this phone\" screen, right after the account was made. Used when the end date of the trial is not known."
            )
        }
        let day = shortDay(endsAt, timeZone: timeZone)
        return String(
            localized: "Your account is ready, and your 14-day free trial has started. It runs until \(day).",
            bundle: .module,
            comment: "Notice above the \"Name this phone\" screen, right after the account was made. %@ is the date the trial ends, such as \"Nov 18\"."
        )
    }
}
