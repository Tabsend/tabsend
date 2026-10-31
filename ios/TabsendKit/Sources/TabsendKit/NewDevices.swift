import Foundation

/// The "new device joined" notice (PLANS.md P-10), iOS half.
///
/// A line-for-line mirror of `shared/src/newdevices.ts` (`watchDevices`,
/// `confirmNewDevice`, `listIncludesSelf`, `endpointsKnownTo`, `heldTabChoices`,
/// `rotationDue`, `rotationDone`, `vouchTag`, `vouchTags`, `withVouch`, `parseVouch`,
/// `announcesNewDevices`, `settleNotices`).
/// The rule and its reasons are written down there;
/// the short version is that each client remembers the device ids in the last list it fetched
/// and compares every new fetch against them. It never trusts the relay's
/// `endpoint_added` event, because a compromised relay would simply not send it.
///
/// Two further rules, both from the 2026-10-13 verification pass: a removal this
/// phone made is recorded at once (`removeDevice`, X13), because "Remove it" is only a
/// request and a relay can answer it and keep listing the device; and the rotation a
/// departure owes is owed FOR named devices (`rotateFor`), so a key that merely arrived
/// later does not pay it (`rotationDue`, X14).
///
/// The pairing link vouches for the first list (P-23): the device that shows a link
/// appends a short tag of each device it has accepted (`vouchTags`, `withVouch`), and
/// a device in the joiner's first list under a vouched key is not put on the first
/// look (`parseVouch`, the `vouched` argument of `watch`). The link goes from the
/// user's hand to the new device, so the relay cannot add to it.
///
/// A device that joined is told once, as information (P-23; owner, 2026-10-30): the
/// phone posts one notification and stores the record settled (`settleNotices`), so
/// nothing waits for an answer and no row is marked. A phone always tells
/// (`announcesNewDevices`); the rule says when a browser does too.
///
/// `NewDevicesTests` runs every case in `shared/vectors/new-devices.json`, the same
/// file the extension and Android run, so the three cannot drift apart silently.

/// One device that joined since the baseline and that the user has not answered yet.
public struct NewDeviceNotice: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var label: String
    public var createdAt: String

    public init(id: String, label: String, createdAt: String) {
        self.id = id
        self.label = label
        self.createdAt = createdAt
    }
}

/// What this phone stores between fetches. Device-local; never sent anywhere.
public struct NewDeviceWatch: Codable, Sendable, Equatable {
    /// The endpoint this record belongs to. A different one (re-pair, new relay)
    /// starts a fresh baseline.
    public var selfId: String
    /// Every device id in the last list that was accepted.
    public var known: [String]
    /// Joined since the previous list, oldest first. A record this phone stores is
    /// settled (`NewDevices.settleNotices`, P-23), so this is empty there; the rule
    /// still reads it, and a record from an earlier build may carry some.
    public var unconfirmed: [NewDeviceNotice]
    /// Each known device's published key (`e2ePubkey`), by id. Optional only because
    /// records written before 2026-10-13 lack it; such a record learns the keys on
    /// its next list without announcing anything.
    public var keys: [String: String]?
    /// Set when a device left the list: the group key must be replaced. Cleared by
    /// `NewDevices.rotationDone`, which also matches on it, so a departure that
    /// arrives while a rotation is being minted is not lost.
    public var rotateOwedAt: String?
    /// The `createdAt` of the key that was current when that device left: the key
    /// to replace. Compared with a KEY, not a clock, because a key dated ahead of
    /// the clock (allowed by up to a day, `KeyCreatedAt`) would otherwise look like
    /// a rotation that already happened, and a device about to be removed could
    /// hand one out to keep the group on a key it holds. Nil when the ring was
    /// empty then: any key that turns up is replaced once.
    public var rotateFrom: String?
    /// The ids behind the owed rotation: every device that left, was removed here, or
    /// had its key swapped since the last rotation this phone settled. The key that
    /// settles the debt must name all of them (`GroupKeyRecord.departed`); the key
    /// this phone mints names exactly these. Oldest first, at most
    /// `Keyring.maxDeparted` (the newest are kept). Nil when nothing is owed.
    public var rotateFor: [String]?
    /// The devices THIS phone removed, by id, for as long as this pairing lasts. Left
    /// out of `endpointsKnownTo` whatever the relay's list says, and announced if the
    /// list shows one again. By id: an id never comes back honestly. Their keys are on
    /// `removedKeys`.
    public var removed: [String]?
    /// The published keys (`e2ePubkey`) of the devices THIS phone removed, where it knew
    /// them. A device carrying one of these under a NEW id stays out of
    /// `endpointsKnownTo` until the user answers its notice ("It's mine"): a relay
    /// can otherwise re-list a removed device under a fresh id and be handed the next key
    /// before anyone looks. Held back only until answered, because the extension keeps
    /// its device key when it re-pairs, so an honest re-paired device does come back
    /// under a new id with the same key: one tap lets it in. Since P-23 a record this
    /// phone stores keeps no notice waiting (`NewDevices.settleNotices`), so this holds
    /// only while a record an earlier build left still has one.
    public var removedKeys: [String]?
    /// The first look (GH6): the other devices in the first list this phone accepted
    /// that the pairing link did not vouch for (P-23). Told once and settled, so nil on a
    /// record this phone stores (`NewDevices.settleNotices`); the rule still reads it.
    public var review: [NewDeviceNotice]?
    /// Devices that were announced as new, never answered, and then left the list
    /// without this phone removing them (GH7). Shown until dismissed. Newest last, at
    /// most `NewDevices.maxVanished`.
    public var vanished: [NewDeviceNotice]?

    public init(
        selfId: String, known: [String], unconfirmed: [NewDeviceNotice],
        keys: [String: String]? = nil, rotateOwedAt: String? = nil, rotateFrom: String? = nil,
        rotateFor: [String]? = nil, removed: [String]? = nil, removedKeys: [String]? = nil,
        review: [NewDeviceNotice]? = nil, vanished: [NewDeviceNotice]? = nil
    ) {
        self.selfId = selfId
        self.known = known
        self.unconfirmed = unconfirmed
        self.keys = keys
        self.rotateOwedAt = rotateOwedAt
        self.rotateFrom = rotateFrom
        self.rotateFor = rotateFor
        self.removed = removed
        self.removedKeys = removedKeys
        self.review = review
        self.vanished = vanished
    }
}

public enum NewDevices {
    /// The most "joined, then disappeared" notices kept; a relay that flaps ids cannot
    /// grow the record.
    public static let maxVanished = 20

    /// The most devices a pairing link vouches for (P-23). A larger group's link
    /// vouches for the first ones; the rest are asked about.
    public static let maxVouched = 50

    /// Characters of a published key a pairing link carries per device: 96 bits, too
    /// many to grind a key for.
    public static let vouchTagLength = 16

    public struct WatchResult: Sendable, Equatable {
        /// What to store next. Nil only when there was nothing before and the list
        /// could not be used.
        public var watch: NewDeviceWatch?
        /// Devices that joined since the previous fetch: announce these once.
        public var joined: [NewDeviceNotice]
    }

    /// True when a list may be used at all: it has to contain this device.
    ///
    /// A list without it means this phone was just removed, or the relay is lying.
    /// The rule below ignores such a list, so nothing else may act on it either:
    /// not the cache, not the sender check, and above all not the key hand-out,
    /// which would otherwise seal the group key to whatever the list named with
    /// no notice at all.
    public static func listIncludesSelf(_ list: [Endpoint], selfId: String) -> Bool {
        list.contains { $0.id == selfId }
    }

    /// Compare a freshly fetched device list with what this phone saw last. Pure.
    /// When a device has left, `now` stamps `rotateOwedAt` and
    /// `currentKeyCreatedAt` (the `createdAt` of this phone's current group key, if
    /// it has one) becomes `rotateFrom`.
    ///
    /// `seed` is the device list a build from before this rule cached, if any. With no
    /// record yet it is the baseline, so a device that appeared after it was cached is
    /// announced instead of being taken on trust (GH6). It counts only if it contains
    /// this phone, so a cache left by another pairing is ignored.
    ///
    /// `vouched` is the tags the pairing link carried (`parseVouch`), if any (P-23). It
    /// is used only when this list becomes the baseline: a device in it whose key has a
    /// vouched tag is not put on the first look. Once a record exists it is never
    /// consulted again.
    public static func watch(
        prev prevRecord: NewDeviceWatch?,
        list rawList: [Endpoint],
        selfId: String,
        now: String = WireDate.string(from: Date()),
        currentKeyCreatedAt: String? = nil,
        seed: [Endpoint]? = nil,
        vouched: [String]? = nil
    ) -> WatchResult {
        // A list without this device means it was just removed, or the fetch was
        // wrong. Taking it as the baseline would make the next good fetch announce
        // every device, so it is ignored entirely.
        guard listIncludesSelf(rawList, selfId: selfId) else {
            return WatchResult(watch: prevRecord, joined: [])
        }
        // A list that names one id twice (a relay can) counts it once, so no card or banner is doubled.
        let list = firstById(rawList)
        let prev: NewDeviceWatch
        if let record = prevRecord, record.selfId == selfId {
            prev = record
        } else if let seed, listIncludesSelf(seed, selfId: selfId) {
            prev = baseline(seed, selfId: selfId)
        } else {
            return WatchResult(watch: baseline(list, selfId: selfId, vouched: vouched), joined: [])
        }

        let known = Set(prev.known)
        var byId: [String: Endpoint] = [:]
        for endpoint in list where byId[endpoint.id] == nil { byId[endpoint.id] = endpoint }

        // A known id whose published key changed is a different device wearing an
        // old name: an honest relay has no route that changes an endpoint's key.
        // A record without `keys` (written before they were kept) learns them
        // here without announcing anything.
        let prevKeys = prev.keys
        func rekeyed(_ endpoint: Endpoint) -> Bool {
            guard let old = prevKeys?[endpoint.id] else { return false }
            return old != endpoint.e2ePubkey
        }
        let joined = list
            .filter { $0.id != selfId && (!known.contains($0.id) || rekeyed($0)) }
            .map { NewDeviceNotice(id: $0.id, label: $0.label, createdAt: $0.createdAt) }
        let joinedIds = Set(joined.map(\.id))

        func refreshed(_ notice: NewDeviceNotice) -> NewDeviceNotice {
            var renamed = notice
            renamed.label = byId[notice.id]?.label ?? notice.label
            return renamed
        }
        let unconfirmed = prev.unconfirmed
            .filter { byId[$0.id] != nil && !joinedIds.contains($0.id) }
            .map(refreshed)
            + joined
        let removedIds = Set(prev.removed ?? [])
        let review = (prev.review ?? [])
            .filter { byId[$0.id] != nil && !joinedIds.contains($0.id) }
            .map(refreshed)
        // Shown to the user and never answered (a pending banner, or a device on the first-look
        // card), then gone without this phone removing it: the relay may be hiding it (GH7).
        // That holds for a device on the card too: it was shown once and cannot be allowed to
        // drop off without a trace. One that is back is a pending notice again, not both. One
        // whose key is still on screen as another unanswered device (a browser that re-paired:
        // new id, same key, old id deleted) is not hidden, only renamed, and is not reported.
        let onScreenKeys = Set((unconfirmed + review).compactMap { byId[$0.id]?.e2ePubkey })
        let goneNotices = (prev.unconfirmed + (prev.review ?? [])).filter { notice in
            guard byId[notice.id] == nil, !removedIds.contains(notice.id) else { return false }
            guard let key = prevKeys?[notice.id] else { return true }
            return !onScreenKeys.contains(key)
        }
        let vanished = Array(
            ((prev.vanished ?? []).filter { !joinedIds.contains($0.id) } + goneNotices)
                .suffix(maxVanished)
        )

        // Whatever left may hold the current group key, so the next device able to
        // mint replaces it (ADR-0028 §7). Removal and a device the relay showed
        // once and then hid are the same event here, which is the point.
        // A changed key counts as leaving too: whoever held the old key may hold
        // the group key, and a key swapped in and back out must not keep it.
        // A device this phone removed owes nothing when it leaves again: it was left out of
        // key handoff the whole time it was listed, and its removal already owed (and
        // settled, or still owes) the rotation.
        let departed = (prev.known.filter { $0 != selfId && byId[$0] == nil }
            + list.filter { $0.id != selfId && known.contains($0.id) && rekeyed($0) }.map(\.id))
            .filter { !removedIds.contains($0) }
        let left = !departed.isEmpty
        return WatchResult(
            watch: NewDeviceWatch(
                selfId: selfId, known: list.map(\.id), unconfirmed: unconfirmed,
                keys: keys(of: list),
                rotateOwedAt: left ? now : prev.rotateOwedAt,
                rotateFrom: left ? currentKeyCreatedAt : prev.rotateFrom,
                rotateFor: left
                    ? owedIds(prev.rotateFor, departed, removed: prev.removed ?? [])
                    : prev.rotateFor,
                removed: prev.removed,
                removedKeys: prev.removedKeys,
                review: review.isEmpty ? nil : review,
                vanished: vanished.isEmpty ? nil : vanished
            ),
            joined: joined
        )
    }

    /// This phone removed `id` and the relay accepted the request. Record it NOW, in
    /// the watch, rather than waiting for a list to confirm it: the relay is the one
    /// party that can say the removal did not happen, and a relay that answers the
    /// DELETE and keeps listing the device would otherwise cost the attacker nothing.
    /// The device leaves `known`, `keys` and the pending notices, goes on `removed`,
    /// and a rotation is owed at once against the key current now, named for it. If
    /// the relay then keeps listing it, the next list announces it as new and
    /// `endpointsKnownTo` still leaves it out. Pure. A phone never removes itself
    /// here (Unpair is the way out).
    public static func removeDevice(
        _ watch: NewDeviceWatch, id: String,
        now: String = WireDate.string(from: Date()), currentKeyCreatedAt: String? = nil
    ) -> NewDeviceWatch {
        guard id != watch.selfId else { return watch }
        var next = watch
        next.known = watch.known.filter { $0 != id }
        next.unconfirmed = watch.unconfirmed.filter { $0.id != id }
        next.vanished = watch.vanished?.filter { $0.id != id }
        if next.vanished?.isEmpty == true { next.vanished = nil }
        next.review = watch.review?.filter { $0.id != id }
        if next.review?.isEmpty == true { next.review = nil }
        next.keys = watch.keys?.filter { $0.key != id }
        if !(watch.removed ?? []).contains(id) { next.removed = (watch.removed ?? []) + [id] }
        if let key = watch.keys?[id], !(watch.removedKeys ?? []).contains(key) {
            next.removedKeys = (watch.removedKeys ?? []) + [key]
        }
        next.rotateOwedAt = now
        next.rotateFrom = currentKeyCreatedAt
        next.rotateFor = owedIds(watch.rotateFor, [id], removed: next.removed ?? [])
        return next
    }

    /// The owed ids after adding `more`: unique, oldest first, at most `Keyring.maxDeparted`.
    /// An id a key record could not carry (empty, or over `Keyring.maxDepartedIdLength`
    /// UTF-16 units) is not owed: the relay mints UUIDs, and a record naming such an id
    /// would be refused by every other client, leaving this phone writing under a key
    /// nobody shares. Over the cap the oldest ids go first, but never one the user removed
    /// while another can go instead, so a flood of invented ids cannot push a real removal
    /// out. Ids are compared byte for byte, as on the other clients.
    private static func owedIds(
        _ prev: [String]?, _ more: [String], removed: [String] = []
    ) -> [String] {
        func bytes(_ id: String) -> [UInt8] { Array(id.utf8) }
        var seen = Set<[UInt8]>()
        let add = more.filter {
            !$0.isEmpty && $0.utf16.count <= Keyring.maxDepartedIdLength && seen.insert(bytes($0)).inserted
        }
        let all = (prev ?? []).filter { !seen.contains(bytes($0)) } + add
        var excess = all.count - Keyring.maxDeparted
        if excess <= 0 { return all }
        let removedBytes = Set(removed.map(bytes))
        let kept = all.filter { id in
            if excess > 0 && !removedBytes.contains(bytes(id)) {
                excess -= 1
                return false
            }
            return true
        }
        return Array(kept.suffix(Keyring.maxDeparted))
    }

    /// The ids a key minted for this debt names: sorted, so every client writes the
    /// same record.
    public static func rotationDeparted(_ watch: NewDeviceWatch?) -> [String] {
        (watch?.rotateFor ?? []).sorted()
    }

    /// The whole first look answered at once, on this phone only. No screen offers it since
    /// P-23 (the first look is told once and settled, `settleNotices`); kept because the
    /// shared vectors run it on every client.
    public static func confirmReview(_ watch: NewDeviceWatch) -> NewDeviceWatch {
        var next = watch
        next.review = nil
        return next
    }

    /// Dismiss one "joined, then disappeared" notice on this phone.
    public static func dismissVanished(_ watch: NewDeviceWatch, id: String) -> NewDeviceWatch {
        var next = watch
        let left = (watch.vanished ?? []).filter { $0.id != id }
        next.vanished = left.isEmpty ? nil : left
        return next
    }

    /// One device answered: drop its pending notice, or its place on the first look. No
    /// screen offers it since P-23 (notices are told once and settled, `settleNotices`);
    /// kept because the shared vectors run it on every client. The rest of the first look
    /// stays.
    public static func confirm(_ watch: NewDeviceWatch, id: String) -> NewDeviceWatch {
        var next = watch
        next.unconfirmed = watch.unconfirmed.filter { $0.id != id }
        let review = watch.review?.filter { $0.id != id }
        next.review = review?.isEmpty == false ? review : nil
        return next
    }

    /// The devices in `list` this watch has accepted: id in `known`, with the same
    /// published key it recorded, never one this phone removed, and not one that carries
    /// the key of a device this phone removed until its notice is answered. The key sync
    /// hands keys only to these and trusts key copies only from these, so a list read
    /// before the watch moved on (a removed device still in it), or a relay that
    /// keeps a removed device listed, cannot carry a new key to the device that was
    /// removed. No watch trusts nobody; a record from before keys were kept trusts by id.
    public static func endpointsKnownTo(_ watch: NewDeviceWatch?, _ list: [Endpoint]) -> [Endpoint] {
        guard let watch else { return [] }
        let known = Set(watch.known)
        let removed = Set(watch.removed ?? [])
        let heldKeys = Set(watch.removedKeys ?? [])
        let unanswered = Set(watch.unconfirmed.map(\.id))
        return list.filter { endpoint in
            known.contains(endpoint.id)
                && !removed.contains(endpoint.id)
                && !(unanswered.contains(endpoint.id) && heldKeys.contains(endpoint.e2ePubkey))
                && (watch.keys == nil || watch.keys?[endpoint.id] == endpoint.e2ePubkey)
        }
    }

    /// The devices a held tab whose device is gone may be moved to (P-15 item 3,
    /// SECURITY_REVIEW L3): those this watch has accepted (`endpointsKnownTo`, so
    /// never one this phone removed), never this phone or a console, and none the
    /// user has not answered yet, a pending "new device" notice or the first-look
    /// card. The relay decides when a held tab asks for a new device, so it must not
    /// also decide what is offered. The device the tab was for is not left out: once
    /// accepted again it is a fair choice. In list order; the screen sorts. A watch
    /// that belongs to another pairing offers nothing.
    public static func heldTabChoices(
        _ watch: NewDeviceWatch?, _ list: [Endpoint], selfId: String
    ) -> [Endpoint] {
        guard let watch, watch.selfId == selfId else { return [] }
        let unanswered = Set((watch.unconfirmed + (watch.review ?? [])).map(\.id))
        return endpointsKnownTo(watch, list).filter {
            $0.id != selfId && $0.kind != "console" && !unanswered.contains($0.id)
        }
    }

    /// Should this phone replace the group key now? Only when a rotation is owed and
    /// the ring's newest key does not already pay it. It pays it when it is newer than
    /// the key that was current when the device left (`rotateFrom`) AND names every
    /// device owed for (`rotateFor`, against the key's `departed`). A key that is
    /// merely newer proves nothing: it may have been minted before the departure by
    /// the departed device itself, and held back by the relay until now (X14). A key
    /// that names the debt was minted after the departure by a device that knew of it,
    /// and was never sealed to the departed device. The caller clears the debt
    /// (`rotationDone`) either way once its ring holds a key: minted here, or found.
    /// Canonical ISO strings, compared as text like the keyring compares them. A debt
    /// with no ids is paid by any newer key.
    public static func rotationDue(
        _ watch: NewDeviceWatch?, newestKeyCreatedAt: String?, newestKeyDeparted: [String]? = nil
    ) -> Bool {
        guard let watch, watch.rotateOwedAt != nil, let newest = newestKeyCreatedAt else { return false }
        guard let from = watch.rotateFrom else { return true }
        if newest <= from { return true }
        let named = Set(newestKeyDeparted ?? [])
        return !(watch.rotateFor ?? []).allSatisfy { named.contains($0) }
    }

    /// Clear an owed rotation and the key it was against, but only the one that
    /// was read: a device that left while the rotation was being minted owes another.
    public static func rotationDone(_ watch: NewDeviceWatch, owedAt: String) -> NewDeviceWatch {
        guard watch.rotateOwedAt == owedAt else { return watch }
        var next = watch
        next.rotateOwedAt = nil
        next.rotateFrom = nil
        next.rotateFor = nil
        return next
    }

    /// A phone not seen for this long no longer counts as the one that tells the user
    /// (P-23). Milliseconds, as `now` is given to `announcesNewDevices`.
    public static let announcerStaleMs: Double = 30 * 24 * 60 * 60 * 1000

    /// Should THIS device tell the user that a device joined (P-23; owner, 2026-10-30:
    /// "show that warning once", information only)? A phone always does. A browser does
    /// only when the group has no phone this device had accepted before this list and has
    /// seen in the last 30 days, so a user without a phone still hears, and one with a
    /// phone hears it once. A console never does: it has no notifications.
    ///
    /// Only a phone from the record BEFORE this list counts (`prev`): a phone that arrives
    /// in the same list as the newcomer, or is the newcomer, silences nobody, so a relay
    /// cannot hush the browsers by adding a phone along with its device. A `lastSeenAt`
    /// that cannot be read counts as not seen. `now` is epoch milliseconds. Pure.
    public static func announcesNewDevices(
        _ prev: NewDeviceWatch?, _ list: [Endpoint], selfId: String, now: Double
    ) -> Bool {
        guard let me = list.first(where: { $0.id == selfId }) else { return false }
        if me.kind == "mobile" { return true }
        guard me.kind == "extension" else { return false }
        let before = prev?.selfId == selfId ? prev : nil
        return !endpointsKnownTo(before, firstById(list)).contains { endpoint in
            guard endpoint.id != selfId, endpoint.kind == "mobile",
                  let seen = WireDate.date(from: endpoint.lastSeenAt)
            else { return false }
            return now - seen.timeIntervalSince1970 * 1000 <= announcerStaleMs
        }
    }

    /// The notices, once told (P-23): a joined device is reported once, as information,
    /// and nothing waits for an answer, so nothing is kept on the first look (`review`) or
    /// pending (`unconfirmed`), with one exception: a device carrying the published key of
    /// a device THIS phone removed stays pending, so `endpointsKnownTo` keeps it out of key
    /// handoff. A relay could otherwise list a removed device again under a fresh id and
    /// have it handed the next key a moment after one notification. Everything else in
    /// the record stays. Pure.
    public static func settleNotices(_ watch: NewDeviceWatch) -> NewDeviceWatch {
        let held = Set(watch.removedKeys ?? [])
        var next = watch
        next.unconfirmed = watch.unconfirmed.filter { notice in
            guard let key = watch.keys?[notice.id] else { return false }
            return held.contains(key)
        }
        next.review = nil
        return next
    }

    /// A device's tag in a pairing link (P-23): the first `vouchTagLength` characters of
    /// its published key, in the URL-safe alphabet so the link needs no escaping. A
    /// published key is base64, so a character here is a UTF-16 unit in TypeScript.
    public static func vouchTag(_ e2ePubkey: String) -> String {
        String(e2ePubkey.prefix(vouchTagLength))
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    /// The tags a pairing link this phone shows vouches for (P-23): every device it has
    /// accepted (`endpointsKnownTo`, this phone included), never one it has not answered
    /// yet, a pending notice or one on its own first look. Unique, in list order, at
    /// most `maxVouched`. Empty when the watch belongs to another pairing or the list is
    /// not one this phone may use; the link then vouches for nothing.
    public static func vouchTags(
        _ watch: NewDeviceWatch?, _ list: [Endpoint], selfId: String
    ) -> [String] {
        guard let watch, watch.selfId == selfId, listIncludesSelf(list, selfId: selfId) else { return [] }
        let unanswered = Set((watch.unconfirmed + (watch.review ?? [])).map(\.id))
        var seen = Set<String>()
        let tags = endpointsKnownTo(watch, firstById(list))
            .filter { !unanswered.contains($0.id) }
            .map { vouchTag($0.e2ePubkey) }
            .filter { $0.count == vouchTagLength && seen.insert($0).inserted }
        return Array(tags.prefix(maxVouched))
    }

    /// A pairing link with the tags appended to its fragment as `&v=tag.tag` (P-23).
    /// Unchanged when there are none.
    public static func withVouch(_ link: String, _ tags: [String]) -> String {
        // The relay makes the base link, so any `v` already in its fragment goes first,
        // tags or not: only this device may vouch (v0.9.0 review, finding 1).
        guard let hash = link.firstIndex(of: "#") else { return link }
        let kept = link[link.index(after: hash)...]
            .split(separator: "&", omittingEmptySubsequences: false)
            .filter { !$0.hasPrefix("v=") }
        let base = String(link[...hash]) + kept.joined(separator: "&")
        return tags.isEmpty ? base : "\(base)&v=\(tags.joined(separator: "."))"
    }

    /// The tags a pairing link carries (P-23), or nil when it carries none (a link from
    /// an older client, or one whose `v` held nothing usable). A tag that is not exactly
    /// `vouchTagLength` URL-safe characters is dropped: a shorter one would match more keys.
    public static func parseVouch(_ link: String) -> [String]? {
        guard let hash = link.firstIndex(of: "#") else { return nil }
        // More than one `v` means something other than the showing device wrote one.
        let params = link[link.index(after: hash)...]
            .split(separator: "&", omittingEmptySubsequences: false)
            .filter { $0.hasPrefix("v=") }
        guard params.count == 1, let param = params.first else { return nil }
        var seen = Set<String>()
        let tags = param.dropFirst(2)
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .split(separator: ".", omittingEmptySubsequences: false)
            .map(String.init)
            .filter { seen.insert($0).inserted && isVouchTag($0) }
        let capped = Array(tags.prefix(maxVouched))
        return capped.isEmpty ? nil : capped
    }

    /// `^[A-Za-z0-9_-]{vouchTagLength}$`, without a regex.
    private static func isVouchTag(_ tag: String) -> Bool {
        tag.utf8.count == vouchTagLength && tag.utf8.allSatisfy { byte in
            switch byte {
            case UInt8(ascii: "0")...UInt8(ascii: "9"), UInt8(ascii: "A")...UInt8(ascii: "Z"),
                 UInt8(ascii: "a")...UInt8(ascii: "z"), UInt8(ascii: "-"), UInt8(ascii: "_"):
                return true
            default:
                return false
            }
        }
    }

    /// The list with each id once, in order of first appearance.
    private static func firstById(_ list: [Endpoint]) -> [Endpoint] {
        var seen = Set<String>()
        return list.filter { seen.insert($0.id).inserted }
    }

    private static func baseline(
        _ raw: [Endpoint], selfId: String, vouched: [String]? = nil
    ) -> NewDeviceWatch {
        let list = firstById(raw)
        let vouchedTags = Set(vouched ?? [])
        // The first look: asked once, when anyone the pairing link did not vouch for is there (P-23).
        let others = list.filter { $0.id != selfId && !vouchedTags.contains(vouchTag($0.e2ePubkey)) }
            .map { NewDeviceNotice(id: $0.id, label: $0.label, createdAt: $0.createdAt) }
        return NewDeviceWatch(
            selfId: selfId, known: list.map(\.id), unconfirmed: [], keys: keys(of: list),
            review: others.isEmpty ? nil : others
        )
    }

    private static func keys(of list: [Endpoint]) -> [String: String] {
        var keys: [String: String] = [:]
        for endpoint in list { keys[endpoint.id] = endpoint.e2ePubkey }
        return keys
    }

    // MARK: store helpers

    /// What to tell the user about new devices, once, as information (P-23).
    public struct Announcement: Sendable, Equatable {
        public enum Kind: Sendable, Equatable {
            /// Joined since the previous list.
            case joined
            /// Already in the group on a fresh pairing, and the pairing link did not
            /// vouch for them (the first look).
            case firstList
        }
        public var kind: Kind
        /// Never empty.
        public var devices: [NewDeviceNotice]

        public init(kind: Kind, devices: [NewDeviceNotice]) {
            self.kind = kind
            self.devices = devices
        }
    }

    /// What `observe` made of a fetched list.
    public struct Observation: Sendable, Equatable {
        /// The list, when the rule accepted it. Nil means "treat the fetch as
        /// failed": the list did not contain this phone (or it is not registered),
        /// so nothing may be cached, trusted or handed a key from it.
        public var accepted: [Endpoint]?
        /// Devices that joined since the previous fetch.
        public var joined: [NewDeviceNotice] = []
        /// The one notification to post (P-23), or nil when there is nothing to tell or
        /// this device is not the one that tells (`announcesNewDevices`).
        public var announcement: Announcement?
    }

    /// Run the rule on a list just fetched from the relay, save the result, and
    /// only then cache the list. Every device-list fetch in the app goes through
    /// here, and callers act on `accepted`, never on the raw fetch.
    ///
    /// The order is the fix for a relay that serves a list without this phone
    /// (a fake device plus the others): the rule ignores such a list, so it was
    /// never noticed, yet it used to be cached first and the key sync then sealed
    /// the group key to the fake device. Now a list the rule ignores goes nowhere.
    ///
    /// Read-modify-write under the store's lock, so two fetches landing together
    /// (the drain and the foreground refresh do) cannot both announce the same
    /// device.
    ///
    /// The tags the pairing link carried (`Registration.vouched`, P-23) go to the call
    /// that creates this pairing's record, and are cleared once that record is stored:
    /// the rule never consults them again.
    ///
    /// Told once, as information (P-23): the record is stored settled (`settleNotices`),
    /// so nothing waits for an answer. What to tell is the devices that joined, or, when
    /// this pairing had no record before, the ones on its first look; whether this phone
    /// tells is `announcesNewDevices`, against the record as it was before this list.
    @discardableResult
    public static func observe(
        _ list: [Endpoint], store: TabsendStore, now: Date = Date()
    ) -> Observation {
        guard let reg = store.registration,
              listIncludesSelf(list, selfId: reg.endpointId)
        else { return Observation(accepted: nil) }
        let selfId = reg.endpointId
        var joined: [NewDeviceNotice] = []
        var firstList: [NewDeviceNotice] = []
        // This pairing's record as it was before this list: what `announcesNewDevices` reads.
        var before: NewDeviceWatch?
        let stamp = WireDate.string(from: now)
        // The key a departure in this list leaves to be replaced.
        let currentKey = Keyring.current(store.groupKeyring)?.createdAt
        // With no record yet, the list a build from before this rule cached is the
        // baseline (GH6). Read here, before the cache is overwritten below and outside the
        // store's lock (reading it inside the update would wait on that lock for ever).
        let cached = store.cachedEndpoints
        store.updateNewDeviceWatch { prev in
            let mine = prev?.selfId == selfId ? prev : nil
            before = mine
            let seed = prev == nil ? cached : nil
            // Only a call that creates the record gets the link's tags (P-23).
            let vouched = mine == nil ? reg.vouched : nil
            let result = watch(
                prev: prev, list: list, selfId: selfId, now: stamp, currentKeyCreatedAt: currentKey,
                seed: seed, vouched: vouched
            )
            joined = result.joined
            // On a fresh pairing, the devices the link did not vouch for are told too.
            firstList = mine == nil ? (result.watch?.review ?? []) : []
            // Told once and nothing kept waiting for an answer (P-23).
            return result.watch.map { settleNotices($0) }
        }
        // The record for this pairing is stored now, so the tags have done their one job.
        // Read again rather than writing `reg` back, so a write made since is kept. A stale
        // copy written back later can restore them; the rule ignores them then, and the
        // next list clears them again.
        if reg.vouched != nil, var current = store.registration,
           current.endpointId == selfId, current.vouched != nil {
            current.vouched = nil
            store.registration = current
        }
        store.cachedEndpoints = list
        var announcement: Announcement?
        if announcesNewDevices(before, list, selfId: selfId, now: now.timeIntervalSince1970 * 1000) {
            if !joined.isEmpty {
                announcement = Announcement(kind: .joined, devices: joined)
            } else if !firstList.isEmpty {
                announcement = Announcement(kind: .firstList, devices: firstList)
            }
        }
        return Observation(accepted: list, joined: joined, announcement: announcement)
    }

    /// Mark the owed rotation that was read as done, through the store's
    /// read-modify-write rather than a blind overwrite, so a departure recorded
    /// by a fetch in the meantime is kept.
    public static func markRotationDone(owedAt: String, store: TabsendStore) {
        store.updateNewDeviceWatch { prev in prev.map { rotationDone($0, owedAt: owedAt) } }
    }

    /// This phone's record, or nil when it belongs to an earlier pairing.
    public static func current(store: TabsendStore) -> NewDeviceWatch? {
        guard let watch = store.newDeviceWatch,
              watch.selfId == store.registration?.endpointId
        else { return nil }
        return watch
    }

    /// Remove another device from the group, then write the removal into the watch
    /// (X13). A relay that answers "not found" means the device is already gone,
    /// which is what was asked for, so that counts as done. Any other failure throws
    /// and records nothing: the device may still be in the group.
    public static func removeFromGroup(
        id: String, api: ApiClient, store: TabsendStore, now: Date = Date()
    ) async throws {
        do {
            try await api.removeEndpoint(id: id)
        } catch let error as ApiError where error.status == 404 || error.code == "not_found" {
            // Already gone.
        }
        recordRemoval(id: id, store: store, now: now)
    }

    /// A device this phone removed and the relay accepted (X13): written into the
    /// watch now, rather than left to the relay's next list. Through the store's
    /// read-modify-write so a fetch landing at the same time cannot undo it. A record
    /// from another pairing is not this phone's to change.
    public static func recordRemoval(
        id: String, store: TabsendStore, now: Date = Date()
    ) {
        let stamp = WireDate.string(from: now)
        let currentKey = Keyring.current(store.groupKeyring)?.createdAt
        let selfId = store.registration?.endpointId
        store.updateNewDeviceWatch { prev in
            guard let prev, prev.selfId == selfId else { return prev }
            return removeDevice(prev, id: id, now: stamp, currentKeyCreatedAt: currentKey)
        }
    }

    /// Announced as new, never answered, then gone from the list (GH7).
    public static func vanished(store: TabsendStore) -> [NewDeviceNotice] {
        current(store: store)?.vanished ?? []
    }

    /// Dismiss one "joined, then disappeared" notice on this phone.
    public static func dismissVanished(id: String, store: TabsendStore) {
        store.updateNewDeviceWatch { prev in prev.map { dismissVanished($0, id: id) } }
    }

    // MARK: copy (PLANS.md P-10 "The copy", word for word)

    /// `{when}`: the same relative time the rest of the app uses ("just now",
    /// "3m ago"), so "Joined 3m ago" reads naturally. A date that cannot be read
    /// says "recently" rather than "unknown".
    public static func when(_ createdAt: String, now: Date = Date()) -> String {
        let text = Inbox.relativeTime(createdAt, now: now)
        return text == "unknown" ? "recently" : text
    }

    // The one notification, information only (P-23): the same words on every client.

    public static func alertTitle(_ announcement: Announcement) -> String {
        let devices = announcement.devices
        switch announcement.kind {
        case .joined:
            if devices.count == 1 { return "\(devices[0].label) was added" }
            return "\(devices.count) devices were added"
        case .firstList:
            if devices.count == 1 { return "\(devices[0].label) is in your group" }
            return "\(devices.count) devices are in your group"
        }
    }

    public static func alertBody(_ announcement: Announcement, now: Date = Date()) -> String {
        let devices = announcement.devices
        switch announcement.kind {
        case .joined:
            if devices.count == 1 {
                // A time that cannot be read is left out rather than guessed.
                guard WireDate.date(from: devices[0].createdAt) != nil else {
                    return "It joined your Tabsend devices. If that wasn't you, remove it in Tabsend."
                }
                return "It joined your Tabsend devices \(Inbox.relativeTime(devices[0].createdAt, now: now)). If that wasn't you, remove it in Tabsend."
            }
            return "\(listLabels(devices.map(\.label))) joined your Tabsend devices. If any wasn't you, remove it in Tabsend."
        case .firstList:
            if devices.count == 1 {
                return "The device you paired with didn't list it. If it isn't yours, remove it in Tabsend."
            }
            return "\(listLabels(devices.map(\.label))). The device you paired with didn't list them. If any isn't yours, remove it in Tabsend."
        }
    }

    // The vanished notice: the same words on every client.
    public static let vanishedDismiss = "Dismiss"

    public static func vanishedTitle(_ notice: NewDeviceNotice) -> String {
        "\(notice.label) joined, then disappeared"
    }

    public static func vanishedBody(_ notice: NewDeviceNotice, now: Date = Date()) -> String {
        "It joined \(when(notice.createdAt, now: now)) and is no longer in your list. Your relay may be hiding it. It could have read the links sent while it was listed. If you removed it yourself, you can dismiss this."
    }

    /// "A", "A and B", "A, B and C".
    static func listLabels(_ labels: [String]) -> String {
        guard let last = labels.last else { return "" }
        if labels.count == 1 { return last }
        return labels.dropLast().joined(separator: ", ") + " and " + last
    }
}
