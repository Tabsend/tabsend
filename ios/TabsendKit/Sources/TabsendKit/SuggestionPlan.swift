import Foundation

/// One endpoint promoted to a share-sheet suggestion slot.
public struct SuggestionTarget: Equatable, Sendable {
    public var endpointId: String
    public var label: String
    public var kind: String
    /// Lower is more wanted, mirroring the chooser's own order.
    ///
    /// iOS offers no published ordering hint the way Android's shortcut `rank`
    /// does — the suggestions row is ranked entirely by the system's own model,
    /// fed by donation recency and frequency. So this rank is not something we
    /// hand over; it only tells the donor which target to donate LAST, which is
    /// the single ordering lever the platform leaves us.
    public var rank: Int

    public init(endpointId: String, label: String, kind: String, rank: Int) {
        self.endpointId = endpointId
        self.label = label
        self.kind = kind
        self.rank = rank
    }
}

/// Which endpoints get a slot in the iOS share sheet's suggestions row
/// (INTERACTION_FLOWS §2.6) — the pure half of `App/Shared/ShareSuggestions`,
/// mirroring android/.../logic/ShortcutPlan.kt.
///
/// Slots are scarce and the system caps them, so this is the chooser list
/// *truncated*, never a different list: same exclusions (self, consoles) and same
/// order (primary → recents → alphabetical), so what sits on top of the chooser is
/// also what the share sheet offers. Unlike Android there is no per-app quota to
/// ask about — the suggestions row is shared across every app on the phone, so an
/// extra donation of ours does not cost us a slot, it costs a live device one.
///
/// Stale endpoints are the one extra exclusion. They stay perfectly sendable in
/// the chooser (presence is non-gating, ADR-0001), but a month-dark endpoint
/// spending one of four slots costs a live device its place, and a suggestion has
/// nowhere to put the "(inactive)" qualifier the chooser row shows.
public enum SuggestionPlan {
    /// Our own cap. Apple documents no number and exposes no API to ask for one,
    /// and the row mixes every app's conversations, so a long tail of ours is
    /// never seen and only dilutes the head.
    public static let maxTargets = 4

    /// Conversation ids are namespaced rather than bare endpoint ids, so an id
    /// arriving back from the system is always recognisably one of ours.
    /// `extensionContext.intent` is only ever populated from our own donations,
    /// but donations OUTLIVE the build that made them: an id minted under some
    /// future scheme, or left behind by a build whose ids meant something else,
    /// has to read as "no pick" and fall back to the chooser rather than be spent
    /// as an endpoint id.
    private static let idPrefix = "endpoint:"

    public static func conversationId(for endpointId: String) -> String {
        idPrefix + endpointId
    }

    /// The endpoint a share-sheet pick names, or nil if this wasn't one of ours.
    public static func endpointId(ofConversation conversationId: String?) -> String? {
        guard let conversationId, conversationId.hasPrefix(idPrefix) else { return nil }
        let id = String(conversationId.dropFirst(idPrefix.count))
        return id.isEmpty ? nil : id
    }

    public static func build(rows: [Chooser.Row], max: Int = maxTargets) -> [SuggestionTarget] {
        rows
            .filter { !$0.stale }
            .prefix(Swift.max(max, 0))
            .enumerated()
            .map { index, row in
                SuggestionTarget(
                    endpointId: row.endpoint.id,
                    label: row.endpoint.label,
                    kind: row.endpoint.kind,
                    rank: index
                )
            }
    }

    /// What a donated set looks like, for deciding whether re-donating is work.
    ///
    /// Android could read its published shortcuts back and diff them; iOS has no
    /// way to ask what it has already been told, so the donor remembers this
    /// instead. Covers everything a donation carries (identity, label, avatar
    /// kind) and the order, so a rename or a reshuffle still re-donates.
    public static func signature(_ targets: [SuggestionTarget]) -> String {
        targets.map { "\($0.endpointId)|\($0.label)|\($0.kind)" }.joined(separator: "\n")
    }
}
