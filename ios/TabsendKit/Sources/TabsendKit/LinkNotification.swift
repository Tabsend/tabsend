import Foundation
import UserNotifications

/// The notifications both the app and its notification extension (`TabsendNotify`,
/// docs/PLANS.md P-29) post, built in one place so the two processes show the same
/// thing. Mirrors android/.../receive/Notifications.kt: title = the page title or the
/// address's host, body = the address, and a tap opens the default browser.
///
/// The tap handling stays in the app (`Notifications` there), which reads the
/// `userInfo` keys named here.
public enum LinkNotification {
    /// `userInfo` keys on a link notification.
    public static let urlKey = "url"
    public static let messageIdKey = "messageId"
    /// `userInfo["kind"]` on a notice that is not a link, which is how the tap handler
    /// tells it apart. A link notification has no kind.
    public static let kindKey = "kind"
    public static let newDeviceKind = "newDevice"
    public static let groupResetKind = "groupReset"

    /// The content for a link, or nil when its address is not one Tabsend opens (not
    /// http or https). The app posts its own "Unsupported link blocked" notice for that
    /// case; the extension leaves such a message on the relay for the app to present.
    public static func content(payload: SendPayload, messageId: String) -> UNMutableNotificationContent? {
        guard let url = LinkURLPolicy.openableURL(from: payload.url) else { return nil }
        let content = UNMutableNotificationContent()
        content.sound = .default
        let host = url.host ?? payload.url
        content.title = payload.title?.isEmpty == false ? payload.title! : host
        content.body = payload.url
        content.userInfo = [urlKey: payload.url, messageIdKey: messageId]
        applyBatch(payload, to: content)
        return content
    }

    /// Multi-tab batches share a thread id so iOS stacks them into one group on the lock
    /// screen. Single sends keep the default thread. A blocked link still belongs to the
    /// batch it arrived with, so the app's blocked-link notice calls this too: hiding it
    /// from the stack would make a batch of five look like a batch of four.
    public static func applyBatch(_ payload: SendPayload, to content: UNMutableNotificationContent) {
        if let batch = payload.batch {
            content.threadIdentifier = batch.id
        }
    }

    /// Post content under the message id, so a second post of the same link replaces the
    /// first rather than stacking beside it. False when iOS refused it.
    public static func post(_ content: UNNotificationContent, identifier: String) async -> Bool {
        let request = UNNotificationRequest(identifier: identifier, content: content, trigger: nil)
        do {
            try await UNUserNotificationCenter.current().add(request)
            return true
        } catch {
            return false
        }
    }

    /// Whether the system lets this app show notifications at all.
    public static func allowed() async -> Bool {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        return settings.authorizationStatus == .authorized
            || settings.authorizationStatus == .provisional
    }

    /// Tell the user, once, about devices that joined since the last list this phone
    /// saw, or that were already in the group on a fresh pairing and that the pairing
    /// link did not vouch for (P-10, P-23). One notification, information only.
    ///
    /// Not gated on any in-app setting, only on the system's own notification
    /// permission: it is a security notice, not a convenience. When permission is off
    /// nothing is posted; the device is in "Your devices" either way. The rule hands each
    /// device over exactly once, so this does not repeat.
    public static func postNewDevices(_ announcement: NewDevices.Announcement?) async {
        guard let announcement, !announcement.devices.isEmpty, await allowed() else { return }
        let content = UNMutableNotificationContent()
        content.title = NewDevices.alertTitle(announcement)
        content.body = NewDevices.alertBody(announcement)
        content.sound = .default
        content.threadIdentifier = "new-devices"
        content.userInfo = [kindKey: newDeviceKind]
        _ = await post(
            content,
            identifier: "new-device-" + announcement.devices.map(\.id).joined(separator: "-")
        )
    }

    /// Announce a pending reset of the group (P-18 item 12). Same rules as
    /// `postNewDevices`: a security notice, gated only on the system permission, and
    /// handed over once per reset by `GroupReset.observe`, so it does not repeat. When
    /// permission is off, the card on the home screen carries it alone.
    public static func postGroupReset(_ reset: GroupResetState) async {
        guard await allowed() else { return }
        let content = UNMutableNotificationContent()
        content.title = GroupReset.notificationTitle
        content.body = GroupReset.notificationBody(reset)
        content.sound = .default
        content.threadIdentifier = "group-reset"
        content.userInfo = [kindKey: groupResetKind]
        _ = await post(content, identifier: "group-reset-" + reset.requestedAt)
    }
}
