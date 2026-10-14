import Foundation

/// Builds and opens wire envelopes around CryptoBox,
/// mirroring android/.../crypto/Sealer.kt.
public enum Sealer {
    public enum SealerError: Error {
        case badKey
        case badEnvelope
        case authenticationFailure
    }

    /// Seal a payload for a target. `senderKeyId` is the cached keyId of our own public key.
    public static func seal(
        plaintext: Data,
        targetPublicKeyBase64: String,
        senderPrivateKeyBase64: String,
        senderKeyId: String
    ) throws -> Envelope {
        guard let targetPub = Base64X.decode(targetPublicKeyBase64),
              let senderPriv = Base64X.decode(senderPrivateKeyBase64)
        else { throw SealerError.badKey }
        let nonce = CryptoBox.randomNonce()
        let box = try CryptoBox.seal(
            message: [UInt8](plaintext), nonce: nonce,
            recipientPublicKey: targetPub, senderPrivateKey: senderPriv
        )
        return Envelope(
            alg: Wire.envelopeAlg,
            senderKeyId: senderKeyId,
            targetKeyId: Base64X.keyId(ofPublicKeyBase64: targetPublicKeyBase64),
            nonce: Base64X.encode(nonce),
            ciphertext: Base64X.encode(box)
        )
    }

    /// Open an envelope from a verified sender (caller resolves senderKeyId -> pubkey first).
    public static func open(
        envelope: Envelope,
        senderPublicKeyBase64: String,
        recipientPrivateKeyBase64: String
    ) throws -> Data {
        guard envelope.alg == Wire.envelopeAlg,
              let nonce = Base64X.decode(envelope.nonce),
              let box = Base64X.decode(envelope.ciphertext)
        else { throw SealerError.badEnvelope }
        guard let senderPub = Base64X.decode(senderPublicKeyBase64),
              let recipientPriv = Base64X.decode(recipientPrivateKeyBase64)
        else { throw SealerError.badKey }
        do {
            let message = try CryptoBox.open(
                box: box, nonce: nonce,
                senderPublicKey: senderPub, recipientPrivateKey: recipientPriv
            )
            return Data(message)
        } catch CryptoBox.CryptoError.authenticationFailure {
            throw SealerError.authenticationFailure
        }
    }

    // --- group history [0028] --------------------------------------------------

    /// Seal a history record under the group key. No sender fingerprint: see
    /// `GroupSealed`.
    public static func sealGroup(plaintext: Data, groupKeyBase64: String, keyId: String) throws -> GroupSealed {
        guard let key = Base64X.decode(groupKeyBase64) else { throw SealerError.badKey }
        let nonce = CryptoBox.randomNonce()
        let box = try CryptoBox.secretBoxSeal(message: [UInt8](plaintext), nonce: nonce, key: key)
        return GroupSealed(
            keyId: keyId,
            nonce: Base64X.encode(nonce),
            ciphertext: Base64X.encode(box)
        )
    }

    /// Open a group-sealed blob. The caller resolves `blob.keyId` to a held key
    /// first; a blob naming a key we do not have is not an error to recover from,
    /// it is a row we can only show the relay's own facts about.
    public static func openGroup(_ blob: GroupSealed, groupKeyBase64: String) throws -> Data {
        guard blob.alg == Wire.groupSealedAlg,
              let nonce = Base64X.decode(blob.nonce),
              let box = Base64X.decode(blob.ciphertext)
        else { throw SealerError.badEnvelope }
        guard let key = Base64X.decode(groupKeyBase64) else { throw SealerError.badKey }
        do {
            return Data(try CryptoBox.secretBoxOpen(box: box, nonce: nonce, key: key))
        } catch CryptoBox.CryptoError.authenticationFailure {
            throw SealerError.authenticationFailure
        }
    }
}
