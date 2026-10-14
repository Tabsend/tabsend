import Testing
import Foundation
@testable import TabsendKit

/// Pins TabsendKit's crypto byte-for-byte to libsodium via the shared interop
/// vector (the same one the Android client is pinned with).
struct InteropTests {
    struct Vector: Decodable {
        struct Party: Decodable {
            let publicKey: String
            let privateKey: String
            let keyId: String
        }
        struct Env: Decodable {
            let alg: String
            let senderKeyId: String
            let targetKeyId: String
            let nonce: String
            let ciphertext: String
        }
        let alg: String
        let sender: Party
        let recipient: Party
        let nonce: String
        let plaintext: String
        let envelope: Env
    }

    private func loadVector() throws -> Vector {
        let url = try #require(
            Bundle.module.url(forResource: "interop-vector", withExtension: "json")
        )
        return try JSONDecoder().decode(Vector.self, from: Data(contentsOf: url))
    }

    @Test func keyIdsMatchVector() throws {
        let v = try loadVector()
        #expect(Base64X.keyId(ofPublicKeyBase64: v.sender.publicKey) == v.sender.keyId)
        #expect(Base64X.keyId(ofPublicKeyBase64: v.recipient.publicKey) == v.recipient.keyId)
    }

    @Test func sealReproducesLibsodiumCiphertext() throws {
        let v = try loadVector()
        let message = [UInt8](v.plaintext.utf8)
        let nonce = try #require(Base64X.decode(v.nonce))
        let recipientPub = try #require(Base64X.decode(v.recipient.publicKey))
        let senderPriv = try #require(Base64X.decode(v.sender.privateKey))
        let box = try CryptoBox.seal(
            message: message, nonce: nonce,
            recipientPublicKey: recipientPub, senderPrivateKey: senderPriv
        )
        #expect(Base64X.encode(box) == v.envelope.ciphertext)
    }

    @Test func openRecoversPlaintext() throws {
        let v = try loadVector()
        let box = try #require(Base64X.decode(v.envelope.ciphertext))
        let nonce = try #require(Base64X.decode(v.nonce))
        let senderPub = try #require(Base64X.decode(v.sender.publicKey))
        let recipientPriv = try #require(Base64X.decode(v.recipient.privateKey))
        let plaintext = try CryptoBox.open(
            box: box, nonce: nonce,
            senderPublicKey: senderPub, recipientPrivateKey: recipientPriv
        )
        #expect(String(decoding: plaintext, as: UTF8.self) == v.plaintext)
    }

    @Test func tamperedCiphertextFailsAuthentication() throws {
        let v = try loadVector()
        var box = try #require(Base64X.decode(v.envelope.ciphertext))
        box[box.count - 1] ^= 0x01
        let nonce = try #require(Base64X.decode(v.nonce))
        let senderPub = try #require(Base64X.decode(v.sender.publicKey))
        let recipientPriv = try #require(Base64X.decode(v.recipient.privateKey))
        #expect(throws: CryptoBox.CryptoError.authenticationFailure) {
            _ = try CryptoBox.open(
                box: box, nonce: nonce,
                senderPublicKey: senderPub, recipientPrivateKey: recipientPriv
            )
        }
    }

    @Test func sealerRoundTripWithFreshKeys() throws {
        let sender = Identity.generate()
        let recipient = Identity.generate()
        let payload = SendPayload(
            url: "https://example.com/x",
            title: "Round trip",
            sentAt: WireDate.string(from: Date())
        )
        let plaintext = try Wire.encoder.encode(payload)
        let envelope = try Sealer.seal(
            plaintext: plaintext,
            targetPublicKeyBase64: recipient.publicKey,
            senderPrivateKeyBase64: sender.privateKey,
            senderKeyId: sender.keyId
        )
        #expect(envelope.alg == Wire.envelopeAlg)
        #expect(envelope.senderKeyId == sender.keyId)
        #expect(envelope.targetKeyId == recipient.keyId)
        let opened = try Sealer.open(
            envelope: envelope,
            senderPublicKeyBase64: sender.publicKey,
            recipientPrivateKeyBase64: recipient.privateKey
        )
        let decoded = try Wire.decoder.decode(SendPayload.self, from: opened)
        #expect(decoded == payload)
    }

    @Test func batchFieldRoundTrips() throws {
        let payload = SendPayload(
            url: "https://example.com/x",
            title: "Batched",
            sentAt: WireDate.string(from: Date()),
            batch: SendPayload.Batch(id: "b-123", count: 4)
        )
        let encoded = try Wire.encoder.encode(payload)
        let decoded = try Wire.decoder.decode(SendPayload.self, from: encoded)
        #expect(decoded == payload)
        #expect(decoded.batch?.id == "b-123")
        #expect(decoded.batch?.count == 4)
    }

    @Test func payloadWithoutBatchDecodes() throws {
        // Old senders never include `batch`; absence must decode fine.
        let json = #"{"url":"https://example.com/x","sentAt":"2026-08-03T00:00:00.000Z"}"#
        let decoded = try Wire.decoder.decode(SendPayload.self, from: Data(json.utf8))
        #expect(decoded.batch == nil)
        #expect(decoded.url == "https://example.com/x")
    }
}
