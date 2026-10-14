import Testing
import Foundation
@testable import TabsendKit

/// The group history seal [ADR-0028]: `crypto_secretbox` (XSalsa20-Poly1305).
///
/// Pinned to libsodium by a vector generated against `libsodium-wrappers`, the
/// same library the extension seals with, so a blob written by any client opens on
/// every other one. The construction is the second half of the `crypto_box` the
/// interop vector already pins, but the halves are pinned separately on purpose —
/// a mistake in the key path would show up in exactly one of them.
struct GroupSealTests {
    struct Vector: Decodable {
        struct Blob: Decodable {
            let alg: String
            let keyId: String
            let nonce: String
            let ciphertext: String
        }
        let key: String
        let keyId: String
        let nonce: String
        let plaintext: String
        let record: HistoryRecord
        let blob: Blob
    }

    private func loadVector() throws -> Vector {
        let url = try #require(
            Bundle.module.url(forResource: "group-history-vector", withExtension: "json")
        )
        return try JSONDecoder().decode(Vector.self, from: Data(contentsOf: url))
    }

    @Test func keyIdMatchesTheVector() throws {
        let v = try loadVector()
        #expect(Base64X.groupKeyId(ofKeyBase64: v.key) == v.keyId)
    }

    @Test func sealReproducesLibsodiumCiphertext() throws {
        let v = try loadVector()
        let key = try #require(Base64X.decode(v.key))
        let nonce = try #require(Base64X.decode(v.nonce))
        let box = try CryptoBox.secretBoxSeal(
            message: [UInt8](v.plaintext.utf8), nonce: nonce, key: key
        )
        #expect(Base64X.encode(box) == v.blob.ciphertext)
    }

    @Test func openRecoversTheHistoryRecord() throws {
        let v = try loadVector()
        let blob = GroupSealed(
            alg: v.blob.alg, keyId: v.blob.keyId, nonce: v.blob.nonce, ciphertext: v.blob.ciphertext
        )
        let plaintext = try Sealer.openGroup(blob, groupKeyBase64: v.key)
        #expect(String(data: plaintext, encoding: .utf8) == v.plaintext)
        let decoded = try Wire.decoder.decode(HistoryRecord.self, from: plaintext)
        #expect(decoded == v.record)
        #expect(decoded.payload.batch?.count == 3)
    }

    @Test func roundTripsThroughOurOwnSeal() throws {
        let key = Keyring.generate()
        let record = HistoryRecord(
            payload: SendPayload(
                url: "https://example.test/x", title: "A tab",
                sentAt: "2026-08-05T10:00:00.000Z"
            ),
            sourceLabelAtSend: "iPhone",
            targetLabelAtSend: "Chrome · Work"
        )
        let blob = try Sealer.sealGroup(
            plaintext: Wire.encoder.encode(record), groupKeyBase64: key.key, keyId: key.keyId
        )
        #expect(blob.alg == Wire.groupSealedAlg)
        #expect(blob.keyId == key.keyId)
        let opened = try Wire.decoder.decode(
            HistoryRecord.self, from: Sealer.openGroup(blob, groupKeyBase64: key.key)
        )
        #expect(opened == record)
    }

    @Test func aNonceIsNeverReusedBetweenTwoSeals() throws {
        let key = Keyring.generate()
        let data = Data("x".utf8)
        let first = try Sealer.sealGroup(plaintext: data, groupKeyBase64: key.key, keyId: key.keyId)
        let second = try Sealer.sealGroup(plaintext: data, groupKeyBase64: key.key, keyId: key.keyId)
        #expect(first.nonce != second.nonce)
        #expect(first.ciphertext != second.ciphertext)
    }

    @Test func theWrongKeyFailsAuthenticationRatherThanReturningGarbage() throws {
        let blob = try Sealer.sealGroup(
            plaintext: Data("secret".utf8),
            groupKeyBase64: Keyring.generate().key,
            keyId: "k"
        )
        #expect(throws: Sealer.SealerError.self) {
            try Sealer.openGroup(blob, groupKeyBase64: Keyring.generate().key)
        }
    }

    @Test func aTamperedBlobFailsAuthentication() throws {
        let key = Keyring.generate()
        var blob = try Sealer.sealGroup(
            plaintext: Data("secret".utf8), groupKeyBase64: key.key, keyId: key.keyId
        )
        var bytes = try #require(Base64X.decode(blob.ciphertext))
        bytes[bytes.count - 1] ^= 0x01
        blob.ciphertext = Base64X.encode(bytes)
        #expect(throws: Sealer.SealerError.self) {
            try Sealer.openGroup(blob, groupKeyBase64: key.key)
        }
    }

    @Test func anUnknownAlgIsRefused() throws {
        // A future primitive must not be opened with today's one on the strength of
        // the ciphertext happening to authenticate.
        let key = Keyring.generate()
        var blob = try Sealer.sealGroup(
            plaintext: Data("x".utf8), groupKeyBase64: key.key, keyId: key.keyId
        )
        blob.alg = "something-else"
        #expect(throws: Sealer.SealerError.self) {
            try Sealer.openGroup(blob, groupKeyBase64: key.key)
        }
    }

    @Test func aShortKeyIsRefusedRatherThanPadded() throws {
        #expect(throws: CryptoBox.CryptoError.self) {
            try CryptoBox.secretBoxSeal(
                message: [1, 2, 3], nonce: CryptoBox.randomNonce(), key: [UInt8](repeating: 7, count: 16)
            )
        }
    }
}
