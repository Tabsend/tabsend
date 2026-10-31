import Foundation
import Security

/// Production store: App Group UserDefaults for non-secrets (shared with the
/// share extension), Keychain for the private key and device token. Mirrors
/// the split Android *should* have; secrets never sit in UserDefaults.
public final class AppGroupStore: TabsendStore, @unchecked Sendable {
    public static let defaultAppGroup = "group.io.tabsend.app"
    public static let defaultKeychainService = "io.tabsend.app"

    private let defaults: UserDefaults
    private let keychain: Keychain
    private let inboxFile: ProtectedLocalFile?
    private let historyFile: ProtectedLocalFile?
    private let lock = NSLock()

    private enum Key {
        static let identityPublic = "id.pub"
        static let identityKeyId = "id.keyId"
        static let registration = "reg.json"
        static let sourcePrefs = "prefs.source"
        static let seenSet = "seen.set"
        static let endpointsCache = "endpoints.cache"
        static let outboundQueue = "outbound.queue"
        static let inbox = "inbox.received"
        static let relayHealth = "relay.health"
        static let deliveredGroupKeys = "gk.delivered"
        /// Where the history cache lived before it moved to `historyFile`. Only
        /// removed on unpair now; nothing reads it.
        static let history = "history.cache"
        static let announcedNeverArrived = "history.announced"
        static let instantDeliveryOptOut = "wake.optout"
        static let newDeviceWatch = "devices.watch"
        static let groupResetWatch = "group.reset"
        // Keychain items
        static let identityPrivate = "id.priv"
        static let deviceToken = "reg.token"
        static let groupKeyring = "gk.ring"
        static let wakeRegistration = "wake.reg"
    }

    public convenience init(appGroup: String = AppGroupStore.defaultAppGroup,
                            keychainService: String = AppGroupStore.defaultKeychainService,
                            keychainAccessGroup: String? = nil) {
        let defaults = UserDefaults(suiteName: appGroup) ?? .standard
        let keychain = Keychain(service: keychainService, accessGroup: keychainAccessGroup)
        let container = FileManager.default
            .containerURL(forSecurityApplicationGroupIdentifier: appGroup)
        let inboxFile = container
            .map { ProtectedLocalFile(url: $0.appendingPathComponent("received-tabs.json")) }
        let historyFile = container
            .map { ProtectedLocalFile(url: $0.appendingPathComponent("group-history.json")) }
        self.init(defaults: defaults, keychain: keychain, inboxFile: inboxFile, historyFile: historyFile)
    }

    init(
        defaults: UserDefaults, keychain: Keychain,
        inboxFile: ProtectedLocalFile?, historyFile: ProtectedLocalFile?
    ) {
        self.defaults = defaults
        self.keychain = keychain
        self.inboxFile = inboxFile
        self.historyFile = historyFile
        // Upgrade existing v0.6 credentials immediately; waiting for a future
        // pairing write would leave long-lived installs transferable in backups.
        self.keychain.makeDeviceOnly(Key.identityPrivate)
        self.keychain.makeDeviceOnly(Key.deviceToken)
    }

    public var identity: Identity? {
        get {
            lock.withLock {
                guard let pub = defaults.string(forKey: Key.identityPublic),
                      let keyId = defaults.string(forKey: Key.identityKeyId),
                      let priv = keychain.get(Key.identityPrivate)
                else { return nil }
                return Identity(publicKey: pub, privateKey: priv, keyId: keyId)
            }
        }
        set {
            lock.withLock {
                if let identity = newValue {
                    defaults.set(identity.publicKey, forKey: Key.identityPublic)
                    defaults.set(identity.keyId, forKey: Key.identityKeyId)
                    keychain.set(identity.privateKey, for: Key.identityPrivate)
                } else {
                    defaults.removeObject(forKey: Key.identityPublic)
                    defaults.removeObject(forKey: Key.identityKeyId)
                    keychain.remove(Key.identityPrivate)
                }
            }
        }
    }

    /// Registration is stored as JSON minus the deviceToken, which lives in
    /// the Keychain and is stitched back in on read.
    public var registration: Registration? {
        get {
            lock.withLock {
                guard var reg: Registration = read(Key.registration),
                      let token = keychain.get(Key.deviceToken)
                else { return nil }
                reg.deviceToken = token
                return reg
            }
        }
        set {
            lock.withLock {
                if var reg = newValue {
                    keychain.set(reg.deviceToken, for: Key.deviceToken)
                    reg.deviceToken = ""
                    write(reg, Key.registration)
                } else {
                    keychain.remove(Key.deviceToken)
                    defaults.removeObject(forKey: Key.registration)
                }
            }
        }
    }

    /// The registered relay's address, WITHOUT touching the Keychain.
    ///
    /// `registration` needs the device token, which lives in the Keychain, so
    /// reading it is comparatively expensive and fails outright if the Keychain
    /// is unavailable. The relay-health tracker consults this on EVERY api call
    /// just to decide whether the call concerned our own relay — it has no use
    /// for the token — so it reads the address straight out of the registration
    /// JSON instead.
    public var registeredRelayUrl: String? {
        lock.withLock {
            let reg: Registration? = read(Key.registration)
            return reg?.relayUrl
        }
    }

    public var sourcePrefs: SourcePrefs {
        get { lock.withLock { read(Key.sourcePrefs) ?? SourcePrefs() } }
        set { lock.withLock { write(newValue, Key.sourcePrefs) } }
    }

    public var seenMessages: [SeenMessage] {
        get { lock.withLock { read(Key.seenSet) ?? [] } }
        set { lock.withLock { write(newValue, Key.seenSet) } }
    }

    public var cachedEndpoints: [Endpoint] {
        get { lock.withLock { read(Key.endpointsCache) ?? [] } }
        set { lock.withLock { write(newValue, Key.endpointsCache) } }
    }

    public var outboundQueue: [OutboundItem] {
        get { lock.withLock { read(Key.outboundQueue) ?? [] } }
        set { lock.withLock { write(newValue, Key.outboundQueue) } }
    }

    public var inbox: [InboxItem] {
        get { lock.withLock { readInbox() } }
        set { lock.withLock { writeInbox(newValue) } }
    }

    /// The group history keyring [0028] — in the KEYCHAIN, beside the identity
    /// private key, because 32 random bytes that decrypt every tab the group has
    /// ever moved are exactly as secret as it is.
    ///
    /// App Group UserDefaults is a plist in a container other processes with the
    /// entitlement can read and that lands in an unencrypted backup; the split
    /// this store already makes is between "shared, not secret" and "secret", and
    /// the ring is on the secret side. It goes in as one JSON item rather than one
    /// item per key so a partial read can never produce a ring that disagrees with
    /// itself about which key is current.
    public var groupKeyring: [GroupKeyRecord] {
        get { lock.withLock { readRing() } }
        set { lock.withLock { writeRing(newValue) } }
    }

    /// Same lock as every other write here. The background wake and the
    /// foreground drain run in this one process, so the lock covers both; the
    /// share extension only reads the ring.
    public func updateGroupKeyring(_ transform: ([GroupKeyRecord]) -> [GroupKeyRecord]) {
        lock.withLock { writeRing(transform(readRing())) }
    }

    private func readRing() -> [GroupKeyRecord] {
        guard let json = keychain.get(Key.groupKeyring),
              let ring = try? Wire.decoder.decode([GroupKeyRecord].self, from: Data(json.utf8))
        else { return [] }
        return ring
    }

    private func writeRing(_ ring: [GroupKeyRecord]) {
        guard !ring.isEmpty else {
            keychain.remove(Key.groupKeyring)
            return
        }
        guard let data = try? Wire.encoder.encode(ring),
              let json = String(data: data, encoding: .utf8)
        else { return }
        keychain.set(json, for: Key.groupKeyring)
    }

    public var deliveredGroupKeys: [String] {
        get { lock.withLock { read(Key.deliveredGroupKeys) ?? [] } }
        set { lock.withLock { write(newValue, Key.deliveredGroupKeys) } }
    }

    /// The decrypted history cache: up to 30 days of the whole group's links, so
    /// it gets the inbox's protection (ADR-0026): a file readable after first
    /// unlock for background wakes, and left out of device backups. Not App Group
    /// defaults, which travel in a backup.
    ///
    /// No fallback to defaults when the file cannot be written, unlike the inbox:
    /// this is a cache of what the relay holds, so the cost of losing it is one
    /// refetch, and keeping it in a backed-up plist is what this moved away from.
    public var history: [HistoryItem] {
        get { lock.withLock { historyFile?.read([HistoryItem].self) ?? [] } }
        set { lock.withLock { _ = historyFile?.write(newValue) } }
    }

    public var announcedNeverArrived: [String] {
        get { lock.withLock { read(Key.announcedNeverArrived) ?? [] } }
        set { lock.withLock { write(newValue, Key.announcedNeverArrived) } }
    }

    /// The wake path's credentials [0032] — in the KEYCHAIN, beside the device token,
    /// because the wake token is a bearer credential (anyone holding it can ring this
    /// phone until it is replaced) and the APNs device token is this phone's address at
    /// Apple. Written as one JSON item so a partial read cannot produce a record whose
    /// wake token belongs to a different APNs token than the one beside it.
    ///
    /// Marked device-only like the other two, for the same reason: a restored backup
    /// must re-pair rather than clone an endpoint, and a cloned wake token would mean
    /// two phones ringing for one relay's tabs.
    public var wakeRegistration: WakeRegistration? {
        get {
            lock.withLock {
                guard let json = keychain.get(Key.wakeRegistration),
                      let record = try? Wire.decoder.decode(
                          WakeRegistration.self, from: Data(json.utf8)
                      )
                else { return nil }
                return record
            }
        }
        set {
            lock.withLock {
                guard let record = newValue else {
                    keychain.remove(Key.wakeRegistration)
                    return
                }
                guard let data = try? Wire.encoder.encode(record),
                      let json = String(data: data, encoding: .utf8)
                else { return }
                keychain.set(json, for: Key.wakeRegistration)
            }
        }
    }

    /// Plain App Group defaults: a boolean preference, not a secret. Absent reads as
    /// false, which is "instant delivery on" (P-5).
    public var instantDeliveryOptOut: Bool {
        get { lock.withLock { defaults.bool(forKey: Key.instantDeliveryOptOut) } }
        set { lock.withLock { defaults.set(newValue, forKey: Key.instantDeliveryOptOut) } }
    }

    /// JSON in App Group defaults: device ids and labels, not a secret, and the
    /// same names the endpoint cache beside it already holds.
    public var newDeviceWatch: NewDeviceWatch? {
        get { lock.withLock { read(Key.newDeviceWatch) } }
        set { lock.withLock { writeOrRemove(newValue, Key.newDeviceWatch) } }
    }

    /// Same lock, same honest limit as `updateOutbound`. Only the app runs the
    /// rule; the share extension never writes this record.
    public func updateNewDeviceWatch(_ transform: (NewDeviceWatch?) -> NewDeviceWatch?) {
        lock.withLock {
            let current: NewDeviceWatch? = read(Key.newDeviceWatch)
            writeOrRemove(transform(current), Key.newDeviceWatch)
        }
    }

    /// JSON in App Group defaults: two timestamps and the ones already answered,
    /// not a secret.
    public var groupResetWatch: GroupResetWatch? {
        get { lock.withLock { read(Key.groupResetWatch) } }
        set { lock.withLock { writeOrRemove(newValue, Key.groupResetWatch) } }
    }

    /// Same lock, same honest limit as `updateOutbound`. Only the app writes it.
    public func updateGroupResetWatch(_ transform: (GroupResetWatch?) -> GroupResetWatch?) {
        lock.withLock {
            let current: GroupResetWatch? = read(Key.groupResetWatch)
            writeOrRemove(transform(current), Key.groupResetWatch)
        }
    }

    public var relayHealth: RelayHealth? {
        get { lock.withLock { read(Key.relayHealth) } }
        set {
            lock.withLock {
                if let newValue { write(newValue, Key.relayHealth) }
                else { defaults.removeObject(forKey: Key.relayHealth) }
            }
        }
    }

    /// Held under this store's lock, which serializes the app's own writes.
    ///
    /// Honest limit: the share extension is a separate PROCESS, so this lock does
    /// not span both. App Group UserDefaults has no cross-process transaction to
    /// borrow, and the consequence of a genuine interleave here is bounded — a
    /// duplicate POST of an already-accepted id, which the relay inserts with
    /// ON CONFLICT DO NOTHING, or one extra flush attempt. Both are harmless;
    /// losing a tab is not, and enqueue-before-POST is what prevents that.
    public func updateOutbound(_ transform: ([OutboundItem]) -> [OutboundItem]) {
        lock.withLock {
            let current: [OutboundItem] = read(Key.outboundQueue) ?? []
            write(transform(current), Key.outboundQueue)
        }
    }

    /// Same lock, same honest limit as `updateOutbound`. Nothing in the share
    /// extension touches the inbox — it is a sender surface — so in practice this
    /// only serializes the app's own drain against its own notification taps.
    public func updateInbox(_ transform: ([InboxItem]) -> [InboxItem]) {
        lock.withLock {
            writeInbox(transform(readInbox()))
        }
    }

    public func clear() {
        lock.withLock {
            for key in [Key.identityPublic, Key.identityKeyId, Key.registration,
                        Key.sourcePrefs, Key.seenSet, Key.endpointsCache, Key.outboundQueue,
                        Key.inbox, Key.relayHealth, Key.deliveredGroupKeys,
                        Key.history, Key.announcedNeverArrived, Key.newDeviceWatch,
                        Key.groupResetWatch] {
                defaults.removeObject(forKey: key)
            }
            keychain.remove(Key.identityPrivate)
            keychain.remove(Key.deviceToken)
            // The ring goes too. ADR-0028 is explicit that losing the key on every
            // device makes history unreadable, and that this is acceptable: leaving
            // it behind after an unpair would keep a key for a group this phone is
            // no longer in, which is worse than losing it.
            keychain.remove(Key.groupKeyring)
            // The wake registration goes too. Its token was already revoked at the
            // forwarder by the unpair path; this is the local half, and leaving it
            // would keep a credential for a doorbell nobody is going to ring.
            // `Key.instantDeliveryOptOut` is NOT removed: see `MemoryStore.clear`.
            keychain.remove(Key.wakeRegistration)
            inboxFile?.remove()
            historyFile?.remove()
        }
    }

    private func read<T: Decodable>(_ key: String) -> T? {
        guard let data = defaults.data(forKey: key) else { return nil }
        return try? Wire.decoder.decode(T.self, from: data)
    }

    private func write<T: Encodable>(_ value: T, _ key: String) {
        if let data = try? Wire.encoder.encode(value) {
            defaults.set(data, forKey: key)
        }
    }

    private func writeOrRemove<T: Encodable>(_ value: T?, _ key: String) {
        if let value { write(value, key) } else { defaults.removeObject(forKey: key) }
    }

    private func readInbox() -> [InboxItem] {
        if let stored: [InboxItem] = inboxFile?.read([InboxItem].self) {
            return stored
        }

        // v0.6 stored the inbox in App Group UserDefaults. Migrate it on first
        // access and delete the backed-up legacy copy only after the protected,
        // backup-excluded file is safely written.
        let legacy: [InboxItem] = read(Key.inbox) ?? []
        if inboxFile?.write(legacy) == true {
            defaults.removeObject(forKey: Key.inbox)
        }
        return legacy
    }

    private func writeInbox(_ value: [InboxItem]) {
        if inboxFile?.write(value) == true {
            defaults.removeObject(forKey: Key.inbox)
        } else {
            // Preserve history rather than silently discard it if the App Group
            // entitlement is broken; physical qualification must catch this
            // fallback before an external build is approved.
            write(value, Key.inbox)
        }
    }
}

/// Minimal generic-password Keychain wrapper. `accessGroup` shares items
/// between the app and the share extension.
struct Keychain {
    let service: String
    let accessGroup: String?

    private func query(for key: String) -> [CFString: Any] {
        var q: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: key,
        ]
        if let accessGroup {
            q[kSecAttrAccessGroup] = accessGroup
        }
        return q
    }

    func get(_ key: String) -> String? {
        var q = query(for: key)
        q[kSecReturnData] = true
        q[kSecMatchLimit] = kSecMatchLimitOne
        var result: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data
        else { return nil }
        return String(data: data, encoding: .utf8)
    }

    func set(_ value: String, for key: String) {
        let data = Data(value.utf8)
        var q = query(for: key)
        // Endpoint credentials are device-bound. A restored backup must require
        // re-pairing rather than creating two phones with the same relay token and
        // E2E identity. Including accessibility in the update migrates existing
        // v0.6 items the next time either credential is written.
        let accessibility = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let update: [CFString: Any] = [
            kSecValueData: data,
            kSecAttrAccessible: accessibility,
        ]
        let status = SecItemUpdate(q as CFDictionary, update as CFDictionary)
        if status == errSecItemNotFound {
            q[kSecValueData] = data
            // Available after first unlock so background drains can read it.
            q[kSecAttrAccessible] = accessibility
            SecItemAdd(q as CFDictionary, nil)
        }
    }

    func makeDeviceOnly(_ key: String) {
        let update: [CFString: Any] = [
            kSecAttrAccessible: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        SecItemUpdate(query(for: key) as CFDictionary, update as CFDictionary)
    }

    func remove(_ key: String) {
        SecItemDelete(query(for: key) as CFDictionary)
    }
}
