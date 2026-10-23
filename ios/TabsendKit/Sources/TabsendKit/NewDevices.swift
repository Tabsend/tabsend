import Foundation

/// The "new device joined" notice (PLANS.md P-10), iOS half.
///
/// A line-for-line mirror of `shared/src/newdevices.ts` (`watchDevices`,
/// `confirmNewDevice`, `listIncludesSelf`, `endpointsKnownTo`, `heldTabChoices`,
/// `rotationDue`, `rotationDone`). The rule and its reasons are written down there;
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
    /// Joined since the baseline, not yet answered with "Yes, it's mine" or removed.
    /// Oldest first.
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
    /// `endpointsKnownTo` until the user answers its notice ("Yes, it's mine"): a relay
    /// can otherwise re-list a removed device under a fresh id and be handed the next key
    /// before anyone looks. Held back only until answered, because the extension keeps
    /// its device key when it re-pairs, so an honest re-paired device does come back
    /// under a new id with the same key: one tap lets it in.
    public var removedKeys: [String]?
    /// The first look (GH6): the other devices in the first list this phone accepted,
    /// waiting for ONE answer ("All of these are mine") or for each to be removed. Nil
    /// once answered, and on a record written before this existed.
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
    public static func watch(
        prev prevRecord: NewDeviceWatch?,
        list rawList: [Endpoint],
        selfId: String,
        now: String = WireDate.string(from: Date()),
        currentKeyCreatedAt: String? = nil,
        seed: [Endpoint]? = nil
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
            return WatchResult(watch: baseline(list, selfId: selfId), joined: [])
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

    /// "All of these are mine": the first look is answered; its card goes on this phone only.
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

    /// The user said "Yes, it's mine" (or removed it): drop that device's pending notice.
    public static func confirm(_ watch: NewDeviceWatch, id: String) -> NewDeviceWatch {
        var next = watch
        next.unconfirmed = watch.unconfirmed.filter { $0.id != id }
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

    /// The list with each id once, in order of first appearance.
    private static func firstById(_ list: [Endpoint]) -> [Endpoint] {
        var seen = Set<String>()
        return list.filter { seen.insert($0.id).inserted }
    }

    private static func baseline(_ raw: [Endpoint], selfId: String) -> NewDeviceWatch {
        let list = firstById(raw)
        // The first look: one card, asked once, when there is anyone else to check.
        let others = list.filter { $0.id != selfId }
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

    /// What `observe` made of a fetched list.
    public struct Observation: Sendable, Equatable {
        /// The list, when the rule accepted it. Nil means "treat the fetch as
        /// failed": the list did not contain this phone (or it is not registered),
        /// so nothing may be cached, trusted or handed a key from it.
        public var accepted: [Endpoint]?
        /// Devices that joined since the previous fetch: announce these once.
        public var joined: [NewDeviceNotice] = []
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
    @discardableResult
    public static func observe(
        _ list: [Endpoint], store: TabsendStore, now: Date = Date()
    ) -> Observation {
        guard let selfId = store.registration?.endpointId,
              listIncludesSelf(list, selfId: selfId)
        else { return Observation(accepted: nil) }
        var joined: [NewDeviceNotice] = []
        let stamp = WireDate.string(from: now)
        // The key a departure in this list leaves to be replaced.
        let currentKey = Keyring.current(store.groupKeyring)?.createdAt
        // With no record yet, the list a build from before this rule cached is the
        // baseline (GH6). Read here, before the cache is overwritten below and outside the
        // store's lock (reading it inside the update would wait on that lock for ever).
        let cached = store.cachedEndpoints
        store.updateNewDeviceWatch { prev in
            let seed = prev == nil ? cached : nil
            let result = watch(
                prev: prev, list: list, selfId: selfId, now: stamp, currentKeyCreatedAt: currentKey,
                seed: seed
            )
            joined = result.joined
            return result.watch
        }
        store.cachedEndpoints = list
        return Observation(accepted: list, joined: joined)
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

    /// Drop one device's pending notice: "Yes, it's mine".
    /// The answer is kept on this phone only (P-10: answers are per device).
    public static func dismiss(id: String, store: TabsendStore) {
        store.updateNewDeviceWatch { prev in prev.map { confirm($0, id: id) } }
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

    /// The first look: the other devices in the first list, waiting for one answer (GH6).
    public static func review(store: TabsendStore) -> [NewDeviceNotice] {
        current(store: store)?.review ?? []
    }

    /// Announced as new, never answered, then gone from the list (GH7).
    public static func vanished(store: TabsendStore) -> [NewDeviceNotice] {
        current(store: store)?.vanished ?? []
    }

    /// "All of these are mine": answered on this phone only (answers are not synced).
    public static func answerReview(store: TabsendStore) {
        store.updateNewDeviceWatch { prev in prev.map { confirmReview($0) } }
    }

    /// Dismiss one "joined, then disappeared" notice on this phone.
    public static func dismissVanished(id: String, store: TabsendStore) {
        store.updateNewDeviceWatch { prev in prev.map { dismissVanished($0, id: id) } }
    }

    /// The notices still waiting for an answer, oldest first.
    public static func unconfirmed(store: TabsendStore) -> [NewDeviceNotice] {
        current(store: store)?.unconfirmed ?? []
    }

    // MARK: copy (PLANS.md P-10 "The copy", word for word)

    /// `{when}`: the same relative time the rest of the app uses ("just now",
    /// "3m ago"), so "Joined 3m ago" reads naturally. A date that cannot be read
    /// says "recently" rather than "unknown".
    public static func when(_ createdAt: String, now: Date = Date()) -> String {
        let text = Inbox.relativeTime(createdAt, now: now)
        return text == "unknown" ? "recently" : text
    }

    public static func alertTitle(_ joined: [NewDeviceNotice]) -> String {
        if joined.count == 1 { return "New device: \(joined[0].label)" }
        return "\(joined.count) new devices joined"
    }

    public static func alertBody(_ joined: [NewDeviceNotice], now: Date = Date()) -> String {
        if joined.count == 1 {
            return "Joined your Tabsend devices \(when(joined[0].createdAt, now: now)). Was this you? If not, remove it."
        }
        return "\(listLabels(joined.map(\.label))). Were these you? If not, remove them."
    }

    public static func bannerTitle(_ notice: NewDeviceNotice) -> String {
        "New device: \(notice.label)"
    }

    public static func bannerBody(_ notice: NewDeviceNotice, now: Date = Date()) -> String {
        "Joined \(when(notice.createdAt, now: now)). Was this you? If it isn't yours, remove it. It could read the links you send."
    }

    // The first look and the vanished notice: the same words on every client.
    public static let reviewTitle = "Check your devices"
    public static let reviewBody =
        "Your group has these devices. A device you don't know could read the links you send, so remove it."
    public static let reviewRemove = "Remove"
    public static let reviewConfirm = "All of these are mine"
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
