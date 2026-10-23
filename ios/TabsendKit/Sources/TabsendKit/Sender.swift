import Foundation

/// Sending, mirroring android/.../send/Sender.kt. Client-generated UUID ids
/// make retries idempotent; the sealed envelope (never plaintext) is queued
/// until the relay has actually accepted it.
public enum Sender {
    /// Ids this process is POSTing right now.
    ///
    /// A send enqueues its item before the POST, so a drain running in that window
    /// would POST the same id (harmless, the relay dedupes) and then count it as a
    /// recovered tab — announcing "Sent the tab that was waiting" on top of the
    /// sheet's own confirmation. Skipping in-flight ids keeps the flush to tabs
    /// that are genuinely stuck.
    ///
    /// Process-local, so it does NOT span the app and the share extension. That
    /// leaves one narrow case (the app draining at the same instant the extension
    /// posts) where the duplicate message can still appear; a duplicate message is
    /// the acceptable side of this trade, a lost tab is not.
    private static let inFlight = InFlightIds()

    final class InFlightIds: @unchecked Sendable {
        private let lock = NSLock()
        private var ids = Set<String>()
        func insert(_ id: String) { lock.withLock { _ = ids.insert(id) } }
        func remove(_ id: String) { lock.withLock { _ = ids.remove(id) } }
        /// Take the id, or report that someone else already holds it.
        func claim(_ id: String) -> Bool { lock.withLock { ids.insert(id).inserted } }
    }

    /// Outcome of a single send.
    ///
    /// `failure` is the classified reason it didn't land, and its ABSENCE is the
    /// only licence a surface has to say "Sent". A tab held in the outbound queue
    /// is `ok` — it isn't lost — but it is not sent, so it carries a recoverable
    /// failure and renders as "Waiting to send" (ADR-0008 amendment).
    public struct Result: Sendable {
        public var ok: Bool
        /// Accepted by the relay, but the target is asleep: opens when it wakes.
        public var queued: Bool
        public var targetLabel: String?
        /// Title of the tab this outcome is about, so several sends stay distinct.
        public var title: String?
        public var failure: SendFailure?
        /// The message id, so a notification can be keyed to this one send.
        public var messageId: String

        public var banner: SendBanner {
            Feedback.banner(ok: ok, queued: queued, targetLabel: targetLabel, title: title, failure: failure)
        }
    }

    /// What one queue flush achieved, so the queue can report on itself.
    public struct FlushReport: Sendable {
        public var sent: Int = 0
        public var firstTitle: String?
        /// Items that stayed queued because the relay still isn't answering.
        public var stillHeld: Int = 0
        /// Items the relay finally REFUSED, so they left the queue unsent.
        ///
        /// Reported for the same reason the rest of this change exists: the user
        /// was told "waiting to send" and walked away. A tab that then dies on a
        /// 401 or a `not_in_group` when the relay comes back would otherwise
        /// vanish with nothing said, which is the original bug with a longer fuse.
        public var dropped: Int = 0
        public var firstDroppedTitle: String?
        public var firstDroppedTargetLabel: String?
        public var firstDroppedFailure: SendFailure?
        /// Tabs this pass found waiting for a device that has left the group
        /// (PLANS.md P-15 item 3). They stay queued, unposted, until the user
        /// picks another device in the app, and are announced once, here.
        public var newlyGone: Int = 0
        public var firstGoneTitle: String?
        public var firstGoneTargetLabel: String?
        /// This phone removed the first one's device itself, so the notice may say
        /// it "was removed"; otherwise it "is no longer in your group" (L3).
        public var firstGoneRemovedHere = false
        public var recovered: Bool { sent > 0 }
    }

    public static func send(
        payload: SendPayload,
        to target: Endpoint,
        store: TabsendStore,
        api: ApiClient
    ) async -> Result {
        guard let identity = store.identity, let reg = store.registration else {
            return Result(
                ok: false, queued: false, targetLabel: target.label, title: payload.title,
                failure: .relayUnauthorized, messageId: ""
            )
        }
        let envelope: Envelope
        do {
            let plaintext = try Wire.encoder.encode(payload)
            envelope = try Sealer.seal(
                plaintext: plaintext,
                targetPublicKeyBase64: target.e2ePubkey,
                senderPrivateKeyBase64: identity.privateKey,
                senderKeyId: identity.keyId
            )
        } catch {
            // Sealing failed (a malformed target key from an older or misbehaving
            // relay). NOT .nothingToSend: that blames the page the user shared and
            // tells them to share something else, when the page was fine.
            return Result(
                ok: false, queued: false, targetLabel: target.label, title: payload.title,
                failure: .relayError(code: "internal"), messageId: ""
            )
        }

        // The group-history copy [0028]: the same tab, sealed once under the key
        // the whole group holds instead of per target. Best-effort by design — no
        // key yet (a group that has not been given one, or this device joined a
        // minute ago) means the field is simply absent, which every relay and
        // client already treats as a pre-0028 sender. A send never fails over its
        // own bookkeeping.
        //
        // The share extension seals this too, and can: the ring is in the Keychain
        // under the shared access group, exactly like the identity private key the
        // envelope above was just sealed with. Where that read fails the extension
        // cannot send at all, so history and sending are never inconsistent.
        let history = historyBlob(payload: payload, target: target, store: store)

        let id = UUID().uuidString.lowercased()
        let item = OutboundItem(
            id: id, targetEndpointId: target.id, envelope: envelope,
            createdAt: payload.sentAt, title: payload.title, url: payload.url,
            targetLabel: target.label, history: history
        )

        // Queue FIRST, then POST, then dequeue on a definite answer. A share
        // extension is killed the moment the host app decides it is done, and a
        // tab that was never queued and never accepted is simply lost with no
        // record anywhere — the queue would only notice nothing at all on the
        // next app open. Replaying is safe: the relay inserts on the
        // client-generated id with ON CONFLICT DO NOTHING, so a second POST of
        // the same id adds no duplicate row. This is why the send path needs no
        // background URLSession to be crash-safe.
        // Claim before enqueuing, not after: between the two the item would be
        // visible in the queue but unowned, and a concurrent flush could POST it
        // (harmless, the relay dedupes) and then announce it a second time on top
        // of this send's own report.
        inFlight.insert(id)
        defer { inFlight.remove(id) }
        // Bounding the queue is part of enqueuing it, not a separate sweep: this
        // is the moment the queue can grow, and the tabs it has to let go of are
        // announced rather than deleted quietly. Never the item just added —
        // eviction is oldest-first, and the newest is the one the user just
        // asked for.
        var enqueuePlan = OutboundQueue.Plan(keep: [OutboundItem]())
        store.updateOutbound { queue in
            let appended = queue.contains(where: { $0.id == id }) ? queue : queue + [item]
            enqueuePlan = OutboundQueue.plan(appended, now: Date())
            return enqueuePlan.keep
        }
        await announce(givenUp(enqueuePlan))

        do {
            let response = try await api.send(
                SendRequest(items: [
                    .init(id: id, targetEndpointId: target.id, envelope: envelope, history: history)
                ])
            )
            if let rejection = response.rejected.first(where: { $0.id == id }) {
                let failure = SendFailure.relayRejected(
                    reason: rejection.reason, limit: rejection.limit
                )
                if failure.isRecoverable {
                    // A per-group cap [0030] is the relay saying "not this
                    // minute", not "no": the send window rolls over on its own,
                    // and the queue caps drain as the target reads its tabs. The
                    // item was queued BEFORE the POST, so holding it is simply
                    // not dequeuing — the ordinary flush (a background refresh or
                    // the next app open) retries it, and the queue's own bounds
                    // still apply, so this can neither spin nor grow without limit.
                    var prefs = store.sourcePrefs
                    prefs.recordSend(to: target.id)
                    store.sourcePrefs = prefs
                    return Result(
                        ok: true, queued: false, targetLabel: target.label,
                        title: payload.title, failure: failure, messageId: id
                    )
                }
                // The relay answered and refused this item; retrying won't help.
                dequeue(store, id)
                return Result(
                    ok: false, queued: false, targetLabel: target.label, title: payload.title,
                    failure: failure, messageId: id
                )
            }
            dequeue(store, id)
            var prefs = store.sourcePrefs
            prefs.recordSend(to: target.id)
            store.sourcePrefs = prefs
            return Result(
                ok: true, queued: !target.isOnline, targetLabel: target.label,
                title: payload.title, failure: nil, messageId: id
            )
        } catch let error as ApiError {
            // The relay answered with an error envelope. Only the CODE travels into
            // the copy — `message` is written for a log and the contract says it may
            // change (shared/types.ts §10b).
            //
            // A refusal is final, so the item leaves the queue: retrying identical
            // input fails identically. But a 429 or a 5xx is NOT a refusal, and
            // dropping the tab there was silent data loss — a reverse proxy in
            // front of a restarting relay answers HTML 502.
            let failure = SendFailure.classify(apiError: error)
            if failure.isRecoverable {
                var prefs = store.sourcePrefs
                prefs.recordSend(to: target.id)
                store.sourcePrefs = prefs
                return Result(
                    ok: true, queued: false, targetLabel: target.label,
                    title: payload.title, failure: failure, messageId: id
                )
            }
            dequeue(store, id)
            return Result(
                ok: false, queued: false, targetLabel: target.label, title: payload.title,
                failure: failure, messageId: id
            )
        } catch {
            // The relay never answered. The item stays queued, and the tone is
            // pending, not "Sent" — and not "No connection" either unless the
            // error or the OS says there is genuinely no network.
            var prefs = store.sourcePrefs
            prefs.recordSend(to: target.id)
            store.sourcePrefs = prefs
            return Result(
                ok: true, queued: false, targetLabel: target.label, title: payload.title,
                failure: .classifyTransport(error, relayUrl: reg.relayUrl), messageId: id
            )
        }
    }

    /// Flush the outbound queue.
    ///
    /// An item leaves the queue only on a DEFINITE answer: accepted, or refused in
    /// a way that retrying cannot change. Silence, a 429, any 5xx and a per-group
    /// cap refusal [0030] all keep it for the next flush — including the HTML 502 a
    /// proxy returns for a restarting relay, which used to empty the whole queue in
    /// one pass.
    @discardableResult
    public static func flushOutbound(store: TabsendStore, api: ApiClient) async -> FlushReport {
        let stored = store.outboundQueue
        guard !stored.isEmpty else { return FlushReport() }

        // Ids this pass settled one way or another. Removing exactly these, rather
        // than writing back a whole list computed before the network calls, is
        // what keeps a send queued mid-flush from being clobbered.
        var settled = Set<String>()
        var report = FlushReport()

        // Give up on the dead ones BEFORE anything is POSTed, and this half is
        // the one that ends the failure the queue could not end by itself: an
        // envelope one relay 5xxes forever is never competing with newer sends
        // for the size cap, so nothing but its own age can finish it. Without
        // this it is retried on every flush and every background refresh, for as
        // long as the app is installed. They ride out on the same report as a
        // relay's own refusals, because from the user's side both are "a tab you
        // were promised is not going".
        let plan = OutboundQueue.plan(stored, now: Date())
        for (item, failure) in givenUp(plan) {
            settled.insert(item.id)
            report.dropped += 1
            if report.firstDroppedFailure == nil {
                report.firstDroppedTitle = item.title
                report.firstDroppedTargetLabel = item.targetLabel
                report.firstDroppedFailure = failure
            }
        }

        // A tab whose device has left the group is not posted again: the relay
        // would only refuse it, and the old flush then dropped the tab. It waits,
        // flagged, for the user to pick another device (P-15 item 3). "Left" means
        // no longer accepted by this phone's watch, not merely missing from the
        // relay's list: a device this phone removed is gone even while the relay
        // lists it (L3). A list's flag lifts once the device is accepted again, and
        // that tab goes out in this pass like any other.
        let targets = HeldTargets(store: store)
        let marked = OutboundQueue.markGoneTargets(plan.keep, acceptedIds: targets.acceptedIds)
        // Each tab's flag as this pass leaves it, by id: set by a list, set by the
        // relay, or lifted. Only these are written back, onto the queue as it is
        // then, so a re-target or a send made while this pass was posting keeps
        // whatever it wrote.
        var flags: [String: (targetGone: Bool?, goneFromList: Bool?)] = [:]
        func announceGone(_ item: OutboundItem) {
            if report.newlyGone == 0 {
                report.firstGoneTitle = item.title
                report.firstGoneTargetLabel = item.targetLabel
                report.firstGoneRemovedHere = targets.removedHere(item)
            }
            report.newlyGone += 1
        }

        for (before, item) in zip(plan.keep, marked) {
            if item.targetGone != before.targetGone || item.goneFromList != before.goneFromList {
                flags[item.id] = (item.targetGone, item.goneFromList)
            }
            if item.targetGone == true {
                // Said once: a tab flagged before this pass was announced then.
                if before.targetGone != true { announceGone(item) }
                continue
            }
            // A background refresh's expiration handler cancels this task, and
            // `api.send` is a real await, so cancellation lands in the generic
            // `catch` below and would otherwise be absorbed — churning through the
            // rest of the queue after the OS asked us to stop. Un-attempted items
            // aren't in `settled`, so they simply stay queued for the next flush.
            if Task.isCancelled { break }
            // Claim the id: this both skips a send still POSTing and stops two
            // concurrent flushes from each counting the same tab as recovered.
            guard inFlight.claim(item.id) else {
                report.stillHeld += 1
                continue
            }
            defer { inFlight.remove(item.id) }
            do {
                let response = try await api.send(
                    SendRequest(items: [
                        .init(
                            id: item.id, targetEndpointId: item.targetEndpointId,
                            envelope: item.envelope, history: item.history
                        )
                    ])
                )
                // A per-item rejection is still HTTP 200. Most are final, so the
                // item leaves the queue either way — but only an acceptance counts
                // towards the "your tabs went out" announcement. A cap refusal
                // [0030] is the exception and stays queued: the cap clears itself,
                // so the next flush tries again, and announcing it would withdraw
                // a promise that is still being kept.
                if let rejection = response.rejected.first(where: { $0.id == item.id }) {
                    let failure = SendFailure.relayRejected(
                        reason: rejection.reason, limit: rejection.limit
                    )
                    if isTargetGoneReason(rejection.reason) {
                        // The relay says the device is gone. Keep the tab and flag
                        // it rather than dropping it: it can still go elsewhere.
                        // The relay's word, not a list's, so no list lifts it: it
                        // stays until the user moves the tab.
                        flags[item.id] = (true, nil)
                        if before.targetGone != true { announceGone(item) }
                    } else if failure.isRecoverable {
                        report.stillHeld += 1
                    } else {
                        settled.insert(item.id)
                        report.dropped += 1
                        if report.firstDroppedFailure == nil {
                            report.firstDroppedTitle = item.title
                            report.firstDroppedTargetLabel = item.targetLabel
                            report.firstDroppedFailure = failure
                        }
                    }
                } else {
                    settled.insert(item.id)
                    report.sent += 1
                    if report.firstTitle == nil { report.firstTitle = item.title }
                }
            } catch let error as ApiError {
                // A refusal is final and the item goes; "not now" keeps it. Without
                // this split one pass against a 502-ing relay emptied the entire
                // queue, the largest possible version of the bug this change exists
                // to prevent.
                let failure = SendFailure.classify(apiError: error)
                if failure.isRecoverable {
                    report.stillHeld += 1
                } else {
                    settled.insert(item.id)
                    report.dropped += 1
                    if report.firstDroppedFailure == nil {
                        report.firstDroppedTitle = item.title
                        report.firstDroppedTargetLabel = item.targetLabel
                        report.firstDroppedFailure = failure
                    }
                }
            } catch {
                report.stillHeld += 1 // relay still not answering: keep
            }
        }
        store.updateOutbound { current in
            current.filter { !settled.contains($0.id) }.map { item in
                guard let flag = flags[item.id] else { return item }
                var next = item
                next.targetGone = flag.targetGone
                next.goneFromList = flag.goneFromList
                return next
            }
        }
        return report
    }

    /// The relay's answer for a device that is not in the group. `not_in_group`
    /// is retired as an answer [0029], but an older relay may still say it, and
    /// it means the same thing here.
    static func isTargetGoneReason(_ reason: String) -> Bool {
        reason == "unknown_target" || reason == "not_in_group"
    }

    /// Send a held tab whose device is gone to `target` instead (PLANS.md P-15
    /// item 3). False, with the queue untouched, when there is nothing to move
    /// or nowhere it may go: the tab was cancelled or sent meanwhile, it has no
    /// stored address to seal again or one that is not an openable web link, or
    /// the target is not one of `NewDevices.heldTabChoices`.
    ///
    /// The old envelope is NEVER reused: it is sealed to the old device's key.
    /// The tab is sealed again from its plaintext (kept beside every held tab for
    /// the list) to the new device's key, with a new history blob naming the new
    /// device, and takes the old item's place in the queue. The caller then runs
    /// a flush, which delivers it now or when the relay is back.
    ///
    /// Only `target.id` is read. The device, and above all the key the tab is
    /// sealed to, come from the choices this phone's watch allows, worked out
    /// here from the store rather than taken from the caller: the relay decides
    /// when a held tab asks for a new device, and must not also decide which key
    /// it is sealed to (SECURITY_REVIEW L3). The address is checked as a link is
    /// before it is opened, so a held `javascript:` or `file:` address is never
    /// sealed for another device to open.
    @discardableResult
    public static func retargetHeld(id: String, to target: Endpoint, store: TabsendStore) -> Bool {
        guard let identity = store.identity, let reg = store.registration,
              let chosen = NewDevices.heldTabChoices(
                  store.newDeviceWatch, store.cachedEndpoints, selfId: reg.endpointId
              ).first(where: { $0.id == target.id }),
              let old = store.outboundQueue.first(where: { $0.id == id }),
              let url = old.url, LinkURLPolicy.openableURL(from: url) != nil
        else { return false }
        // The time the user first sent it, so the tab and its history row are
        // dated honestly and the queue's age bound still counts from then.
        let payload = SendPayload(url: url, title: old.title, sentAt: old.createdAt)
        guard let plaintext = try? Wire.encoder.encode(payload),
              let envelope = try? Sealer.seal(
                  plaintext: plaintext,
                  targetPublicKeyBase64: chosen.e2ePubkey,
                  senderPrivateKeyBase64: identity.privateKey,
                  senderKeyId: identity.keyId
              )
        else { return false }
        // No flag: the new device is one this phone has accepted.
        let moved = OutboundItem(
            id: UUID().uuidString.lowercased(), targetEndpointId: chosen.id,
            envelope: envelope, createdAt: old.createdAt, title: old.title, url: url,
            targetLabel: chosen.label,
            history: historyBlob(payload: payload, target: chosen, store: store)
        )
        var done = false
        store.updateOutbound { queue in
            // Read again inside the write: the queue may have moved on.
            guard queue.contains(where: { $0.id == id }) else { return queue }
            done = true
            return OutboundQueue.retarget(queue, id: id, replacement: moved)
        }
        if done {
            var prefs = store.sourcePrefs
            prefs.recordSend(to: target.id)
            store.sourcePrefs = prefs
        }
        return done
    }

    /// Extract the first http(s) URL from shared text; fall back to the whole text.
    public static func extractUrl(from text: String) -> String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        for token in trimmed.split(whereSeparator: { $0.isWhitespace }) {
            if token.hasPrefix("http://") || token.hasPrefix("https://") {
                return String(token)
            }
        }
        return trimmed
    }

    /// Abandon one held tab, at the user's request (INTERACTION_FLOWS §4f).
    ///
    /// A pure local delete: nothing is transmitted, because there is nothing to
    /// retract. The honest limit, which the swipe's wording respects too — this
    /// stops Tabsend TRYING. An item whose POST is in flight at this instant can
    /// still be accepted and delivered, and a tab the relay has already taken is
    /// long past anything this can reach. There is no unsend and this is not one.
    ///
    /// No announcement: the user just did it, and §4d's rule is about withdrawing
    /// a promise the user has not been watching. The standing notice for that
    /// message is taken down separately, by the caller's reconcile pass.
    public static func cancelHeld(id: String, store: TabsendStore) {
        store.updateOutbound { OutboundQueue.cancel($0, id: id) }
    }

    /// The tabs a plan gave up on, paired with the sentence to say about each.
    ///
    /// Expired first, so that when one pass manages to do both, the line the
    /// notification shows is the one about waiting too long — the cause a
    /// self-hoster can actually act on.
    private static func givenUp(_ plan: OutboundQueue.Plan<OutboundItem>) -> [(OutboundItem, SendFailure)] {
        plan.expired.map { ($0, SendFailure.gaveUp(reason: .tooOld)) }
            + plan.evicted.map { ($0, SendFailure.gaveUp(reason: .queueFull)) }
    }

    /// Say so. Never silent: the user was told "the tab is held here and sends
    /// itself once the relay answers again", and this is the moment that stops
    /// being true. Exactly the §4d rule — a promise is withdrawn out loud.
    private static func announce(_ given: [(OutboundItem, SendFailure)]) async {
        guard let (first, failure) = given.first else { return }
        await SendNotifications.postDropped(
            count: given.count,
            firstTitle: first.title,
            targetLabel: first.targetLabel,
            failure: failure
        )
    }

    private static func dequeue(_ store: TabsendStore, _ id: String) {
        store.updateOutbound { queue in queue.filter { $0.id != id } }
    }

    /// Seal the record of this send under the group's current history key [0028].
    ///
    /// The labels are snapshotted here rather than resolved when the row is read:
    /// a history entry has to still read correctly after a device is renamed or
    /// leaves the group, and the relay's routing row only carries ids.
    ///
    /// nil on any failure at all, including no key. There is nothing to report and
    /// nothing to retry: the tab itself is unaffected, and the next send under a
    /// key that has by then arrived records itself normally.
    static func historyBlob(
        payload: SendPayload, target: Endpoint, store: TabsendStore
    ) -> GroupSealed? {
        guard let key = Keyring.current(store.groupKeyring) else { return nil }
        let record = HistoryRecord(
            payload: payload,
            sourceLabelAtSend: store.registration?.label ?? "This phone",
            targetLabelAtSend: target.label
        )
        guard let plaintext = try? Wire.encoder.encode(record) else { return nil }
        return try? Sealer.sealGroup(
            plaintext: plaintext, groupKeyBase64: key.key, keyId: key.keyId
        )
    }
}
