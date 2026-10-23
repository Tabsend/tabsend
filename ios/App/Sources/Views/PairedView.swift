import SwiftUI
import TabsendKit

/// Paired state, the home screen: received tabs, your devices, pair a device, and
/// the same tiny settings surface as Android (instant delivery, rename, refresh,
/// unpair).
///
/// A grouped inset `List` (docs/APP_UI.md, "Phones: native-leaning"): panels on
/// the tinted ground, standard section headers and separators, SF Symbols on
/// coloured tiles, native controls. Held tabs keep their swipe-to-delete and the
/// whole screen keeps pull-to-refresh.
struct PairedView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.openURL) private var openURL

    @State private var showRename = false
    @State private var renameText = ""
    @State private var showUnpairConfirm = false
    @State private var minted: AppModel.MintedPairing?
    /// The device the remove confirmation is asking about, from its row or its banner.
    @State private var removing: RemoveTarget?

    struct RemoveTarget: Identifiable {
        let id: String
        let label: String
    }

    /// How many received tabs the home screen shows before "History" takes over.
    private static let receivedOnHome = 4

    /// What this phone can actually promise right now. The second line is v0.6's, and
    /// it stays the honest answer whenever the wake path is unavailable or switched
    /// off: no held connection, no self-wake, Background App Refresh as a bonus (P-5).
    private var deliveryLine: String {
        if model.wakePathAvailable && model.instantDeliveryOn {
            return "Delivery: instant, whether or not Tabsend is open."
        }
        return "Delivery: instant while the app is open; otherwise when you open it (or iOS wakes it in the background)."
    }

    /// The newest tabs this phone received, from the same merged timeline the
    /// History screen shows [0028].
    private func recentReceived(selfEndpointId: String) -> [HistoryItem] {
        let received = model.historyGroups
            .flatMap { $0.items }
            .filter { History.direction($0, selfEndpointId: selfEndpointId) == .received }
        return Array(received.prefix(Self.receivedOnHome))
    }

    var body: some View {
        List {
            if let reg = model.registration {
                // New devices first (PLANS.md P-10): a security notice, and it stays
                // on the screen the app opens to until it is answered.
                if !model.reviewDevices.isEmpty {
                    Section {
                        reviewCard(model.reviewDevices)
                            .panelRow()
                    }
                }
                ForEach(model.vanishedDevices) { notice in
                    Section {
                        vanishedCard(notice)
                            .panelRow()
                    }
                }
                ForEach(model.newDeviceNotices) { notice in
                    Section {
                        newDeviceCard(notice)
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
                            PanelSectionHeader(Feedback.heldTabsHeading(model.heldTabs.count))
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
                    receivedRows(selfEndpointId: reg.endpointId)

                    // The way back to any tab this group has moved [0028], whether its
                    // notification is gone or it never arrived at all. Near the top
                    // because it is the one thing here a person needs in a hurry, and
                    // it carries a count so it only asks for attention when it has
                    // something.
                    NavigationLink {
                        HistoryView()
                    } label: {
                        HStack(spacing: 12) {
                            TileLabel(title: "History", systemName: "clock.arrow.circlepath", tile: Palette.accentFill)
                            if model.unopenedReceived > 0 {
                                Spacer()
                                Text("\(model.unopenedReceived)")
                                    .font(.body)
                                    .foregroundColor(Palette.muted)
                                    .accessibilityLabel("\(model.unopenedReceived) unopened")
                            }
                        }
                    }
                    .panelRow()
                } header: {
                    PanelSectionHeader("Received")
                }

                Section {
                    if model.endpoints.isEmpty {
                        Text("No other devices yet.")
                            .font(.body)
                            .foregroundColor(Palette.muted)
                            .panelRow()
                    }
                    ForEach(model.endpoints) { endpoint in
                        HStack(spacing: 8) {
                            DeviceRow(
                                name: endpoint.label,
                                symbol: endpoint.themeSymbol,
                                kind: endpoint.kindWord,
                                presence: endpoint.isOnline ? .online : .offline,
                                note: endpoint.id == reg.endpointId ? "this phone" : nil
                            )
                            // A visible Remove, so removing is never a hidden gesture
                            // or a tap on the name. Borderless, so only the button is
                            // a tap target and not the whole List row.
                            if endpoint.id != reg.endpointId {
                                Button("Remove", role: .destructive) {
                                    removing = RemoveTarget(id: endpoint.id, label: endpoint.label)
                                }
                                .buttonStyle(.borderless)
                                .accessibilityLabel("Remove \(endpoint.label)")
                            }
                        }
                        .panelRow()
                        // Every other device can be removed from here; this phone
                        // leaves through Unpair instead. Swipe and long-press stay as
                        // shortcuts for the button above. Not `role: .destructive`:
                        // that makes the List drop the row before the user confirms.
                        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                            if endpoint.id != reg.endpointId {
                                Button {
                                    removing = RemoveTarget(id: endpoint.id, label: endpoint.label)
                                } label: {
                                    Label("Remove", systemImage: "trash")
                                }
                                .tint(Palette.danger)
                            }
                        }
                        .contextMenu {
                            if endpoint.id != reg.endpointId {
                                Button(role: .destructive) {
                                    removing = RemoveTarget(id: endpoint.id, label: endpoint.label)
                                } label: {
                                    Label("Remove from group", systemImage: "trash")
                                }
                            }
                        }
                    }
                } header: {
                    PanelSectionHeader("Your devices")
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
                        Label("Pair a device", systemImage: "plus")
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

                settingsSections(reg)
            }
        }
        .groupedListBackground()
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
        .alert("Rename this device", isPresented: $showRename) {
            TextField("Name", text: $renameText)
            Button("Save") {
                Task { await model.rename(to: renameText) }
            }
            Button("Cancel", role: .cancel) {}
        }
        .confirmationDialog(
            "Unpair this phone? Links already on other devices stay there.",
            isPresented: $showUnpairConfirm,
            titleVisibility: .visible
        ) {
            Button("Unpair", role: .destructive) {
                Task { await model.unpair() }
            }
        }
        // The same confirmation the extension and the console ask, word for word.
        .confirmationDialog(
            removing.map { "Remove \u{201C}\($0.label)\u{201D} from the group?" } ?? "",
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
            Text("\u{201C}\(target.label)\u{201D} will stop receiving tabs and disappear from every device\u{2019}s chooser. Any tabs still queued for it are dropped. It must be re-paired to rejoin.")
        }
        .sheet(item: $minted) { pairing in
            PairSheetView(pairing: pairing)
                .presentationDragIndicator(.visible)
        }
    }

    // MARK: first look and vanished devices

    /// The first look (GH6): one card for the whole first list, asked once. A row per
    /// device with its own Remove, and one answer for all of it. Copy is the shared
    /// design's, word for word.
    private func reviewCard(_ devices: [NewDeviceNotice]) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                SymbolTile(systemName: "exclamationmark.shield", color: Palette.waitingFill)
                VStack(alignment: .leading, spacing: 2) {
                    Text(NewDevices.reviewTitle)
                        .font(.body.weight(.semibold))
                        .foregroundColor(.primary)
                    Text(NewDevices.reviewBody)
                        .font(.subheadline)
                        .foregroundColor(Palette.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .accessibilityElement(children: .combine)
            ForEach(devices) { device in
                HStack {
                    Text(device.label)
                        .font(.body)
                        .foregroundColor(.primary)
                    Spacer()
                    Button(NewDevices.reviewRemove, role: .destructive) {
                        removing = RemoveTarget(id: device.id, label: device.label)
                    }
                    .buttonStyle(.bordered)
                    .accessibilityLabel("\(NewDevices.reviewRemove) \(device.label)")
                }
            }
            Button(NewDevices.reviewConfirm) {
                model.confirmReview()
            }
            .buttonStyle(.bordered)
        }
        .padding(.vertical, 4)
    }

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

    // MARK: new device banner

    /// One row per device that joined and has not been answered (PLANS.md P-10).
    /// Copy is the shared design's, word for word.
    private func newDeviceCard(_ notice: NewDeviceNotice) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                SymbolTile(systemName: "exclamationmark.shield", color: Palette.waitingFill)
                VStack(alignment: .leading, spacing: 2) {
                    Text(NewDevices.bannerTitle(notice))
                        .font(.body.weight(.semibold))
                        .foregroundColor(.primary)
                    Text(NewDevices.bannerBody(notice))
                        .font(.subheadline)
                        .foregroundColor(Palette.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .accessibilityElement(children: .combine)
            HStack(spacing: 10) {
                Button("Yes, it's mine") {
                    model.confirmNewDevice(id: notice.id)
                }
                .buttonStyle(.bordered)
                Button("Remove it", role: .destructive) {
                    removing = RemoveTarget(id: notice.id, label: notice.label)
                }
                // An explicit style keeps each button its own tap target; the
                // List's default would fire both from anywhere in the row.
                .buttonStyle(.bordered)
            }
        }
        .padding(.vertical, 4)
    }

    // MARK: settings

    /// Settings: this phone, how it gets tabs, and the account actions. Split out
    /// of `body` only to keep that one expression small enough to type-check fast.
    @ViewBuilder
    private func settingsSections(_ reg: Registration) -> some View {
        Section {
            VStack(alignment: .leading, spacing: 4) {
                Text("Linked as \(reg.label)")
                    .font(.body)
                    .foregroundColor(.primary)
                (Text("Relay: ") + Text(reg.relayUrl).font(.footnote.monospaced()))
                    .font(.footnote)
                    .foregroundColor(Palette.muted)
                Text(deliveryLine)
                    .font(.footnote)
                    .foregroundColor(Palette.muted)
            }
            .padding(.vertical, 4)
            .panelRow()
        } header: {
            PanelSectionHeader("Settings")
        }

        // The wake path [0032], shown only where the toggle would do something:
        // this build knows a forwarder AND the paired relay has one configured.
        // On by default the moment both hold (P-5), so this is the opt-out and
        // not a setup step.
        if model.wakePathAvailable {
            Section {
                Toggle(isOn: Binding(
                    get: { model.instantDeliveryOn },
                    set: { on in Task { await model.setInstantDelivery(on) } }
                )) {
                    TileLabel(title: "Instant delivery", systemName: "bolt.fill", tile: Palette.petrol)
                }
                .tint(Palette.petrol)
                .panelRow()
            } footer: {
                // The metadata cost, in the same words the forwarder's own
                // documentation uses, because a promise this narrow is worth
                // nothing if what it does keep is left vague.
                Text("Tabs arrive even when Tabsend is closed. Your relay asks the Tabsend wake-up service to ring this phone, then this phone fetches the tab from your relay. The service learns that a device received something, and when. Never what. Turn this off to get tabs only when you open Tabsend.")
                    .foregroundColor(Palette.muted)
            }
        }

        Section {
            Button {
                renameText = reg.label
                showRename = true
            } label: {
                TileLabel(title: "Rename this device", systemName: "pencil", tile: Palette.tileGrey)
            }
            .panelRow()
            Button {
                Task {
                    await model.refreshEndpoints()
                    await model.heartbeat()
                    // Refresh is the obvious "check again" affordance, so it
                    // must re-read the verdict too. The outage line is gated
                    // behind a 30s grace, and without this a relay that went
                    // quiet since the last foreground stayed invisible until
                    // the user switched apps.
                    model.refreshSendState()
                }
            } label: {
                TileLabel(title: "Refresh", systemName: "arrow.clockwise", tile: Palette.petrol)
            }
            .panelRow()
            Button(role: .destructive) {
                showUnpairConfirm = true
            } label: {
                TileLabel(title: "Unpair", systemName: "xmark", tile: Palette.tileDanger, titleColor: Palette.danger)
            }
            .panelRow()
        } footer: {
            Text(AppModel.buildInfo)
                .foregroundColor(Palette.muted)
                .padding(.top, 8)
        }
    }

    // MARK: received rows

    /// The newest received tabs as rows of the "Received" section, or one line
    /// saying where they will show up.
    @ViewBuilder
    private func receivedRows(selfEndpointId: String) -> some View {
        let items = recentReceived(selfEndpointId: selfEndpointId)
        if items.isEmpty {
            Text("Tabs sent to this phone show up here, and stay in History after you open them.")
                .font(.subheadline)
                .foregroundColor(Palette.muted)
                .padding(.vertical, 4)
                .panelRow()
        }
        ForEach(items) { item in
            receivedRow(item)
                .panelRow()
        }
    }

    private func receivedRow(_ item: HistoryItem) -> some View {
        let openable = item.payload.flatMap { LinkURLPolicy.openableURL(from: $0.url) }
        return Button {
            open(item)
        } label: {
            HStack(spacing: 12) {
                SymbolTile(systemName: History.symbol(.received), color: Palette.petrol)
                VStack(alignment: .leading, spacing: 2) {
                    Text(History.displayTitle(item))
                        .font(.body)
                        .foregroundColor(.primary)
                        .lineLimit(2)
                    Text(History.subtitle(item, direction: .received))
                        .font(.subheadline)
                        .foregroundColor(Palette.muted)
                        .lineLimit(1)
                }
            }
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .contentShape(Rectangle())
        }
        // Plain, and one per row: inside a List row, buttons with the default
        // style all fire together on a tap anywhere in the row.
        .buttonStyle(.plain)
        .disabled(openable == nil)
        // Dimmed once opened, still listed — the same rule as History.
        .opacity(item.openedAt == nil ? 1 : 0.55)
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
