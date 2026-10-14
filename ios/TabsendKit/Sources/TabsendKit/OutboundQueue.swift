import Foundation

/// The little a queue rule needs to know about the thing it is holding. Keeping
/// it to this is what lets the rule below be tested with no store, no envelope
/// and no App Group.
public protocol HeldItem {
    var id: String { get }
    /// ISO — when the user hit send. Age is measured from here, never from a retry.
    var createdAt: String { get }
}

/// What bounds the source-side outbound queue.
///
/// An item leaves that queue only on a DEFINITE answer from the relay: accepted,
/// or refused in a way retrying cannot change (ADR-0008, INTERACTION_FLOWS §4e).
/// Silence, a 429 and any 5xx all keep it, deliberately — dropping a tab because
/// a reverse proxy answered HTML 502 for the few seconds a relay container takes
/// to restart was silent data loss, and in a flush it was the whole queue at once.
///
/// That rule is unchanged. What it left open is the other side: nothing ever
/// ENDED a wait. A relay that permanently 5xxes one particular envelope retried
/// it on every flush and every background refresh forever, and sharing through a
/// long outage grew the queue without bound — on a phone, where the whole queue
/// is one blob rewritten into App Group UserDefaults on every single change, and
/// where the share extension pays that cost inside the few seconds iOS gives it.
///
/// Hand-mirrored from `extension/src/lib/outbound.ts`, and by
/// `logic/OutboundQueue.kt`. The three must agree: a tab that dies on the phone
/// at seven days and lives on the laptop for a month is two different products.
public enum OutboundQueue {

    /// How long a tab may wait before Tabsend gives up on it.
    ///
    /// Mirrors `DEFAULT_MESSAGE_TTL_DAYS` in `shared/src/types.ts` — the SOURCE,
    /// which is TypeScript and cannot be consumed from Swift, so like the copy
    /// tables it lives three times. Pinned to the relay's own message TTL rather
    /// than picked: past that horizon the relay would have deleted the message
    /// anyway, so both sides hold one opinion about when a send is dead.
    ///
    /// An age cap and NOT a consecutive-5xx counter, which was the other option
    /// on the table: a counter kills tabs during a legitimately long proxy
    /// outage, which is exactly the failure the recoverable/final split exists
    /// to prevent. Age has no false-kill mode — a relay back inside the week
    /// keeps every tab — and it ends the poison envelope too, since that ages
    /// out as well.
    public static let maxAgeDays = 7
    public static let maxAge: TimeInterval = TimeInterval(maxAgeDays) * 24 * 60 * 60

    /// How many held tabs the queue keeps.
    ///
    /// Age alone does not bound a burst, and a week is a long time to keep
    /// sharing at a relay that is not answering. The number is a compromise
    /// between "nobody sharing normally ever meets it" and what the storage
    /// actually costs: this queue is one blob rewritten on every enqueue and
    /// every flush, so its length is paid for on every send, not only when it is
    /// read. Identical in all three clients on purpose.
    public static let maxItems = 200

    /// What to do with a queue, decided before anything is written or POSTed.
    ///
    /// `expired` and `evicted` are kept apart because the user is told about
    /// them differently: one waited too long, the other was pushed out by newer
    /// sends, and a single sentence covering both would be false half the time.
    public struct Plan<T> {
        /// The queue as it should now be stored, in its original order.
        public var keep: [T]
        /// Given up on: older than the relay's own message TTL.
        public var expired: [T] = []
        /// Given up on: the oldest tabs, pushed out by the size cap.
        public var evicted: [T] = []
    }

    /// Age out, then cap. Pure: the caller stores `keep` and announces the rest
    /// — never silently, because the user was promised "the tab is held here and
    /// sends itself once the relay answers again" and this is the moment that
    /// promise stops being kept (INTERACTION_FLOWS §4d).
    ///
    /// Run at BOTH ends — when something is enqueued, and at the top of a flush.
    /// The flush is the half that matters for the poison envelope: it is never
    /// competing with newer sends for the size cap, so nothing but its own age
    /// can ever finish it.
    ///
    /// A `createdAt` that will not parse is treated as brand new rather than as
    /// infinitely old. Guessing the other way would let a formatting bug delete
    /// somebody's tabs, and the size cap still bounds the queue either way.
    public static func plan<T: HeldItem>(_ queue: [T], now: Date) -> Plan<T> {
        var expired: [T] = []
        var survived: [T] = []
        for item in queue {
            if now.timeIntervalSince(createdAt(item, now: now)) >= maxAge {
                expired.append(item)
            } else {
                survived.append(item)
            }
        }

        let excess = survived.count - maxItems
        guard excess > 0 else { return Plan(keep: survived, expired: expired) }

        // Oldest first, by the TIMESTAMP rather than by position in the array: a
        // place in the queue only says when the item was last written, and the
        // newest item is the one the user just asked for — dropping that one to
        // make room would be the single worst choice available. Ties (and
        // unparseable stamps, which read as "now") fall back to position, so the
        // ordering is total and the same list always yields the same plan.
        let doomed = Set(
            survived.enumerated()
                .sorted { lhs, rhs in
                    let a = createdAt(lhs.element, now: now)
                    let b = createdAt(rhs.element, now: now)
                    return a == b ? lhs.offset < rhs.offset : a < b
                }
                .prefix(excess)
                .map { $0.element.id }
        )
        return Plan(
            keep: survived.filter { !doomed.contains($0.id) },
            expired: expired,
            evicted: survived.filter { doomed.contains($0.id) }
        )
    }

    /// Abandon one held tab: a pure local delete, and NOTHING is transmitted.
    ///
    /// Same principle as the extension's quick-send undo window — there is no
    /// retraction message to build because there is nothing to retract. Be
    /// honest about the limit that follows: this can only forget something
    /// nobody else has yet. An item whose POST is in flight at this instant may
    /// still be accepted by the relay and delivered, and a tab the relay has
    /// already taken is long past anything this can reach. Cancelling is "stop
    /// trying", not "unsend"; the product has never had an unsend and this does
    /// not add one.
    public static func cancel<T: HeldItem>(_ queue: [T], id: String) -> [T] {
        queue.filter { $0.id != id }
    }

    /// When the send was made; `now` when the stamp will not parse.
    private static func createdAt(_ item: HeldItem, now: Date) -> Date {
        WireDate.date(from: item.createdAt) ?? now
    }
}
