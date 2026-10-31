import Testing
import Foundation
@testable import TabsendKit

/// The stream's dead-connection check [2026-10-27], mirroring Android's HeartbeatTest: a
/// socket the relay has stopped answering is given up within one ping and its answer
/// window. Runs on a fake clock that `sleep` moves forward.
struct HeartbeatTests {
    /// A fake relay socket and clock. `answeringUntil`: the relay answers pings sent
    /// before this time, and nothing after. `refuseAfter`: sends fail after that many pings.
    final class Fake: @unchecked Sendable {
        var now: UInt64 = 0
        var lastHeardAt: UInt64 = 0
        var pings: [UInt64] = []
        var answeringUntil = UInt64.max
        var refuseAfter = Int.max
        var stopAt = UInt64.max
        /// Frames that are not pongs: (time, arrives) pairs applied as the clock passes them.
        var otherFrames: [UInt64] = []

        func sleep(_ ms: UInt64) throws {
            let target = now + ms
            for t in otherFrames where t > now && t <= target { lastHeardAt = t }
            now = target
            if now >= stopAt { throw CancellationError() }
        }

        func sendPing() -> Bool {
            guard pings.count < refuseAfter else { return false }
            pings.append(now)
            if now < answeringUntil { lastHeardAt = now + 50 }
            return true
        }

        func run() async -> Heartbeat.End {
            await Heartbeat.run(
                now: { self.now },
                lastHeardAt: { self.lastHeardAt },
                sleep: { try self.sleep($0) },
                sendPing: { self.sendPing() }
            )
        }
    }

    @Test func anAnsweringRelayKeepsTheStreamOnePingEvery30Seconds() async {
        let fake = Fake()
        fake.stopAt = 10 * 60_000
        #expect(await fake.run() == .closed)
        #expect(fake.pings.count == 20)
        #expect(fake.pings[1] - fake.pings[0] == Heartbeat.pingIntervalMs)
    }

    @Test func aRelayThatStopsAnsweringIsGivenUpWithin40Seconds() async {
        let fake = Fake()
        let diedAt: UInt64 = 5 * 60_000 + 1
        fake.answeringUntil = diedAt
        #expect(await fake.run() == .silent)
        #expect(fake.now - diedAt <= Heartbeat.pingIntervalMs + Heartbeat.pongTimeoutMs)
    }

    @Test func anyFrameCountsAsAnAnswerNotOnlyPong() async {
        let fake = Fake()
        fake.answeringUntil = 0
        // A frame lands 3 s after each ping (pings at 20 s, 50 s, ...), though no pong does.
        fake.otherFrames = (0..<20).map { UInt64($0) * Heartbeat.pingIntervalMs + 23_000 }
        fake.stopAt = 10 * 60_000
        #expect(await fake.run() == .closed)
        #expect(fake.pings.count == 20)
    }

    @Test func aFailedSendEndsTheLoopAsClosed() async {
        let fake = Fake()
        fake.refuseAfter = 3
        #expect(await fake.run() == .closed)
        #expect(fake.pings.count == 3)
    }
}
