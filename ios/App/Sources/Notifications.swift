import Foundation
import UserNotifications
import UIKit
import TabsendKit

/// Link notifications, mirroring android/.../receive/Notifications.kt:
/// title = payload title or the URL host, body = the URL, and tapping opens
/// the OS default browser — the app never auto-opens or intercepts.
enum Notifications {
    private final class Delegate: NSObject, UNUserNotificationCenterDelegate {
        static let shared = Delegate()

        func userNotificationCenter(
            _ center: UNUserNotificationCenter,
            didReceive response: UNNotificationResponse
        ) async {
            let info = response.notification.request.content.userInfo
            // A new-device notice carries no URL and must never try to open one.
            // Tapping it brings the app forward on its own, and the banner on the
            // home screen is where it is answered (PLANS.md P-10).
            if info[Notifications.newDeviceKindKey] as? String == Notifications.newDeviceKind {
                await MainActor.run { AppModel.shared.refreshNewDevices() }
                return
            }
            // Both values are read out here rather than inside the hop below: the
            // notification's userInfo is an untyped dictionary, which cannot cross into
            // another actor, and the strings can.
            let messageId = info["messageId"] as? String
            if
                let urlString = info["url"] as? String,
                let url = LinkURLPolicy.openableURL(from: urlString)
            {
                await MainActor.run {
                    UIApplication.shared.open(url)
                    // The tap comes back through the app on iOS, so the inbox can
                    // simply see it — no trampoline activity, which is what Android
                    // needs for the same fact [P-7]. Opening comes first; the
                    // record is bookkeeping either way.
                    if let messageId {
                        AppModel.shared.markReceivedOpened([messageId])
                    }
                }
            }
        }

        func userNotificationCenter(
            _ center: UNUserNotificationCenter,
            willPresent notification: UNNotification
        ) async -> UNNotificationPresentationOptions {
            [.banner, .list, .sound]
        }
    }

    /// `userInfo["kind"]` on a new-device notice, which is how the tap handler
    /// tells it apart from a link notification.
    static let newDeviceKindKey = "kind"
    static let newDeviceKind = "newDevice"

    /// Announce devices that joined since the last list this phone saw (P-10).
    ///
    /// Not gated on any in-app setting, only on the system's own notification
    /// permission: it is a security notice, not a convenience. When permission is
    /// off nothing is posted and the banner on the home screen carries it alone.
    /// The rule hands each device over exactly once, so this does not repeat.
    static func postNewDevices(_ joined: [NewDeviceNotice]) async {
        guard !joined.isEmpty, await enabled() else { return }
        let content = UNMutableNotificationContent()
        content.title = NewDevices.alertTitle(joined)
        content.body = NewDevices.alertBody(joined)
        content.sound = .default
        content.threadIdentifier = "new-devices"
        content.userInfo = [newDeviceKindKey: newDeviceKind]
        let request = UNNotificationRequest(
            identifier: "new-device-" + joined.map(\.id).joined(separator: "-"),
            content: content,
            trigger: nil
        )
        try? await UNUserNotificationCenter.current().add(request)
    }

    static func installDelegate() {
        UNUserNotificationCenter.current().delegate = Delegate.shared
    }

    static func requestPermission() async {
        _ = try? await UNUserNotificationCenter.current()
            .requestAuthorization(options: [.alert, .sound, .badge])
    }

    static func enabled() async -> Bool {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        return settings.authorizationStatus == .authorized
            || settings.authorizationStatus == .provisional
    }

    /// Returns false when the notification could not be posted, in which case
    /// the deliverer leaves the message queued rather than ack-and-drop.
    static func postLink(payload: SendPayload, messageId: String) async -> Bool {
        guard await enabled() else { return false }

        let content = UNMutableNotificationContent()
        content.sound = .default

        if let url = LinkURLPolicy.openableURL(from: payload.url) {
            let host = url.host ?? payload.url
            content.title = payload.title?.isEmpty == false ? payload.title! : host
            content.body = payload.url
            content.userInfo = ["url": payload.url, "messageId": messageId]
        } else {
            // A rejected message is still presented and acknowledged, rather
            // than silently disappearing or retrying forever.
            content.title = "Unsupported link blocked"
            content.body = "Tabsend only opens HTTP and HTTPS links."
        }

        // Multi-tab batches share a thread id so iOS stacks them into one group
        // on the lock screen. Single sends keep the default thread. This sits
        // outside the policy branch on purpose: a blocked link still belongs to
        // the batch it arrived with, and hiding it from the stack would make a
        // batch of five look like a batch of four.
        if let batch = payload.batch {
            content.threadIdentifier = batch.id
        }

        let request = UNNotificationRequest(
            identifier: messageId,
            content: content,
            trigger: nil
        )
        do {
            try await UNUserNotificationCenter.current().add(request)
            return true
        } catch {
            return false
        }
    }
}
