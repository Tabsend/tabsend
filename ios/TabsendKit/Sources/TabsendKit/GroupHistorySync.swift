import Foundation

/// The network side of ADR-0028: collect group keys, mint or rotate one when due,
/// hand ours out, fetch the group's history, and say once when a tab this phone
/// sent never arrived.
///
/// **Everything here is best-effort.** It runs on the same wakes that already
/// refresh endpoints, and not one step of it may break sending or receiving: a
/// relay that predates ADR-0028 answers 404 for `/v1/group-keys` and
/// `invalid_request` for `?history=1`, and that is the NORMAL state for a while —
/// an app updates itself, a self-hosted relay is updated by hand. So an error
/// here means "this group has no history yet", never an error banner and never a
/// retry storm. The cache stays; the screen shows what it already had.
public enum GroupHistorySync {
    /// How many announced ids are kept. They exist only to stop a repeat
    /// notification, and a row leaves the relay's window long before this fills,
    /// so an unbounded list would be a slow leak with nothing on the other side.
    static let maxAnnounced = 200

    public struct Report: Sendable {
        /// False when the relay ANSWERED but does not know these routes: a relay
        /// older than ADR-0028. The screen says so instead of looking broken.
        public var relayKeepsHistory = true
        /// Sends of ours that ran out of time, not yet announced.
        public var neverArrived: [HistoryItem] = []
        /// True when nothing was reached at all, so nothing can be concluded.
        public var offline = false
    }

    /// One pass. `endpoints` is the list the caller just fetched AND the new-device
    /// rule accepted (`NewDevices.observe(...).accepted`), never the cache: it
    /// decides whose key copies are trusted and who is handed the key, so it has
    /// to be the list the rule judged. A caller whose fetch failed, or was
    /// refused, skips the pass. The drain fetches the list a moment earlier, and
    /// asking the relay again would be a second round trip for the same answer.
    @discardableResult
    public static func run(
        store: TabsendStore,
        api: ApiClient,
        endpoints: [Endpoint],
        now: Date = Date()
    ) async -> Report {
        var report = Report()
        guard let reg = store.registration, let identity = store.identity else { return report }
        // The rule ignores a list without this phone, so nothing here may act on
        // one either. `observe` never passes one on; this is the backstop.
        guard NewDevices.listIncludesSelf(endpoints, selfId: reg.endpointId) else { return report }

        // Read the new-device record once, and trust key copies from and hand
        // keys to only the devices it has accepted, by id AND key. The list may
        // have been read before the record moved on (a removed device still in
        // it), and a new key must never reach the device that just left.
        let watch = NewDevices.current(store: store)
        let members = NewDevices.endpointsKnownTo(watch, endpoints)

        await collectKeys(
            store: store, api: api, endpoints: members, identity: identity,
            now: now, into: &report
        )
        mintFirstKeyIfElected(store: store, endpoints: members, selfEndpointId: reg.endpointId, now: now)
        rotateIfOwed(store: store, watch: watch, now: now)
        await deliverKeys(store: store, api: api, endpoints: members, identity: identity, into: &report)
        await fetchHistory(
            store: store, api: api, endpoints: endpoints,
            reg: reg, now: now, into: &report
        )
        return report
    }

    /// Post the never-arrived notification and remember that it was posted.
    ///
    /// Marked only once a notification actually went out. If authorisation is
    /// missing nothing is posted and nothing is recorded, so the news is still
    /// waiting the day the user turns notifications on — the history screen was
    /// showing it the whole time either way.
    public static func announce(_ report: Report, store: TabsendStore) async {
        guard !report.neverArrived.isEmpty else { return }
        let first = report.neverArrived[0]
        let posted = await SendNotifications.postNeverArrived(
            count: report.neverArrived.count,
            firstTitle: first.payload?.title,
            targetLabel: first.targetLabel
        )
        guard posted else { return }
        let announced = store.announcedNeverArrived + report.neverArrived.map(\.id)
        store.announcedNeverArrived = Array(announced.suffix(maxAnnounced))
    }

    // MARK: steps

    /// Fetch every copy sealed to us and fold what we can open into the ring.
    private static func collectKeys(
        store: TabsendStore, api: ApiClient, endpoints: [Endpoint],
        identity: Identity, now: Date, into report: inout Report
    ) async {
        let deliveries: [GroupKeyDelivery]
        do {
            deliveries = try await api.getGroupKeys()
        } catch let error as ApiError {
            if error.isUnsupportedRoute { report.relayKeepsHistory = false }
            return
        } catch {
            report.offline = true
            return
        }
        guard !deliveries.isEmpty else { return }

        // The same anti-injection rule a tab gets (ADR-0009): the sender must be a
        // CURRENT group endpoint, matched by key fingerprint. A relay cannot forge
        // one — it has no member's private key — but it could replay a copy from a
        // device that has since been removed, and accepting a key from outside the
        // group is the one mistake that would make every later history blob
        // readable by whoever supplied it.
        let senderByKeyId = Dictionary(
            endpoints.map { (Base64X.keyId(ofPublicKeyBase64: $0.e2ePubkey), $0) },
            uniquingKeysWith: { _, last in last }
        )

        let nowMs = Int64((now.timeIntervalSince1970 * 1000).rounded(.down))
        var incoming: [GroupKeyRecord] = []
        for delivery in deliveries {
            guard let sender = senderByKeyId[delivery.envelope.senderKeyId] else { continue }
            guard let plaintext = try? Sealer.open(
                envelope: delivery.envelope,
                senderPublicKeyBase64: sender.e2ePubkey,
                recipientPrivateKeyBase64: identity.privateKey
            ),
            var record = try? Wire.decoder.decode(GroupKeyRecord.self, from: plaintext),
            // A keyId that does not fingerprint its own key would make two devices
            // disagree about which key is which, and a crafted createdAt (far
            // future, or a shape that sorts above every real date) would stay the
            // current key past every rotation. Both are cheap to check, and so is
            // the list of devices the key claims to replace (X14).
            Keyring.isAcceptable(record, nowMs: nowMs)
            else { continue }
            // What the key claims to replace, minus the device that sent this copy: a
            // device cannot vouch that it has left (X14).
            record.departed = Keyring.vouchedDeparted(record.departed, sender: sender.id)
            incoming.append(record)
        }
        guard !incoming.isEmpty else { return }
        store.updateGroupKeyring { Keyring.merge($0, incoming) }
    }

    /// Mint the group's first key, but only if this device is the one elected to.
    ///
    /// Runs even when the relay turned out not to know ADR-0028's routes. A key
    /// that cannot be handed anywhere yet costs 32 bytes in the Keychain and
    /// nothing else, and the alternative — gating on the relay — buys a special
    /// case whose only effect is that the group waits one extra wake for history
    /// to start working after the relay is updated. The election is deterministic,
    /// so no second device mints a competing one in the meantime.
    private static func mintFirstKeyIfElected(
        store: TabsendStore, endpoints: [Endpoint], selfEndpointId: String, now: Date
    ) {
        store.updateGroupKeyring { ring in
            guard Keyring.shouldMintFirstKey(
                ring: ring, endpoints: endpoints, selfEndpointId: selfEndpointId
            ) else { return ring }
            return Keyring.merge(ring, [Keyring.rotated(ring: ring, now: now)])
        }
    }

    /// Replace the group key when a device has left since the current one was made
    /// (ADR-0028 §7). The new-device rule records the departure in `rotateOwedAt`,
    /// so this covers a removal from any client, the console included, and a
    /// device the relay showed once and then hid.
    ///
    /// After collecting, so a rotation another device already made is seen and not
    /// repeated; before handing out, so `deliverKeys` seals the new key to everyone
    /// the record still accepts, which no longer includes the departed device.
    ///
    /// The debt is settled either way once the ring holds a key: minted here, or a
    /// newer one found. Otherwise every device would mint once per departure.
    private static func rotateIfOwed(store: TabsendStore, watch: NewDeviceWatch?, now: Date) {
        guard let owedAt = watch?.rotateOwedAt else { return }
        var holdsKey = false
        store.updateGroupKeyring { ring in
            guard let newest = Keyring.current(ring) else { return ring }
            holdsKey = true
            // Stand down only for a key that is newer AND names the devices owed
            // for: one that merely arrived later may be held by the device that left (X14).
            guard NewDevices.rotationDue(
                watch, newestKeyCreatedAt: newest.createdAt, newestKeyDeparted: newest.departed
            ) else { return ring }
            return Keyring.merge(ring, [
                Keyring.rotated(ring: ring, now: now, departed: NewDevices.rotationDeparted(watch)),
            ])
        }
        // An empty ring is the first-key election's business; the debt waits.
        guard holdsKey else { return }
        NewDevices.markRotationDone(owedAt: owedAt, store: store)
    }

    /// Hand the group's keys to every member that has not had them from us: the
    /// current one and the older ones that still open history, since a device that
    /// arrived after a rotation has retained history sealed under the key it
    /// replaced (ADR-0028 amended 2026-10-30).
    private static func deliverKeys(
        store: TabsendStore, api: ApiClient, endpoints: [Endpoint],
        identity: Identity, into report: inout Report
    ) async {
        let pending = Keyring.pendingDeliveries(
            ring: store.groupKeyring, endpoints: endpoints,
            selfEndpointId: store.registration?.endpointId ?? "",
            delivered: store.deliveredGroupKeys
        )
        guard !pending.isEmpty else { return }

        var items: [GroupKeyRequest.Item] = []
        for delivery in pending {
            guard let plaintext = try? Wire.encoder.encode(delivery.record),
                  let envelope = try? Sealer.seal(
                plaintext: plaintext,
                targetPublicKeyBase64: delivery.targetPubkey,
                senderPrivateKeyBase64: identity.privateKey,
                senderKeyId: identity.keyId
            ) else { continue }
            items.append(
                GroupKeyRequest.Item(
                    id: delivery.id,
                    targetEndpointId: delivery.targetEndpointId,
                    envelope: envelope
                )
            )
        }
        guard !items.isEmpty else { return }

        do {
            let response = try await api.postGroupKeys(GroupKeyRequest(items: items))
            // Only what the relay accepted. A rejection means the target's key
            // moved under us or it left the group; forgetting it here is what lets
            // the next pass try again with a fresh endpoint list.
            guard !response.accepted.isEmpty else { return }
            let delivered = Set(store.deliveredGroupKeys).union(response.accepted)
            store.deliveredGroupKeys = Array(delivered).sorted()
        } catch let error as ApiError {
            if error.isUnsupportedRoute { report.relayKeepsHistory = false }
        } catch {
            report.offline = true
        }
    }

    /// Fetch the group's history and rewrite the local cache from it.
    private static func fetchHistory(
        store: TabsendStore, api: ApiClient, endpoints: [Endpoint],
        reg: Registration, now: Date, into report: inout Report
    ) async {
        let entries: [HistoryEntry]
        do {
            entries = try await api.getHistory()
        } catch let error as ApiError {
            if error.isUnsupportedRoute { report.relayKeepsHistory = false }
            return
        } catch {
            report.offline = true
            return
        }

        // Current labels, for a row whose own labels were sealed inside a blob we
        // cannot open. Second best on purpose: the labels in the blob are the ones
        // that were true when the tab was sent.
        let labels = Dictionary(
            endpoints.map { ($0.id, $0.label) }, uniquingKeysWith: { first, _ in first }
        )
        let ring = store.groupKeyring
        let merged = History.merge(
            relay: entries.map { History.project($0, ring: ring, labels: labels) },
            inbox: store.inbox,
            selfEndpointId: reg.endpointId,
            selfLabel: reg.label
        )
        store.history = merged
        report.neverArrived = History.unannouncedNeverArrived(
            merged,
            selfEndpointId: reg.endpointId,
            announced: store.announcedNeverArrived,
            now: now
        )
    }
}
