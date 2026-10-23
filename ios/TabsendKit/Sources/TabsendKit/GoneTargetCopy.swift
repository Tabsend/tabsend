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
        let who = named(targetLabel) ?? "The device it was for"
        return "\(who) \(removedHere ? "was removed from" : "is no longer in") your group."
    }

    /// The menu that lists the devices left.
    public static let sendToMenu = "Send to…"

    /// The only device left is this one.
    public static let noOtherDevice = "No other device to send it to."

    /// The flush found the device gone. The tab was promised to send itself, and
    /// now it will not, so this is said once, out loud, like any withdrawn promise.
    /// `targetLabel` and `removedHere` are about the first tab announced.
    public static func banner(
        count: Int, firstTitle: String?, targetLabel: String?, removedHere: Bool
    ) -> SendBanner {
        let headline: String
        if count > 1 {
            headline = "\(count) tabs are waiting for a new device"
        } else if let title = firstTitle, !title.trimmingCharacters(in: .whitespaces).isEmpty {
            headline = "“\(title)” is waiting for a new device"
        } else {
            headline = "A tab is waiting for a new device"
        }
        let who = named(targetLabel) ?? (count > 1 ? "The device they were for" : "The device it was for")
        let gone = removedHere ? "was removed from" : "is no longer in"
        let them = count > 1 ? "them" : "it"
        return SendBanner(
            tone: .pending,
            headline: headline,
            title: count > 1 ? firstTitle : nil,
            detail: "\(who) \(gone) your group. Open Tabsend to send \(them) to another device."
        )
    }

    /// The device's label, or nil when there is none worth showing.
    private static func named(_ label: String?) -> String? {
        guard let label, !label.trimmingCharacters(in: .whitespaces).isEmpty else { return nil }
        return label
    }
}
