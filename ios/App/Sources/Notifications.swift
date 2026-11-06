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

        // Both handlers use the completion-handler form, and call it on the main
        // thread. The `async` form these had crashed build 0.10.0 (579) on the first
        // tap on a link notification (TestFlight, iOS 27.0.1, 2026-11-03): Swift runs
        // an `async` method of this non-isolated class off the main thread and hands
        // the answer back to iOS from there; UIKit then updated its app snapshot on
        // that background thread and stopped the app with an assertion
        // (`-[UIApplication _performBlockAfterCATransactionCommitSynchronizes:]`,
        // called from the compiler-generated closure in `didReceive`). Do not convert
        // these back to `async`.
        func userNotificationCenter(
            _ center: UNUserNotificationCenter,
            didReceive response: UNNotificationResponse,
            withCompletionHandler completionHandler: @escaping () -> Void
        ) {
            // Every value is read out here, before the hop: the notification's
            // userInfo is an untyped dictionary, which should not cross threads, and
            // the strings can.
            let info = response.notification.request.content.userInfo
            let kind = info[Notifications.newDeviceKindKey] as? String
            let urlString = info[LinkNotification.urlKey] as? String
            let messageId = info[LinkNotification.messageIdKey] as? String
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    Notifications.handleTap(kind: kind, urlString: urlString, messageId: messageId)
                }
                completionHandler()
            }
        }

        func userNotificationCenter(
            _ center: UNUserNotificationCenter,
            willPresent notification: UNNotification,
            withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
        ) {
            DispatchQueue.main.async {
                completionHandler([.banner, .list, .sound])
            }
        }
    }

    /// What a tap on one of this app's notifications does. Main thread only.
    @MainActor
    private static func handleTap(kind: String?, urlString: String?, messageId: String?) {
        // A new-device notice carries no URL and must never try to open one.
        // Tapping it brings the app forward on its own. It is information only
        // (P-23): the device is in "Your devices", with Remove, and nothing waits
        // for an answer.
        if kind == newDeviceKind {
            AppModel.shared.refreshNewDevices()
            return
        }
        // The same for a pending reset: no URL, and the card on the home screen
        // is where it is stopped (P-18 item 12).
        if kind == groupResetKind {
            AppModel.shared.refreshGroupResetCard()
            return
        }
        guard let urlString, let url = LinkURLPolicy.openableURL(from: urlString) else { return }
        UIApplication.shared.open(url)
        // The tap comes back through the app on iOS, so the inbox can simply see
        // it — no trampoline activity, which is what Android needs for the same
        // fact [P-7]. Opening comes first; the record is bookkeeping either way.
        if let messageId {
            AppModel.shared.markReceivedOpened([messageId])
        }
    }

    /// `userInfo["kind"]` on a notice that is not a link (`LinkNotification` in
    /// TabsendKit, shared with the notification extension).
    static let newDeviceKindKey = LinkNotification.kindKey
    static let newDeviceKind = LinkNotification.newDeviceKind
    static let groupResetKind = LinkNotification.groupResetKind

    /// The text of a visible wake whose extension did not run or could not fill it in
    /// (docs/PLANS.md P-29). The forwarder's push names the key `NEW_LINK` and iOS looks
    /// it up in this app's own catalog, in the phone's language. Nothing in the app shows
    /// it; it is declared here so the catalog keeps the entry and its translations.
    static let newLinkPushText = String(
        localized: "NEW_LINK",
        defaultValue: "New link",
        comment: "Notification text when a link arrived but Tabsend could not fetch it in time to show its title and address, for example on a phone not unlocked since it restarted. Opening Tabsend shows the link."
    )

    static func postNewDevices(_ announcement: NewDevices.Announcement?) async {
        await LinkNotification.postNewDevices(announcement)
    }

    static func postGroupReset(_ reset: GroupResetState) async {
        await LinkNotification.postGroupReset(reset)
    }

    static func installDelegate() {
        UNUserNotificationCenter.current().delegate = Delegate.shared
    }

    static func requestPermission() async {
        _ = try? await UNUserNotificationCenter.current()
            .requestAuthorization(options: [.alert, .sound, .badge])
    }

    static func enabled() async -> Bool {
        await LinkNotification.allowed()
    }

    /// Returns false when the notification could not be posted, in which case
    /// the deliverer leaves the message queued rather than ack-and-drop.
    static func postLink(payload: SendPayload, messageId: String) async -> Bool {
        guard await enabled() else { return false }
        if let content = LinkNotification.content(payload: payload, messageId: messageId) {
            return await LinkNotification.post(content, identifier: messageId)
        }
        // A rejected message is still presented and acknowledged, rather than silently
        // disappearing or retrying forever.
        let content = UNMutableNotificationContent()
        content.sound = .default
        content.title = String(
            localized: "Unsupported link blocked",
            comment: "Notification title when a tab arrived whose address is not a web address (not http or https), so Tabsend will not open it."
        )
        content.body = String(
            localized: "Tabsend only opens HTTP and HTTPS links.",
            comment: "Notification body under \"Unsupported link blocked\". HTTP and HTTPS are the two kinds of web address Tabsend opens."
        )
        LinkNotification.applyBatch(payload, to: content)
        return await LinkNotification.post(content, identifier: messageId)
    }
}
