import Foundation

/// The two gentle asks inside the app (docs/PLANS.md P-22): the "Know someone who'd like
/// Tabsend?" box on Home, and Apple's review pop-up. Everything that decides whether either
/// shows is a plain function here, with the clock passed in, so the rules are tested without
/// a phone. The views only draw what these say.
public enum InAppAsks {
    // MARK: the numbers

    static let day: TimeInterval = 24 * 60 * 60
    /// A dismissed box (or a tap on Share) stays hidden this long, then may return.
    public static let shareBoxHiddenFor: TimeInterval = 365 * day
    /// A self-hosted phone waits this long after it first showed the paired Home.
    public static let selfHostedWait: TimeInterval = 30 * day
    /// The share box and a review ask keep this far apart, either way round.
    public static let askGap: TimeInterval = 14 * day
    /// A review ask needs the paired Home to have been shown this long ago.
    public static let reviewMinAge: TimeInterval = 7 * day
    public static let reviewMinSpacing: TimeInterval = 120 * day
    public static let reviewMaxPerYear = 3
    /// A send counts as "just now" for this long, because the share sheet is another
    /// process and the app learns of the send when it is next opened.
    public static let recentSendWindow: TimeInterval = 15 * 60

    // MARK: the one place the review link would go

    /// Where "Rate Tabsend" in Settings goes. Left empty until the app has its App Store
    /// page (an `https://apps.apple.com/app/id.../?action=write-review` link). While it is
    /// nil the row is hidden. The system review pop-up needs no link, so it works either way.
    public static let reviewURL: URL? = nil

    // MARK: the words that are not literals in a view

    public static let feedbackAddress = "contact@tabsend.org" // l10n-ignore: address
    public static let feedbackSubject = "Tabsend feedback" // l10n-ignore: mail subject, as the other clients send it

    /// `mailto:` with the subject filled in.
    public static var feedbackURL: URL? {
        var parts = URLComponents()
        parts.scheme = "mailto"
        parts.path = feedbackAddress
        parts.queryItems = [URLQueryItem(name: "subject", value: feedbackSubject)]
        return parts.url
    }

    public static var boxBodyCredit: String {
        String(localized: "Built by a dad to support his family. Share it, and get $5 off your next payment when a friend subscribes (once a year, however many friends join).", bundle: .module, comment: "Home, the box under Add a device, short text when sharing earns a credit. $5 is US dollars. Keep: it is once a year however many friends join.")
    }

    public static var boxBodyPlain: String {
        String(localized: "Built by a dad to support his family. If you like it, would you share it with a coworker or friend?", bundle: .module, comment: "Home, the box under Add a device, short text with no credit.")
    }

    public static var expandedCredit: String {
        String(localized: "Tabsend was built by a dad to support his family. If you like it, would you share it with a coworker or friend? It's not for everyone, but I bet you have a good idea who else would find it useful. As a thank you, you'll get $5 off your next payment when a friend subscribes. That's once a year, however many friends join.", bundle: .module, comment: "Home, the box under Add a device, text after Read more, when sharing earns a credit. $5 is US dollars. Keep: it is once a year however many friends join.")
    }

    public static var expandedPlain: String {
        String(localized: "Tabsend was built by a dad to support his family. If you like it, would you share it with a coworker or friend? It's not for everyone, but I bet you have a good idea who else would find it useful.", bundle: .module, comment: "Home, the box under Add a device, text after Read more, with no credit.")
    }

    /// What the system share sheet carries (the plain variant).
    public static var shareText: String {
        String(localized: "Tabsend sends a link from your computer to your phone, or the other way. https://tabsend.org", bundle: .module, comment: "The text a person shares with a friend from the system share sheet. Keep the web address at the end exactly as it is.")
    }

    // MARK: which variant

    public enum Variant: Equatable, Sendable {
        /// Sharing earns $5 off, so Share opens the account site's Share page.
        case credit
        /// Share opens the system share sheet.
        case plain
    }

    /// Credit only where the phone can reach the account site AND the group is on Tabsend's
    /// service with an account. A trial, a trial that ended, a self-hosted relay and a phone
    /// outside the US App Store are plain. Also what the Settings row follows.
    public static func variant(plan: GroupService.Plan?, accountDoor: Bool) -> Variant {
        if accountDoor, case .account = plan { return .credit }
        return .plain
    }

    // MARK: the box on Home

    /// The box's variant, or nil while it must not show.
    /// - Hosted with an account: shows at once (credit or plain).
    /// - Trial or trial ended: never.
    /// - Hosted with no plan known yet: never.
    /// - Self-hosted (no plan): plain, after 30 days since the paired Home first showed and
    ///   with two or more devices.
    /// Tabsend's own relays. The extension, console and Android use the same two names.
    private static let hostedHosts: Set<String> = ["app.tabsend.org", "demo.tabsend.org"]

    /// True when `relayUrl` is Tabsend's own service, whatever plan the relay has reported so far.
    public static func isHostedRelay(_ relayUrl: String) -> Bool {
        guard let host = URL(string: relayUrl.trimmingCharacters(in: .whitespaces))?.host?.lowercased() else {
            return false
        }
        return hostedHosts.contains(host)
    }

    public static func shareBox(
        plan: GroupService.Plan?,
        accountDoor: Bool,
        firstHomeAt: Date?,
        deviceCount: Int,
        handledAt: Date?,
        lastReviewAskAt: Date?,
        reviewAskedThisSession: Bool,
        relayIsHosted: Bool = false,
        now: Date
    ) -> Variant? {
        if reviewAskedThisSession { return nil }
        if let handledAt, now.timeIntervalSince(handledAt) < shareBoxHiddenFor { return nil }
        if let last = lastReviewAskAt, abs(now.timeIntervalSince(last)) < askGap { return nil }
        switch plan {
        case .trial, .trialEnded:
            return nil
        case .account:
            return variant(plan: plan, accountDoor: accountDoor)
        case nil:
            // A hosted group whose plan is not known yet could be a trial: no box, not "self-hosted".
            if relayIsHosted { return nil }
            guard let firstHomeAt, now.timeIntervalSince(firstHomeAt) >= selfHostedWait,
                  deviceCount >= 2 else { return nil }
            return .plain
        }
    }

    // MARK: the review ask

    /// Whether Apple's review pop-up may be requested now. There is no question first
    /// (App Store Guideline 5.6.1); the system decides whether to show it.
    public static func reviewAsk(
        lastSuccessfulSendAt: Date?,
        firstHomeAt: Date?,
        deviceCount: Int,
        askDates: [Date],
        shareBoxHandledAt: Date?,
        shareBoxShownThisSession: Bool,
        reviewAskedThisSession: Bool,
        errorShowing: Bool,
        now: Date
    ) -> Bool {
        if errorShowing || shareBoxShownThisSession || reviewAskedThisSession { return false }
        guard let sent = lastSuccessfulSendAt else { return false }
        let sinceSend = now.timeIntervalSince(sent)
        guard sinceSend >= -60, sinceSend <= recentSendWindow else { return false }
        guard let firstHomeAt, now.timeIntervalSince(firstHomeAt) >= reviewMinAge,
              deviceCount >= 2 else { return false }
        if let last = askDates.max(), now.timeIntervalSince(last) < reviewMinSpacing { return false }
        if askDates.filter({ now.timeIntervalSince($0) < 365 * day }).count >= reviewMaxPerYear { return false }
        if let handled = shareBoxHandledAt, abs(now.timeIntervalSince(handled)) < askGap { return false }
        return true
    }

    // MARK: what this phone remembers

    private static let firstHomeKey = "inAppAsksFirstHomeAt"
    private static let handledKey = "inAppAsksShareBoxHandledAt"
    private static let asksKey = "inAppAsksReviewAsks"

    /// The first time the paired Home was drawn. Later calls change nothing.
    public static func noteHomeShown(now: Date = Date(), in defaults: UserDefaults = .standard) {
        guard defaults.object(forKey: firstHomeKey) == nil else { return }
        defaults.set(now.timeIntervalSince1970, forKey: firstHomeKey)
    }

    public static func firstHomeAt(in defaults: UserDefaults = .standard) -> Date? {
        (defaults.object(forKey: firstHomeKey) as? Double).map(Date.init(timeIntervalSince1970:))
    }

    /// The box was dismissed, or Share in it was tapped: hidden for a year.
    public static func markShareBoxHandled(now: Date = Date(), in defaults: UserDefaults = .standard) {
        defaults.set(now.timeIntervalSince1970, forKey: handledKey)
    }

    public static func shareBoxHandledAt(in defaults: UserDefaults = .standard) -> Date? {
        (defaults.object(forKey: handledKey) as? Double).map(Date.init(timeIntervalSince1970:))
    }

    /// A review ask was made. Only the last year is kept.
    public static func recordReviewAsk(now: Date = Date(), in defaults: UserDefaults = .standard) {
        let kept = reviewAskDates(in: defaults).filter { now.timeIntervalSince($0) < 365 * day }
        let all = (kept + [now]).map(\.timeIntervalSince1970)
        defaults.set(all, forKey: asksKey)
    }

    public static func reviewAskDates(in defaults: UserDefaults = .standard) -> [Date] {
        (defaults.array(forKey: asksKey) as? [Double] ?? []).map(Date.init(timeIntervalSince1970:))
    }

    /// Unpairing forgets the Home clock and the box's dismissal. Review asks are kept, so
    /// pairing again cannot reset the limits.
    public static func clear(in defaults: UserDefaults = .standard) {
        defaults.removeObject(forKey: firstHomeKey)
        defaults.removeObject(forKey: handledKey)
    }
}
