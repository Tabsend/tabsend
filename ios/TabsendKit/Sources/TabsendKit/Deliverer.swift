import Foundation

/// The single idempotent drain path, mirroring android/.../receive/Deliverer.kt.
/// Order of operations matters and is kept identical:
///  1. verify sender by keyId against the CURRENT group list (unknown -> leave queued),
///  2. mark seen BEFORE presenting; un-see and skip the ack if presenting fails,
///  3. ack after presenting; ack failures are quiet (a later drain re-acks).
public actor Deliverer {
    public struct Summary: Sendable, Equatable {
        public var delivered = 0
        public var skipped = 0
        public var pending = 0
        public var offline = false
        /// Devices that joined since the last list this phone saw (PLANS.md P-10).
        /// The caller announces them; the record is already saved.
        public var joinedDevices: [NewDeviceNotice] = []
        /// The device list this drain fetched, once the new-device rule accepted
        /// it. Nil when the fetch failed or the list did not contain this phone.
        /// The group-key pass runs on this and only this, never on the cache.
        public var endpoints: [Endpoint]?
        public init() {}
    }

    private let store: TabsendStore
    /// Presents a link to the user (notification). Returns false on failure,
    /// in which case the message stays queued and unacked.
    private let present: @Sendable (SendPayload, String) async -> Bool
    private let makeApi: @Sendable (Registration) -> ApiClient

    public init(store: TabsendStore, present: @escaping @Sendable (SendPayload, String) async -> Bool) {
        self.init(store: store, present: present) { reg in
            ApiClient(
                relayUrl: reg.relayUrl,
                deviceToken: reg.deviceToken,
                certFingerprint: reg.certFingerprint
            )
        }
    }

    /// Test seam: the same drain over a caller-supplied client.
    init(
        store: TabsendStore,
        present: @escaping @Sendable (SendPayload, String) async -> Bool,
        makeApi: @escaping @Sendable (Registration) -> ApiClient
    ) {
        self.store = store
        self.present = present
        self.makeApi = makeApi
    }

    @discardableResult
    public func drain() async -> Summary {
        var summary = Summary()
        guard let reg = store.registration, let identity = store.identity else { return summary }
        let api = makeApi(reg)

        store.pruneSeen()

        let endpoints: [Endpoint]
        let pending: [Message]
        do {
            // Every device-list fetch runs the new-device rule, this one included:
            // it is the fetch the background wakes make, so it is what notices a
            // device added while the app is closed. The rule also decides whether
            // the list may be used at all: one without this phone is treated as a
            // failed fetch, so it is neither cached nor trusted to vouch for a
            // sender, and nothing is delivered from it.
            let observed = NewDevices.observe(try await api.listEndpoints(), store: store)
            summary.joinedDevices = observed.joined
            guard let accepted = observed.accepted else { return summary }
            endpoints = accepted
            summary.endpoints = accepted
            pending = try await api.getPending()
        } catch {
            summary.offline = error.isOffline
            return summary
        }

        let senderByKeyId = Dictionary(
            endpoints.map { (Base64X.keyId(ofPublicKeyBase64: $0.e2ePubkey), $0) },
            uniquingKeysWith: { first, _ in first }
        )

        for message in pending {
            guard let envelope = message.envelope else {
                summary.skipped += 1
                continue
            }
            if store.hasSeen(message.id) {
                await api.ackQuietly(messageId: message.id)
                summary.skipped += 1
                continue
            }
            guard let sender = senderByKeyId[envelope.senderKeyId] else {
                // Unknown sender is not a current group endpoint: refuse, leave queued.
                summary.pending += 1
                continue
            }
            let payload: SendPayload
            do {
                let plaintext = try Sealer.open(
                    envelope: envelope,
                    senderPublicKeyBase64: sender.e2ePubkey,
                    recipientPrivateKeyBase64: identity.privateKey
                )
                payload = try Wire.decoder.decode(SendPayload.self, from: plaintext)
            } catch {
                summary.skipped += 1
                continue
            }
            if payload.historyOf != nil {
                // Console history copies never open on a device.
                store.markSeen(message.id)
                await api.ackQuietly(messageId: message.id)
                summary.skipped += 1
                continue
            }
            store.markSeen(message.id)
            let presented = await present(payload, message.id)
            if presented {
                await api.ackQuietly(messageId: message.id)
                summary.delivered += 1
                // Keep a copy the notification can't take with it [P-7]. Only
                // after presenting succeeded, and deliberately outside the
                // presented/unmarkSeen branch: the inbox is presentation on top
                // of delivery, never part of the ack contract.
                store.updateInbox { list in
                    Inbox.record(
                        list,
                        Inbox.project(
                            messageId: message.id,
                            payload: payload,
                            sourceLabel: sender.label,
                            receivedAt: Date()
                        )
                    )
                }
            } else {
                store.unmarkSeen(message.id)
                summary.pending += 1
            }
        }
        return summary
    }
}
