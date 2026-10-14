import Foundation
import CryptoKit

/// Base64 helpers. The wire mixes two variants ON PURPOSE:
/// keys/nonce/ciphertext are STANDARD PADDED base64; keyId and deviceToken are
/// BASE64URL UNPADDED. Do not normalise them.
public enum Base64X {
    public static func encode(_ bytes: [UInt8]) -> String {
        Data(bytes).base64EncodedString()
    }

    public static func decode(_ string: String) -> [UInt8]? {
        Data(base64Encoded: string).map { [UInt8]($0) }
    }

    public static func encodeUrlNoPad(_ bytes: [UInt8]) -> String {
        Data(bytes).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    public static func decodeUrl(_ string: String) -> [UInt8]? {
        var s = string
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        while s.count % 4 != 0 { s += "=" }
        return Data(base64Encoded: s).map { [UInt8]($0) }
    }

    /// keyId = base64url-nopad(SHA-256(utf8(publicKeyBase64String))).
    /// NOTE: hashes the base64 STRING of the key, not the raw key bytes —
    /// this must match server/src/ids.ts and the other clients exactly.
    public static func keyId(ofPublicKeyBase64 publicKeyBase64: String) -> String {
        fingerprint(publicKeyBase64)
    }

    /// The same fingerprint over a GROUP history key [0028], so two devices can
    /// name the same key without ever comparing the secret. Deliberately the
    /// identical construction — the relay computes it for public keys, nobody
    /// computes it for this one, and a second hashing rule would be one more
    /// thing four clients could disagree about.
    public static func groupKeyId(ofKeyBase64 keyBase64: String) -> String {
        fingerprint(keyBase64)
    }

    private static func fingerprint(_ base64String: String) -> String {
        let digest = SHA256.hash(data: Data(base64String.utf8))
        return encodeUrlNoPad([UInt8](digest))
    }
}
