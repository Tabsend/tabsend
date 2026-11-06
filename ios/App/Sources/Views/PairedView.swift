import SwiftUI
import TabsendKit

/// Paired state, the Home tab: anything asking for attention, the latest tabs, your
/// devices and pair a device. Settings and the whole timeline have their own tabs.
///
/// A grouped inset `List` (docs/APP_UI.md, "Phones: native-leaning"): panels on
/// the tinted ground, standard section headers and separators, SF Symbols on
/// coloured tiles, native controls. Held tabs keep their swipe-to-delete and the
/// whole screen keeps pull-to-refresh.
struct PairedView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.openURL) private var openURL
    @Environment(\.dynamicTypeSize) private var typeSize

    /// "See all" switches to the History tab.
    @Binding var tab: MainTabsView.Tab

    @State private var minted: AppModel.MintedPairing?
    /// The device the remove confirmation is asking about, from its row.
    @State private var removing: RemoveTarget?

    struct RemoveTarget: Identifiable {
        let id: String
        let label: String
    }

    /// Tabs newest first, the same merged timeline the History tab shows [0028].
    private var latest: [HistoryItem] {
        History.latest(model.historyGroups.flatMap { $0.items })
    }

    var body: some View {
        List {
            if let reg = model.registration {
                // A reset that waits comes before everything (P-18 item 12, layout A):
                // if it was not the user, this is the one thing on the screen that
                // cannot wait, and any one device stopping it is enough.
                if let reset = model.pendingReset {
                    Section {
                        groupResetCard(reset)
                            .panelRow()
                    }
                }
                // The trial ended and sending is paused (screen 8). Only on the relay's word,
                // never from a date: the app says what happened and that an email has the next
                // step, with no price and no button to pay (Apple, outside the US).
                if model.servicePlan == .trialEnded {
                    Section {
                        trialEndedCard
                            .panelRow()
                    }
                }
                // A device that joined and then disappeared is the one device notice
                // with a card of its own (GH7): it is no longer in the list below. A
                // device that joined is told once, by notification, and its row is like
                // any other (P-23), so nothing repeats the list.
                ForEach(model.vanishedDevices) { notice in
                    Section {
                        vanishedCard(notice)
                            .panelRow()
                    }
                }

                // Grouped only to keep each ViewBuilder block under ten children;
                // a Group adds nothing to the List itself.
                Group {
                    // Two separate blocks on purpose (wireframe option A). "The relay
                    // is down" and "we are still holding these tabs" are different
                    // facts, and the list has to read correctly on its own: the phone
                    // having been in a tunnel isn't an outage, but the tabs are
                    // waiting just the same. Merging them would let one hide the other.
                    if let outage = model.relayOutage {
                        Section {
                            HStack(alignment: .top, spacing: 12) {
                                SymbolTile(systemName: "exclamationmark.triangle", color: Palette.waitingFill)
                                Text(outage)
                                    .font(.subheadline)
                                    .foregroundColor(.primary)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                            .padding(.vertical, 2)
                            .accessibilityElement(children: .combine)
                            .panelRow()
                        }
                    }

                    if !model.heldTabs.isEmpty {
                        Section {
                            ForEach(model.heldTabs, id: \.id) { item in
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(Feedback.heldTabLabel(title: item.title, url: item.url))
                                        .font(.body)
                                        .foregroundColor(.primary)
                                    // Naming the destination is the point of the row:
                                    // which tab, going where. The label was captured
                                    // when the send was made, since the envelope is
                                    // sealed and can't be asked who it was for.
                                    if model.isTargetGone(item) {
                                        // Its device left the group, so "to <device>"
                                        // would point nowhere. Say so, and offer the
                                        // devices this phone has accepted (P-15 item 3).
                                        Text(model.goneLine(for: item))
                                            .font(.subheadline)
                                            .foregroundColor(Palette.muted)
                                        let others = model.retargetChoices(for: item)
                                        if others.isEmpty {
                                            Text(GoneTargetCopy.noOtherDevice)
                                                .font(.subheadline)
                                                .foregroundColor(Palette.muted)
                                        } else if item.url != nil {
                                            Menu(GoneTargetCopy.sendToMenu) {
                                                ForEach(others) { endpoint in
                                                    Button(endpoint.label) {
                                                        model.retargetHeld(item, to: endpoint)
                                                    }
                                                }
                                            }
                                            .font(.subheadline)
                                        }
                                    } else if let label = item.targetLabel {
                                        Text("to \(label)")
                                            .font(.subheadline)
                                            .foregroundColor(Palette.muted)
                                    }
                                }
                                .padding(.vertical, 2)
                                .panelRow()
                            }
                            // The way out of a wait, on the affordance a List already
                            // gives every row. Until this the list was read-only, so a
                            // tab aimed at a relay that was never coming back could
                            // only be watched. It is a pure local delete and it cannot
                            // unsend, which is why the footer says "stop waiting for"
                            // rather than offering to cancel a send outright.
                            .onDelete { model.cancelHeld(at: $0) }
                        } header: {
                            PanelSectionHeader(verbatim: Feedback.heldTabsHeading(model.heldTabs.count))
                        } footer: {
                            VStack(alignment: .leading, spacing: 6) {
                                Text("These are still on this phone. Each one sends itself as soon as your relay answers again. Swipe a tab away to stop waiting for it.")
                                    .foregroundColor(Palette.muted)
                                // With notifications denied this list is the ONLY place
                                // a failed or held send shows up, so it stops being
                                // optional and the user should know that.
                                if model.notificationsDenied {
                                    Text("Notifications are off for Tabsend, so this list is the only place a waiting or failed send shows up. Turn them on in Settings to be told when a tab doesn't land.")
                                        .foregroundColor(Palette.danger)
                                }
                            }
                        }
                    }
                }

                Section {
                    latestRow(selfEndpointId: reg.endpointId)
                } header: {
                    HStack {
                        PanelSectionHeader("Latest")
                        Spacer()
                        Button("See all") { tab = .history }
                            .font(.subheadline)
                            .textCase(nil)
                            .tint(Palette.accent)
                    }
                }

                Section {
                    ForEach(model.endpoints) { endpoint in
                        deviceRow(endpoint, selfId: reg.endpointId)
                    }
                    if !hasOtherDevices(selfId: reg.endpointId) {
                        Text("No other devices yet.")
                            .font(.body)
                            .foregroundColor(Palette.muted)
                            .panelRow()
                    }
                } header: {
                    PanelSectionHeader("Your devices")
                } footer: {
                    // A newcomer's first list: this phone and nothing else. Say what to do next.
                    if !hasOtherDevices(selfId: reg.endpointId) {
                        Text("Add your computer or another phone to send your first link.")
                            .foregroundColor(Palette.muted)
                    }
                }

                // The free trial and its end (screen 5), on the relay's word.
                if case let .trial(endsAt) = model.servicePlan {
                    Section {
                        HStack {
                            Text(GroupService.trialLabel)
                                .font(.body)
                                .foregroundColor(.primary)
                            Spacer()
                            Text(GroupService.trialValue(endsAt: endsAt))
                                .font(.body)
                                .foregroundColor(Palette.muted)
                        }
                        .accessibilityElement(children: .combine)
                        .panelRow()
                    } header: {
                        PanelSectionHeader(verbatim: GroupService.sectionTitle)
                    } footer: {
                        Text(GroupService.trialFooter)
                            .foregroundColor(Palette.muted)
                    }
                }

                Section {
                    // This screen's one primary action: a system prominent button,
                    // full width, sitting on the ground rather than in a panel.
                    Button {
                        Task {
                            if let pairing = await model.mintPairing() {
                                minted = pairing
                            }
                        }
                    } label: {
                        Label("Add a device", systemImage: "plus")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                    .tint(Palette.accentFill)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets())
                } footer: {
                    if let banner = model.banner {
                        Text(banner)
                            .foregroundColor(.primary)
                    }
                }
            }
        }
        .groupedListBackground()
        .tightSections()
        .tint(Palette.accent)
        .refreshable {
            await model.refreshEndpoints()
            await model.heartbeat()
            // The heartbeat above is what refreshes the relay verdict; reading it
            // back here is what turns a pull-to-refresh into a way to check.
            model.refreshSendState()
        }
        // Local only (no network): picks up tabs that arrived while another screen
        // was showing, so the received rows are current whenever they are on screen.
        .onAppear { model.refreshHistory() }
        // The same confirmation the extension and the console ask, word for word.
        .confirmationDialog(
            removing.map { target in
                String(
                    localized: "Remove “\(target.label)” from the group?",
                    comment: "Title of the confirmation dialog before removing a device. %@ is the device name, in curly quotes."
                )
            } ?? "",
            isPresented: Binding(
                get: { removing != nil },
                set: { if !$0 { removing = nil } }
            ),
            titleVisibility: .visible,
            presenting: removing
        ) { target in
            Button("Remove", role: .destructive) {
                Task { await model.removeDevice(id: target.id) }
            }
            Button("Cancel", role: .cancel) {}
        } message: { target in
            Text("“\(target.label)” will stop receiving tabs and disappear from every device’s chooser. Any tabs still queued for it are dropped. It must be re-paired to rejoin.")
        }
        .sheet(item: $minted) { pairing in
            PairSheetView(pairing: pairing)
                .presentationDragIndicator(.visible)
        }
    }

    // MARK: your devices

    /// Whether the list holds a device besides this phone.
    private func hasOtherDevices(selfId: String) -> Bool {
        model.endpoints.contains { $0.id != selfId }
    }

    /// One row of "Your devices". Split out of `body` to keep that expression small
    /// enough to type-check fast.
    @ViewBuilder
    private func deviceRow(_ endpoint: Endpoint, selfId: String) -> some View {
        HStack(spacing: 8) {
            DeviceRow(
                name: endpoint.label,
                symbol: endpoint.themeSymbol,
                kind: endpoint.kindWord,
                presence: endpoint.isOnline ? .online : .offline,
                note: endpoint.id == selfId
                    ? String(
                        localized: "this phone",
                        comment: "Replaces the status of the device list row that is this phone: \"iPhone · this phone\". Lowercase, short."
                    )
                    : nil,
                // Sending is paused: only on the relay's word (screen 8), never from a date.
                pausedLine: GroupService.pausedLine(
                    model.servicePlan,
                    kind: endpoint.kindWord,
                    isThisPhone: endpoint.id == selfId
                )
            )
            // A visible Remove, so removing is never a hidden gesture or a tap on the name.
            // Borderless, so only the button is a tap target and not the whole List row.
            if endpoint.id != selfId {
                Button("Remove", role: .destructive) {
                    removing = RemoveTarget(id: endpoint.id, label: endpoint.label)
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("Remove \(endpoint.label)")
            }
        }
        .panelRow()
        // Every other device can be removed from here; this phone leaves through Unpair
        // instead. Swipe and long-press stay as shortcuts for the button above. Not
        // `role: .destructive`: that makes the List drop the row before the user confirms.
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            if endpoint.id != selfId {
                Button {
                    removing = RemoveTarget(id: endpoint.id, label: endpoint.label)
                } label: {
                    Label("Remove", systemImage: "trash")
                }
                .tint(Palette.danger)
            }
        }
        .contextMenu {
            if endpoint.id != selfId {
                Button(role: .destructive) {
                    removing = RemoveTarget(id: endpoint.id, label: endpoint.label)
                } label: {
                    Label("Remove from group", systemImage: "trash")
                }
            }
        }
    }

    // MARK: vanished devices

    /// A device that joined and then disappeared (GH7). Stays until dismissed.
    private func vanishedCard(_ notice: NewDeviceNotice) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                SymbolTile(systemName: "exclamationmark.shield", color: Palette.waitingFill)
                VStack(alignment: .leading, spacing: 2) {
                    Text(NewDevices.vanishedTitle(notice))
                        .font(.body.weight(.semibold))
                        .foregroundColor(.primary)
                    Text(NewDevices.vanishedBody(notice))
                        .font(.subheadline)
                        .foregroundColor(Palette.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .accessibilityElement(children: .combine)
            Button(NewDevices.vanishedDismiss) {
                model.dismissVanished(id: notice.id)
            }
            .buttonStyle(.bordered)
        }
        .padding(.vertical, 4)
    }

    // MARK: the trial ended

    /// Amber, like the other waiting notices: nothing is lost, sending is paused. No price and
    /// no way to pay here; the email has the next step (design sheet, screen 8).
    private var trialEndedCard: some View {
        HStack(alignment: .top, spacing: 12) {
            SymbolTile(systemName: "clock", color: Palette.waitingFill)
            VStack(alignment: .leading, spacing: 2) {
                Text(GroupService.trialEndedTitle)
                    .font(.body.weight(.semibold))
                    .foregroundColor(.primary)
                Text(GroupService.trialEndedBody)
                    .font(.subheadline)
                    .foregroundColor(.primary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }

    // MARK: the reset that waits

    /// A pending reset of the whole group (PLANS.md P-18 item 12). Built like the
    /// vanished-device card, in the danger colour: it removes every device, this one too.
    private func groupResetCard(_ reset: GroupResetState) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                SymbolTile(systemName: "exclamationmark.triangle.fill", color: Palette.tileDanger)
                VStack(alignment: .leading, spacing: 2) {
                    Text(GroupReset.cardTitle)
                        .font(.body.weight(.semibold))
                        .foregroundColor(Palette.danger)
                    Text(GroupReset.cardBody(reset))
                        .font(.subheadline)
                        .foregroundColor(Palette.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .accessibilityElement(children: .combine)
            HStack(spacing: 10) {
                Button(GroupReset.stopButton, role: .destructive) {
                    Task { await model.stopGroupReset() }
                }
                .buttonStyle(.borderedProminent)
                .tint(Palette.danger)
                .disabled(model.stoppingReset)
                Button(GroupReset.itWasMeButton) {
                    model.dismissGroupReset(reset)
                }
                // An explicit style keeps each button its own tap target; the
                // List's default would fire both from anywhere in the row.
                .buttonStyle(.bordered)
                .disabled(model.stoppingReset)
            }
        }
        .padding(.vertical, 4)
    }

    // MARK: latest

    /// One row holding the cards: two side by side, one across the whole width, or a
    /// line saying where they will appear. Largest text sizes stack them.
    @ViewBuilder
    private func latestRow(selfEndpointId: String) -> some View {
        let items = latest
        if items.isEmpty {
            Text("Tabs you send and tabs that arrive show up here.")
                .font(.subheadline)
                .foregroundColor(Palette.muted)
                .padding(.vertical, 4)
                .panelRow()
        } else {
            Group {
                if typeSize.isAccessibilitySize {
                    VStack(spacing: 10) {
                        ForEach(items) { latestCard($0, selfEndpointId: selfEndpointId) }
                    }
                } else {
                    HStack(alignment: .top, spacing: 10) {
                        ForEach(items) { latestCard($0, selfEndpointId: selfEndpointId) }
                    }
                    // Cards of different lengths still end on one line.
                    .fixedSize(horizontal: false, vertical: true)
                }
            }
            .listRowInsets(EdgeInsets())
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
        }
    }

    private func latestCard(_ item: HistoryItem, selfEndpointId: String) -> some View {
        let direction = History.direction(item, selfEndpointId: selfEndpointId)
        let isNew = History.isNew(item, direction: direction)
        return LinkPreviewReader(item: item) { preview in
            Button {
                open(item)
            } label: {
                VStack(alignment: .leading, spacing: 0) {
                    SitePicture(slot: preview.slot, letter: History.siteLetter(item), letterFont: .largeTitle)
                        .frame(height: 104)
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(spacing: 5) {
                            if isNew {
                                Circle()
                                    .fill(Palette.accent)
                                    .frame(width: 8, height: 8)
                                    .accessibilityHidden(true)
                            }
                            Text(History.latestLine(item, direction: direction))
                                .font(.caption.weight(.bold))
                                .foregroundColor(isNew ? Palette.accent : Palette.muted)
                                .lineLimit(2)
                        }
                        Text(Self.title(item, preview: preview))
                            .font(.subheadline.weight(.semibold))
                            .foregroundColor(.primary)
                            .lineLimit(3)
                        Text(History.latestDetail(item, direction: direction))
                            .font(.caption)
                            .foregroundColor(Palette.muted)
                            .lineLimit(2)
                    }
                    .padding(EdgeInsets(top: 10, leading: 12, bottom: 12, trailing: 12))
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .background(Palette.panel)
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                .contentShape(Rectangle())
            }
            // Plain, and one per card: inside a List row, buttons with the default
            // style all fire together on a tap anywhere in the row.
            .buttonStyle(.plain)
            .accessibilityElement(children: .combine)
        }
    }

    /// The tab's own title, else the page's, else the site.
    private static func title(_ item: HistoryItem, preview: LinkPreviewState) -> String {
        let own = item.payload?.title?.trimmingCharacters(in: .whitespaces) ?? ""
        return own.isEmpty ? (preview.pageTitle ?? History.displayTitle(item)) : History.displayTitle(item)
    }

    private func open(_ item: HistoryItem) {
        // Re-check the scheme here, not only at receipt: this is the step that
        // turns a stored string back into a navigation (same as HistoryView).
        guard let payload = item.payload,
              let url = LinkURLPolicy.openableURL(from: payload.url)
        else { return }
        openURL(url)
        model.markReceivedOpened([item.id])
    }
}

extension AppModel.MintedPairing: Identifiable {
    var id: String { link }
}

private extension View {
    /// Closer sections on iOS 17 and later, so Home's button clears the tab bar on a
    /// normal phone with a few devices. Earlier versions keep the system's spacing.
    @ViewBuilder
    func tightSections() -> some View {
        if #available(iOS 17, *) {
            listSectionSpacing(.compact)
        } else {
            self
        }
    }
}
