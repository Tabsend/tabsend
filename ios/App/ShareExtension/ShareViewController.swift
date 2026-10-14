import UIKit
import SwiftUI
import Intents
import UniformTypeIdentifiers
import TabsendKit

/// Share-sheet target ("Send tab to"), mirroring android/.../send/ShareActivity.kt:
/// extract the URL, list targets (cached list when offline), chooser sorted
/// primary -> MRU -> label, presence decorates but never gates, feedback uses
/// the shared copy in a send banner (docs/APP_UI.md "Send toast"), then dismiss.
///
/// The sheet may also name a device up front, when the share came from one of the
/// donated suggestions ([ShareSuggestions]). That launches this same extension
/// with the intent attached, and the only difference it makes is skipping the
/// chooser below — capture, seal, send and feedback are one path either way.
final class ShareViewController: UIViewController {
    private let store = AppGroupStore()

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear

        // Sending is usually the first thing that notices an outage, and this is a
        // separate process from the app — so the verdict has to be recorded HERE
        // too, into the shared App Group store, or the app would open later with
        // nothing to explain itself with.
        RelayHealthTracker.install(store: store)
        Reachability.shared.start()
        // This is its own process, so the app's navigation-bar look has to be set
        // here too, before the hosting controller builds its bar.
        ThemeAppearance.apply()

        let host = UIHostingController(
            rootView: ShareRootView(
                store: store,
                pickedEndpointId: pickedEndpointId,
                loadShared: { [weak self] in await self?.extractShared() ?? nil },
                finish: { [weak self] in
                    self?.extensionContext?.completeRequest(returningItems: nil)
                }
            )
        )
        addChild(host)
        host.view.frame = view.bounds
        host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        host.view.backgroundColor = .clear
        view.addSubview(host.view)
        host.didMove(toParent: self)
    }

    /// The endpoint a suggestions-row pick named, if this share came from one of
    /// our donated conversations. The system hands the whole donated intent back
    /// on `extensionContext.intent`; anything else (the plain sheet entry, or an
    /// id we didn't mint) reads as nil and takes the chooser path.
    private var pickedEndpointId: String? {
        let intent = extensionContext?.intent as? INSendMessageIntent
        return SuggestionPlan.endpointId(ofConversation: intent?.conversationIdentifier)
    }

    /// Pulls a URL (public.url or plain text) + title out of the share items.
    private func extractShared() async -> SendPayload? {
        guard let items = extensionContext?.inputItems as? [NSExtensionItem] else { return nil }
        var url: String?
        var title: String?

        for item in items {
            if title == nil, let text = item.attributedContentText?.string, !text.isEmpty {
                title = text
            }
            for provider in item.attachments ?? [] {
                if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
                    let loaded = try? await provider.loadItem(forTypeIdentifier: UTType.url.identifier)
                    if let u = loaded as? URL {
                        url = u.absoluteString
                    } else if let d = loaded as? Data, let u = URL(dataRepresentation: d, relativeTo: nil) {
                        url = u.absoluteString
                    }
                } else if url == nil, provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
                    let loaded = try? await provider.loadItem(forTypeIdentifier: UTType.plainText.identifier)
                    if let text = loaded as? String {
                        url = Sender.extractUrl(from: text)
                    }
                }
            }
            if url != nil { break }
        }
        guard let url else { return nil }
        if title == url { title = nil }
        return SendPayload(url: url, title: title, sentAt: WireDate.string(from: Date()))
    }
}


private struct ShareRootView: View {
    let store: TabsendStore
    /// Non-nil when the share sheet already named a device (see [ShareSuggestions]).
    let pickedEndpointId: String?
    let loadShared: () async -> SendPayload?
    let finish: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @State private var payload: SendPayload?
    @State private var rows: [Chooser.Row] = []
    /// What is currently on offer in the suggestions row, so a send can feed its
    /// usage back to the right target and only to one that has a slot.
    @State private var plan: [SuggestionTarget] = []
    /// The device list `load()` built the sheet from. The re-sync after a send
    /// reuses it: this extension does not write the shared cache, so the cache
    /// may be older than what the sheet is showing.
    @State private var sheetEndpoints: [Endpoint] = []
    /// Why the chooser is on screen when a device had already been picked.
    @State private var notice: String?
    @State private var status: String?
    /// The send toast: "Sending to X…", then the classified outcome.
    @State private var toast: SendToastState?
    @State private var sending = false
    @State private var loaded = false
    /// Set once the request is completed, so the auto-dismiss and a Cancel tap
    /// landing together complete it only once.
    @State private var finished = false

    var body: some View {
        NavigationStack {
            Group {
                if let status {
                    resultView(status)
                } else if !loaded {
                    ProgressView()
                        .tint(Palette.muted)
                } else if store.registration == nil {
                    resultView("Tabsend isn't linked yet — open the app to pair this phone.")
                } else if rows.isEmpty {
                    resultView(Feedback.noDevices)
                } else {
                    targetList
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Palette.ground.ignoresSafeArea())
            // The banner drops in at the top, under the bar, like an AirDrop or
            // Apple Pay confirmation. It may cover the top of the list, which is
            // fine: once it is up the rows are disabled and the banner IS the
            // answer, so nothing under it is still asking to be tapped.
            .overlay(alignment: .top) {
                if let toast {
                    SendToast(state: toast, close: { close() })
                        .padding(.horizontal, 12)
                        .padding(.top, 8)
                        .transition(
                            reduceMotion
                                ? AnyTransition.opacity
                                : AnyTransition.move(edge: .top).combined(with: .opacity)
                        )
                }
            }
            .navigationTitle("Send tab to")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { close() }
                }
            }
        }
        .tint(Palette.accent)
        .task { await load() }
    }

    private func close() {
        guard !finished else { return }
        finished = true
        finish()
    }

    // MARK: chooser

    private var targetList: some View {
        List {
            if let payload {
                Section {
                    tabPreview(payload)
                        .panelRow()
                } footer: {
                    if let notice {
                        Text(notice)
                            .foregroundColor(Palette.muted)
                    }
                }
            }
            Section {
                ForEach(rows) { row in
                    Button {
                        Task { await send(to: row) }
                    } label: {
                        DeviceRow(
                            name: row.endpoint.label,
                            symbol: row.endpoint.themeSymbol,
                            kind: row.endpoint.kindWord,
                            // Only a list we just fetched can vouch for presence.
                            presence: row.presenceKnown ? (row.online ? .online : .offline) : .unknown,
                            isMain: row.isPrimary,
                            isStale: row.stale
                        )
                    }
                    // Plain, and one per row: inside a List row, buttons with the
                    // default style tint the whole label and fire on any tap.
                    .buttonStyle(.plain)
                    // One send per sheet: once a toast is up, the outcome is the
                    // answer, as the old outcome screen was.
                    .disabled(sending || toast != nil)
                    .panelRow()
                }
            } header: {
                PanelSectionHeader("Devices")
            }
        }
        .groupedListBackground()
    }

    /// What is being sent: the page title, then its URL in the system monospace.
    private func tabPreview(_ payload: SendPayload) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            if let title = payload.title, !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                Text(title)
                    .font(.body.weight(.semibold))
                    .foregroundColor(.primary)
                    .lineLimit(2)
            }
            Text(payload.url)
                .font(.footnote.monospaced())
                .foregroundColor(Palette.muted)
                .lineLimit(2)
                .truncationMode(.middle)
        }
        .padding(.vertical, 4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }

    private func resultView(_ text: String) -> some View {
        VStack(spacing: 20) {
            Text(text)
                .font(.body)
                .foregroundColor(.primary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            Button {
                close()
            } label: {
                Text("Done")
                    .frame(maxWidth: 240)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .tint(Palette.accentFill)
        }
        .padding(24)
    }

    // MARK: load + send

    @MainActor
    private func load() async {
        payload = await loadShared()
        guard payload != nil else {
            // Same sentence as Android's share sheet, from the shared table.
            status = Feedback.failureLine(.nothingToSend)
            loaded = true
            return
        }
        guard let reg = store.registration else {
            loaded = true
            return
        }
        let api = ApiClient(
            relayUrl: reg.relayUrl,
            deviceToken: reg.deviceToken,
            certFingerprint: reg.certFingerprint
        )
        // Live list when reachable, cached list when not (offline sends queue).
        // A list without this phone counts as no answer, exactly as it does for
        // the rule: the relay is wrong or this phone was removed, and neither is a
        // list to send from.
        let fresh = (try? await api.listEndpoints()).flatMap {
            NewDevices.listIncludesSelf($0, selfId: reg.endpointId) ? $0 : nil
        }
        // The new-device rule (PLANS.md P-10) is deliberately NOT run here:
        // running it would announce from a process that is torn down as soon as
        // the sheet closes. So this list is used for the sheet only and NOT
        // written to the shared cache. The cache is what the app shows and what
        // the rule has judged; a list the rule never saw must not land there.
        let endpoints = fresh ?? store.cachedEndpoints
        sheetEndpoints = endpoints
        rows = Chooser.build(
            endpoints: endpoints,
            selfEndpointId: reg.endpointId,
            prefs: store.sourcePrefs,
            // Only a list we just fetched can vouch for presence. Falling back to
            // the cache means the relay didn't answer, and its last verdict may be
            // hours old — the rows say "Status unknown" rather than repeating it.
            presenceKnown: fresh != nil
        )
        plan = ShareSuggestions.sync(endpoints: endpoints, store: store)
        loaded = true

        // A suggestions-row pick already named the device, so asking again would
        // undo the whole point of the suggestion. If that device is no longer in
        // the list — unpaired since the donation, or missing from a cached list we
        // couldn't refresh — fall through to the chooser rather than guess at a
        // substitute; sending a tab to the wrong device is not a recoverable
        // mistake.
        guard let wanted = pickedEndpointId else { return }
        if let picked = rows.first(where: { $0.id == wanted }) {
            await send(to: picked)
            return
        }
        notice = "That device isn't in your group any more — pick another."
    }

    /// Send, then report — in the toast AND, when it matters, as a notification.
    ///
    /// The sheet can only speak while it is on screen, and it is torn down the
    /// moment this extension completes its request. So the notification is the
    /// surface that outlives it, and only the two outcomes where the relay HAS the
    /// tab are allowed to dismiss themselves: a tab still on this phone, or one
    /// that failed, has something to say that the user needs to be able to read,
    /// so that toast stays until Close.
    @MainActor
    private func send(to row: Chooser.Row) async {
        guard !sending, toast == nil else { return }
        guard let payload, let reg = store.registration else { return }
        sending = true
        let label = row.endpoint.label
        show(.sending(label: label, title: Self.tabName(payload)))
        let api = ApiClient(
            relayUrl: reg.relayUrl,
            deviceToken: reg.deviceToken,
            certFingerprint: reg.certFingerprint
        )
        let result = await Sender.send(payload: payload, to: row.endpoint, store: store, api: api)
        // Re-donate the set FIRST, then report the usage — the order is
        // load-bearing. The send just moved this target to the head of the MRU, so
        // the sync both keeps the sheet agreeing with the chooser about what's on
        // top and, when the target was previously below the cut, gives it a slot
        // at all. Reporting first would spend the usage donation on a target the
        // plan doesn't yet contain (dropped, by design) and then let the sync's own
        // donations land afterwards and take the recency the send had earned.
        //
        // This is the only usage signal the system gets for a send made from our
        // own chooser. A pick made in the suggestions row is recorded by the
        // platform itself, so that path is merely counted twice.
        if result.ok {
            plan = ShareSuggestions.sync(endpoints: sheetEndpoints, store: store)
            ShareSuggestions.reportUsed(row.endpoint.id, in: plan)
        }
        let banner = result.banner
        await SendNotifications.postOutcome(banner, messageId: result.messageId)
        let outcome = SendToastState.outcome(
            of: banner,
            relayHoldsForAsleepTarget: result.queued,
            label: label,
            tabName: Self.tabName(payload)
        )
        show(outcome)
        sending = false
        UIAccessibility.post(notification: .announcement, argument: outcome.announcement)

        // Only "the relay has it" dismisses itself; the spec's ~2.5 s and ~3 s,
        // stretched while VoiceOver is reading so the announcement can finish.
        guard let seconds = outcome.autoDismissSeconds else { return }
        let extra: Double = UIAccessibility.isVoiceOverRunning ? 2 : 0
        try? await Task.sleep(nanoseconds: UInt64((seconds + extra) * 1_000_000_000))
        close()
    }

    @MainActor
    private func show(_ state: SendToastState) {
        withAnimation(reduceMotion ? nil : Animation.easeOut(duration: 0.25)) {
            toast = state
        }
    }

    /// What the toast calls the tab: its title, else its host, else the URL.
    private static func tabName(_ payload: SendPayload) -> String {
        if let title = payload.title, !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return title
        }
        return URL(string: payload.url)?.host ?? payload.url
    }
}
