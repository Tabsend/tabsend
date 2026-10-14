import Foundation

/// Which push transport this phone claims, and everything that keeps that claim true
/// (ADR-0032, PLANS P-5 option 1, HOSTED_PLAN §6).
///
/// Three facts decide it, and all three move on their own:
///
/// 1. **Does this build know a forwarder?** (`ForwarderConfig.url`.) No official
///    instance is deployed yet, so today the answer is no and everything below is a
///    no-op — the app behaves exactly as v0.6 did.
/// 2. **Does the user still want it?** On by default the moment a URL is known (P-5:
///    pairing turns the wake path on with no separate setting step), with an explicit
///    opt-out that this reads on every decision.
/// 3. **Can the relay ring anything?** `GET /v1/config` carries `wakeForwarder` only
///    where its operator configured one. Registering `forwarder` against a relay
///    without one is refused with `invalid_request`, so the hint is read FIRST and
///    `{transport:"none"}` is sent instead. A correct client never meets that refusal.
///
/// The three are re-read on every heartbeat, which is what lets a relay gain or lose a
/// forwarder without the phone needing to re-pair in either direction.
public enum WakePath {
    // MARK: the decision

    /// Does this build have a forwarder to talk to at all?
    public static var isConfigured: Bool { ForwarderConfig.url != nil }

    /// Configured, and not opted out. The precondition for registering with APNs at
    /// all: with no forwarder there is nothing to do with a device token, so the app
    /// does not ask Apple for one.
    public static func isEnabled(store: TabsendStore) -> Bool {
        isConfigured && !store.instantDeliveryOptOut
    }

    /// The subscription to put on the wire right now.
    ///
    /// The whole matrix, in one place, because every branch of it has to stay true at
    /// registration AND at every heartbeat:
    ///
    /// | forwarder URL | opted out | wake token | relay advertises | sent          |
    /// |---------------|-----------|------------|------------------|---------------|
    /// | no            | any       | any        | any              | `none`        |
    /// | yes           | yes       | any        | any              | `none`        |
    /// | yes           | no        | none yet   | any              | `none`        |
    /// | yes           | no        | held       | no               | `none`        |
    /// | yes           | no        | held       | yes              | `forwarder`   |
    ///
    /// The fourth row is the one worth naming: `forwarder` is NEVER sent to a relay
    /// that does not advertise one, because that registration 400s.
    public static func subscription(
        store: TabsendStore, relayAdvertisesForwarder: Bool
    ) -> PushSubscriptionBody {
        guard isEnabled(store: store), relayAdvertisesForwarder else { return .none }
        guard let token = store.wakeRegistration?.wakeToken, !token.isEmpty else { return .none }
        return .forwarder(wakeToken: token)
    }

    /// What the app last learned from `GET /v1/config` about this relay. Persisted so a
    /// screen can explain the wake path without a round trip, and so a background wake
    /// that fails to reach the relay still knows what it knew.
    public static func relayAdvertisesForwarder(store: TabsendStore) -> Bool {
        store.registration?.wakeForwarderAdvertised ?? false
    }

    // MARK: keeping the wake token current

    /// iOS handed over an APNs device token.
    ///
    /// Called on EVERY launch, because that is when Apple delivers it, and Apple may
    /// deliver a different one: a device token rotates on restore, on reinstall, and
    /// at Apple's discretion. A changed token is registered again, which replaces the
    /// old wake token at the forwarder in the same transaction (`PROTOCOL.md` §3.1) —
    /// so there is never a moment where two live tokens ring one phone.
    ///
    /// Returns true when the wake token changed, i.e. when the relay needs to be told.
    @discardableResult
    public static func deviceTokenArrived(
        _ apnsToken: String,
        environment: String = ApnsEnvironment.current,
        store: TabsendStore,
        client: ForwarderClient? = nil
    ) async -> Bool {
        let existing = store.wakeRegistration
        let changed = existing?.apnsToken != apnsToken || existing?.environment != environment
        if changed {
            // The old wake token belongs to an address Apple no longer routes, so it
            // is dropped here rather than revoked: re-registering replaces it anyway,
            // and revoking a token whose device token is already stale would spend a
            // round trip to delete a row the next register overwrites.
            store.wakeRegistration = WakeRegistration(
                apnsToken: apnsToken, environment: environment, wakeToken: nil
            )
        }
        return await mintIfNeeded(
            store: store,
            relayAdvertisesForwarder: relayAdvertisesForwarder(store: store),
            client: client
        )
    }

    /// Register with the forwarder if this device is enabled, holds a device token, and
    /// has no wake token for it yet. Best-effort: a forwarder that is down leaves the
    /// app on `{transport:"none"}`, which is the pre-forwarder behaviour and loses
    /// nothing (`PROTOCOL.md` §7).
    ///
    /// `relayAdvertisesForwarder` is a precondition rather than a detail. A wake token
    /// is only ever used by a relay that has a forwarder to ring, so minting one for an
    /// unpaired phone, or for a relay that cannot ring anything, would put a row in the
    /// forwarder's store for a device that will never be woken. The forwarder is meant
    /// to learn as little as it can; enrolling devices it has no reason to know about
    /// is the opposite of that.
    ///
    /// Returns true when a wake token was minted.
    @discardableResult
    public static func mintIfNeeded(
        store: TabsendStore, relayAdvertisesForwarder: Bool, client: ForwarderClient? = nil
    ) async -> Bool {
        guard relayAdvertisesForwarder, isEnabled(store: store) else { return false }
        guard let record = store.wakeRegistration, record.wakeToken == nil else { return false }
        guard let client = client ?? ForwarderClient.live() else { return false }
        guard let token = try? await client.register(
            apnsToken: record.apnsToken, environment: record.environment
        ) else { return false }
        // Re-read rather than writing back the captured copy: the device token may have
        // rotated while this call was in flight, and a stale write would pair a fresh
        // APNs address with a wake token minted for the old one.
        guard var current = store.wakeRegistration, current.apnsToken == record.apnsToken else {
            return false
        }
        current.wakeToken = token
        store.wakeRegistration = current
        return true
    }

    /// Retire the wake token and forget it locally.
    ///
    /// Called on unpair and on opt-out. Best-effort and fire-and-forget by contract:
    /// the forwarder answers 200 to a live token, a revoked one and an invented one
    /// alike, so there is nothing to check and nothing to retry. The local record goes
    /// either way — a token this app has stopped using must not linger in the Keychain.
    public static func revoke(store: TabsendStore, client: ForwarderClient? = nil) async {
        let token = store.wakeRegistration?.wakeToken
        store.wakeRegistration = nil
        guard let token, !token.isEmpty else { return }
        guard let client = client ?? ForwarderClient.live() else { return }
        await client.revoke(wakeToken: token)
    }

    // MARK: talking to the relay

    /// Read the relay's forwarder hint, remember it, and return it.
    ///
    /// Skipped entirely when this build has no forwarder AND the relay was not
    /// previously advertising one, so a v0.6-shaped install adds no traffic at all.
    @discardableResult
    public static func refreshRelayHint(store: TabsendStore, api: ApiClient) async -> Bool {
        var advertised = relayAdvertisesForwarder(store: store)
        guard isEnabled(store: store) || advertised else { return advertised }
        guard let config = try? await api.getConfig() else { return advertised }
        advertised = config.wakeForwarder ?? false
        remember(advertised, store: store)
        return advertised
    }

    /// The heartbeat, with transport rotation (ADR-0032).
    ///
    /// A heartbeat is where a device's stored subscription is rewritten, so it is also
    /// where every transition lands, in both directions: a relay that GAINED a
    /// forwarder starts being told `forwarder` on the next beat, and one that LOST it
    /// falls back to `none` without a re-pair. The refusal path below is the belt to
    /// that braces — the relay can lose its forwarder between the config read and the
    /// beat itself, and a heartbeat that simply failed would leave the device claiming
    /// a transport its relay cannot honour.
    public static func heartbeat(
        store: TabsendStore, api: ApiClient, client: ForwarderClient? = nil
    ) async {
        guard let reg = store.registration else { return }
        let advertised = await refreshRelayHint(store: store, api: api)
        // Late mint: the device token may have arrived before this phone was paired, or
        // before its relay had a forwarder. Either way this is the first beat at which
        // a wake token is worth having.
        await mintIfNeeded(store: store, relayAdvertisesForwarder: advertised, client: client)
        let subscription = subscription(store: store, relayAdvertisesForwarder: advertised)
        do {
            _ = try await api.heartbeat(endpointId: reg.endpointId, pushSubscription: subscription)
        } catch let error as ApiError where error.code == "invalid_request" && subscription != .none {
            remember(false, store: store)
            _ = try? await api.heartbeat(endpointId: reg.endpointId, pushSubscription: .none)
        } catch {
            // Offline, or a refusal that is not about the transport. The next beat
            // tries again; nothing here is worth showing anyone.
        }
    }

    /// Persist the hint on the registration, and only when it actually changed —
    /// writing it stitches the device token through the Keychain, which is not free
    /// and happens on every drain.
    static func remember(_ advertised: Bool, store: TabsendStore) {
        guard var reg = store.registration else { return }
        guard reg.wakeForwarderAdvertised != advertised else { return }
        reg.wakeForwarderAdvertised = advertised
        store.registration = reg
    }
}
