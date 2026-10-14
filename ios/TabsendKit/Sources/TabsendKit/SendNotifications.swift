import Foundation
import UserNotifications

/// Where a send's outcome lands on iOS.
///
/// Lives in TabsendKit rather than the app target because the SHARE EXTENSION is
/// what posts most of these: `UNUserNotificationCenter.add` works from an
/// extension, and the extension is torn down the instant it completes its
/// request, so it has nothing like the browser's toolbar badge and a delayed
/// outcome had nowhere to go at all. A send that failed after the sheet
/// dismissed was COMPLETELY silent.
///
/// Authorisation still belongs to the HOST APP (`Notifications.requestPermission`
/// in the app target). When it hasn't been granted, `post` returns false and the
/// waiting list in the app is the only surface — which is why that list is not
/// optional.
public enum SendNotifications {

    /// Whether iOS posts a plain success at all.
    ///
    /// **iOS has no `setTimeoutAfter`.** A local notification sits in Notification
    /// Center until it is swiped, so a success notification is permanent litter
    /// for something the user already watched succeed as the sheet dismissed.
    /// Android can auto-dismiss after two seconds and does; iOS can't, so it
    /// stays quiet and notifies only pending, error, and queue-recovery.
    ///
    /// This inverts the extension's default, and is only defensible because
    /// failures now ALWAYS notify: silence has become unambiguously good, which
    /// was not true before this work. Owner decision 2026-07-29, provisional
    /// pending a dogfood check — flip this one flag to get parity with Android,
    /// and see `successInterruption` below for how it should behave if so.
    public static let notifiesPlainSuccess = false

    /// If success notifications are switched on, they should not make noise or
    /// interrupt: the user is looking at the share sheet as it happens.
    private static let successInterruption: UNNotificationInterruptionLevel = .passive

    /// Report one send. `messageId` keys the notification, so two sends in flight
    /// never overwrite each other's outcome while a single send's own optimistic
    /// state is replaced by its real one.
    ///
    /// Returns false when nothing was posted — either because authorisation is
    /// missing or because this is a success on a build that stays quiet about
    /// those. Callers must not read false as "it failed".
    ///
    /// A `.pending` banner is filed under `SendNotices.pendingPrefix`, apart from
    /// a settled one. It is not a report but a standing promise about a tab still
    /// in the queue, and it has to be withdrawable later — by `reconcilePending`,
    /// from a background refresh that has no idea which sends were ever
    /// announced. A settled outcome is the opposite: on iOS it sits in
    /// Notification Center until it is swiped precisely BECAUSE it is the only
    /// record of something that has finished, and nothing may sweep it away.
    @discardableResult
    public static func postOutcome(_ banner: SendBanner, messageId: String) async -> Bool {
        if banner.tone == .success && !notifiesPlainSuccess { return false }
        if banner.tone == .pending {
            return await post(banner, identifier: SendNotices.pendingIdentifier(messageId))
        }
        // A verdict supersedes the promise that preceded it. Only reachable when
        // a send is reported twice, but leaving both up would have the same tab
        // reading as waiting and as finished at once.
        clearPending(messageIds: [messageId])
        return await post(banner, identifier: SendNotices.outcomeIdentifier(messageId))
    }

    /// The queue drained after a real failure. Announced because the tab the user
    /// was told was "waiting" has now actually gone, and nothing else would ever
    /// say so — they walked away from the share sheet a long time ago. This one
    /// posts even though its tone is success, because it is news.
    @discardableResult
    public static func postRecovered(count: Int, firstTitle: String?) async -> Bool {
        await post(
            SendBanner(
                tone: .success,
                headline: Feedback.recoveredLine(count: count, firstTitle: firstTitle),
                detail: count == 1 ? nil : "Your relay is answering again."
            ),
            identifier: recoveredIdentifier
        )
    }

    /// A tab that was waiting has now been refused for good, so it left the queue
    /// unsent. Told because the user was promised "waiting to send" and would
    /// otherwise never learn it didn't happen.
    @discardableResult
    public static func postDropped(
        count: Int,
        firstTitle: String?,
        targetLabel: String?,
        failure: SendFailure?
    ) async -> Bool {
        await post(
            SendBanner(
                tone: .error,
                headline: count == 1
                    ? "Couldn't send a tab that was waiting"
                    : "Couldn't send \(count) tabs that were waiting",
                title: firstTitle,
                // The label was captured when the send was made, so the sentence
                // can name the device rather than fall back to "that device".
                detail: failure.map { Feedback.failureLine($0, targetLabel: targetLabel) }
            ),
            identifier: droppedIdentifier
        )
    }

    /// A tab this phone sent ran out of time at the relay without the target ever
    /// confirming it [0028]. Told because it is the case the whole feature exists
    /// for: the sheet said "Sent", which was true (the relay took it), and then
    /// nothing arrived and nothing anywhere said so.
    ///
    /// The tab is not lost — the history screen still holds the payload, which is
    /// what makes "Send again" possible — so the tone is a problem to fix, not a
    /// bereavement.
    @discardableResult
    public static func postNeverArrived(
        count: Int,
        firstTitle: String?,
        targetLabel: String?
    ) async -> Bool {
        await post(
            SendBanner(
                tone: .error,
                headline: count == 1 ? "A tab never arrived" : "\(count) tabs never arrived",
                title: count == 1 ? firstTitle : nil,
                detail: count == 1
                    ? "\(targetLabel ?? Feedback.thatDevice) never picked it up, and the relay has stopped holding it. Open Tabsend to send it again."
                    : "Nothing picked them up, and the relay has stopped holding them. Open Tabsend to see which, and to send them again."
            ),
            identifier: neverArrivedIdentifier
        )
    }

    /// Report what a queue flush did, either way. The one place that decides, so
    /// the foreground drain and the background refresh cannot drift apart.
    ///
    /// `held` is the outbound queue AFTER the flush, because saying the queue
    /// drained is only half of it: the "Waiting to send" notices that promised
    /// the drain have to come DOWN, or the relay coming back leaves the user
    /// looking at a fresh confirmation and, directly under it, a permanent claim
    /// that their relay is still unreachable.
    public static func announceFlush(_ report: Sender.FlushReport, held: [String]) async {
        if report.recovered {
            await postRecovered(count: report.sent, firstTitle: report.firstTitle)
        }
        if report.dropped > 0 {
            await postDropped(
                count: report.dropped,
                firstTitle: report.firstDroppedTitle,
                targetLabel: report.firstDroppedTargetLabel,
                failure: report.firstDroppedFailure
            )
        }
        // Unconditional, and after the report: this also runs when the flush moved
        // nothing, which is what clears notices stranded by an emptied queue or by
        // a share extension that was killed before it could settle.
        await reconcilePending(held: held)
    }

    /// Take down the "Waiting to send" notices whose tabs are no longer waiting.
    ///
    /// Reconciles against the queue rather than clearing the ids a flush settled,
    /// so it also removes notices this process never posted — which is the
    /// ordinary case, since the share extension that promised is torn down the
    /// instant it completes its request.
    public static func reconcilePending(held: [String]) async {
        let delivered = await UNUserNotificationCenter.current().deliveredNotifications()
        let stale = SendNotices.stalePending(
            posted: delivered.map(\.request.identifier),
            held: held
        )
        guard !stale.isEmpty else { return }
        UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: stale)
    }

    /// Withdraw the promises made about these messages, by id.
    public static func clearPending(messageIds: [String]) {
        let ids = messageIds.map(SendNotices.pendingIdentifier)
        UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: ids)
        UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: ids)
    }

    /// Everything this type has posted, for a phone that has left the group.
    public static func clearAll() async {
        await reconcilePending(held: [])
        UNUserNotificationCenter.current().removeDeliveredNotifications(
            withIdentifiers: [recoveredIdentifier, droppedIdentifier]
        )
    }

    private static func post(_ banner: SendBanner, identifier: String) async -> Bool {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        guard settings.authorizationStatus == .authorized
            || settings.authorizationStatus == .provisional
        else { return false }

        let content = UNMutableNotificationContent()
        content.title = banner.headline
        // The tab's own name goes in the body, never merged into the headline:
        // the headline is the verdict, the title says which tab it is about.
        content.body = [banner.title, banner.detail].compactMap { $0 }.joined(separator: "\n")
        let success = banner.tone == .success
        content.interruptionLevel = success ? successInterruption : .active
        // No sound for a status report. The link notifications keep theirs — an
        // arriving tab is something you want to be told about; a send you just
        // made reporting back is not.
        content.sound = nil

        do {
            try await UNUserNotificationCenter.current().add(
                UNNotificationRequest(identifier: identifier, content: content, trigger: nil)
            )
            return true
        } catch {
            return false
        }
    }

    private static let recoveredIdentifier = "send.recovered"
    private static let droppedIdentifier = "send.dropped"
    /// One identifier, so a second wake replaces the notice rather than stacking a
    /// second one about the same standing situation.
    private static let neverArrivedIdentifier = "send.neverArrived"
}
