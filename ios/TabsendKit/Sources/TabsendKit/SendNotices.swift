import Foundation

/// Which "Waiting to send" notices are still true.
///
/// A pending notice is a PROMISE about a tab that is still sitting in the
/// outbound queue: "the tab is held here and sends itself once the relay answers
/// again". Nothing was ever withdrawing that promise. The relay came back, the
/// queue drained, a separate "Sent the tab that was waiting" notice arrived —
/// and the original notice stayed in Notification Center indefinitely, still
/// claiming an outage that had ended (dogfood 2026-08-16, reported on Android;
/// the same gap was here, and worse, because iOS notices never self-dismiss).
///
/// So the queue, not the notice, is the truth: a pending notice is legitimate
/// exactly while its message is still queued. Reconciling against the queue —
/// rather than clearing the ids a flush happens to have settled — also cleans up
/// after the paths that empty the queue without flushing anything (unpair) and
/// after the share extension being killed mid-outage.
///
/// Pure, and mirrored by `logic/SendNotices.kt` on Android.
public enum SendNotices {

    /// Notices under this prefix are standing promises, and may be withdrawn.
    /// A settled verdict is filed apart from them precisely so that a sweep with
    /// no memory of what it announced cannot take a finished report down too.
    public static let pendingPrefix = "send.pending."

    /// A settled outcome: the only record that a send finished, so never swept.
    public static let outcomePrefix = "send.outcome."

    public static func pendingIdentifier(_ messageId: String) -> String {
        pendingPrefix + messageId
    }

    public static func outcomeIdentifier(_ messageId: String) -> String {
        outcomePrefix + messageId
    }

    /// Of the notices currently in Notification Center (`posted`, as delivered
    /// identifiers), the pending ones whose message is no longer in `held` and
    /// must therefore be removed.
    ///
    /// Takes every delivered identifier rather than a pre-filtered list, because
    /// the caller gets the whole of Notification Center back from iOS and the
    /// decision about what this sweep owns belongs in one tested place: anything
    /// without the pending prefix — a settled outcome, an arriving tab — is not
    /// ours to touch.
    public static func stalePending(posted: [String], held: [String]) -> [String] {
        let keep = Set(held.map(pendingIdentifier))
        return posted.filter { $0.hasPrefix(pendingPrefix) && !keep.contains($0) }
    }
}
