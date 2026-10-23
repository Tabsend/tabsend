import Testing
import Foundation
@testable import TabsendKit

/// Is a relay address one that only works on its home network (PLANS.md P-15
/// item 4)? Runs every case in `shared/vectors/home-network.json`, the same file
/// `shared/src/homenetwork.test.ts` and Android's `HomeNetworkTest.kt` run, so the
/// three clients cannot drift apart. Read from the repo, not copied into
/// Resources, for the same reason as `NewDevicesTests.swift`.

private struct HomeNetworkVectors: Decodable {
    struct Case: Decodable {
        var url: String
        var home: Bool
        var why: String
    }
    var cases: [Case]
}

private func loadHomeNetworkVectors() throws -> HomeNetworkVectors {
    var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
    let relative = "shared/vectors/home-network.json"
    while dir.path != "/" {
        let candidate = dir.appendingPathComponent(relative)
        if FileManager.default.fileExists(atPath: candidate.path) {
            return try JSONDecoder().decode(HomeNetworkVectors.self, from: Data(contentsOf: candidate))
        }
        dir = dir.deletingLastPathComponent()
    }
    throw CocoaError(.fileNoSuchFile, userInfo: [NSFilePathErrorKey: relative])
}

struct HomeNetworkTests {

    @Test func everySharedVectorCase() throws {
        let vectors = try loadHomeNetworkVectors()
        #expect(vectors.cases.contains { $0.home })
        #expect(vectors.cases.contains { !$0.home })
        for c in vectors.cases {
            #expect(HomeNetwork.isHomeNetworkRelay(c.url) == c.home, "\(c.url): \(c.why)")
        }
    }

    @Test func theHintSaysWhyAndWhatToDoWithoutAnEmDash() {
        #expect(HomeNetwork.hint.contains("home network"))
        #expect(HomeNetwork.hint.contains("VPN"))
        #expect(!HomeNetwork.hint.contains("—"))
    }
}
