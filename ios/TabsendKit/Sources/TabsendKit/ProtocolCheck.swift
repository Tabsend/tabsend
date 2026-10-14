import Foundation

/// Protocol compatibility, mirroring shared/src/types.ts checkProtocol() and
/// android/.../logic/Protocol.kt. The messages deliberately name WHICH side is
/// stale and never use reachability wording (dogfood lesson, 2026-07-26).
public enum ProtocolCheck {
    public enum Result: Equatable, Sendable {
        case ok
        case outdated(clientProtocol: Int, recommended: Int)
        case clientTooOld(clientProtocol: Int, relayRequires: Int)
        case relayTooOld(relayProtocol: Int, clientRequires: Int)

        public var blocks: Bool {
            switch self {
            case .clientTooOld, .relayTooOld: return true
            case .ok, .outdated: return false
            }
        }
    }

    public static func check(_ config: ServerConfigResponse) -> Result {
        let relayProtocol = config.protocolVersion ?? 1
        let minClient = config.minClientProtocol ?? 1
        let recommended = config.recommendedClientProtocol ?? minClient

        if Wire.clientProtocol < minClient {
            return .clientTooOld(clientProtocol: Wire.clientProtocol, relayRequires: minClient)
        }
        if relayProtocol < Wire.minRelayProtocol {
            return .relayTooOld(relayProtocol: relayProtocol, clientRequires: Wire.minRelayProtocol)
        }
        if Wire.clientProtocol < recommended {
            return .outdated(clientProtocol: Wire.clientProtocol, recommended: recommended)
        }
        return .ok
    }

    /// What to tell the user. The blocking cases name the stale side and the one
    /// action that fixes it; neither mentions reachability, because the relay
    /// answered fine. The outdated case is advisory — it accompanies a successful
    /// pairing rather than replacing one.
    public static func message(_ result: Result) -> String? {
        switch result {
        case .ok:
            return nil
        case let .outdated(clientProtocol, recommended):
            return "Linked. A newer Tabsend build is available "
                + "(this app speaks v\(clientProtocol), the relay prefers v\(recommended)) — "
                + "everything works, but it's worth updating."
        case let .clientTooOld(clientProtocol, relayRequires):
            return "This version of the Tabsend app is too old for that relay "
                + "(app speaks v\(clientProtocol), relay needs v\(relayRequires)). "
                + "Install the latest build, then pair again."
        case let .relayTooOld(relayProtocol, clientRequires):
            return "That relay is running an older version of Tabsend than this app "
                + "(relay speaks v\(relayProtocol), app needs v\(clientRequires)). "
                + "Update the relay, then pair again."
        }
    }
}
