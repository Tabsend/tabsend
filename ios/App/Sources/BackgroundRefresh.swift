import Foundation
import BackgroundTasks
import TabsendKit

/// Opportunistic background drain via BGAppRefreshTask. iOS decides the actual
/// cadence (P-5: Background App Refresh is fine as a bonus, useless as a promise), so
/// this is the FALLBACK path, not the delivery model.
///
/// The timely path is the wake-up forwarder's silent push (ADR-0032), handled in
/// `AppDelegate`. Both run the same sequence, `BackgroundDrain.run`, and this one stays
/// registered whether or not a forwarder is configured: it is what still works when
/// this build has no forwarder URL, when the relay's operator configured none, when the
/// user opted out, and when the forwarder is simply down.
enum BackgroundRefresh {
    static let identifier = "io.tabsend.app.refresh"

    static func register() {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: identifier, using: nil) { task in
            handle(task: task as! BGAppRefreshTask)
        }
    }

    static func schedule() {
        let request = BGAppRefreshTaskRequest(identifier: identifier)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        try? BGTaskScheduler.shared.submit(request)
    }

    private static func handle(task: BGAppRefreshTask) {
        schedule() // always chain the next opportunity

        // Two paths reach the completion — the drain finished, or iOS took the window
        // back — and they can land within microseconds of each other. iOS treats a
        // second completion for one task as API misuse, so the first one through
        // reports and the other is a no-op.
        let reported = OnceLatch()
        let work = Task {
            let outcome = await BackgroundDrain.run(store: AppGroupStore())
            if reported.claim() { task.setTaskCompleted(success: !outcome.offline) }
        }
        task.expirationHandler = {
            // This cancel now reaches the network calls: the drain runs inside this
            // task rather than in one of its own, so cancellation carries into it.
            work.cancel()
            // Reported here rather than after the drain unwinds. iOS wants the
            // completion promptly once it has expired the task, and cancellation only
            // takes effect at the next await.
            if reported.claim() { task.setTaskCompleted(success: false) }
        }
    }
}
