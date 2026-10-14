import Testing
import Foundation
@testable import TabsendKit

/// The guard on the completions iOS wants answered exactly once: a background refresh
/// task's `setTaskCompleted(success:)` and a silent push's fetch completion handler.
/// Both are reached from two directions at once (the work finished / the time ran out),
/// which is the whole reason this exists.
struct OnceLatchTests {
    @Test func onlyTheFirstClaimSucceeds() {
        let latch = OnceLatch()
        #expect(latch.claim())
        #expect(!latch.claim())
        #expect(!latch.claim())
    }

    @Test func twoLatchesDoNotShareAClaim() {
        #expect(OnceLatch().claim())
        #expect(OnceLatch().claim())
    }

    /// The real shape of the race: a drain finishing on one thread while an expiration
    /// handler fires on another. Exactly one of them may report.
    @Test func exactlyOneClaimantWinsUnderContention() async {
        let latch = OnceLatch()
        let winners = await withTaskGroup(of: Bool.self) { group in
            for _ in 0..<200 { group.addTask { latch.claim() } }
            var count = 0
            for await claimed in group where claimed { count += 1 }
            return count
        }
        #expect(winners == 1)
    }
}
