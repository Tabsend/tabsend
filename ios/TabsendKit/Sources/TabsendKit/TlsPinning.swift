import Foundation
import CryptoKit
import Security

/// Self-signed relay certificate pinning (P-3, ADR-0019), mirroring
/// android/.../net/Tls.kt:
///  - The pin is base64url(SHA-256(SPKI DER of the leaf's public key)),
///    normally unpadded, 43 chars. Padded input is tolerated.
///  - A chain is accepted iff the leaf's SPKI hashes to the pin. No CA
///    validation, and hostname checks are skipped on purpose — identity is
///    the key, not the SAN (which goes stale with the DHCP lease).
///  - Without a pin, platform default trust applies untouched.
public enum TlsPin {
    /// SPKI DER of the leaf certificate. SecKeyCopyExternalRepresentation
    /// returns PKCS#1 for RSA and the raw 04||X||Y point for EC, so the
    /// SubjectPublicKeyInfo wrapper is rebuilt here.
    public static func spkiData(of certificate: SecCertificate) -> Data? {
        guard let key = SecCertificateCopyKey(certificate),
              let attrs = SecKeyCopyAttributes(key) as? [CFString: Any],
              let keyType = attrs[kSecAttrKeyType] as? String,
              let external = SecKeyCopyExternalRepresentation(key, nil) as Data?
        else { return nil }

        if keyType == (kSecAttrKeyTypeRSA as String) {
            // SPKI = SEQ { SEQ { OID rsaEncryption, NULL }, BIT STRING { 00 || PKCS#1 } }
            let algorithm = Der.sequence(
                Der.oid([0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x01, 0x01]) + Der.null()
            )
            return Der.sequence(algorithm + Der.bitString(external))
        }
        if keyType == (kSecAttrKeyTypeECSECPrimeRandom as String) {
            let curveOid: [UInt8]
            switch (attrs[kSecAttrKeySizeInBits] as? Int) ?? 0 {
            case 256: curveOid = [0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x03, 0x01, 0x07] // prime256v1
            case 384: curveOid = [0x2B, 0x81, 0x04, 0x00, 0x22]                   // secp384r1
            case 521: curveOid = [0x2B, 0x81, 0x04, 0x00, 0x23]                   // secp521r1
            default: return nil
            }
            let algorithm = Der.sequence(
                Der.oid([0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x02, 0x01]) + Der.oid(curveOid)
            )
            return Der.sequence(algorithm + Der.bitString(external))
        }
        return nil
    }

    public static func fingerprint(of certificate: SecCertificate) -> String? {
        guard let spki = spkiData(of: certificate) else { return nil }
        return Base64X.encodeUrlNoPad([UInt8](SHA256.hash(data: spki)))
    }

    /// Constant-time pin comparison; a malformed pin never matches.
    public static func matches(pin: String, certificate: SecCertificate) -> Bool {
        let normalized = pin.trimmingCharacters(in: CharacterSet(charactersIn: "="))
        guard let expected = Base64X.decodeUrl(normalized), expected.count == 32,
              let spki = spkiData(of: certificate)
        else { return false }
        let actual = [UInt8](SHA256.hash(data: spki))
        var diff: UInt8 = 0
        for i in 0..<32 { diff |= expected[i] ^ actual[i] }
        return diff == 0
    }

    private enum Der {
        static func length(_ n: Int) -> [UInt8] {
            if n < 0x80 { return [UInt8(n)] }
            var bytes: [UInt8] = []
            var v = n
            while v > 0 {
                bytes.insert(UInt8(v & 0xFF), at: 0)
                v >>= 8
            }
            return [0x80 | UInt8(bytes.count)] + bytes
        }
        static func sequence(_ content: Data) -> Data {
            Data([0x30] + length(content.count)) + content
        }
        static func oid(_ body: [UInt8]) -> Data {
            Data([0x06] + length(body.count) + body)
        }
        static func null() -> Data { Data([0x05, 0x00]) }
        static func bitString(_ content: Data) -> Data {
            Data([0x03] + length(content.count + 1) + [0x00]) + content
        }
    }
}

/// URLSession delegate enforcing the pin for both REST and the /v1/stream
/// WebSocket (they share the session). With a nil pin, default handling applies.
public final class PinningDelegate: NSObject, URLSessionDelegate, @unchecked Sendable {
    private let pin: String?

    public init(pin: String?) {
        self.pin = pin
    }

    public func urlSession(
        _ session: URLSession,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        guard let pin,
              challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust
        else {
            completionHandler(.performDefaultHandling, nil)
            return
        }
        guard let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate],
              let leaf = chain.first,
              TlsPin.matches(pin: pin, certificate: leaf)
        else {
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }
        completionHandler(.useCredential, URLCredential(trust: trust))
    }
}
