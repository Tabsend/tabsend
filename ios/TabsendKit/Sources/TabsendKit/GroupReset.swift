import Foundation

/// The reset that waits (PLANS.md P-18 item 12), iOS half.
///
/// A hosted customer who lost every device can ask, on the account page, for the
/// group to be replaced by a fresh, empty one. The reset waits 72 hours, and for that
/// time EVERY paired device shows it and lets the user stop it. That is the safety
/// against someone who got into the customer's email: they can ask for a reset, but
/// any one device already in the group can say no.
///
/// Built like the new-device watch (`NewDevices`): a pure rule over a small
/// device-local record, run wherever the app already asks the relay about the group
/// (the device-list refresh, the background wake, the stream's `group_updated`), and
/// store helpers that do the read-modify-write under the store's lock.

/// What this phone stores between fetches. Device-local; never sent anywhere.
public struct GroupResetWatch: Codable, Sendable, Equatable {
    /// The reset the relay last reported as pending, or nil when none was.
    public var reset: GroupResetState?
    /// The `requestedAt` of every reset already announced with a notification, so
    /// one reset is announced once. Newest last, at most `GroupReset.maxRemembered`.
    public var notified: [String]
    /// The `requestedAt` of every reset answered "It was me" on this phone. A new
    /// reset has a new `requestedAt`, so it shows again. Newest last, capped the same.
    public var dismissed: [String]

    public init(reset: GroupResetState? = nil, notified: [String] = [], dismissed: [String] = []) {
        self.reset = reset
        self.notified = notified
        self.dismissed = dismissed
    }
}

public enum GroupReset {
    /// How many answered or announced resets are remembered. A relay that keeps
    /// inventing new ones cannot grow the record.
    public static let maxRemembered = 20

    public struct Observation: Sendable, Equatable {
        /// What to store next.
        public var watch: GroupResetWatch
        /// A reset to announce with a notification now, once. Nil when there is
        /// none, or when this one was already announced or answered.
        public var announce: GroupResetState?
    }

    // MARK: the rule (pure)

    /// Fold the relay's answer into the record. Pure.
    ///
    /// The fetched state replaces the stored one outright: the relay is the only
    /// source, and "none pending" (a device stopped it, or the reset was cancelled)
    /// must take the card down on every phone.
    public static func observe(_ prev: GroupResetWatch?, fetched: GroupResetState?) -> Observation {
        var watch = prev ?? GroupResetWatch()
        watch.reset = fetched
        guard let fetched,
              !watch.notified.contains(fetched.requestedAt),
              !watch.dismissed.contains(fetched.requestedAt)
        else { return Observation(watch: watch, announce: nil) }
        watch.notified = remember(watch.notified, fetched.requestedAt)
        return Observation(watch: watch, announce: fetched)
    }

    /// The reset the card shows, or nil: one is pending and this phone has not
    /// answered it "It was me".
    public static func shown(_ watch: GroupResetWatch?) -> GroupResetState? {
        guard let reset = watch?.reset,
              !(watch?.dismissed.contains(reset.requestedAt) ?? false)
        else { return nil }
        return reset
    }

    /// "It was me": hide this reset, and only this one, on this phone.
    public static func dismiss(_ watch: GroupResetWatch?, requestedAt: String) -> GroupResetWatch {
        var next = watch ?? GroupResetWatch()
        if !next.dismissed.contains(requestedAt) {
            next.dismissed = remember(next.dismissed, requestedAt)
        }
        return next
    }

    /// The relay accepted "Stop the reset": nothing is pending any more.
    public static func stopped(_ watch: GroupResetWatch?) -> GroupResetWatch {
        var next = watch ?? GroupResetWatch()
        next.reset = nil
        return next
    }

    /// True when a refusal of GET /v1/group means "this relay has no such route",
    /// which is read as "no reset" and never shown to the user. An older relay
    /// answers 404 `not_found`.
    public static func readsAsNoReset(_ error: ApiError) -> Bool {
        error.status == 404 || error.code == "not_found"
    }

    private static func remember(_ list: [String], _ id: String) -> [String] {
        Array((list.filter { $0 != id } + [id]).suffix(maxRemembered))
    }

    // MARK: relay

    /// The pending reset, or nil. An older relay's 404 is nil, quietly. Any other
    /// refusal, and every transport failure, throws: the caller then keeps what it
    /// knew, so a relay that cannot be reached does not take a pending reset off
    /// the screen.
    public static func fetch(api: ApiClient) async throws -> GroupResetState? {
        try await fetchState(api: api)?.reset
    }

    /// The whole answer, for a caller that also wants the plan words (`GroupService`). Nil for
    /// an older relay's 404, read as "nothing pending and no plan words".
    public static func fetchState(api: ApiClient) async throws -> GroupStateResponse? {
        do {
            return try await api.getGroup()
        } catch let error as ApiError where readsAsNoReset(error) {
            return nil
        }
    }

    // MARK: store helpers

    /// Ask the relay, save what it said, and return a reset to announce now (at most
    /// once per reset). Never throws: a failed fetch changes nothing and announces
    /// nothing. Read-modify-write under the store's lock, so two fetches landing
    /// together cannot both announce the same reset.
    @discardableResult
    public static func refresh(
        api: ApiClient,
        store: TabsendStore,
        defaults: UserDefaults = .standard
    ) async -> GroupResetState? {
        guard store.registration != nil else { return nil }
        let state: GroupStateResponse?
        do {
            state = try await fetchState(api: api)
        } catch {
            return nil
        }
        // One question answers both: the plan words ride on the same route. A good answer
        // replaces them, an older relay's or a self-hosted relay's silence clears them, and a
        // failed fetch (above) leaves what the phone knew.
        GroupService.save(state?.service, in: defaults)
        let fetched = state?.reset
        var announce: GroupResetState?
        store.updateGroupResetWatch { prev in
            let result = observe(prev, fetched: fetched)
            announce = result.announce
            return result.watch
        }
        return announce
    }

    /// "Stop the reset". Throws when the relay did not accept it, and then records
    /// nothing: the reset may still be pending, so the card stays.
    public static func stop(api: ApiClient, store: TabsendStore) async throws {
        _ = try await api.stopGroupReset()
        store.updateGroupResetWatch { prev in stopped(prev) }
    }

    /// The reset the card shows right now, from the store. Local only.
    public static func current(store: TabsendStore) -> GroupResetState? {
        shown(store.groupResetWatch)
    }

    /// "It was me", kept on this phone only.
    public static func dismiss(requestedAt: String, store: TabsendStore) {
        store.updateGroupResetWatch { prev in dismiss(prev, requestedAt: requestedAt) }
    }

    // MARK: copy (PLANS.md P-18 item 12, the same words on every client)

    public static var cardTitle: String {
        String(
            localized: "Someone asked to remove all your devices",
            bundle: .module,
            comment: "Heading of the red card at the top of the home screen when a reset of the whole device group is waiting. May wrap onto two lines."
        )
    }
    public static var stopButton: String {
        String(
            localized: "Stop the reset",
            bundle: .module,
            comment: "Button on the reset card. Stops the waiting reset for every device. Keep it short."
        )
    }
    public static var itWasMeButton: String {
        String(
            localized: "It was me",
            bundle: .module,
            comment: "Button on the reset card for the person who asked for the reset themselves. It hides the card on this phone. Keep it short."
        )
    }
    public static var stoppedLine: String {
        String(
            localized: "Reset stopped. Nothing was removed.",
            bundle: .module,
            comment: "Banner on the home screen after the reset was stopped."
        )
    }
    /// The product name, which is not translated (docs/L10N.md rule 8).
    public static let notificationTitle = "Tabsend" // l10n-ignore: product name

    /// Three sentences, each translated on its own and joined with a space: where the
    /// request came from, when it takes effect, and what to do if it was not the person.
    public static func cardBody(_ reset: GroupResetState, timeZone: TimeZone = .current) -> String {
        let asked: String
        if let day = day(reset.requestedAt, timeZone: timeZone) {
            asked = String(
                localized: "From your account page on \(day).",
                bundle: .module,
                comment: "First sentence of the reset card. %@ is the date the reset was asked for, such as \"October 27\"."
            )
        } else {
            asked = String(
                localized: "From your account page.",
                bundle: .module,
                comment: "First sentence of the reset card when the date of the request is not known."
            )
        }
        let when: String
        if let date = WireDate.date(from: reset.resetsAt) {
            let day = L10n.monthAndDay(date, timeZone: timeZone)
            let time = L10n.hourAndMinute(date, timeZone: timeZone)
            when = String(
                localized: "On \(day) at \(time), every device is removed, this one too.",
                bundle: .module,
                comment: "Second sentence of the reset card. The first %@ is the date, such as \"October 30\". The second %@ is the time of day, such as \"2:05 PM\"."
            )
        } else {
            when = String(
                localized: "Soon, every device is removed, this one too.",
                bundle: .module,
                comment: "Second sentence of the reset card when the time of the reset is not known."
            )
        }
        let advice = String(
            localized: "If it wasn't you, stop it now, then change your email password.",
            bundle: .module,
            comment: "Last sentence of the reset card. It tells the person what to do if someone else asked for the reset. The email password is the password of the email account used for the Tabsend account."
        )
        return [asked, when, advice].joined(separator: " ")
    }

    public static func notificationBody(_ reset: GroupResetState, timeZone: TimeZone = .current) -> String {
        if let day = day(reset.requestedAt, timeZone: timeZone) {
            return String(
                localized: "Someone asked to remove all your devices on \(day). Open Tabsend to stop it.",
                bundle: .module,
                comment: "Notification body when a reset of the whole device group is waiting. %@ is the date the reset was asked for, such as \"October 27\"."
            )
        }
        return String(
            localized: "Someone asked to remove all your devices. Open Tabsend to stop it.",
            bundle: .module,
            comment: "Notification body when a reset of the whole device group is waiting and the date of the request is not known."
        )
    }

    /// "October 27" in the given time zone, or nil for a date that cannot be read.
    private static func day(_ iso: String, timeZone: TimeZone) -> String? {
        WireDate.date(from: iso).map { L10n.monthAndDay($0, timeZone: timeZone) }
    }
}
