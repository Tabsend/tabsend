import Foundation
import Security

/// The group history keyring [ADR-0028]. A faithful port of
/// `extension/src/lib/keyring.ts`, which is the canonical version — the four
/// clients converge on the same current key without talking to each other, so
/// they cannot afford two different rules for which key that is.
///
/// A device holds a SET of group keys, not one. That single decision collapses
/// three problems into the same code path:
///
///  - **Rotation.** A device leaving the list (removed from any client, or shown
///    once and then hidden) makes the next device able to mint replace the key;
///    see `NewDevices.rotationDue`. History written before it stays readable,
///    because the old key is still in the ring.
///  - **A generation race.** A group upgrading from before ADR-0028 has no key,
///    and two devices could mint one at the same moment. Both end up in every
///    ring, everyone converges on the same `current` one, and the blobs written
///    under the loser stay readable instead of becoming garbage.
///  - **Arriving late.** A device that has been off for a month collects whatever
///    it missed and can read the whole window.
///
/// The convergence rule is total and deterministic, so devices agree without
/// talking to each other: newest `createdAt` wins, and `keyId` breaks a tie.
/// `keyId` is a hash, so the tiebreak is arbitrary but identical everywhere —
/// both fields are ASCII (ISO-8601 and base64url), so Swift's string ordering and
/// JavaScript's UTF-16 code-unit ordering agree on every value that can occur.
public enum Keyring {
    /// Newest first, deterministic. The head is what new sends are sealed under.
    public static func sorted(_ ring: [GroupKeyRecord]) -> [GroupKeyRecord] {
        ring.sorted { a, b in
            if a.createdAt != b.createdAt { return a.createdAt > b.createdAt }
            return a.keyId > b.keyId
        }
    }

    /// The key to seal NEW history under, or nil while the group has none.
    public static func current(_ ring: [GroupKeyRecord]) -> GroupKeyRecord? {
        sorted(ring).first
    }

    /// The key a stored blob names, for reading history sealed under an older one.
    public static func key(_ ring: [GroupKeyRecord], id keyId: String) -> GroupKeyRecord? {
        ring.first { $0.keyId == keyId }
    }

    /// Fold newly-received keys into the ring, deduped by `keyId`. Never drops a
    /// key: an old one is what makes old history readable, and they are 32 bytes
    /// each.
    public static func merge(_ ring: [GroupKeyRecord], _ incoming: [GroupKeyRecord]) -> [GroupKeyRecord] {
        var byId: [String: GroupKeyRecord] = [:]
        var order: [String] = []
        for key in ring + incoming where byId[key.keyId] == nil {
            byId[key.keyId] = key
            order.append(key.keyId)
        }
        return sorted(order.compactMap { byId[$0] })
    }

    /// Should THIS device mint the group's first key?
    ///
    /// Only when the ring is empty, and only for the endpoint with the lowest id
    /// among the group's current members. Any device minting whenever it noticed a
    /// missing key would have every device in an upgrading group mint a different
    /// one at once — survivable (see the race note above) but it would fragment
    /// the first day of history across N keys for no reason. Lowest-id is an
    /// election that needs no coordination, from a list every device already
    /// fetches.
    ///
    /// If that device never comes online the group simply has no history yet, and
    /// the election moves to the next id the moment it leaves the group.
    ///
    /// Consoles are left out of the vote: a console never mints, so a console
    /// holding the lowest id would leave the group with no key at all.
    public static func shouldMintFirstKey(
        ring: [GroupKeyRecord], endpoints: [Endpoint], selfEndpointId: String
    ) -> Bool {
        guard ring.isEmpty else { return false }
        guard endpoints.contains(where: { $0.id == selfEndpointId }) else { return false }
        return endpoints
            .filter { $0.kind != "console" }
            .allSatisfy { selfEndpointId <= $0.id }
    }

    /// One copy of the current key that still needs handing to a group member.
    public struct PendingDelivery: Sendable, Equatable, Identifiable {
        /// Deterministic, so a replay dedupes server-side instead of piling up rows.
        public var id: String
        public var targetEndpointId: String
        public var targetPubkey: String
    }

    /// Which group members still need the current key.
    ///
    /// Excludes this device, consoles included on purpose (a console reads history
    /// like anything else — it is excluded from CHOOSERS, not from the group), and
    /// anything already delivered. `delivered` is a local record of
    /// `keyId:endpointId` pairs, which is enough because both halves are stable: a
    /// device that re-pairs gets a new endpoint id and so reappears here.
    public static func pendingDeliveries(
        ring: [GroupKeyRecord], endpoints: [Endpoint],
        selfEndpointId: String, delivered: [String]
    ) -> [PendingDelivery] {
        guard let key = current(ring) else { return [] }
        let done = Set(delivered)
        // Never to a device the key itself names as gone: a key minted after a departure
        // exists to keep that device out, and a relay that lists it again (or shows this
        // phone a list from before) must not get it handed over (X14).
        let gone = Set(key.departed ?? [])
        return endpoints
            .filter { $0.id != selfEndpointId && !gone.contains($0.id) }
            .map {
                PendingDelivery(
                    id: deliveryId(keyId: key.keyId, endpointId: $0.id),
                    targetEndpointId: $0.id,
                    targetPubkey: $0.e2ePubkey
                )
            }
            .filter { !done.contains($0.id) }
    }

    /// The stable id for one (key, recipient) pair.
    public static func deliveryId(keyId: String, endpointId: String) -> String {
        "gk-\(keyId)-\(endpointId)"
    }

    /// Mint a group key: 32 random bytes, fingerprinted by the same rule every
    /// client uses, dated `now`. Minting for the ring goes through `rotated`, which
    /// guarantees the new key sorts first.
    public static func generate(now: Date = Date()) -> GroupKeyRecord {
        var bytes = [UInt8](repeating: 0, count: CryptoBox.keyBytes)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        precondition(status == errSecSuccess, "SecRandomCopyBytes failed")
        let key = Base64X.encode(bytes)
        return GroupKeyRecord(
            key: key,
            keyId: Base64X.groupKeyId(ofKeyBase64: key),
            createdAt: WireDate.string(from: now)
        )
    }

    /// Mint the key that replaces the ring's current one (the first key, or a
    /// rotation after a device left). Mirrors `rotatedKey` in the canonical module:
    /// dated now, or one millisecond past the ring's newest if this clock is
    /// behind it, so the new key always sorts first. A key dated earlier would
    /// make `current` keep choosing the old one and silently un-rotate the group.
    ///
    /// `departed` is the debt it pays (`NewDevices.rotationDeparted`): it names the
    /// devices this key replaces, so a device that owes a rotation for them can tell
    /// this key from one that merely arrived later (X14). A first key names nobody.
    public static func rotated(
        ring: [GroupKeyRecord], now: Date = Date(), departed: [String] = []
    ) -> GroupKeyRecord {
        var minted = generate(now: now)
        if let newest = current(ring), newest.createdAt >= minted.createdAt {
            minted.createdAt = KeyCreatedAt.millis(newest.createdAt)
                .map { KeyCreatedAt.string(millis: $0 + 1) } ?? minted.createdAt
        }
        minted.departed = departed.isEmpty ? nil : departed
        return minted
    }

    /// The most ids a key record names, and a new-device watch tracks as owed. A key
    /// copy has to fit the relay's 4096-byte envelope cap, and a relay that makes ids
    /// appear and disappear must not be able to grow the record until the cap refuses
    /// the copy. The mirror of `MAX_DEPARTED` in `shared/src/keyrecord.ts`.
    public static let maxDeparted = 32
    public static let maxDepartedIdLength = 64

    /// Whether a record's `departed` field may enter the ring: absent, or at most
    /// `maxDeparted` distinct, non-empty ids of at most 64 characters. A value that
    /// is not a list of strings never gets here: decoding the record refuses it, as
    /// the other clients do. The mirror of `isAcceptableDeparted`; `KeyringTests`
    /// runs `shared/vectors/group-key-records.json`.
    ///
    /// Lengths are counted in UTF-16 units and ids compared byte for byte, as the other
    /// clients do: Swift's own `count` counts characters and its `==` treats canonically
    /// equal text as the same, which would make this phone accept or refuse differently
    /// from the others on an id the relay chose.
    public static func isAcceptableDeparted(_ departed: [String]?) -> Bool {
        guard let departed else { return true }
        guard departed.count <= maxDeparted else { return false }
        var seen = Set<[UInt8]>()
        for id in departed {
            guard !id.isEmpty, id.utf16.count <= maxDepartedIdLength,
                  seen.insert(Array(id.utf8)).inserted
            else { return false }
        }
        return true
    }

    /// The `departed` list a receiver may rely on: the record's, minus the device that
    /// sent the copy. A device cannot vouch that IT has left. Without this a device
    /// about to be removed could mint a key naming itself, and a relay that held the
    /// copies back until after the removal would let everyone stand down on a key that
    /// device holds (X14). Nil for a record that names nobody.
    public static func vouchedDeparted(_ departed: [String]?, sender: String) -> [String]? {
        let named = (departed ?? []).filter { $0 != sender }
        return named.isEmpty ? nil : named
    }

    /// Is `record` safe to fold into the ring? Its `createdAt` must pass
    /// `KeyCreatedAt.isAcceptable`, its `departed` list `isAcceptableDeparted`, its
    /// key must be exactly 32 bytes, and its
    /// `keyId` must fingerprint that key. A mismatched id would make two devices
    /// disagree about which key is which; a crafted date would stay "current"
    /// past every rotation.
    public static func isAcceptable(_ record: GroupKeyRecord, nowMs: Int64) -> Bool {
        KeyCreatedAt.isAcceptable(record.createdAt, nowMs: nowMs)
            && isAcceptableDeparted(record.departed)
            && Base64X.decode(record.key)?.count == CryptoBox.keyBytes
            && record.keyId == Base64X.groupKeyId(ofKeyBase64: record.key)
    }
}

/// What a group-key record's `createdAt` must look like before this phone accepts
/// it (ADR-0028 §6, amended 2026-10-13). A mirror of `isAcceptableKeyCreatedAt` in
/// `shared/src/keyrecord.ts`, where the reasons are written down; `KeyringTests`
/// runs `shared/vectors/group-key-records.json`, the same cases the extension and
/// Android run.
///
/// The ring picks the current key by comparing `createdAt` AS TEXT, so the text
/// has to be one exact shape. Accepted: exactly `YYYY-MM-DDTHH:mm:ss.sssZ`, a real
/// instant, and no more than a day ahead of this phone's clock.
///
/// Worked out in whole milliseconds by hand rather than with a date formatter:
/// `ISO8601DateFormatter` goes through a floating-point `Date` and can round a
/// millisecond away, which would refuse a good key or date a rotation onto the
/// key it replaces.
public enum KeyCreatedAt {
    public static let maxAheadMs: Int64 = 24 * 60 * 60 * 1000

    public static func isAcceptable(_ createdAt: String, nowMs: Int64) -> Bool {
        guard let at = millis(createdAt) else { return false }
        return at <= nowMs + maxAheadMs
    }

    /// Milliseconds since 1970 for a canonical `YYYY-MM-DDTHH:mm:ss.sssZ` naming a
    /// real instant, nil for anything else ("2026-02-30…" included).
    static func millis(_ text: String) -> Int64? {
        let chars = Array(text.utf8)
        guard chars.count == 24 else { return nil }
        let shape = Array("dddd-dd-ddTdd:dd:dd.dddZ".utf8)
        for (c, s) in zip(chars, shape) {
            if s == UInt8(ascii: "d") {
                guard c >= UInt8(ascii: "0"), c <= UInt8(ascii: "9") else { return nil }
            } else if c != s {
                return nil
            }
        }
        func number(_ from: Int, _ count: Int) -> Int64 {
            chars[from..<from + count].reduce(0) { $0 * 10 + Int64($1 - UInt8(ascii: "0")) }
        }
        let year = number(0, 4), month = number(5, 2), day = number(8, 2)
        let hour = number(11, 2), minute = number(14, 2), second = number(17, 2)
        let ms = number(20, 3)
        guard (1...12).contains(month), day >= 1, day <= daysIn(month: month, year: year),
              hour <= 23, minute <= 59, second <= 59
        else { return nil }
        let days = daysFromCivil(year: year, month: month, day: day)
        return ((days * 24 + hour) * 60 + minute) * 60_000 + second * 1000 + ms
    }

    /// The canonical text for an instant, the inverse of `millis`. Years 0 to 9999.
    static func string(millis: Int64) -> String {
        let dayMs: Int64 = 86_400_000
        var days = millis / dayMs
        var rest = millis % dayMs
        if rest < 0 { rest += dayMs; days -= 1 }
        let (year, month, day) = civilFromDays(days)
        func pad(_ value: Int64, _ width: Int) -> String {
            let text = String(value)
            return String(repeating: "0", count: max(0, width - text.count)) + text
        }
        return "\(pad(year, 4))-\(pad(month, 2))-\(pad(day, 2))T"
            + "\(pad(rest / 3_600_000, 2)):\(pad(rest / 60_000 % 60, 2)):\(pad(rest / 1000 % 60, 2))"
            + ".\(pad(rest % 1000, 3))Z"
    }

    private static func daysIn(month: Int64, year: Int64) -> Int64 {
        switch month {
        case 2:
            let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
            return leap ? 29 : 28
        case 4, 6, 9, 11: return 30
        default: return 31
        }
    }

    // Howard Hinnant's days_from_civil / civil_from_days, proleptic Gregorian.
    private static func daysFromCivil(year: Int64, month: Int64, day: Int64) -> Int64 {
        let y = month <= 2 ? year - 1 : year
        let era = (y >= 0 ? y : y - 399) / 400
        let yoe = y - era * 400
        let doy = (153 * (month + (month > 2 ? -3 : 9)) + 2) / 5 + day - 1
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
        return era * 146_097 + doe - 719_468
    }

    private static func civilFromDays(_ days: Int64) -> (Int64, Int64, Int64) {
        let z = days + 719_468
        let era = (z >= 0 ? z : z - 146_096) / 146_097
        let doe = z - era * 146_097
        let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100)
        let mp = (5 * doy + 2) / 153
        let day = doy - (153 * mp + 2) / 5 + 1
        let month = mp < 10 ? mp + 3 : mp - 9
        return (yoe + era * 400 + (month <= 2 ? 1 : 0), month, day)
    }
}
