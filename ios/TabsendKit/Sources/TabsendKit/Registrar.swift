import Foundation

/// Join sequence, mirroring android/.../net/Registrar.kt and the order documented in
/// docs (config -> protocol check -> register -> persist). There is no recovery path:
/// a complete pairing link from an already-paired device is the only way into a group [0021].
public enum Registrar {
    public struct JoinOutcome: Sendable {
        public var registration: Registration
        public var protocolResult: ProtocolCheck.Result
    }

    public enum JoinError: Error {
        case protocolBlocked(String)
        case api(ApiError)
        case offline(Error)
    }

    public static func ensureIdentity(store: TabsendStore) -> Identity {
        if let existing = store.identity { return existing }
        let identity = Identity.generate()
        store.identity = identity
        return identity
    }

    /// Join an existing group with a pairing code, or create a new one (pairingCode nil).
    /// The app only ever calls this WITH a code; the create path exists to mirror the
    /// wire contract. A relay that already hosts a group refuses a create with
    /// `group_exists` [0022], surfaced verbatim — its message names the fix.
    public static func join(
        relayUrl rawRelayUrl: String,
        pairingCode: String?,
        label: String,
        deviceName: String?,
        certFingerprint: String?,
        store: TabsendStore
    ) async throws -> JoinOutcome {
        let relayUrl = Pairing.normalizeRelayUrl(rawRelayUrl)
        let api = ApiClient(relayUrl: relayUrl, certFingerprint: certFingerprint)

        // 1. Protocol handshake FIRST, through the pinned session. Version skew
        //    must read as skew, never as "can't reach relay".
        let config: ServerConfigResponse
        do {
            config = try await api.getConfig()
        } catch let error as ApiError {
            throw JoinError.api(error)
        } catch {
            throw JoinError.offline(error)
        }
        let check = ProtocolCheck.check(config)
        if check.blocks {
            throw JoinError.protocolBlocked(ProtocolCheck.message(check) ?? "Incompatible protocol version.")
        }

        // 2. Identity (lazily created, kept across failed joins).
        let identity = ensureIdentity(store: store)

        // 2b. The wake path, decided BEFORE the register call [0032], P-5: pairing is
        //     what turns instant delivery on, with no separate setting step. The relay
        //     has just told us whether it has a forwarder, so this is the one moment
        //     both facts are in hand. Everything here is best-effort — a forwarder that
        //     is down, a device token Apple has not delivered yet, or an opt-out all
        //     land on `{transport:"none"}`, which is exactly the v0.6 behaviour, and
        //     the next heartbeat rotates the transport as soon as that changes.
        let advertised = config.wakeForwarder ?? false
        await WakePath.mintIfNeeded(store: store, relayAdvertisesForwarder: advertised)
        let pushSubscription = WakePath.subscription(
            store: store, relayAdvertisesForwarder: advertised
        )

        // 3. Register.
        let request = RegisterRequest(
            label: label, deviceName: deviceName, e2ePubkey: identity.publicKey,
            pairingCode: pairingCode, pushSubscription: pushSubscription
        )
        let response: RegisterResponse
        do {
            response = try await api.register(request)
        } catch let error as ApiError {
            throw JoinError.api(error)
        } catch {
            throw JoinError.offline(error)
        }

        // 4. Persist, including relayId from the config (P-4) and the forwarder hint
        //    [0032], so later heartbeats and the settings screen know what this relay
        //    can do without asking again.
        let registration = Registration(
            endpointId: response.endpointId,
            groupId: response.groupId,
            deviceToken: response.deviceToken,
            relayUrl: relayUrl,
            label: label,
            certFingerprint: certFingerprint,
            relayId: config.relayId,
            wakeForwarderAdvertised: advertised
        )
        store.registration = registration

        return JoinOutcome(registration: registration, protocolResult: check)
    }


    public struct RelayChangeResult: Sendable {
        public var relayUrl: String
        /// false when either side lacked a relayId — a soft caveat, not an error.
        public var verified: Bool
    }

    public enum RelayChangeError: Error {
        case unreachable(Error)
        case differentRelay
        case notRecognized
    }

    /// Change relay address (P-4, ADR-0020). Commits storage only after all
    /// three checks pass; keeps token, group, and certFingerprint.
    public static func changeRelayUrl(
        to rawCandidate: String,
        store: TabsendStore
    ) async throws -> RelayChangeResult {
        guard let reg = store.registration else { throw RelayChangeError.notRecognized }
        let candidate = Pairing.normalizeRelayUrl(rawCandidate)
        let api = ApiClient(
            relayUrl: candidate,
            deviceToken: reg.deviceToken,
            certFingerprint: reg.certFingerprint
        )

        // 1. The candidate answers.
        let config: ServerConfigResponse
        do {
            config = try await api.getConfig()
        } catch {
            throw RelayChangeError.unreachable(error)
        }

        // 2. Same relay, if both sides can prove identity.
        if let stored = reg.relayId, let fetched = config.relayId, stored != fetched {
            throw RelayChangeError.differentRelay
        }

        // 3. Authenticated proof: the existing token must work there. This is a
        //    probe — a 401 here must NOT trigger the unpair path.
        do {
            _ = try await api.listEndpoints()
        } catch let error as ApiError where error.status == 401 {
            throw RelayChangeError.notRecognized
        } catch let error as ApiError {
            throw RelayChangeError.unreachable(error)
        } catch {
            throw RelayChangeError.unreachable(error)
        }

        var updated = reg
        updated.relayUrl = candidate
        if updated.relayId == nil { updated.relayId = config.relayId }
        // Same relay, but the config just read is the freshest answer there is about
        // its forwarder [0032], and a move is exactly when an operator may have
        // changed one. Nothing rotates here; the next heartbeat carries it.
        updated.wakeForwarderAdvertised = config.wakeForwarder ?? false
        store.registration = updated

        let verified = reg.relayId != nil && config.relayId != nil
        return RelayChangeResult(relayUrl: candidate, verified: verified)
    }
}
