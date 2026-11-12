import Foundation

/// "Is this phone replacing iPhone?" (PLANS.md P-31 item 2). The Swift copy of
/// `shared/src/replacing.ts`; read its header for the whole rule and why it is not the
/// withdrawn "Remove old one" (SECURITY_REVIEW.md L1, L2, L6).
///
/// A reinstalled app pairs as a NEW device, and the relay renames it so two entries
/// never share a label ("iPhone" comes back as "iPhone 2"). Right after THIS phone
/// pairs, during its own setup, it looks for an old offline copy of itself and offers
/// to replace it. This picks that old entry, or none. It never answers or accepts any
/// device: replacing removes the old entry and renames this one.
///
/// Swift pitfalls (L6): Swift's `==` on `String` uses canonical equivalence ("é" and
/// "e" + combining acute are equal), and `lowercased()` is Unicode-aware. The other
/// clients compare UTF-16 code units and lowercase ASCII only, so everything here works
/// on `Array(s.utf16)`: names, ids, the removed list and the id tie-break alike. All
/// three clients run `shared/vectors/replacing-devices.json`.
public protocol ReplacingCandidate {
    var id: String { get }
    var label: String { get }
    var kind: String { get }
    var presence: String { get }
    var lastSeenAt: String { get }
    var createdAt: String { get }
}

extension Endpoint: ReplacingCandidate {}

public enum Replacing {
    /// How long an entry must have been quiet before it is offered: a day.
    public static let quietMs: Int64 = 24 * 60 * 60 * 1000

    /// " · ", as UTF-16. Every unit is in the BMP and none is a surrogate, so a match
    /// never splits a surrogate pair.
    private static let separator: [UInt16] = Array(" · ".utf16)

    /// The highest counter the relay's dedupe writes (`uniqueBrowserName`, `naming.ts`).
    private static let maxCounter = 99

    /// Milliseconds for exactly `YYYY-MM-DDTHH:mm:ss.sssZ` naming a real instant, else
    /// nil. The GH4 rule, the same reader the keyring uses.
    public static func strictIsoMillis(_ text: String) -> Int64? {
        KeyCreatedAt.millis(text)
    }

    /// ASCII-only lowercase, runs of ASCII spaces, tabs and line breaks as one space,
    /// none at either end.
    public static func normalizeName(_ name: String) -> String {
        String(decoding: normalize(Array(name.utf16)), as: UTF16.self)
    }

    /// A normalized name without the relay's counter: "dia 2" → "dia". Only a trailing
    /// " N" with N from 2 to 99 and no leading zero.
    public static func withoutCounter(_ normalized: String) -> String {
        String(decoding: stripCounter(Array(normalized.utf16)), as: UTF16.self)
    }

    /// The two halves a match compares: the app name without its counter, and the
    /// computer name (empty for a phone).
    public static func replacingKey(_ label: String) -> (app: String, computer: String) {
        let key = key(label)
        return (String(decoding: key.app, as: UTF16.self), String(decoding: key.computer, as: UTF16.self))
    }

    /// The app half of a label as shown: "Dia" from "Dia · MacBook Pro", the whole
    /// label for a phone. For "Replace iPhone".
    public static func appNameOf(_ label: String) -> String {
        let units = Array(label.utf16)
        guard let i = firstIndex(of: separator, in: units) else { return label }
        return String(decoding: units[..<i], as: UTF16.self)
    }

    /// The old entry this device replaces, or nil. See `shared/src/replacing.ts`.
    public static func findReplacedSelf<E: ReplacingCandidate>(
        selfId: String, list: [E], removed: [String], nowMs: Int64
    ) -> E? {
        let selfUnits = Array(selfId.utf16)
        guard let me = list.first(where: { Array($0.id.utf16) == selfUnits }),
              let selfCreated = strictIsoMillis(me.createdAt)
        else { return nil }
        let mine = key(me.label)
        if mine.app.isEmpty { return nil }
        let removedUnits = removed.map { Array($0.utf16) }
        let kind = Array(me.kind.utf16)
        let online = Array("online".utf16)

        var best: (e: E, id: [UInt16], seen: Int64, created: Int64)?
        for e in list {
            let id = Array(e.id.utf16)
            if id == selfUnits || removedUnits.contains(id) { continue }
            if Array(e.kind.utf16) != kind { continue }
            if Array(e.presence.utf16) == online { continue }
            guard let seen = strictIsoMillis(e.lastSeenAt),
                  let created = strictIsoMillis(e.createdAt)
            else { continue }
            if nowMs - seen <= quietMs { continue }
            if created >= selfCreated || seen >= selfCreated { continue }
            let theirs = key(e.label)
            if theirs.app != mine.app || theirs.computer != mine.computer { continue }
            if let b = best {
                let better = seen > b.seen
                    || (seen == b.seen && created > b.created)
                    // JavaScript's `>` on strings: UTF-16 code-unit order.
                    || (seen == b.seen && created == b.created && b.id.lexicographicallyPrecedes(id))
                if !better { continue }
            }
            best = (e, id, seen, created)
        }
        return best?.e
    }

    // MARK: Replace, step by step

    /// What pressing "Replace" came to.
    public enum Outcome: Equatable {
        /// The re-fetched list no longer offers the same entry: closed quietly.
        case noLongerOffered
        /// The list could not be fetched again; nothing was changed.
        case listFailed
        /// The relay did not remove the old entry; this phone was not renamed.
        case removeFailed
        /// The old entry is gone and this phone was asked to take `label`.
        case replaced(label: String)
    }

    /// "Replace": fetch the list again and re-run the match; only if it still names
    /// `offeredId`, remove that entry through `remove` (the device list's own removal,
    /// which records it in the watch so the group key rotates), and only if that worked,
    /// rename this phone to the old entry's exact label through `rename`.
    ///
    /// It is given no way to answer, confirm or accept any device, on purpose (L1).
    public static func replace(
        selfId: String,
        offeredId: String,
        fetchList: () async throws -> [Endpoint],
        removed: () -> [String],
        nowMs: () -> Int64,
        remove: (String) async -> Bool,
        rename: (String) async -> Void
    ) async -> Outcome {
        let list: [Endpoint]
        do { list = try await fetchList() } catch { return .listFailed }
        guard let old = findReplacedSelf(selfId: selfId, list: list, removed: removed(), nowMs: nowMs()),
              Array(old.id.utf16) == Array(offeredId.utf16)
        else { return .noLongerOffered }
        guard await remove(old.id) else { return .removeFailed }
        await rename(old.label)
        return .replaced(label: old.label)
    }

    // MARK: UTF-16 helpers

    private static func isSpace(_ c: UInt16) -> Bool {
        c == 0x20 || c == 0x09 || c == 0x0A || c == 0x0D
    }

    static func normalize(_ name: [UInt16]) -> [UInt16] {
        var out: [UInt16] = []
        out.reserveCapacity(name.count)
        var pendingSpace = false
        for c in name {
            if isSpace(c) {
                pendingSpace = !out.isEmpty
                continue
            }
            if pendingSpace { out.append(0x20) }
            pendingSpace = false
            out.append(c >= 0x41 && c <= 0x5A ? c + 0x20 : c)
        }
        return out
    }

    static func stripCounter(_ normalized: [UInt16]) -> [UInt16] {
        guard let space = normalized.lastIndex(of: 0x20), space > 0 else { return normalized }
        let digits = normalized[(space + 1)...]
        func isDigit(_ c: UInt16) -> Bool { c >= 0x30 && c <= 0x39 }
        guard (1...2).contains(digits.count),
              let first = digits.first, first >= 0x31, first <= 0x39,
              digits.allSatisfy(isDigit)
        else { return normalized }
        let n = digits.reduce(0) { $0 * 10 + Int($1 - 0x30) }
        guard n >= 2, n <= maxCounter else { return normalized }
        return Array(normalized[..<space])
    }

    private static func key(_ label: String) -> (app: [UInt16], computer: [UInt16]) {
        let units = Array(label.utf16)
        let app: [UInt16]
        let computer: [UInt16]
        if let i = firstIndex(of: separator, in: units) {
            app = Array(units[..<i])
            computer = Array(units[(i + separator.count)...])
        } else {
            app = units
            computer = []
        }
        return (stripCounter(normalize(app)), normalize(computer))
    }

    /// JavaScript's `indexOf` on UTF-16 code units.
    private static func firstIndex(of needle: [UInt16], in hay: [UInt16]) -> Int? {
        guard !needle.isEmpty, hay.count >= needle.count else { return nil }
        for start in 0...(hay.count - needle.count) where hay[start..<start + needle.count].elementsEqual(needle) {
            return start
        }
        return nil
    }
}

/// The words of the offer, the same on every client (phone wording).
public enum ReplacingCopy {
    /// "Is this phone replacing iPhone?"
    public static func title(oldLabel: String) -> String {
        let appName = Replacing.appNameOf(oldLabel)
        return String(
            localized: "Is this phone replacing \(appName)?",
            bundle: .module,
            comment: "Title of the question shown once, right after this phone pairs, when the group holds an old offline copy of it (Tabsend was reinstalled). %@ is the old device's name, such as \"iPhone\"."
        )
    }

    /// The body: the old name in full and when it was last seen. It asks; it does not
    /// say the two are the same (L2).
    public static func body(oldLabel: String, lastSeenAt: String, timeZone: TimeZone = .current) -> String {
        let millis = Replacing.strictIsoMillis(lastSeenAt) ?? 0
        let date = L10n.shortMonthAndDay(
            Date(timeIntervalSince1970: Double(millis) / 1000), timeZone: timeZone
        )
        return String(
            localized: "“\(oldLabel)” hasn't been online since \(date). If Tabsend was reinstalled here, replace it so links come to this phone.",
            bundle: .module,
            comment: "Message of the question shown right after this phone pairs, when the group holds an old offline copy of it. The first %@ is the old device's full name, in curly quotes; the second is the day it was last online, such as \"Oct 30\"."
        )
    }

    /// The primary button.
    public static func replaceButton(oldLabel: String) -> String {
        let appName = Replacing.appNameOf(oldLabel)
        return String(
            localized: "Replace \(appName)",
            bundle: .module,
            comment: "Button on the question shown right after pairing: removes the old offline copy of this phone and gives this phone its name. %@ is the old device's name, such as \"iPhone\". Keep it short."
        )
    }

    /// The other button: closes the question and changes nothing.
    public static var keepBoth: String {
        String(
            localized: "Keep both",
            bundle: .module,
            comment: "Button on the question shown right after pairing: closes it and keeps both this phone and the old offline copy in the group. Keep it short."
        )
    }

    /// The small line: what Replace does.
    public static func smallLine(oldLabel: String) -> String {
        String(
            localized: "This phone takes the name \(oldLabel). The old one is removed from your devices.",
            bundle: .module,
            comment: "Small line on the question shown right after pairing, saying what Replace does. %@ is the old device's full name."
        )
    }
}
