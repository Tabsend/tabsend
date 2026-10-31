import Foundation
import TabsendKit

/// The one background sequence, run by both things that can wake this app without a
/// person: a `BGAppRefreshTask` (opportunistic, iOS decides when) and a silent push
/// from the wake-up forwarder (ADR-0032, PLANS P-5).
///
/// Factored rather than written twice on purpose. The two wakes differ only in what
/// scheduled them and how completion is reported; what has to happen inside is
/// identical, and a second copy would be a second place for the order to drift —
/// heartbeat, then flush what is waiting to go out, then drain what came in, then the
/// group-key and history pass, which needs the endpoint list the drain just refreshed.
enum BackgroundDrain {
    struct Outcome: Sendable {
        var delivered = 0
        /// The relay never answered. Distinguishes "nothing was waiting" from "we
        /// could not ask", which is the difference iOS wants back from both wakes.
        var offline = false
    }

    /// The ceiling on one background wake.
    ///
    /// iOS gives a silent push around 30 seconds and expects the completion handler
    /// inside that; overrunning it repeatedly is how an app gets its background wakes
    /// throttled. 25 leaves room to report before the axe falls. Nothing is lost when
    /// it bites: the tabs are still on the relay and the next wake, or the next
    /// opening of the app, collects them (`forwarder/PROTOCOL.md` §7).
    static let budget: TimeInterval = 25

    /// Run the sequence, bounded by `budget`.
    ///
    /// Structured on purpose. The sequence and the timer are CHILDREN of whichever task
    /// called this, so the one thing both callers need is true: cancelling the caller
    /// cancels the network calls. An earlier version put the sequence in a `Task` of its
    /// own and awaited its value, which looked the same and was not — awaiting a
    /// non-throwing `Task` ignores the awaiting task's cancellation, so a
    /// `BGAppRefreshTask` expiring left the drain running past the end of its window.
    ///
    /// Cancellation is cooperative — the URLSession calls inside honour it — so both an
    /// expiry and the budget below stop the work at its next await rather than at once,
    /// and the partial result is what gets reported.
    static func run(store: TabsendStore, budget: TimeInterval = Self.budget) async -> Outcome {
        // A background wake may be the first thing to run in a fresh process, so
        // reachability recording has to be armed here as well as in AppModel.
        RelayHealthTracker.install(store: store)
        Reachability.shared.start()
        guard let reg = store.registration else { return Outcome() }

        return await withTaskGroup(of: Step.self) { group in
            group.addTask { .finished(await sequence(store: store, reg: reg)) }
            group.addTask {
                do {
                    try await Task.sleep(nanoseconds: UInt64(max(0, budget) * 1_000_000_000))
                } catch {
                    return .timerStopped  // the sequence answered first, or the caller left
                }
                return .budgetSpent
            }

            // Nothing delivered, and the relay not declared unreachable: the honest
            // report if the budget bites before the sequence gets anywhere at all.
            var outcome = Outcome()
            while let step = await group.next() {
                switch step {
                case .finished(let done):
                    outcome = done
                    group.cancelAll()  // there is nothing left to time
                case .budgetSpent:
                    // Stop the sequence. It answers with what it managed on the way out,
                    // and that answer is the next thing this loop picks up.
                    group.cancelAll()
                case .timerStopped:
                    break
                }
            }
            return outcome
        }
    }

    /// Which of the two children reported, and what it had to say.
    private enum Step: Sendable {
        case finished(Outcome)
        case budgetSpent
        case timerStopped
    }

    private static func sequence(store: TabsendStore, reg: Registration) async -> Outcome {
        let api = ApiClient(
            relayUrl: reg.relayUrl,
            deviceToken: reg.deviceToken,
            certFingerprint: reg.certFingerprint
        )
        // Heartbeat first, and through `WakePath` so the beat also rotates this
        // device's push transport [0032]: a relay that gained or lost a forwarder
        // since the last one is answered with the transport it can honour.
        await WakePath.heartbeat(store: store, api: api)
        // The whole point of running in the background: a queue that resolves
        // twenty minutes after the share sheet closed still gets to say so —
        // and, just as importantly, gets to take down the notice that said it
        // was still waiting.
        let flush = await Sender.flushOutbound(store: store, api: api)
        await SendNotifications.announceFlush(flush, held: SendNotifications.waitingIds(store.outboundQueue))
        let deliverer = Deliverer(store: store) { payload, messageId in
            await Notifications.postLink(payload: payload, messageId: messageId)
        }
        let summary = await deliverer.drain()
        // The drain's device-list fetch ran the new-device rule (P-10); a device
        // added while the app was closed is announced from here.
        await Notifications.postNewDevices(summary.newDevices)
        // A reset that waits (P-18 item 12). The relay wakes every phone when one is
        // scheduled, the same content-free way it does for a tab, so this wake may be
        // the only chance to say so before the user next opens the app.
        if let reset = await GroupReset.refresh(api: api, store: store) {
            await Notifications.postGroupReset(reset)
        }
        // The other reason to run in the background: a tab whose TTL expired
        // without ever being picked up [0028]. The user was told "Sent", which
        // was true, and nothing would otherwise ever tell them it did not
        // arrive. Uses the endpoint list the drain just fetched and the new-device
        // rule accepted, never the cache, and skips the pass when there is none.
        if let accepted = summary.endpoints {
            let history = await GroupHistorySync.run(
                store: store, api: api, endpoints: accepted
            )
            await GroupHistorySync.announce(history, store: store)
        }
        return Outcome(delivered: summary.delivered, offline: summary.offline)
    }
}
