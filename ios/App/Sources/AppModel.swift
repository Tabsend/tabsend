import Foundation
import SwiftUI
import UIKit
import TabsendKit

/// Central app state: registration, endpoint list, stream lifecycle, and the
/// join/unpair/pair-another flows. The behavioural model mirrors the Android
/// MainActivity + TabsendApp pair.
@MainActor
final class AppModel: ObservableObject {
    static let shared = AppModel()

    let store: TabsendStore = AppGroupStore()

    @Published var registration: Registration?
    @Published var endpoints: [Endpoint] = []
    @Published var joining = false
    @Published var banner: String?
    /// A pairing deep link opened while unpaired; JoinView consumes it.
    @Published var pendingDeepLink: Pairing.Parsed?

    private var stream: StreamClient?
    private var deliverer: Deliverer?

    /// The tabs still on this phone because the relay hasn't taken them, newest
    /// first. Kept SEPARATE from any "waiting for <device>" count: that counts
    /// tabs the relay already HAS and is holding for a sleeping target, and its
    /// source is the relay's own outbox, which is unreachable exactly when tabs
    /// start piling up here. During an outage it reads zero (INTERACTION_FLOWS §4b).
    @Published var heldTabs: [OutboundItem] = []
    /// Where `heldTabs` stand against this phone's device watch (P-15 item 3):
    /// which are waiting for a new device, and where they may go.
    @Published private(set) var heldTargets = HeldTargets(watch: nil, list: [], selfId: nil)
    /// The standing relay-outage line, or nil while the relay is answering (or
    /// has only just gone quiet — there is a 30 s grace).
    @Published var relayOutage: String?
    /// True when notifications are off, which makes `heldTabs` the ONLY surface
    /// a waiting or failed send has.
    @Published var notificationsDenied = false
    /// The group's history, batch-grouped and newest first [0028]: sent and
    /// received in one timeline, including transfers this phone was neither end
    /// of. The grouped form rather than the raw list: every reader of it wants
    /// groups, and grouping in one place keeps the screen free of list logic.
    @Published var historyGroups: [HistoryGroup] = []
    /// How many received tabs have not been opened yet — the badge on the way in,
    /// so the screen advertises itself exactly when it has something to offer.
    /// Counted from the inbox, which is where "opened" is actually recorded.
    @Published var unopenedReceived = 0
    /// True when the wake path can be offered at all [0032]: this build knows a
    /// forwarder AND the paired relay says it has one. Both have to hold, so the
    /// settings section appears only where the toggle would do something.
    @Published var wakePathAvailable = false
    /// The P-5 opt-out, read the way a toggle wants it: on means instant delivery.
    @Published var instantDeliveryOn = true
    /// False once the relay has told us it does not know ADR-0028's routes. An app
    /// updates itself and a self-hosted relay is updated by hand, so this is a
    /// normal state to sit in, not a failure — the screen explains it instead of
    /// showing an empty list with no reason for being empty.
    @Published var relayKeepsHistory = true
    /// Devices that joined since this phone's baseline and that the user has not
    /// answered yet (PLANS.md P-10), oldest first. One banner each on the home
    /// screen until "Yes, it's mine" or "Remove it".
    @Published var newDeviceNotices: [NewDeviceNotice] = []
    /// The first look (GH6): the other devices in the first list, waiting for one answer.
    @Published var reviewDevices: [NewDeviceNotice] = []
    /// Announced as new, never answered, then gone from the list (GH7), until dismissed.
    @Published var vanishedDevices: [NewDeviceNotice] = []

    private init() {
        registration = store.registration
        endpoints = store.cachedEndpoints
        RelayHealthTracker.install(store: store)
        Reachability.shared.start()
        refreshSendState()
        refreshHistory()
        refreshWakeState()
        refreshNewDevices()
    }

    // MARK: new devices (PLANS.md P-10)

    /// Re-read the unanswered notices. Local only: the rule itself runs wherever a
    /// device list is fetched (`refreshEndpoints`, and the drain, in the
    /// foreground and in the background).
    func refreshNewDevices() {
        newDeviceNotices = NewDevices.unconfirmed(store: store)
        reviewDevices = NewDevices.review(store: store)
        vanishedDevices = NewDevices.vanished(store: store)
        // An answer, a removal or a new list changes where a held tab may go.
        refreshHeldTargets()
    }

    /// "All of these are mine". Clears the card on this phone only.
    func confirmReview() {
        NewDevices.answerReview(store: store)
        refreshNewDevices()
    }

    /// Dismiss one "joined, then disappeared" notice on this phone only.
    func dismissVanished(id: String) {
        NewDevices.dismissVanished(id: id, store: store)
        refreshNewDevices()
    }

    /// "Yes, it's mine". Clears the banner on this phone only: answers are not
    /// synced, because a compromised relay could then answer for the user.
    func confirmNewDevice(id: String) {
        NewDevices.dismiss(id: id, store: store)
        refreshNewDevices()
    }

    /// Remove another device from the group, from its row or from its banner.
    ///
    /// A relay that answers "not found" means it is already gone, which is what
    /// was asked for, so that counts as done. Returns false (and says why in
    /// `banner`) only when the device may still be in the group.
    @discardableResult
    func removeDevice(id: String) async -> Bool {
        guard let api, let reg = registration, id != reg.endpointId else { return false }
        do {
            // The relay said yes; only the relay says the device is gone. The removal is
            // written into the watch here rather than waiting for a list to show it, so a
            // relay that keeps the device listed cannot keep it on the history key (X13).
            try await NewDevices.removeFromGroup(id: id, api: api, store: store)
        } catch let error as ApiError {
            banner = error.message
            return false
        } catch {
            banner = relayUnreachableBanner()
            return false
        }
        endpoints.removeAll { $0.id == id }
        store.cachedEndpoints = endpoints
        ShareSuggestions.sync(endpoints: endpoints, store: store)
        refreshNewDevices()
        return true
    }

    // MARK: the wake path [0032]

    /// Re-read what the wake path currently is. Cheap and local: no network.
    ///
    /// The registration is re-read too, because `WakePath` writes the relay's forwarder
    /// hint onto it: without this the model would hold a copy from before the hint
    /// arrived and the next rename would write that stale copy back.
    func refreshWakeState() {
        if let fresh = store.registration, fresh != registration { registration = fresh }
        wakePathAvailable = WakePath.isConfigured
            && WakePath.relayAdvertisesForwarder(store: store)
        instantDeliveryOn = !store.instantDeliveryOptOut
    }

    /// Tell the relay which transport this phone is on now. One heartbeat, which is
    /// where a stored subscription is rewritten [0032].
    func rotateWakeTransport() async {
        guard let api else { return }
        await WakePath.heartbeat(store: store, api: api)
        refreshWakeState()
    }

    /// The P-5 opt-out, both directions.
    ///
    /// Turning it OFF disconnects the doorbell at both ends rather than just stopping
    /// the phone from listening: the wake token is revoked at the forwarder, the local
    /// copy goes, Apple is told to stop, and the relay is moved back to
    /// `{transport:"none"}` on the same beat. A relay left holding a token nobody
    /// answers would keep spending wakes on a phone that asked not to be rung.
    ///
    /// Turning it ON asks Apple for a token again; the mint and the rotation follow
    /// from the delegate callback, so there is nothing to await here.
    func setInstantDelivery(_ on: Bool) async {
        store.instantDeliveryOptOut = !on
        instantDeliveryOn = on
        if on {
            RemoteNotifications.registerIfEnabled()
        } else {
            await WakePath.revoke(store: store)
            RemoteNotifications.stop()
        }
        await rotateWakeTransport()
    }

    /// Rebuild the merged history [0028]. Called on foreground, after every drain,
    /// and whenever the screen appears — arrivals, sends and opens all happen while
    /// no view is looking.
    ///
    /// The cache is merged with the inbox HERE rather than only when the relay
    /// answers, so a tab that just arrived is on the screen immediately instead of
    /// waiting for the next history fetch to notice it.
    func refreshHistory() {
        guard let reg = registration else {
            historyGroups = []
            unopenedReceived = 0
            return
        }
        let items = History.merge(
            relay: store.history,
            inbox: store.inbox,
            selfEndpointId: reg.endpointId,
            selfLabel: reg.label
        )
        historyGroups = Inbox.group(items)
        unopenedReceived = store.inbox.filter { $0.openedAt == nil }.count
    }

    /// Stamp received tabs opened, then republish. Used by the row tap and by a
    /// notification tap, which is the case that matters: on iOS the tap comes
    /// back through the app, so unlike Android no trampoline is needed to see it.
    func markReceivedOpened(_ ids: [String]) {
        guard !ids.isEmpty else { return }
        store.updateInbox { Inbox.markOpened($0, ids: Set(ids), at: Date()) }
        refreshHistory()
    }

    /// Re-send a tab that never arrived, to the device it was meant for.
    ///
    /// Possible only because the source kept its plaintext — which is ADR-0028's
    /// point: before it, the sending device dropped the tab the moment the relay
    /// accepted, so there was nothing left to try again with.
    ///
    /// Returns the line to show rather than setting `banner`: the history screen is
    /// pushed on top of the one that renders banners, so the answer would otherwise
    /// appear behind the user and be stale by the time they saw it.
    @discardableResult
    func sendAgain(_ item: HistoryItem) async -> String {
        // The button is hidden for a link that fails the open check; this refuses
        // it too, so no other path can re-send one (`History.sendAgainPayload`).
        guard let again = History.sendAgainPayload(item), let api else { return Feedback.sendFailed }
        guard let target = endpoints.first(where: { $0.id == item.targetEndpointId }) else {
            return "That device isn't in your group any more."
        }
        let result = await Sender.send(payload: again, to: target, store: store, api: api)
        refreshSendState()
        return result.banner.headline
    }

    /// Re-read the two send-side truths the paired screen owes the user: whether
    /// the relay is answering, and which tabs are stuck behind it. Cheap, and
    /// called on every foreground and after every drain, because both can change
    /// while the app isn't looking (the share extension is a separate process).
    func refreshSendState() {
        heldTabs = store.outboundQueue.sorted { lhs, rhs in lhs.createdAt > rhs.createdAt }
        refreshHeldTargets()
        let now = Date()
        if let health = RelayHealthTracker.shared.current(),
           RelayHealth.isDown(health, now: now),
           let reg = registration {
            relayOutage = Feedback.relayDownLine(
                relayUrl: reg.relayUrl,
                sinceMinutes: health.minutesSinceLastOk(now: now)
            )
        } else {
            relayOutage = nil
        }
        // This list and the "Waiting to send" notices in Notification Center are
        // the same claim on two surfaces, so they are reconciled together:
        // anything the list no longer shows must not still be sitting there
        // saying the relay is unreachable. The flush does this too — here as well
        // because opening the app is the moment a stale notice is most obviously
        // wrong, and because a foreground drain may not run at all.
        // A tab waiting for a new device has no true "Waiting to send" notice.
        let held = SendNotifications.waitingIds(heldTabs)
        Task { await SendNotifications.reconcilePending(held: held) }
        Task { notificationsDenied = !(await Notifications.enabled()) }
    }

    /// Abandon held tabs, from the swipe on the waiting list (§4f).
    ///
    /// A pure local delete: nothing is transmitted, because there is nothing to
    /// retract. Be honest about what it cannot do — an item whose POST is in
    /// flight at this instant may still be accepted and delivered, and a tab the
    /// relay has already taken is beyond any of this. It stops Tabsend trying;
    /// it is not an unsend.
    ///
    /// Takes offsets rather than an id because that is what `.onDelete` hands
    /// over, and they index `heldTabs` — the SORTED list on screen — not the
    /// stored queue, so they are resolved to ids here before anything is
    /// removed. `refreshSendState` then re-reads the queue and reconciles the
    /// "Waiting to send" notices against it, which is what takes the abandoned
    /// tab's own notice out of Notification Center (§4d).
    func cancelHeld(at offsets: IndexSet) {
        for id in offsets.map({ heldTabs[$0].id }) {
            Sender.cancelHeld(id: id, store: store)
        }
        refreshSendState()
    }

    /// Re-read where the held tabs stand against this phone's device watch: which
    /// devices it has accepted, which it removed itself, and where a tab whose
    /// device is gone may go. From the store, the same reading the flush makes, so
    /// the screen and the flush cannot disagree about a tab (P-15 item 3, L3).
    /// Run with the send state and with the notices, the two moments either
    /// half of it can change.
    private func refreshHeldTargets() {
        heldTargets = HeldTargets(store: store)
    }

    /// Whether a held tab waits for a device that has left the group (P-15 item 3):
    /// one this phone's watch no longer accepts, or the relay refused.
    func isTargetGone(_ item: OutboundItem) -> Bool {
        heldTargets.isGone(item)
    }

    /// The line under a held tab whose device is gone. "Was removed" only when
    /// this phone removed it; otherwise the relay is all this phone has to go on.
    func goneLine(for item: OutboundItem) -> String {
        GoneTargetCopy.removedLine(item.targetLabel, removedHere: heldTargets.removedHere(item))
    }

    /// The devices a held tab can be moved to (`NewDevices.heldTabChoices`): the
    /// devices this phone has accepted, never itself, a console, or one still
    /// waiting for an answer. The device the tab was for is among them once it is
    /// accepted again.
    func retargetChoices(for item: OutboundItem) -> [Endpoint] {
        heldTargets.choices.sorted { $0.label.lowercased() < $1.label.lowercased() }
    }

    /// Send a held tab whose device is gone to another device instead. It is
    /// sealed again for that device and queued in the old one's place; the drain
    /// then sends it now, or when the relay is back. `Sender.retargetHeld` checks
    /// the choice again against the store, so a stale menu cannot get past it.
    func retargetHeld(_ item: OutboundItem, to target: Endpoint) {
        Sender.retargetHeld(id: item.id, to: target, store: store)
        refreshSendState()
        Task { await drain() }
    }

    var api: ApiClient? {
        guard let reg = registration else { return nil }
        return ApiClient(
            relayUrl: reg.relayUrl,
            deviceToken: reg.deviceToken,
            certFingerprint: reg.certFingerprint
        )
    }

    // MARK: lifecycle

    /// Foreground entry point: drain, refresh devices, hold the stream open.
    func appBecameActive() {
        guard registration != nil else { return }
        // A background wake may have found a new device while the app was away.
        refreshNewDevices()
        startStream()
        Task {
            await drain()
            await refreshEndpoints()
            await heartbeat()
            refreshSendState()
            refreshHistory()
        }
        BackgroundRefresh.schedule()
    }

    func appWentToBackground() {
        Task { await stopStream() }
        BackgroundRefresh.schedule()
    }

    // MARK: joining

    struct JoinInput {
        var pairingLink: String
        var deviceName: String
    }

    func join(_ input: JoinInput) async {
        joining = true
        defer { joining = false }

        guard let parsed = Pairing.parse(input.pairingLink) else {
            banner = "Enter a complete pairing link."
            return
        }
        let label = input.deviceName.trimmingCharacters(in: .whitespacesAndNewlines)

        do {
            let outcome = try await Registrar.join(
                relayUrl: parsed.relayUrl,
                pairingCode: parsed.code,
                label: label.isEmpty ? Self.defaultDeviceName : label,
                deviceName: Self.defaultDeviceName,
                certFingerprint: parsed.certFingerprint,
                store: store
            )
            registration = outcome.registration
            banner = ProtocolCheck.message(outcome.protocolResult) ?? "Linked"
            await Notifications.requestPermission()
            // Pairing is what turns the wake path on (P-5: no separate setting step).
            // `Registrar.join` has already registered the transport this phone can
            // honour; this covers the case where Apple had not delivered a device
            // token yet, which is normal on a first launch. The mint and the rotation
            // then follow from the delegate callback.
            RemoteNotifications.registerIfEnabled()
            refreshWakeState()
            appBecameActive()
        } catch let Registrar.JoinError.protocolBlocked(message) {
            banner = message
        } catch let Registrar.JoinError.api(error) {
            switch error.code {
            case "invalid_pairing_code":
                banner = "That pairing link is unknown, expired, or already used."
            // The group is full [0030]. The relay's own message names the number,
            // but `message` is written for a log and may change, and the fix is the
            // same on every client — so this is one of the two codes answered in
            // Tabsend's own words.
            case "limit_reached":
                banner = Feedback.deviceLimitLine
            default:
                banner = error.message  // includes group_exists [0022], whose message names the fix
            }
        } catch {
            banner = "Couldn't reach the relay. Check the URL and that your phone is on the same network."
        }
    }

    func unpair() async {
        if let reg = registration, let api {
            // Best effort: remove ourselves from the group; local wipe regardless.
            try? await api.removeEndpoint(id: reg.endpointId)
        }
        await stopStream()
        // Retire the wake token BEFORE the local wipe, because the wipe is what takes
        // the token away (`forwarder/PROTOCOL.md` §3.3, ADR-0032: revocation is the
        // app's to do, with the credential it holds, and no relay may do it for us).
        // Best-effort and fire-and-forget: a forwarder that is down leaves a token that
        // rings a phone which will simply have nothing to fetch, and the next pairing
        // replaces it anyway.
        await WakePath.revoke(store: store)
        store.clear()
        // No group, so no device may keep a share-sheet slot. Mandatory rather
        // than tidy-up: a donation outlives the data behind it, so a device that
        // left would go on being offered by a sheet that can no longer send to it.
        ShareSuggestions.clear()
        // The queue went with the store, so every promise made about it is now
        // unkeepable and must not be left standing in Notification Center.
        await SendNotifications.clearAll()
        RelayHealthTracker.shared.reset()
        registration = nil
        endpoints = []
        newDeviceNotices = []
        reviewDevices = []
        vanishedDevices = []
        banner = nil
        refreshSendState()
        // `store.clear()` took the history and the group keyring with everything
        // else. Unlike the extension, whose equivalent path also serves a relay
        // ADDRESS change and so must not throw the list away, this is the explicit
        // destructive action, and it already discards the send queue for the same
        // reason.
        relayKeepsHistory = true
        refreshHistory()
        // Ask Apple for the device token again. It is the same token, delivered
        // straight back from the system's cache, and asking is what puts it where the
        // NEXT pairing can find it — otherwise a re-pair in this same session would
        // have nothing to mint a wake token from until the app was relaunched.
        RemoteNotifications.registerIfEnabled()
        refreshWakeState()
    }

    // MARK: paired actions

    func refreshEndpoints() async {
        guard let api else { return }
        // Every device-list fetch runs the new-device rule (P-10), and only a list
        // the rule accepted (one that contains this phone) is cached or shown.
        if let fetched = try? await api.listEndpoints() {
            let observed = NewDevices.observe(fetched, store: store)
            guard let fresh = observed.accepted else { return }
            endpoints = fresh
            await Notifications.postNewDevices(observed.joined)
            refreshNewDevices()
            // The one place the app learns the device list, so it is also the one
            // place the share sheet's suggestions can learn about a pairing, an
            // unpair or a rename without a job of their own.
            ShareSuggestions.sync(endpoints: fresh, store: store)
        }
    }

    /// Presence ping, and the place a push transport rotates [0032].
    func heartbeat() async {
        guard let api, registration != nil else { return }
        await WakePath.heartbeat(store: store, api: api)
        refreshWakeState()
    }

    func rename(to newLabel: String) async {
        guard let api, let reg = registration else { return }
        let label = newLabel.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !label.isEmpty else { return }
        do {
            _ = try await api.rename(endpointId: reg.endpointId, label: label)
            var updated = reg
            updated.label = label
            store.registration = updated
            registration = updated
            await refreshEndpoints()
        } catch let error as ApiError {
            banner = error.message
        } catch {
            banner = relayUnreachableBanner()
        }
    }

    struct MintedPairing {
        var link: String
        var qrLink: String
        var expiresAt: String
    }

    func mintPairing() async -> MintedPairing? {
        guard let api, registration != nil else { return nil }
        do {
            let response = try await api.createPairing()
            return MintedPairing(
                link: response.browserLink ?? response.link,
                qrLink: response.link,
                expiresAt: response.expiresAt
            )
        } catch let error as ApiError {
            banner = error.message
            return nil
        } catch {
            banner = relayUnreachableBanner()
            return nil
        }
    }

    /// Why a relay round-trip failed, for the paired screen's own actions
    /// (rename, mint a code). Both used to say "No connection", which is the
    /// misdiagnosis ADR-0008's amendment exists to remove: for a self-hoster the
    /// phone's network is usually fine and the relay is the thing that is down,
    /// so the address is what they can act on.
    private func relayUnreachableBanner() -> String {
        guard let reg = registration else { return Feedback.sendFailed }
        return Feedback.failureLine(
            SendFailure.classifyTransport(
                URLError(.cannotConnectToHost), relayUrl: reg.relayUrl
            )
        )
    }

    // MARK: receive path

    func drain() async {
        let deliverer = deliverer ?? Deliverer(store: store) { payload, messageId in
            await Notifications.postLink(payload: payload, messageId: messageId)
        }
        self.deliverer = deliverer
        if let api {
            // Say so either way when tabs that were stuck resolve: the person was
            // told "waiting to send" and then walked away. The queue is re-read
            // AFTER the flush so the notices left standing are exactly the tabs
            // still waiting.
            let report = await Sender.flushOutbound(store: store, api: api)
            await SendNotifications.announceFlush(report, held: SendNotifications.waitingIds(store.outboundQueue))
        }
        let summary = await deliverer.drain()
        // The drain fetched the device list, so it ran the new-device rule too.
        await Notifications.postNewDevices(summary.joinedDevices)
        refreshNewDevices()
        // The group-key and history pass rides the same wake, after the drain so
        // it can use the endpoint list the drain just fetched and the new-device
        // rule accepted, rather than asking the relay for the same answer twice.
        // Never the cache: no list this drain could vouch for means no pass.
        // Best-effort throughout: an older relay has none of these routes, and
        // sending and receiving are untouched either way.
        if let api, let accepted = summary.endpoints {
            let report = await GroupHistorySync.run(
                store: store, api: api, endpoints: accepted
            )
            if !report.offline { relayKeepsHistory = report.relayKeepsHistory }
            await GroupHistorySync.announce(report, store: store)
        }
        refreshSendState()
        // A drain is exactly when a received tab appears, so republish the list.
        refreshHistory()
    }

    private func startStream() {
        guard stream == nil, let reg = registration else { return }
        let client = StreamClient(
            relayUrl: reg.relayUrl,
            deviceToken: reg.deviceToken,
            certFingerprint: reg.certFingerprint
        ) { [weak self] event in
            await self?.handleStreamEvent(event)
        }
        stream = client
        Task { await client.start() }
    }

    private func stopStream() async {
        let client = stream
        stream = nil
        await client?.stop()
    }

    private func handleStreamEvent(_ event: StreamClient.Event) async {
        switch event {
        case .messageWaiting:
            await drain()
        case .endpointsChanged:
            await refreshEndpoints()
        case .connected:
            // A socket that has just come up is the earliest and most certain
            // evidence there is that the relay is answering again. Ignoring it
            // left tabs held here waiting on a foreground drain or an
            // opportunistic background refresh — so a relay that came back could
            // stay "waiting to send" in Notification Center long after it had.
            await drain()
        case .disconnected:
            break
        }
    }

    // MARK: naming

    static var defaultDeviceName: String {
        let name = UIDevice.current.name.trimmingCharacters(in: .whitespacesAndNewlines)
        return name.isEmpty ? "iPhone" : name
    }

    static var buildInfo: String {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?"
        return "Tabsend \(version)"
    }
}
