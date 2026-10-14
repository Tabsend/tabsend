import Foundation

/// One tab this phone RECEIVED, kept device-locally so it outlives its
/// notification [P-7]. Mirrors android/.../logic/Inbox.kt `InboxItem` and
/// extension/src/lib/model.ts `InboxItem`.
///
/// No favicon: nothing on this screen draws one, and storing a field no surface
/// reads is debris. Every field after `receivedAt` is optional so a list written
/// by an older build still decodes.
public struct InboxItem: Codable, Sendable, Equatable, Identifiable {
    /// The relay message id — the dedupe key, the same one the seen-set uses.
    public var id: String
    public var url: String
    public var title: String?
    /// The sender's label as it read WHEN THIS ARRIVED (survives a later rename).
    public var sourceLabel: String
    /// ISO — when the sender hit send.
    public var sentAt: String
    /// When this phone recorded it.
    public var receivedAt: Date
    /// The multi-tab send this belonged to, when it was one.
    public var batch: SendPayload.Batch?
    /// When the user actually opened it, nil while they have not.
    ///
    /// This is the distinction the extension has no use for (a browser opens
    /// every tab it receives) and that matters most here: an unopened row is a
    /// tab whose notification was swiped away or never tapped, which is the
    /// whole reason this screen exists.
    public var openedAt: Date?

    public init(
        id: String, url: String, title: String? = nil, sourceLabel: String,
        sentAt: String, receivedAt: Date, batch: SendPayload.Batch? = nil, openedAt: Date? = nil
    ) {
        self.id = id
        self.url = url
        self.title = title
        self.sourceLabel = sourceLabel
        self.sentAt = sentAt
        self.receivedAt = receivedAt
        self.batch = batch
        self.openedAt = openedAt
    }
}

/// Anything the batch grouper can arrange: a stable id, and the multi-tab send it
/// belonged to. Received tabs and group-history rows are both grouped [0028], and
/// they must group IDENTICALLY — the history screen shows the two side by side, so
/// two implementations of "what a batch is" would be visible in one list.
public protocol BatchGrouped: Identifiable, Equatable, Sendable where ID == String {
    var batch: SendPayload.Batch? { get }
}

/// One rendered block: a single tab, or every tab of one multi-tab send.
public struct BatchGroup<Item: BatchGrouped>: Sendable, Equatable, Identifiable {
    public var batchId: String?
    public var sentCount: Int?
    public var items: [Item]

    /// Stable across re-renders: a batch is its batch id, a single send its own id.
    public var id: String { batchId ?? items.first?.id ?? "" }

    public init(batchId: String? = nil, sentCount: Int? = nil, items: [Item]) {
        self.batchId = batchId
        self.sentCount = sentCount
        self.items = items
    }
}

public typealias InboxGroup = BatchGroup<InboxItem>

extension InboxItem: BatchGrouped {}

/// The received-tabs inbox [P-7].
///
/// A received link used to exist in exactly one place, its notification, and the
/// relay deletes the payload on ack — so one swipe lost the tab for good. This is
/// the device-local record that survives it.
///
/// It matters most on this platform. Android can offer "Open all" and a batch
/// summary in the shade; iOS structurally cannot (a notification action cannot
/// open N URLs, and iOS 15 removed custom summary text), so an in-app list is the
/// only surface where iOS reaches parity.
///
/// Retention is a COUNT, not an age (owner decision 2026-08-05): the newest
/// `maxItems`, stated on the screen rather than buried in settings.
///
/// ADR-0028 absorbed this rather than replacing it. The list is still what proves
/// a tab ARRIVED here — the relay's history says a message was acked, this says
/// what it was and whether the user opened it — and it is still the only record of
/// a tab whose sender predates the group history key. The merged screen is built
/// in `History`; everything below stayed where it was.
public enum Inbox {
    /// How many received tabs this phone keeps. Stated in the UI verbatim.
    public static let maxItems = 50

    /// Project a decrypted payload into the stored record. Pure. The sender label
    /// is snapshotted at receipt so the row still reads correctly after a later
    /// rename, or after that device leaves the group.
    public static func project(
        messageId: String,
        payload: SendPayload,
        sourceLabel: String,
        receivedAt: Date
    ) -> InboxItem {
        InboxItem(
            id: messageId,
            url: payload.url,
            title: payload.title,
            sourceLabel: sourceLabel,
            sentAt: payload.sentAt,
            receivedAt: receivedAt,
            batch: payload.batch
        )
    }

    /// Add one received tab, newest first, dropping anything past the cap.
    ///
    /// Prepending is what lets `group(_:)` restore a batch's original order (see
    /// there). Idempotent on the message id, and a re-delivery keeps the ORIGINAL
    /// record — so a tab the user already opened does not come back unopened.
    public static func record(
        _ items: [InboxItem], _ item: InboxItem, max: Int = maxItems
    ) -> [InboxItem] {
        guard !items.contains(where: { $0.id == item.id }) else { return items }
        return Array(([item] + items).prefix(max))
    }

    /// Stamp tabs as opened. Already-opened tabs keep their FIRST open time.
    public static func markOpened(
        _ items: [InboxItem], ids: Set<String>, at date: Date
    ) -> [InboxItem] {
        items.map { item in
            guard ids.contains(item.id), item.openedAt == nil else { return item }
            var copy = item
            copy.openedAt = date
            return copy
        }
    }

    public static func markOpened(
        _ items: [InboxItem], id: String, at date: Date
    ) -> [InboxItem] {
        markOpened(items, ids: [id], at: date)
    }

    /// Group so one multi-tab send reads as one send instead of N unrelated rows.
    ///
    /// Grouping is by batch id across the WHOLE list, not just adjacent rows: a
    /// batch can be recorded across separate drains, so a later single send can
    /// land between two of its tabs.
    ///
    /// A group takes the position of its FIRST item, so the list stays newest
    /// first. Items within a group are reversed, which restores the order the
    /// sender picked them in: `record` prepends, so the last tab of a batch ends
    /// up in front.
    public static func group<Item: BatchGrouped>(_ items: [Item]) -> [BatchGroup<Item>] {
        var groups: [BatchGroup<Item>] = []
        var indexByBatch: [String: Int] = [:]
        for item in items {
            guard let batch = item.batch else {
                groups.append(BatchGroup(items: [item]))
                continue
            }
            if let at = indexByBatch[batch.id] {
                groups[at].items.append(item)
                // Trust the largest count seen: every tab of the batch carries it.
                groups[at].sentCount = Swift.max(groups[at].sentCount ?? 0, batch.count)
                continue
            }
            indexByBatch[batch.id] = groups.count
            groups.append(BatchGroup(batchId: batch.id, sentCount: batch.count, items: [item]))
        }
        return groups.map { group in
            guard group.batchId != nil else { return group }
            var copy = group
            copy.items.reverse()
            return copy
        }
    }

    /// The count line for a batch block: "3 tabs" when all of them are here,
    /// "2 of 3 tabs" when they are not. A gap is a real outcome, not a bug — a tab
    /// can still be queued at the relay, or have been pushed off the end of the
    /// cap — so this names it instead of quietly showing a shorter list.
    public static func batchHeading<Item: BatchGrouped>(_ group: BatchGroup<Item>) -> String {
        let here = group.items.count
        let sent = Swift.max(group.sentCount ?? here, here)
        return here == sent ? "\(sent) tabs" : "\(here) of \(sent) tabs"
    }

    /// What a row calls the tab. A tab sent without a title is normal (some pages
    /// have none), and the host is a better handle than an empty line. Same rule
    /// as the link notification's title, so a row and its notification agree.
    public static func displayTitle(_ item: InboxItem) -> String {
        if let title = item.title, !title.trimmingCharacters(in: .whitespaces).isEmpty {
            return title
        }
        return hostOf(item.url)
    }

    /// A safe host for the row's secondary line; the raw string if it won't parse.
    public static func hostOf(_ url: String) -> String {
        URL(string: url)?.host ?? url
    }

    /// Compact, calm relative time ("just now", "3m ago", "5d ago"). Wording is
    /// kept identical to the other three clients on purpose: they list the same
    /// sends this one does, and two vocabularies for one age would read as two
    /// different facts.
    public static func relativeTime(_ iso: String, now: Date = Date()) -> String {
        guard let then = WireDate.date(from: iso) else { return "unknown" }
        let delta = now.timeIntervalSince(then)
        if delta < 60 { return "just now" }
        if delta < 3600 { return "\(Int(delta / 60))m ago" }
        if delta < 86_400 { return "\(Int(delta / 3600))h ago" }
        let days = Int(delta / 86_400)
        if days < 30 { return "\(days)d ago" }
        if days < 365 { return "\(days / 30)mo ago" }
        return "\(days / 365)y ago"
    }
}
