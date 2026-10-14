import Foundation
import CryptoKit

/// NaCl crypto_box_easy / crypto_box_open_easy: X25519 + XSalsa20-Poly1305.
/// Byte-for-byte compatible with libsodium (pinned by the interop vector test).
public enum CryptoBox {
    public static let nonceBytes = 24
    public static let macBytes = 16
    public static let keyBytes = 32

    public enum CryptoError: Error {
        case invalidKey
        case authenticationFailure
        case invalidInput
    }

    public struct KeyPair: Sendable {
        public let publicKey: [UInt8]
        public let privateKey: [UInt8]
    }

    public static func generateKeyPair() -> KeyPair {
        let priv = Curve25519.KeyAgreement.PrivateKey()
        return KeyPair(
            publicKey: [UInt8](priv.publicKey.rawRepresentation),
            privateKey: [UInt8](priv.rawRepresentation)
        )
    }

    public static func randomNonce() -> [UInt8] {
        var nonce = [UInt8](repeating: 0, count: nonceBytes)
        let status = SecRandomCopyBytes(kSecRandomDefault, nonceBytes, &nonce)
        precondition(status == errSecSuccess, "SecRandomCopyBytes failed")
        return nonce
    }

    /// crypto_box_beforenm: HSalsa20(zeros, X25519(sk, pk)).
    static func beforeNm(publicKey: [UInt8], privateKey: [UInt8]) throws -> [UInt8] {
        guard publicKey.count == keyBytes, privateKey.count == keyBytes else {
            throw CryptoError.invalidKey
        }
        let priv: Curve25519.KeyAgreement.PrivateKey
        let pub: Curve25519.KeyAgreement.PublicKey
        do {
            priv = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: Data(privateKey))
            pub = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: Data(publicKey))
        } catch {
            throw CryptoError.invalidKey
        }
        guard let shared = try? priv.sharedSecretFromKeyAgreement(with: pub) else {
            throw CryptoError.invalidKey
        }
        let sharedBytes = shared.withUnsafeBytes { [UInt8]($0) }
        return Salsa20.hsalsa20(key: sharedBytes, input: [UInt8](repeating: 0, count: 16))
    }

    /// crypto_box_easy: returns tag(16) || ciphertext.
    public static func seal(
        message: [UInt8], nonce: [UInt8],
        recipientPublicKey: [UInt8], senderPrivateKey: [UInt8]
    ) throws -> [UInt8] {
        guard nonce.count == nonceBytes else { throw CryptoError.invalidInput }
        let k = try beforeNm(publicKey: recipientPublicKey, privateKey: senderPrivateKey)
        return xsalsaSeal(message: message, nonce: nonce, key: k)
    }

    /// crypto_box_open_easy: input is tag(16) || ciphertext.
    public static func open(
        box: [UInt8], nonce: [UInt8],
        senderPublicKey: [UInt8], recipientPrivateKey: [UInt8]
    ) throws -> [UInt8] {
        guard nonce.count == nonceBytes, box.count >= macBytes else { throw CryptoError.invalidInput }
        let k = try beforeNm(publicKey: senderPublicKey, privateKey: recipientPrivateKey)
        return try xsalsaOpen(box: box, nonce: nonce, key: k)
    }

    // --- crypto_secretbox: the same construction, key given directly [0028] ----
    //
    // `crypto_box` is X25519 followed by XSalsa20-Poly1305 over the derived key.
    // `crypto_secretbox` IS that second half with the key handed in, so the two
    // functions below are not a new primitive: they are the code `seal`/`open`
    // above were already running, now reachable without a key exchange. That is
    // precisely why ADR-0028 chose secretbox for the group history blob — the
    // group key is shared by every paired device, so there is no pair to do an
    // exchange between, and nothing new has to be audited.

    /// crypto_secretbox_easy: returns tag(16) || ciphertext.
    public static func secretBoxSeal(message: [UInt8], nonce: [UInt8], key: [UInt8]) throws -> [UInt8] {
        guard nonce.count == nonceBytes else { throw CryptoError.invalidInput }
        guard key.count == keyBytes else { throw CryptoError.invalidKey }
        return xsalsaSeal(message: message, nonce: nonce, key: key)
    }

    /// crypto_secretbox_open_easy: input is tag(16) || ciphertext.
    public static func secretBoxOpen(box: [UInt8], nonce: [UInt8], key: [UInt8]) throws -> [UInt8] {
        guard nonce.count == nonceBytes, box.count >= macBytes else { throw CryptoError.invalidInput }
        guard key.count == keyBytes else { throw CryptoError.invalidKey }
        return try xsalsaOpen(box: box, nonce: nonce, key: key)
    }

    private static func xsalsaSeal(message: [UInt8], nonce: [UInt8], key: [UInt8]) -> [UInt8] {
        let keystream = Salsa20.xsalsa20Keystream(key: key, nonce: nonce, length: 32 + message.count)
        let polyKey = Array(keystream[0..<32])
        var ciphertext = [UInt8](repeating: 0, count: message.count)
        for i in 0..<message.count {
            ciphertext[i] = message[i] ^ keystream[32 + i]
        }
        let tag = Poly1305.mac(message: ciphertext, key: polyKey)
        return tag + ciphertext
    }

    private static func xsalsaOpen(box: [UInt8], nonce: [UInt8], key: [UInt8]) throws -> [UInt8] {
        let tag = Array(box[0..<macBytes])
        let ciphertext = Array(box[macBytes...])
        let keystream = Salsa20.xsalsa20Keystream(key: key, nonce: nonce, length: 32 + ciphertext.count)
        let polyKey = Array(keystream[0..<32])
        let expected = Poly1305.mac(message: ciphertext, key: polyKey)
        guard Poly1305.verify(tag, expected) else { throw CryptoError.authenticationFailure }
        var message = [UInt8](repeating: 0, count: ciphertext.count)
        for i in 0..<ciphertext.count {
            message[i] = ciphertext[i] ^ keystream[32 + i]
        }
        return message
    }
}
