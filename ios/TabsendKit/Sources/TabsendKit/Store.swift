import Foundation

/// Device-local state, mirroring android/.../store/Store.kt. Everything here
/// stays on the device (ADR-0009 §1) — the relay never sees source prefs,
/// the seen-set, the endpoint cache, or the outbound queue.

public struct Identity: Codable, Sendable, Equatable {
    public var publicKey: String   // standard base64
    public var privateKey: String  // standard base64 — keep in Keychain
    public var keyId: String       // cached base64url-nopad fingerprint

    public init(publicKey: String, privateKey: String, keyId: String) {
        self.publicKey = publicKey
        self.privateKey = privateKey
        self.keyId = keyId
    }

    public static func generate() -> Identity {
        let pair = CryptoBox.generateKeyPair()
        let pub = Base64X.encode(pair.publicKey)
        return Identity(
            publicKey: pub,
            privateKey: Base64X.encode(pair.privateKey),
            keyId: Base64X.keyId(ofPublicKeyBase64: pub)
        )
    }
}

public struct Registration: Codable, Sendable, Equatable {
    public var endpointId: String
    public var groupId: String
    public var deviceToken: String
    public var relayUrl: String
    public var label: String
    public var certFingerprint: String?
    public var relayId: String?
    /// What `GET /v1/config` last said about this relay's wake-up forwarder [0032].
    /// Nil until the app has asked, and on registrations written by an older build.
    /// Kept here because it is a fact about the relay we are registered to, so it is
    /// discarded with the registration and cannot outlive it.
    public var wakeForwarderAdvertised: Bool?
    /// The device tags the pairing link carried (`NewDevices.parseVouch`, P-23): the
    /// devices the phone or browser that showed it had accepted. Read once, by the
    /// device-list fetch that creates this pairing's new-device record, and cleared
    /// then (`NewDevices.observe`). Nil for a link from an older client, and once used.
    /// Device-local, like the rest of this record.
    public var vouched: [String]?

    public init(
        endpointId: String, groupId: String, deviceToken: String,
        relayUrl: String, label: String,
        certFingerprint: String? = nil, relayId: String? = nil,
        wakeForwarderAdvertised: Bool? = nil, vouched: [String]? = nil
    ) {
        self.endpointId = endpointId
        self.groupId = groupId
        self.deviceToken = deviceToken
        self.relayUrl = relayUrl
        self.label = label
        self.certFingerprint = certFingerprint
        self.relayId = relayId
        self.wakeForwarderAdvertised = wakeForwarderAdvertised
        self.vouched = vouched
    }
}

public struct SeenMessage: Codable, Sendable, Equatable {
    public var id: String
    public var seenAt: Date
    public init(id: String, seenAt: Date) {
        self.id = id
        self.seenAt = seenAt
    }
}

/// A sealed send the relay hasn't accepted yet, held for retry.
///
/// `title`, `url` and `targetLabel` are the shared page's own, kept in PLAINTEXT
/// and device-locally beside the sealed envelope. The envelope is sealed to the
/// target's key, so a queue of envelopes can be counted but never described, and
/// without these no screen could say WHICH tabs are stuck — the state with the
/// most tabs at risk showed the least evidence (INTERACTION_FLOWS §4b). Nothing
/// extra reaches the relay: it still only ever sees ciphertext, and these die
/// with the item when it drains. The page they name was open on this phone
/// anyway. All three are optional so a queue written by an older build decodes.
///
/// `HeldItem` is the slice `OutboundQueue` works in, so the rules that bound
/// this queue can be tested without an envelope, a store or an App Group.
public struct OutboundItem: Codable, Sendable, Equatable, TargetedItem {
    public var id: String
    public var targetEndpointId: String
    public var envelope: Envelope
    public var createdAt: String
    public var title: String?
    public var url: String?
    /// Label of the target as it read when the send was made, for the held list.
    public var targetLabel: String?
    /// The group-history copy sealed alongside the envelope [0028], carried so a
    /// tab that finally flushes hours later still records itself. Sealed once, at
    /// send time, deliberately: the labels inside it are the ones that were true
    /// then, and re-sealing at flush time under a key that had since rotated would
    /// silently date the row wrong.
    public var history: GroupSealed?
    /// The target has left the group (PLANS.md P-15 item 3), so the flush stops
    /// posting this tab and the app offers another device for it. Optional so a
    /// queue written by an older build still decodes; nil reads as false. Sticky
    /// when the relay set it; see `OutboundQueue.isTargetGone`.
    public var targetGone: Bool?
    /// `targetGone` was set because a device list no longer had the device, so it
    /// clears once the device is accepted again (SECURITY_REVIEW L3). Nil beside
    /// `targetGone` is the relay's own refusal, which is what a flag written
    /// before this existed was, so an older queue needs nothing done to it.
    public var goneFromList: Bool?

    public init(
        id: String, targetEndpointId: String, envelope: Envelope, createdAt: String,
        title: String? = nil, url: String? = nil, targetLabel: String? = nil,
        history: GroupSealed? = nil, targetGone: Bool? = nil, goneFromList: Bool? = nil
    ) {
        self.targetGone = targetGone
        self.goneFromList = goneFromList
        self.id = id
        self.targetEndpointId = targetEndpointId
        self.envelope = envelope
        self.createdAt = createdAt
        self.title = title
        self.url = url
        self.targetLabel = targetLabel
        self.history = history
    }
}

public struct SourcePrefs: Codable, Sendable, Equatable {
    public var primaryTargetId: String?
    public var primaryPinned: Bool
    public var recentTargetIds: [String]

    public init(primaryTargetId: String? = nil, primaryPinned: Bool = false, recentTargetIds: [String] = []) {
        self.primaryTargetId = primaryTargetId
        self.primaryPinned = primaryPinned
        self.recentTargetIds = recentTargetIds
    }

    public static let maxRecents = 20

    /// MRU update on a successful send; primary follows the MRU head unless pinned.
    public mutating func recordSend(to targetId: String) {
        recentTargetIds.removeAll { $0 == targetId }
        recentTargetIds.insert(targetId, at: 0)
        if recentTargetIds.count > Self.maxRecents {
            recentTargetIds.removeLast(recentTargetIds.count - Self.maxRecents)
        }
        if !primaryPinned {
            primaryTargetId = targetId
        }
    }
}

/// Abstract storage so the app can back it with App Group UserDefaults +
/// Keychain while tests use an in-memory instance.
public protocol TabsendStore: AnyObject, Sendable {
    var identity: Identity? { get set }
    var registration: Registration? { get set }
    var sourcePrefs: SourcePrefs { get set }
    var seenMessages: [SeenMessage] { get set }
    /// The last device list the new-device rule accepted (it contains this phone).
    /// Written by `NewDevices.observe` after the rule runs, and by a removal made
    /// from this phone; nothing else writes it, the share extension included.
    var cachedEndpoints: [Endpoint] { get set }
    var outboundQueue: [OutboundItem] { get set }
    /// Tabs this phone received, newest first, capped at `Inbox.maxItems` [P-7].
    var inbox: [InboxItem] { get set }
    /// The group history keyring [0028] — every key this device has been handed,
    /// newest first. KEY MATERIAL: an implementation must put it where the
    /// identity private key goes, not beside the non-secrets.
    var groupKeyring: [GroupKeyRecord] { get set }
    /// `gk-<keyId>-<endpointId>` ids this device has already handed over, so it
    /// stops re-posting the same copy. Not a secret: a keyId is a hash.
    var deliveredGroupKeys: [String] { get set }
    /// The offline CACHE of the group's history, newest first, capped at
    /// `History.maxItems`. The relay's list is authoritative [0028]; this is what
    /// the screen can show without it.
    var history: [HistoryItem] { get set }
    /// Sends already announced as never-arrived, so it is said exactly once.
    var announcedNeverArrived: [String] { get set }
    /// The persisted relay-reachability verdict; see `RelayHealth`.
    var relayHealth: RelayHealth? { get set }
    /// The wake path's own credentials [0032]: Apple's device token and the wake token
    /// the forwarder minted for it. KEY MATERIAL: an implementation must put it where
    /// the device token goes, not beside the non-secrets.
    var wakeRegistration: WakeRegistration? { get set }
    /// P-5's explicit opt-out. False by default and false is ON: once a forwarder URL
    /// is known, pairing turns the wake path on with no separate setting step, and this
    /// is the switch for the small number of people who would rather it stayed off.
    /// Deliberately spelled as the opt-OUT so an absent value reads as enabled.
    var instantDeliveryOptOut: Bool { get set }
    /// The registered relay's address only, without the cost of reading the
    /// device token. Consulted on every api call by `RelayHealthTracker`.
    var registeredRelayUrl: String? { get }
    /// The "new device joined" record (PLANS.md P-10): this device's id, the device
    /// ids in the last list it accepted, their published keys, the joined devices
    /// not yet answered, and a group-key rotation owed since a device left.
    /// Device-local, never sent anywhere.
    var newDeviceWatch: NewDeviceWatch? { get set }
    /// The reset that waits (PLANS.md P-18 item 12): the last state the relay
    /// reported, and which resets were already announced or answered "It was me".
    /// Device-local, never sent anywhere.
    var groupResetWatch: GroupResetWatch? { get set }

    /// Unpair: wipe everything, including the identity.
    func clear()

    /// Read-modify-write the queue under the store's own lock.
    ///
    /// A send now enqueues its item BEFORE the POST and removes it after, so a
    /// flush running at the same moment can be holding a list that is already
    /// stale — and on iOS the two can even be in DIFFERENT PROCESSES (the share
    /// extension sending while the app drains). Every mutation goes through here
    /// so the last writer can't resurrect a drained item or drop a fresh one.
    func updateOutbound(_ transform: ([OutboundItem]) -> [OutboundItem])

    /// Read-modify-write the inbox under the store's own lock, for the same
    /// reason as `updateOutbound`: the drain records arrivals while a
    /// notification tap stamps a tab opened, and on iOS those can even be
    /// different entry points into the process. A lost update here would either
    /// resurrect a dropped row or forget that the user opened one.
    func updateInbox(_ transform: ([InboxItem]) -> [InboxItem])

    /// Read-modify-write the new-device record under the store's lock, so two
    /// device-list fetches landing together cannot both announce one device.
    func updateNewDeviceWatch(_ transform: (NewDeviceWatch?) -> NewDeviceWatch?)

    /// Read-modify-write the reset record under the store's lock, so two fetches
    /// landing together (a background wake and the foreground) cannot both announce
    /// the same reset.
    func updateGroupResetWatch(_ transform: (GroupResetWatch?) -> GroupResetWatch?)

    /// Read-modify-write the group keyring under the store's lock. The key sync
    /// runs from the foreground and from background wakes, and two passes that
    /// each read the ring and wrote it back could drop a key the other just
    /// minted, a rotation included. Every ring write in the sync goes through here.
    func updateGroupKeyring(_ transform: ([GroupKeyRecord]) -> [GroupKeyRecord])
}

extension TabsendStore {
    public var isRegistered: Bool { registration != nil }

    public func markSeen(_ id: String, at date: Date = Date()) {
        var seen = seenMessages
        guard !seen.contains(where: { $0.id == id }) else { return }
        seen.append(SeenMessage(id: id, seenAt: date))
        seenMessages = seen
    }

    public func unmarkSeen(_ id: String) {
        seenMessages = seenMessages.filter { $0.id != id }
    }

    public func hasSeen(_ id: String) -> Bool {
        seenMessages.contains { $0.id == id }
    }

    /// Retention is 14 days — 2x the relay's 7-day message TTL.
    public func pruneSeen(now: Date = Date()) {
        seenMessages = seenMessages.filter {
            now.timeIntervalSince($0.seenAt) < Wire.seenRetentionSeconds
        }
    }
}

/// In-memory store for tests and previews.
public final class MemoryStore: TabsendStore, @unchecked Sendable {
    private let lock = NSLock()
    private var _identity: Identity?
    private var _registration: Registration?
    private var _sourcePrefs = SourcePrefs()
    private var _seen: [SeenMessage] = []
    private var _cached: [Endpoint] = []
    private var _outbound: [OutboundItem] = []
    private var _inbox: [InboxItem] = []
    private var _relayHealth: RelayHealth?
    private var _groupKeyring: [GroupKeyRecord] = []
    private var _deliveredGroupKeys: [String] = []
    private var _history: [HistoryItem] = []
    private var _announcedNeverArrived: [String] = []
    private var _wakeRegistration: WakeRegistration?
    private var _instantDeliveryOptOut = false
    private var _newDeviceWatch: NewDeviceWatch?
    private var _groupResetWatch: GroupResetWatch?

    public init() {}

    public var identity: Identity? {
        get { lock.withLock { _identity } }
        set { lock.withLock { _identity = newValue } }
    }
    public var registration: Registration? {
        get { lock.withLock { _registration } }
        set { lock.withLock { _registration = newValue } }
    }
    public var sourcePrefs: SourcePrefs {
        get { lock.withLock { _sourcePrefs } }
        set { lock.withLock { _sourcePrefs = newValue } }
    }
    public var seenMessages: [SeenMessage] {
        get { lock.withLock { _seen } }
        set { lock.withLock { _seen = newValue } }
    }
    public var cachedEndpoints: [Endpoint] {
        get { lock.withLock { _cached } }
        set { lock.withLock { _cached = newValue } }
    }
    public var outboundQueue: [OutboundItem] {
        get { lock.withLock { _outbound } }
        set { lock.withLock { _outbound = newValue } }
    }
    public var inbox: [InboxItem] {
        get { lock.withLock { _inbox } }
        set { lock.withLock { _inbox = newValue } }
    }
    public var relayHealth: RelayHealth? {
        get { lock.withLock { _relayHealth } }
        set { lock.withLock { _relayHealth = newValue } }
    }
    public var groupKeyring: [GroupKeyRecord] {
        get { lock.withLock { _groupKeyring } }
        set { lock.withLock { _groupKeyring = newValue } }
    }
    public var deliveredGroupKeys: [String] {
        get { lock.withLock { _deliveredGroupKeys } }
        set { lock.withLock { _deliveredGroupKeys = newValue } }
    }
    public var history: [HistoryItem] {
        get { lock.withLock { _history } }
        set { lock.withLock { _history = newValue } }
    }
    public var announcedNeverArrived: [String] {
        get { lock.withLock { _announcedNeverArrived } }
        set { lock.withLock { _announcedNeverArrived = newValue } }
    }
    public var wakeRegistration: WakeRegistration? {
        get { lock.withLock { _wakeRegistration } }
        set { lock.withLock { _wakeRegistration = newValue } }
    }
    public var instantDeliveryOptOut: Bool {
        get { lock.withLock { _instantDeliveryOptOut } }
        set { lock.withLock { _instantDeliveryOptOut = newValue } }
    }
    public var registeredRelayUrl: String? {
        lock.withLock { _registration?.relayUrl }
    }
    public var newDeviceWatch: NewDeviceWatch? {
        get { lock.withLock { _newDeviceWatch } }
        set { lock.withLock { _newDeviceWatch = newValue } }
    }

    public func updateNewDeviceWatch(_ transform: (NewDeviceWatch?) -> NewDeviceWatch?) {
        lock.withLock { _newDeviceWatch = transform(_newDeviceWatch) }
    }

    public var groupResetWatch: GroupResetWatch? {
        get { lock.withLock { _groupResetWatch } }
        set { lock.withLock { _groupResetWatch = newValue } }
    }

    public func updateGroupResetWatch(_ transform: (GroupResetWatch?) -> GroupResetWatch?) {
        lock.withLock { _groupResetWatch = transform(_groupResetWatch) }
    }

    public func updateGroupKeyring(_ transform: ([GroupKeyRecord]) -> [GroupKeyRecord]) {
        lock.withLock { _groupKeyring = transform(_groupKeyring) }
    }

    public func updateOutbound(_ transform: ([OutboundItem]) -> [OutboundItem]) {
        lock.withLock { _outbound = transform(_outbound) }
    }

    public func updateInbox(_ transform: ([InboxItem]) -> [InboxItem]) {
        lock.withLock { _inbox = transform(_inbox) }
    }

    public func clear() {
        lock.withLock {
            _identity = nil
            _registration = nil
            _sourcePrefs = SourcePrefs()
            _seen = []
            _cached = []
            _outbound = []
            _inbox = []
            _relayHealth = nil
            _groupKeyring = []
            _deliveredGroupKeys = []
            _history = []
            _announcedNeverArrived = []
            _wakeRegistration = nil
            _newDeviceWatch = nil
            _groupResetWatch = nil
            // `_instantDeliveryOptOut` deliberately SURVIVES: it is a standing choice
            // about this phone's background activity, not group data, and re-pairing
            // must not quietly switch a wake path back on that somebody turned off.
        }
    }
}
