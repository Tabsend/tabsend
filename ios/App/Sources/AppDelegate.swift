import Foundation
import UIKit
import TabsendKit

/// The APNs side of the wake path (ADR-0032, PLANS P-5 option 1, HOSTED_PLAN §6).
///
/// Two jobs, and nothing else lives here:
///
/// 1. Ask Apple for this device's token, and hand every token it delivers to
///    `WakePath`, which exchanges it for a wake token at the forwarder.
/// 2. Answer the silent push by running the ordinary background drain.
///
/// **The push carries no content and none is read.** The forwarder sends
/// `{"aps":{"content-available":1}}` and there is no field in it for anything else
/// (`forwarder/PROTOCOL.md` §3.2). Its ARRIVAL is the entire message: something is
/// waiting on the relay. The tab itself is fetched from the relay and decrypted here,
/// exactly as it is on every other wake, so the forwarder never sees it.
final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        // Apple delivers the device token in response to this call and nowhere else,
        // and it may deliver a DIFFERENT one than last time, so it is made at every
        // launch rather than once at pairing.
        RemoteNotifications.registerIfEnabled()
        return true
    }

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        // Hex, because that is the form APNs providers take (`PROTOCOL.md` §3.1).
        // Never logged: a device token is this phone's address at Apple.
        let hex = deviceToken.apnsHexString
        Task { await RemoteNotifications.deviceTokenArrived(hex) }
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        // No device token means no wake token means `{transport:"none"}` — which is the
        // pre-forwarder behaviour and works: instant in the foreground, drain on open.
        // Deliberately silent. This fails on a simulator, in an unsigned build, and
        // with no network at launch, and none of those is worth interrupting anyone
        // over. The next launch asks again.
    }

    func application(
        _ application: UIApplication,
        didReceiveRemoteNotification userInfo: [AnyHashable: Any],
        fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void
    ) {
        // `userInfo` is NOT read, here or anywhere. There is nothing in it: the wake is
        // a doorbell, and treating its payload as data would be the first step towards
        // a forwarder that carries content. The arrival is the whole signal.
        //
        // Unlike a `BGAppRefreshTask` there is no expiration callback on this path, so
        // the only ceiling is the drain's own budget, which cancels the sequence from
        // the inside and hands back what it had. One `run`, one report, on exactly one
        // of the branches below: iOS wants this handler called once, and around 30
        // seconds after the push is the last moment it counts.
        Task {
            let outcome = await BackgroundDrain.run(store: AppGroupStore())
            // The app may be in the foreground when this lands (iOS delivers silent
            // pushes either way), so republish what the drain changed.
            await MainActor.run {
                AppModel.shared.refreshSendState()
                AppModel.shared.refreshHistory()
                AppModel.shared.refreshNewDevices()
                // The drain heartbeats through `WakePath`, which may have rewritten the
                // relay's forwarder hint on the stored registration. Re-read it, or the
                // model would keep serving a copy from before this wake.
                AppModel.shared.refreshWakeState()
            }
            if outcome.offline {
                completionHandler(.failed)
            } else {
                completionHandler(outcome.delivered > 0 ? .newData : .noData)
            }
        }
    }
}

/// Turning the wake path on and off from the app's side.
///
/// Registering for remote notifications shows no prompt and asks for no permission: a
/// background push is not a notification. What the user is asked for is the ordinary
/// notification permission at pairing, which is what lets an ARRIVED tab be shown.
enum RemoteNotifications {
    /// Ask Apple for a device token, unless this build has no forwarder to hand it to
    /// or the user opted out. With no forwarder URL this does nothing at all, which is
    /// what keeps a v0.6-shaped install byte-for-byte the app it was.
    @MainActor
    static func registerIfEnabled() {
        guard WakePath.isEnabled(store: AppModel.shared.store) else { return }
        UIApplication.shared.registerForRemoteNotifications()
    }

    /// Stop Apple sending anything here. Paired with a revoke at the forwarder, so the
    /// doorbell is disconnected at both ends rather than only at this one.
    @MainActor
    static func stop() {
        UIApplication.shared.unregisterForRemoteNotifications()
    }

    /// A device token arrived from Apple.
    @MainActor
    static func deviceTokenArrived(_ apnsToken: String) async {
        let model = AppModel.shared
        let minted = await WakePath.deviceTokenArrived(apnsToken, store: model.store)
        // A fresh wake token is only useful once the relay has it, and the relay learns
        // it on a heartbeat. Rotating immediately rather than waiting for the next
        // foreground is what makes "reinstalled, re-paired, token rotated" recover on
        // its own instead of leaving a phone that cannot be rung.
        if minted { await model.rotateWakeTransport() }
        model.refreshWakeState()
    }
}
