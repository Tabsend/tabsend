#if os(macOS)
import Testing
import Foundation
import Security
@testable import TabsendKit

/// Verifies the SPKI fingerprint implementation against openssl on macOS,
/// using freshly generated self-signed certs like the relay's tls.ts makes.
struct TlsPinTests {
    private func run(_ args: [String], stdin: Data? = nil) throws -> Data {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = args
        let inPipe = Pipe(), outPipe = Pipe()
        process.standardInput = inPipe
        process.standardOutput = outPipe
        process.standardError = Pipe()
        try process.run()
        if let stdin {
            inPipe.fileHandleForWriting.write(stdin)
        }
        inPipe.fileHandleForWriting.closeFile()
        let out = outPipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        try #require(process.terminationStatus == 0, "command failed: \(args)")
        return out
    }

    private func check(keyArgs: [String]) throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("tabsend-tlspin-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let certPath = dir.appendingPathComponent("cert.pem").path
        let keyPath = dir.appendingPathComponent("key.pem").path

        _ = try run(
            ["openssl", "req", "-x509", "-nodes", "-subj", "/CN=tabsend-relay",
             "-days", "3650", "-keyout", keyPath, "-out", certPath] + keyArgs
        )

        // Expected pin: base64url-nopad(SHA-256(SPKI DER)) computed via openssl.
        let spkiPem = try run(["openssl", "x509", "-in", certPath, "-pubkey", "-noout"])
        let spkiDer = try run(["openssl", "pkey", "-pubin", "-outform", "DER"], stdin: spkiPem)
        let shaOut = try run(["shasum", "-a", "256"], stdin: spkiDer)
        let hexDigest = String(decoding: shaOut, as: UTF8.self).prefix(64)
        var digestBytes: [UInt8] = []
        var index = hexDigest.startIndex
        while index < hexDigest.endIndex {
            let next = hexDigest.index(index, offsetBy: 2)
            digestBytes.append(try #require(UInt8(hexDigest[index..<next], radix: 16)))
            index = next
        }
        let expectedPin = Base64X.encodeUrlNoPad(digestBytes)

        // Actual pin via our Security-framework path.
        let certPem = try String(contentsOfFile: certPath, encoding: .utf8)
        let base64 = certPem
            .replacingOccurrences(of: "-----BEGIN CERTIFICATE-----", with: "")
            .replacingOccurrences(of: "-----END CERTIFICATE-----", with: "")
            .replacingOccurrences(of: "\n", with: "")
        let der = try #require(Data(base64Encoded: base64))
        let certificate = try #require(SecCertificateCreateWithData(nil, der as CFData))

        #expect(TlsPin.fingerprint(of: certificate) == expectedPin)
        #expect(expectedPin.count == 43)
        #expect(TlsPin.matches(pin: expectedPin, certificate: certificate))
        #expect(TlsPin.matches(pin: expectedPin + "=", certificate: certificate), "padded pin tolerated")
        #expect(!TlsPin.matches(pin: String(expectedPin.reversed()), certificate: certificate))
        #expect(!TlsPin.matches(pin: "not-a-pin", certificate: certificate))
    }

    @Test func rsa2048LikeRelayDefault() throws {
        try check(keyArgs: ["-newkey", "rsa:2048"])
    }

    @Test func ecP256() throws {
        try check(keyArgs: ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1"])
    }
}
#endif
