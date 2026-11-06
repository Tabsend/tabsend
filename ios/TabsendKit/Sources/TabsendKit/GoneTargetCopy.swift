import Foundation

/// A held tab whose device is no longer in the group (PLANS.md P-15 item 3).
/// Said word for word as the extension's `goneTargetCopy` (lib/strings.ts) and
/// Android's `GoneTargetCopy` (GoneTargetCopy.kt).
///
/// The tab is not lost: it is still held here, and the user picks where it goes
/// next. So the words say what happened and what to do, never "failed".
///
/// "Was removed" only when THIS phone removed the device (`removedHere`: the
/// watch has it on `removed`). Anything else this phone knows only from the
/// relay, a list without the device or a refusal, and a relay can say either
/// about a device that is still there (SECURITY_REVIEW L3). So it says what this
/// phone can see: the device is no longer in the group.
public enum GoneTargetCopy {
    /// The line under the held tab, in place of "to <device>".
    public static func removedLine(_ targetLabel: String?, removedHere: Bool) -> String {
        let who = named(targetLabel) ?? String(
            localized: "The device it was for",
            bundle: .module,
            comment: "Stands in for a device's name when the name is unknown. It starts a sentence: \"%@ was removed from your group.\", \"%@ is no longer in your group.\" (and the notification versions, which end \"...send it to another device.\"). A language with cases or genders may need those sentences reworded when this phrase is used."
        )
        if removedHere {
            return String(
                localized: "\(who) was removed from your group.",
                bundle: .module,
                comment: "Line under a waiting tab whose receiving device was removed from the group on this phone. %@ is the device name, or \"The device it was for\"."
            )
        }
        return String(
            localized: "\(who) is no longer in your group.",
            bundle: .module,
            comment: "Line under a waiting tab whose receiving device is no longer in the group, as the relay reports it. %@ is the device name, or \"The device it was for\"."
        )
    }

    /// The menu that lists the devices left.
    public static var sendToMenu: String {
        String(
            localized: "Send to…",
            bundle: .module,
            comment: "Menu button on a waiting tab whose device is gone. Opens a list of the other devices the tab can go to. Keep it short."
        )
    }

    /// The only device left is this one.
    public static var noOtherDevice: String {
        String(
            localized: "No other device to send it to.",
            bundle: .module,
            comment: "Line under a waiting tab whose device is gone, when this phone has no other device to send it to."
        )
    }

    /// The flush found the device gone. The tab was promised to send itself, and
    /// now it will not, so this is said once, out loud, like any withdrawn promise.
    /// `targetLabel` and `removedHere` are about the first tab announced.
    public static func banner(
        count: Int, firstTitle: String?, targetLabel: String?, removedHere: Bool
    ) -> SendBanner {
        let headline: String
        if count == 1, let title = firstTitle, !title.trimmingCharacters(in: .whitespaces).isEmpty {
            headline = String(
                localized: "“\(title)” is waiting for a new device",
                bundle: .module,
                comment: "Notification title: one waiting tab has no device to go to. %@ is the title of the page, in curly quotes."
            )
        } else {
            headline = String(
                localized: "\(count) tabs are waiting for a new device",
                bundle: .module,
                comment: "Notification title: tabs have no device to go to. %lld is how many. The singular form is used when one tab has no title to show."
            )
        }
        let who = named(targetLabel) ?? (count > 1
            ? String(
                localized: "The device they were for",
                bundle: .module,
                comment: "Stands in for a device's name when the name is unknown and several tabs were waiting for it. It starts a sentence: \"%@ was removed from your group. Open Tabsend to send them to another device.\" A language with cases or genders may need that sentence reworded when this phrase is used."
            )
            : String(
                localized: "The device it was for",
                bundle: .module,
                comment: "Stands in for a device's name when the name is unknown. It starts a sentence: \"%@ was removed from your group.\", \"%@ is no longer in your group.\" (and the notification versions, which end \"...send it to another device.\"). A language with cases or genders may need those sentences reworded when this phrase is used."
            ))
        return SendBanner(
            tone: .pending,
            headline: headline,
            title: count > 1 ? firstTitle : nil,
            detail: detail(who: who, count: count, removedHere: removedHere)
        )
    }

    /// The notification body: what happened to the device, and what to do next. Four
    /// whole sentences rather than one with pieces swapped in, so each can be translated
    /// as a sentence (removed or no longer there, one tab or several).
    private static func detail(who: String, count: Int, removedHere: Bool) -> String {
        switch (removedHere, count > 1) {
        case (true, false):
            return String(
                localized: "\(who) was removed from your group. Open Tabsend to send it to another device.",
                bundle: .module,
                comment: "Notification body for one waiting tab whose device this phone removed. %@ is the device name."
            )
        case (true, true):
            return String(
                localized: "\(who) was removed from your group. Open Tabsend to send them to another device.",
                bundle: .module,
                comment: "Notification body for several waiting tabs whose device this phone removed. %@ is the device name. \"them\" means the tabs."
            )
        case (false, false):
            return String(
                localized: "\(who) is no longer in your group. Open Tabsend to send it to another device.",
                bundle: .module,
                comment: "Notification body for one waiting tab whose device is no longer in the group, as the relay reports it. %@ is the device name."
            )
        case (false, true):
            return String(
                localized: "\(who) is no longer in your group. Open Tabsend to send them to another device.",
                bundle: .module,
                comment: "Notification body for several waiting tabs whose device is no longer in the group, as the relay reports it. %@ is the device name. \"them\" means the tabs."
            )
        }
    }

    /// The device's label, or nil when there is none worth showing.
    private static func named(_ label: String?) -> String? {
        guard let label, !label.trimmingCharacters(in: .whitespaces).isEmpty else { return nil }
        return label
    }
}
