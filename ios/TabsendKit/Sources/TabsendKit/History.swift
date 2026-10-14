import Foundation

/// The group's shared history [ADR-0028]: one timeline of every transfer in the
/// group, sent and received, readable from any paired device.
///
/// What this replaces is a received-only list that could not answer the question
/// people actually have. A tab that is sent, never arrives, and whose source tab
/// is then closed existed nowhere at all: the sender drops its copy the moment the
/// relay accepts (ADR-0008 — "Sent" only ever meant "the relay took it"), and the
/// target never records what it never got.
///
/// The local store is now a CACHE. The relay's list is authoritative, which is
/// what lets this phone show a transfer between two OTHER devices; the cache is
/// what lets it show anything at all on a train.
public enum HistoryDirection: String, Codable, Sendable {
    /// This phone sent it. Paper plane.
    case sent
    /// This phone received it. Tray.
    case received
    /// Neither end is this phone, so no preposition fits and the row names both
    /// ends instead (ADR-0028 decision 9). Neutral exchange glyph.
    case between
}

/// Where a transfer got to, from facts the relay has always held.
public enum HistoryState: String, Sendable {
    /// The target confirmed it.
    case arrived
    /// Accepted by the relay, not yet acked, still inside its TTL.
    case waiting
    /// The TTL ran out with no ack. The tab is gone unless someone re-sends it,
    /// which is possible only because the source kept its plaintext.
    case neverArrived
}

/// One row of the merged timeline.
///
/// Cached verbatim so the screen works offline. It holds a URL in plain text,
/// exactly as `InboxItem` and `OutboundItem` already do, and for the same reason:
/// a row that cannot name the tab is not worth keeping. It holds no key material.
///
/// `direction` and `state` are deliberately NOT stored: one depends on which
/// endpoint this phone is and the other changes with the clock, so both are
/// computed at read time from the facts below.
public struct HistoryItem: Codable, Sendable, Equatable, Identifiable {
    /// The relay message id, which is also the inbox's id for the same tab.
    public var id: String
    public var sourceEndpointId: String
    public var targetEndpointId: String
    /// The relay's own row time. The sort key AND the age shown, in preference to
    /// the payload's `sentAt`: a metadata-only row has no payload to ask, and one
    /// list ordered by two different clocks would put rows in an order the
    /// timestamps beside them contradict.
    public var createdAt: String
    public var expiresAt: String?
    public var ackedAt: String?
    /// nil when the blob is sealed under a key this phone does not hold. The row
    /// stays: a transfer really happened, and the relay's routing facts about it
    /// are true whether or not we can read what moved.
    public var payload: SendPayload?
    /// Labels as they read AT SEND, so a row survives a rename. Falls back to the
    /// current endpoint list for a metadata-only row, whose labels were sealed
    /// inside the blob along with everything else.
    public var sourceLabel: String?
    public var targetLabel: String?
    /// When the user opened it here, nil while they have not. Received rows only,
    /// re-joined from the inbox on every read rather than trusted from the cache.
    public var openedAt: Date?

    public init(
        id: String, sourceEndpointId: String, targetEndpointId: String,
        createdAt: String, expiresAt: String? = nil, ackedAt: String? = nil,
        payload: SendPayload? = nil,
        sourceLabel: String? = nil, targetLabel: String? = nil,
        openedAt: Date? = nil
    ) {
        self.id = id
        self.sourceEndpointId = sourceEndpointId
        self.targetEndpointId = targetEndpointId
        self.createdAt = createdAt
        self.expiresAt = expiresAt
        self.ackedAt = ackedAt
        self.payload = payload
        self.sourceLabel = sourceLabel
        self.targetLabel = targetLabel
        self.openedAt = openedAt
    }

    public var batch: SendPayload.Batch? { payload?.batch }
    /// True when the blob named a group key this phone does not hold.
    public var isMetadataOnly: Bool { payload == nil }
}

extension HistoryItem: BatchGrouped {}

public typealias HistoryGroup = BatchGroup<HistoryItem>

public enum History {
    /// The cache is capped like the inbox, and for the same reason: a phone should
    /// hold a bounded amount, and the number is stated on the screen. The relay
    /// keeps its own longer window (ADR-0028: `HISTORY_RETENTION_DAYS`), so this
    /// cap is what this phone shows offline, not what the group remembers.
    public static let maxItems = Inbox.maxItems

    // MARK: projection

    /// Turn one relay row into a timeline row, opening its blob when the ring has
    /// the key it names. A missing key is not an error: an older key we were never
    /// given, or a group that rotated before this phone joined, produces a row that
    /// is honest about being unreadable rather than no row at all.
    public static func project(
        _ entry: HistoryEntry,
        ring: [GroupKeyRecord],
        labels: [String: String] = [:]
    ) -> HistoryItem {
        var item = HistoryItem(
            id: entry.id,
            sourceEndpointId: entry.sourceEndpointId,
            targetEndpointId: entry.targetEndpointId,
            createdAt: entry.createdAt,
            expiresAt: entry.expiresAt,
            ackedAt: entry.ackedAt,
            sourceLabel: labels[entry.sourceEndpointId],
            targetLabel: labels[entry.targetEndpointId]
        )
        guard let key = Keyring.key(ring, id: entry.blob.keyId),
              let plaintext = try? Sealer.openGroup(entry.blob, groupKeyBase64: key.key),
              let record = try? Wire.decoder.decode(HistoryRecord.self, from: plaintext)
        else { return item }
        item.payload = record.payload
        item.sourceLabel = record.sourceLabelAtSend
        item.targetLabel = record.targetLabelAtSend
        return item
    }

    /// A received tab the relay's history does not cover: a sender that predates
    /// ADR-0028, a relay that does, or a group that had no key yet when it was
    /// sent. Dropping these would make the new screen show LESS than the one it
    /// replaces, which is the one outcome this change cannot have.
    public static func project(
        inboxItem item: InboxItem,
        selfEndpointId: String,
        selfLabel: String?
    ) -> HistoryItem {
        HistoryItem(
            id: item.id,
            // The sender's endpoint id was never stored with the tab, only its
            // label, so this row can name the source but not identify it. Using
            // this phone's id would make it read as sent-from-here, so the source
            // stays deliberately unmatchable and the direction falls out as
            // `received` from the target below.
            sourceEndpointId: "",
            targetEndpointId: selfEndpointId,
            createdAt: item.sentAt,
            // It is here, so it was acked. Nothing about it can ever read as
            // "never arrived".
            ackedAt: WireDate.string(from: item.receivedAt),
            payload: SendPayload(
                url: item.url, title: item.title, sentAt: item.sentAt, batch: item.batch
            ),
            sourceLabel: item.sourceLabel,
            targetLabel: selfLabel,
            openedAt: item.openedAt
        )
    }

    /// Merge the relay's list with the local inbox into one timeline, newest
    /// first, capped.
    ///
    /// The relay wins on a shared id — it holds the delivery state, which the
    /// inbox knows nothing about — but the inbox still supplies `openedAt` for
    /// every row, because whether the user opened a tab is a fact only this phone
    /// has.
    public static func merge(
        relay: [HistoryItem],
        inbox: [InboxItem],
        selfEndpointId: String,
        selfLabel: String?,
        max: Int = maxItems
    ) -> [HistoryItem] {
        let openedById = Dictionary(
            inbox.map { ($0.id, $0.openedAt) }, uniquingKeysWith: { first, _ in first }
        )
        var byId: [String: HistoryItem] = [:]
        for var item in relay {
            item.openedAt = openedById[item.id] ?? nil
            byId[item.id] = item
        }
        for item in inbox where byId[item.id] == nil {
            byId[item.id] = project(
                inboxItem: item, selfEndpointId: selfEndpointId, selfLabel: selfLabel
            )
        }
        // Newest first, id breaking a tie so two rows written in the same
        // millisecond do not swap places between renders.
        let sorted = byId.values.sorted { a, b in
            a.createdAt == b.createdAt ? a.id > b.id : a.createdAt > b.createdAt
        }
        return Array(sorted.prefix(max))
    }

    // MARK: reading a row

    public static func direction(_ item: HistoryItem, selfEndpointId: String) -> HistoryDirection {
        if item.sourceEndpointId == selfEndpointId { return .sent }
        if item.targetEndpointId == selfEndpointId { return .received }
        return .between
    }

    /// Where a transfer got to. `ackedAt` set means it arrived; no ack past the
    /// relay's TTL means it never will. Everything else is still in flight.
    public static func state(_ item: HistoryItem, now: Date = Date()) -> HistoryState {
        if item.ackedAt != nil { return .arrived }
        guard let expiresAt = item.expiresAt, let expiry = WireDate.date(from: expiresAt) else {
            return .waiting
        }
        return expiry <= now ? .neverArrived : .waiting
    }

    /// Sent rows that have run out of time and have not been announced yet [0028
    /// §E]. Only this phone's OWN sends: telling someone a tab another device sent
    /// never arrived hands them a problem they cannot act on from here.
    public static func unannouncedNeverArrived(
        _ items: [HistoryItem],
        selfEndpointId: String,
        announced: [String],
        now: Date = Date()
    ) -> [HistoryItem] {
        let done = Set(announced)
        return items.filter { item in
            direction(item, selfEndpointId: selfEndpointId) == .sent
                && state(item, now: now) == .neverArrived
                && !done.contains(item.id)
        }
    }

    /// The payload "Send again" would send for this row, or nil when the row
    /// must not offer it: there is no plaintext to send, or its link fails the
    /// same check a received link must pass before it is opened.
    ///
    /// The link came out of a history blob, which any group member (or a relay
    /// that slipped a device in) can write, so it is no more trusted than a
    /// received tab. Re-sending a `javascript:` or deep link would hand it to
    /// another device to open.
    ///
    /// A fresh send, not a replay: it gets `now` as its time, and it deliberately
    /// drops the batch it belonged to. Keeping the batch id would file one re-sent
    /// tab under the original multi-tab send and make the target's heading read
    /// "1 of 3" for a send of one.
    public static func sendAgainPayload(_ item: HistoryItem, now: Date = Date()) -> SendPayload? {
        guard let payload = item.payload,
              LinkURLPolicy.openableURL(from: payload.url) != nil
        else { return nil }
        return SendPayload(
            url: payload.url,
            title: payload.title,
            favicon: payload.favicon,
            sentAt: WireDate.string(from: now)
        )
    }

    // MARK: copy

    /// Mail imagery, never a bare arrow (ADR-0028 decision 9). An up/down arrow
    /// does not say what it means, and a lone arrow in a row's left gutter reads as
    /// a handle for reordering the list.
    public static func symbol(_ direction: HistoryDirection) -> String {
        switch direction {
        case .sent: return "paperplane"
        case .received: return "tray.and.arrow.down"
        case .between: return "arrow.left.arrow.right"
        }
    }

    /// What the row calls the tab. A tab sent without a title is normal, and the
    /// host is a better handle than an empty line; a row we cannot read says so
    /// rather than showing a blank.
    public static func displayTitle(_ item: HistoryItem) -> String {
        guard let payload = item.payload else { return "A tab this phone can't read" }
        if let title = payload.title, !title.trimmingCharacters(in: .whitespaces).isEmpty {
            return title
        }
        return Inbox.hostOf(payload.url)
    }

    /// The second line: where the tab lives, who moved it, and how long ago.
    ///
    /// A `between` row names both ends, because "from" and "to" have nothing to
    /// attach to when neither end is the device you are holding — which is exactly
    /// where an arrow earns its place, sitting between two device names.
    public static func subtitle(
        _ item: HistoryItem,
        direction: HistoryDirection,
        grouped: Bool = false,
        now: Date = Date()
    ) -> String {
        var parts: [String] = []
        if let payload = item.payload {
            parts.append(Inbox.hostOf(payload.url))
        } else {
            parts.append("sealed with a group key this phone doesn't have")
        }
        // A grouped row's route and age are already on the section header.
        if !grouped {
            parts.append(route(item, direction: direction))
            parts.append(Inbox.relativeTime(item.createdAt, now: now))
        }
        return parts.joined(separator: " · ")
    }

    /// Who moved it, phrased for the direction.
    public static func route(_ item: HistoryItem, direction: HistoryDirection) -> String {
        let source = item.sourceLabel ?? Feedback.thatDevice
        let target = item.targetLabel ?? Feedback.thatDevice
        switch direction {
        case .sent: return "to \(target)"
        case .received: return "from \(source)"
        case .between: return "\(source) → \(target)"
        }
    }

    /// What became of a send. Only sent rows show it: a received row arriving is
    /// what put it on the screen, and a transfer between two other devices is not
    /// this phone's to chase.
    public static func stateLine(_ item: HistoryItem, now: Date = Date()) -> String? {
        switch state(item, now: now) {
        case .arrived: return "Arrived"
        case .waiting: return "Waiting for \(item.targetLabel ?? Feedback.thatDevice)"
        case .neverArrived: return "Never arrived"
        }
    }

    /// Said once, under the list, so retention is on the screen rather than in
    /// settings nobody opens.
    public static func retentionLine(relayKeepsHistory: Bool) -> String {
        relayKeepsHistory
            ? "Newest first, every device in your group. The last \(maxItems) are kept on this phone."
            : "Newest first. The last \(maxItems) are kept on this phone."
    }
}
