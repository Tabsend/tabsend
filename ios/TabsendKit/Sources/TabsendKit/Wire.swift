import Foundation

/// Wire models mirroring shared/src/types.ts. Timestamps stay ISO-8601 strings
/// on the wire; parse with `WireDate` where a real date is needed.
/// Descriptive enums (`platform`, `browser`) are plain strings so unknown
/// values from newer peers never break decoding (P-6 tolerance).

public enum Wire {
    public static let apiVersion = "v1"
    public static let clientProtocol = 3
    public static let minRelayProtocol = 3
    public static let envelopeAlg = "x25519-xsalsa20-poly1305/box"
    /// The group-history seal [0028]: the same XSalsa20-Poly1305 construction as
    /// `envelopeAlg` with the key supplied directly instead of derived by X25519.
    public static let groupSealedAlg = "xsalsa20-poly1305/secretbox"
    public static let authScheme = "Bearer"
    public static let presenceOnlineThresholdSeconds = 90
    public static let wsClientPingIntervalSeconds = 30
    public static let seenRetentionSeconds: TimeInterval = 14 * 24 * 60 * 60

    public static let encoder: JSONEncoder = {
        let e = JSONEncoder()
        return e
    }()

    public static let decoder: JSONDecoder = {
        let d = JSONDecoder()
        return d
    }()
}

public enum WireDate {
    private static let withFractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let plain: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    /// ISO-8601 UTC with milliseconds, matching JS Date.toISOString().
    public static func string(from date: Date) -> String {
        withFractional.string(from: date)
    }

    public static func date(from string: String) -> Date? {
        withFractional.date(from: string) ?? plain.date(from: string)
    }
}

public struct Envelope: Codable, Sendable, Equatable {
    public var alg: String
    public var senderKeyId: String
    public var targetKeyId: String
    public var nonce: String
    public var ciphertext: String

    public init(alg: String, senderKeyId: String, targetKeyId: String, nonce: String, ciphertext: String) {
        self.alg = alg
        self.senderKeyId = senderKeyId
        self.targetKeyId = targetKeyId
        self.nonce = nonce
        self.ciphertext = ciphertext
    }
}

public struct SendPayload: Codable, Sendable, Equatable {
    public var url: String
    public var title: String?
    public var favicon: String?
    public var sentAt: String
    public var historyOf: HistoryOf?
    /// Present only when this link is part of a multi-tab send: the id shared
    /// by every tab of the batch, plus how many tabs the batch holds. Old
    /// senders omit it, so absence must decode fine (like `historyOf`).
    public var batch: Batch?

    public struct HistoryOf: Codable, Sendable, Equatable {
        public var targetEndpointId: String
    }

    public struct Batch: Codable, Sendable, Equatable {
        public var id: String
        public var count: Int

        public init(id: String, count: Int) {
            self.id = id
            self.count = count
        }
    }

    public init(url: String, title: String? = nil, favicon: String? = nil, sentAt: String, historyOf: HistoryOf? = nil, batch: Batch? = nil) {
        self.url = url
        self.title = title
        self.favicon = favicon
        self.sentAt = sentAt
        self.historyOf = historyOf
        self.batch = batch
    }
}

/// Something sealed to the GROUP history key rather than to one endpoint [0028].
///
/// There is no `senderKeyId` to check, deliberately: anyone holding the group key
/// could have written it, and everyone holding it is by definition a paired
/// device. A TAB's authenticity still rests on its per-target `Envelope`; this
/// seals the RECORD of that send.
public struct GroupSealed: Codable, Sendable, Equatable {
    public var alg: String
    /// Which group key sealed this. A device holds a SET of keys (rotation keeps
    /// the old ones so old history stays readable), so a blob has to name its own
    /// or every reader would be guessing by trial decryption.
    public var keyId: String
    public var nonce: String
    public var ciphertext: String

    public init(alg: String = Wire.groupSealedAlg, keyId: String, nonce: String, ciphertext: String) {
        self.alg = alg
        self.keyId = keyId
        self.nonce = nonce
        self.ciphertext = ciphertext
    }
}

/// What a history blob decrypts to [0028]. The labels are SNAPSHOTS taken at send
/// time: a history row has to still read correctly after a device is renamed or
/// leaves the group, and the relay's routing row only ever carries ids.
public struct HistoryRecord: Codable, Sendable, Equatable {
    public var payload: SendPayload
    public var sourceLabelAtSend: String
    public var targetLabelAtSend: String

    public init(payload: SendPayload, sourceLabelAtSend: String, targetLabelAtSend: String) {
        self.payload = payload
        self.sourceLabelAtSend = sourceLabelAtSend
        self.targetLabelAtSend = targetLabelAtSend
    }
}

/// One row of the group's shared history [0028]: the relay's own routing facts,
/// plus the opaque blob only paired devices can read.
///
/// `deliveredAt`/`ackedAt` are metadata the relay has always held, which is what
/// lets a client say "this never arrived" honestly rather than inferring it.
public struct HistoryEntry: Codable, Sendable, Identifiable, Equatable {
    public var id: String
    public var sourceEndpointId: String
    public var targetEndpointId: String
    public var createdAt: String
    public var expiresAt: String
    public var deliveredAt: String?
    /// Set once the target confirmed it. Null past `expiresAt` means it never arrived.
    public var ackedAt: String?
    public var blob: GroupSealed

    public init(
        id: String, sourceEndpointId: String, targetEndpointId: String,
        createdAt: String, expiresAt: String,
        deliveredAt: String? = nil, ackedAt: String? = nil, blob: GroupSealed
    ) {
        self.id = id
        self.sourceEndpointId = sourceEndpointId
        self.targetEndpointId = targetEndpointId
        self.createdAt = createdAt
        self.expiresAt = expiresAt
        self.deliveredAt = deliveredAt
        self.ackedAt = ackedAt
        self.blob = blob
    }
}

/// One copy of the group history key, sealed to ONE endpoint's X25519 key [0028].
///
/// Its own route rather than an ordinary message: a control message travelling as
/// a tab IS a tab to every client already shipped, and iOS would show the user
/// "Unsupported link blocked" every time one arrived.
public struct GroupKeyDelivery: Codable, Sendable, Identifiable, Equatable {
    public var id: String
    /// Who sealed it. The envelope's `senderKeyId` is what actually proves it.
    public var sourceEndpointId: String
    public var envelope: Envelope
    public var createdAt: String

    public init(id: String, sourceEndpointId: String, envelope: Envelope, createdAt: String) {
        self.id = id
        self.sourceEndpointId = sourceEndpointId
        self.envelope = envelope
        self.createdAt = createdAt
    }
}

/// What a `GroupKeyDelivery` envelope decrypts to, and what this device persists.
public struct GroupKeyRecord: Codable, Sendable, Equatable {
    /// 32 random bytes, base64. The only secret in ADR-0028.
    public var key: String
    /// Fingerprint of `key`, so two devices can agree which key is which without
    /// ever comparing the secrets.
    public var keyId: String
    /// When this key came into being. Newest wins when a device holds several.
    public var createdAt: String
    /// The ids of the devices that had left, or been removed, when this key was
    /// minted to replace the one they held: the minter's debt. A device that owes a
    /// rotation stands down only for a key that names every one of its own departed
    /// ids, so a key that merely arrived later does not count (X14). Nil on a
    /// group's first key; at most 32 ids (`Keyring.isAcceptableDeparted`).
    public var departed: [String]?

    public init(key: String, keyId: String, createdAt: String, departed: [String]? = nil) {
        self.key = key
        self.keyId = keyId
        self.createdAt = createdAt
        self.departed = departed
    }
}

public struct GroupKeyRequest: Codable, Sendable {
    public var items: [Item]
    public struct Item: Codable, Sendable {
        public var id: String
        public var targetEndpointId: String
        public var envelope: Envelope
        public init(id: String, targetEndpointId: String, envelope: Envelope) {
            self.id = id
            self.targetEndpointId = targetEndpointId
            self.envelope = envelope
        }
    }
    public init(items: [Item]) { self.items = items }
}

public struct GroupKeyResponse: Codable, Sendable {
    public var accepted: [String]
    public var rejected: [Rejection]
    public struct Rejection: Codable, Sendable {
        public var id: String
        public var reason: String  // unknown_target | expired_key | not_in_group
    }
}

public struct Endpoint: Codable, Sendable, Identifiable, Equatable {
    public var id: String
    public var groupId: String
    public var kind: String       // extension | mobile | console
    public var browser: String?
    public var platform: String?  // unknown values tolerated
    public var label: String
    public var deviceName: String?
    public var e2ePubkey: String
    public var presence: String   // online | offline
    public var lastSeenAt: String
    public var createdAt: String

    public var isOnline: Bool { presence == "online" }
}

public struct ServerConfigResponse: Codable, Sendable {
    public var vapidPublicKey: String?
    public var protocolVersion: Int?
    public var minClientProtocol: Int?
    public var recommendedClientProtocol: Int?
    public var relayVersion: String?
    public var relayId: String?
    /// Will this relay accept a NEW group right now? [0022] Nil on relays predating the
    /// field — read as true (the old behaviour). Mirrored for contract completeness like
    /// `relayVersion`, but UNUSED on iOS: this app is join-only (it always sends a
    /// pairing code), so it can never be refused with `group_exists`. A future create
    /// path would read this to decide whether to offer creation at all.
    public var acceptsNewGroups: Bool?
    /// Can this relay ring an iPhone through the wake-up forwarder? [0032]
    ///
    /// Present and true ONLY where the relay's operator configured a forwarder. Nil on
    /// every relay that predates the field, which reads as false, which is right — such
    /// a relay has no forwarder either. This is a HINT the client reads before it
    /// registers, never the enforcement: a relay without a forwarder REFUSES
    /// `{transport:"forwarder"}` with `invalid_request`, so a client that asked anyway
    /// would be paired-and-silent or turned away for no reason. `WakePath` is the one
    /// place that reads it.
    public var wakeForwarder: Bool?

    enum CodingKeys: String, CodingKey {
        case vapidPublicKey
        case protocolVersion = "protocol"
        case minClientProtocol, recommendedClientProtocol, relayVersion, relayId
        case acceptsNewGroups, wakeForwarder
    }
}

/// The `pushSubscription` this app is able to send. Two of the five variants in
/// shared §2, because they are the only two an iPhone can honestly claim:
///
/// - `none` — no wake channel [0015]: instant in the foreground, drain on open.
/// - `forwarder` — the wake token the project's forwarder minted for this phone
///   [0032]. The relay rings the forwarder ITS OPERATOR configured; there is
///   deliberately no url field here and there never will be, because a
///   client-supplied URL would make every register call an SSRF lever on the relay.
///
/// Which one goes on the wire is `WakePath.subscription`'s decision, never a caller's.
public enum PushSubscriptionBody: Codable, Sendable, Equatable {
    case none
    case forwarder(wakeToken: String)

    private enum CodingKeys: String, CodingKey {
        case transport, wakeToken
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .none:
            try container.encode("none", forKey: .transport)
        case .forwarder(let wakeToken):
            try container.encode("forwarder", forKey: .transport)
            try container.encode(wakeToken, forKey: .wakeToken)
        }
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let transport = try container.decode(String.self, forKey: .transport)
        if transport == "forwarder" {
            self = .forwarder(wakeToken: try container.decode(String.self, forKey: .wakeToken))
        } else {
            self = .none
        }
    }
}

public struct RegisterRequest: Codable, Sendable {
    public var label: String
    public var kind: String
    public var browser: String?
    public var platform: String
    public var pushSubscription: PushSubscriptionBody
    public var e2ePubkey: String
    public var deviceName: String?
    public var pairingCode: String?

    public init(
        label: String, deviceName: String?, e2ePubkey: String,
        pairingCode: String? = nil,
        pushSubscription: PushSubscriptionBody = .none
    ) {
        self.label = label
        self.kind = "mobile"
        self.browser = nil
        self.platform = "ios"
        self.pushSubscription = pushSubscription
        self.e2ePubkey = e2ePubkey
        self.deviceName = deviceName
        self.pairingCode = pairingCode
    }
}

public struct HeartbeatRequest: Codable, Sendable {
    /// Sent on every heartbeat, because this is also how a device ROTATES its
    /// transport: a relay that gained or lost a forwarder since the last beat is
    /// answered with the transport it can actually honour [0032].
    public var pushSubscription: PushSubscriptionBody

    public init(pushSubscription: PushSubscriptionBody = .none) {
        self.pushSubscription = pushSubscription
    }
}

public struct RegisterResponse: Codable, Sendable {
    public var endpointId: String
    public var groupId: String
    public var deviceToken: String
}

public struct HeartbeatResponse: Codable, Sendable {
    public var presence: String
    public var serverTime: String
}

public struct RenameRequest: Codable, Sendable {
    public var label: String
    public var deviceName: String?
    public init(label: String, deviceName: String? = nil) {
        self.label = label
        self.deviceName = deviceName
    }
}

public struct SendRequest: Codable, Sendable {
    public var items: [Item]
    public struct Item: Codable, Sendable {
        public var id: String
        public var targetEndpointId: String
        public var envelope: Envelope
        /// The group-history copy of this same tab [0028]. Omitted when this
        /// device holds no group key yet, which a relay and every other client
        /// treat exactly as a pre-0028 sender: everything else behaves as before.
        public var history: GroupSealed?
        public init(
            id: String, targetEndpointId: String, envelope: Envelope,
            history: GroupSealed? = nil
        ) {
            self.id = id
            self.targetEndpointId = targetEndpointId
            self.envelope = envelope
            self.history = history
        }
    }
    public init(items: [Item]) { self.items = items }
}

public struct SendResponse: Codable, Sendable {
    public var accepted: [String]
    public var rejected: [Rejection]
    public struct Rejection: Codable, Sendable {
        public var id: String
        public var reason: String  // unknown_target | expired_key | not_in_group | limit_reached
        /// Which per-group cap refused this item [0030]. Set only alongside
        /// `limit_reached`, and always then; absent from every older relay, so it
        /// is optional and decodes to nil. See `SendFeedback.swift`.
        public var limit: String?
    }
}

public struct Message: Codable, Sendable, Identifiable {
    public var id: String
    public var groupId: String
    public var sourceEndpointId: String
    public var targetEndpointId: String
    public var envelope: Envelope?
    public var createdAt: String
    public var expiresAt: String
    public var deliveredAt: String?
    public var ackedAt: String?
}

public struct AckResponse: Codable, Sendable {
    public var ok: Bool
    public var ackedAt: String?
}

public struct OkResponse: Codable, Sendable {
    public var ok: Bool
}

public struct CreatePairingResponse: Codable, Sendable {
    /// Complete link: relay address + one-time secret + optional TLS pin.
    /// The secret is deliberately not returned as a separate user-facing value.
    public var link: String
    public var browserLink: String?
    public var expiresAt: String
}

public struct ApiErrorBody: Codable, Sendable {
    public var error: Inner
    public struct Inner: Codable, Sendable {
        public var code: String
        public var message: String
    }
}

/// Server -> client stream events; unknown types must be ignored.
public struct StreamEvent: Decodable, Sendable {
    public var type: String
    public var message: Message?
    public var endpoint: Endpoint?
    public var endpointId: String?
    public var presence: String?
    public var messageId: String?
}
