import Testing
import Foundation
@testable import TabsendKit

struct PairingTests {
    @Test func fullLink() {
        let parsed = Pairing.parse("https://relay.example/pair#c=ABC12345")
        #expect(parsed == Pairing.Parsed(code: "ABC12345", relayUrl: "https://relay.example", certFingerprint: nil))
    }

    @Test func linkWithFingerprint() {
        let fp = String(repeating: "a", count: 43)
        let parsed = Pairing.parse("https://192.168.1.20:8787/pair#c=ABC12345&fp=\(fp)")
        #expect(parsed?.code == "ABC12345")
        #expect(parsed?.relayUrl == "https://192.168.1.20:8787")
        #expect(parsed?.certFingerprint == fp)
    }

    @Test func fingerprintIsNotCaseNormalized() {
        let parsed = Pairing.parse("https://r.example/pair#c=abc123&fp=AbC_d-9")
        #expect(parsed?.code == "ABC123")
        #expect(parsed?.certFingerprint == "AbC_d-9")
    }

    @Test func unknownFragmentParamsIgnored() {
        let parsed = Pairing.parse("https://r.example/pair#c=ABC123&x=1&fp=FP&y=2")
        #expect(parsed?.certFingerprint == "FP")
        #expect(parsed?.code == "ABC123")
    }

    @Test func nativeRouteHintCorrectsBrowserLinkWithCustomPorts() {
        let parsed = Pairing.parse(
            "http://relay.lan:9080/pair#c=ABC123&fp=PIN&native=https%3A%2F%2Frelay.lan%3A9443"
        )
        #expect(parsed?.relayUrl == "https://relay.lan:9443")
        #expect(parsed?.certFingerprint == "PIN")
    }

    @Test func legacyDefaultBrowserPortIsCorrectedForNativePairing() {
        let parsed = Pairing.parse("http://192.168.1.20:8786/pair#c=ABC123&fp=PIN")
        #expect(parsed?.relayUrl == "https://192.168.1.20:8787")
    }

    @Test func rejectsDetachedCodesAndNonWebLinks() {
        #expect(Pairing.parse("  abc12345 ") == nil)
        #expect(Pairing.parse("tabsend://pair#c=abc123") == nil)
        #expect(Pairing.parse("   ") == nil)
    }

    @Test func trailingSlashesAndPairSuffixStripped() {
        #expect(Pairing.parse("https://r.example/pair/#c=Z9")?.relayUrl == "https://r.example")
        #expect(Pairing.parse("https://r.example/#c=Z9")?.relayUrl == "https://r.example")
    }

    @Test func linkReemitsFingerprint() {
        #expect(
            Pairing.link(relayUrl: "https://r.example/", code: "ABC123", certFingerprint: "FP")
                == "https://r.example/pair#c=ABC123&fp=FP"
        )
        #expect(
            Pairing.link(relayUrl: "https://r.example", code: "ABC123", certFingerprint: nil)
                == "https://r.example/pair#c=ABC123"
        )
    }
}

struct ProtocolCheckTests {
    private func config(protocolVersion: Int?, min: Int?, recommended: Int?) throws -> ServerConfigResponse {
        let json: [String: Any?] = [
            "protocol": protocolVersion,
            "minClientProtocol": min,
            "recommendedClientProtocol": recommended,
        ]
        let data = try JSONSerialization.data(withJSONObject: json.compactMapValues { $0 })
        return try Wire.decoder.decode(ServerConfigResponse.self, from: data)
    }

    @Test func ok() throws {
        #expect(ProtocolCheck.check(try config(protocolVersion: 3, min: 3, recommended: 3)) == .ok)
    }

    @Test func absentFieldsMeanAnOldRelay() throws {
        let result = ProtocolCheck.check(try config(protocolVersion: nil, min: nil, recommended: nil))
        #expect(result.blocks)
        #expect(ProtocolCheck.message(result)?.contains("older version") == true)
    }

    @Test func clientTooOld() throws {
        let result = ProtocolCheck.check(try config(protocolVersion: 5, min: 5, recommended: 5))
        #expect(result.blocks)
        #expect(ProtocolCheck.message(result)?.contains("too old for that relay") == true)
    }

    @Test func outdatedDoesNotBlock() throws {
        let result = ProtocolCheck.check(try config(protocolVersion: 3, min: 3, recommended: 4))
        #expect(!result.blocks)
        #expect(ProtocolCheck.message(result) != nil)
    }
}

struct WireTests {
    @Test func sendPayloadOmitsNilFields() throws {
        let payload = SendPayload(url: "https://x.example", sentAt: "2026-07-28T00:00:00.000Z")
        let json = String(decoding: try Wire.encoder.encode(payload), as: UTF8.self)
        #expect(!json.contains("title"))
        #expect(!json.contains("favicon"))
        #expect(!json.contains("historyOf"))
        #expect(!json.contains("null"))
    }

    @Test func registerRequestShape() throws {
        let request = RegisterRequest(
            label: "iPhone", deviceName: "iPhone", e2ePubkey: "PUB", pairingCode: "ABC123"
        )
        let json = try #require(
            try JSONSerialization.jsonObject(with: Wire.encoder.encode(request)) as? [String: Any]
        )
        #expect(json["kind"] as? String == "mobile")
        #expect(json["platform"] as? String == "ios")
        #expect(json["browser"] == nil)
        #expect((json["pushSubscription"] as? [String: Any])?["transport"] as? String == "none")
        #expect(json["pairingCode"] as? String == "ABC123")
    }

    @Test func endpointToleratesUnknownEnumValuesAndFields() throws {
        let json = """
        {"id":"e1","groupId":"g1","kind":"mobile","browser":"zen","platform":"fuchsia",
         "label":"L","e2ePubkey":"PK","presence":"online",
         "lastSeenAt":"2026-07-28T00:00:00.000Z","createdAt":"2026-07-28T00:00:00.000Z",
         "someFutureField":42}
        """
        let endpoint = try Wire.decoder.decode(Endpoint.self, from: Data(json.utf8))
        #expect(endpoint.platform == "fuchsia")
        #expect(endpoint.isOnline)
    }

    @Test func unknownStreamEventTypeDecodes() throws {
        let event = try Wire.decoder.decode(
            StreamEvent.self,
            from: Data(#"{"type":"hologram","weird":true}"#.utf8)
        )
        #expect(event.type == "hologram")
    }

    @Test func wireDateFormat() throws {
        let date = try #require(WireDate.date(from: "2026-07-18T12:34:56.000Z"))
        #expect(WireDate.string(from: date) == "2026-07-18T12:34:56.000Z")
        // Non-fractional timestamps parse too.
        #expect(WireDate.date(from: "2026-07-18T12:34:56Z") != nil)
    }
}
