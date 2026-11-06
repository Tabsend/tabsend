import SwiftUI
import TabsendKit

/// The Settings tab: this phone, how it gets tabs, the server, Website images and the
/// account actions. Nothing here is needed day to day, which is why it is not on Home.
struct SettingsView: View {
    @EnvironmentObject private var model: AppModel

    @State private var showRename = false
    @State private var renameText = ""
    @State private var showUnpairConfirm = false
    @State private var showRelayMove = false
    @State private var shownInfo: PrivacyInfo?
    /// Delete account: the confirmation, then the account site's delete section in a sheet.
    @State private var showDeleteAccount = false
    /// The account site's page open in a sheet (Manage account, or the last step of Delete account).
    @State private var accountPage: AccountPage?

    /// What the info icon beside a Privacy switch explains (owner, 2026-11-04: the text
    /// sits behind the icon, not on the page). The delivery text must keep saying what
    /// the wake-up service and Apple learn [SECURITY_REVIEW G6].
    private enum PrivacyInfo: String, Identifiable {
        case delivery, images
        var id: String { rawValue }

        var title: String {
            switch self {
            case .delivery: return String(localized: "Only get tabs when Tabsend is open", comment: "Settings, Privacy section: label of a switch, off by default. On means tabs arrive only while the app is open, because Apple is no longer asked to wake the phone.")
            case .images: return String(localized: "Don't load website images", comment: "Settings, Privacy section: label of a switch, off by default. On means no pictures are fetched from websites; each tab shows its site's first letter.")
            }
        }

        var paragraphs: [String] {
            switch self {
            case .delivery:
                return [
                    String(localized: "Tabs normally reach this phone right away, even when Tabsend is closed. To do that, Tabsend's wake-up service asks Apple to wake the phone.", comment: "Info sheet for the switch \"Only get tabs when Tabsend is open\", first paragraph."),
                    String(localized: "They learn that this phone received something, and when, and Apple also sees its internet address. They never learn what was sent or who sent it.", comment: "Info sheet for the switch \"Only get tabs when Tabsend is open\", second paragraph. They means the wake-up service and Apple. Keep exactly what each one learns."),
                    String(localized: "Turn this on if you'd rather not share that. Tabs will then arrive when you open Tabsend.", comment: "Info sheet for the switch \"Only get tabs when Tabsend is open\", last paragraph."),
                ]
            case .images:
                return [
                    String(localized: "Pictures load directly from each website, so those sites can see this phone's internet address and when it asked.", comment: "Info sheet for the switch \"Don't load website images\", first paragraph."),
                    String(localized: "Turn this on if you don't want to be tracked this way. You'll see each site's first letter instead.", comment: "Info sheet for the switch \"Don't load website images\", last paragraph."),
                ]
            }
        }
    }

    var body: some View {
        List {
            if let reg = model.registration {
                Section {
                    HStack {
                        Text("This phone")
                            .foregroundColor(.primary)
                        Spacer()
                        Text(reg.label)
                            .foregroundColor(Palette.muted)
                            .multilineTextAlignment(.trailing)
                    }
                    .font(.body)
                    .frame(minHeight: 44)
                    .accessibilityElement(children: .combine)
                    .panelRow()
                    Button {
                        renameText = reg.label
                        showRename = true
                    } label: {
                        TileLabel(title: "Rename this device", systemName: "pencil", tile: Palette.tileGrey)
                    }
                    .panelRow()
                } footer: {
                    // What Rename, Unpair or a move reports, where they were tapped.
                    if let banner = model.banner {
                        Text(banner)
                            .foregroundColor(.primary)
                    }
                }

                privacySection

                Section {
                    Text(reg.relayUrl)
                        .font(.footnote.monospaced())
                        .foregroundColor(Palette.muted)
                        .padding(.vertical, 4)
                        .panelRow()
                    Button {
                        showRelayMove = true
                    } label: {
                        TileLabel(verbatim: RelayMove.button, systemName: "arrow.left.arrow.right", tile: Palette.tileGrey)
                    }
                    .panelRow()
                } header: {
                    PanelSectionHeader("Relay")
                }

                actionsSection

                if showsAccountGroup {
                    accountSection
                }
            }
        }
        .groupedListBackground()
        .navigationTitle("Settings")
        .navigationBarTitleDisplayMode(.large)
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
        .sheet(item: $shownInfo) { info in
            infoSheet(info)
        }
        .sheet(isPresented: $showRelayMove) {
            RelayMoveView(currentUrl: model.registration?.relayUrl ?? "")
                .environmentObject(model)
        }
        // A sign-in link from the email: this sheet closes, and the root shows the signed-in one.
        .onChange(of: model.accountSignInURL) { url in
            if url != nil { accountPage = nil }
        }
        .sheet(item: $accountPage) { page in
            if let url = page.url {
                AccountSheet(url: url) { accountPage = nil }
                    .ignoresSafeArea()
                    .presentationDragIndicator(.visible)
            }
        }
        // One confirmation, then the website finishes the deletion (Apple's 5.1.1(v): the app
        // starts it, and may link straight to the page that ends it).
        .confirmationDialog(
            "Delete your account?",
            isPresented: $showDeleteAccount,
            titleVisibility: .visible
        ) {
            Button("Continue on tabsend.org", role: .destructive) {
                accountPage = .delete
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This ends any plan without a refund, deletes your group and unpairs every device. You finish on tabsend.org.")
        }
    }

    /// Two opt-outs, off by default, so most people have nothing to do here. The delivery
    /// switch appears only where it would do something: this build knows a forwarder AND
    /// the paired relay has one configured (P-5). Where it can't, the footer says what
    /// this phone can promise: no held connection, no self-wake, Background App Refresh
    /// as a bonus.
    private var privacySection: some View {
        Section {
            if model.wakePathAvailable {
                privacyRow(
                    .delivery,
                    systemName: "bolt.slash.fill",
                    isOn: Binding(
                        get: { !model.instantDeliveryOn },
                        set: { off in Task { await model.setInstantDelivery(!off) } }
                    )
                )
            }
            privacyRow(
                .images,
                systemName: "photo",
                isOn: Binding(
                    get: { !model.websiteImagesOn },
                    set: { off in model.setWebsiteImages(!off) }
                )
            )
        } header: {
            PanelSectionHeader("Privacy")
        } footer: {
            if !model.wakePathAvailable {
                Text("Tabs arrive while Tabsend is open, or when you open it. iOS may also wake it in the background.")
                    .foregroundColor(Palette.muted)
            }
        }
    }

    private func privacyRow(_ info: PrivacyInfo, systemName: String, isOn: Binding<Bool>) -> some View {
        HStack(spacing: 4) {
            TileLabel(verbatim: info.title, systemName: systemName, tile: Palette.petrol)
            Spacer(minLength: 0)
            Button {
                shownInfo = info
            } label: {
                Image(systemName: "info.circle")
                    .font(.body)
                    .foregroundColor(Palette.accent)
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.borderless)
            .accessibilityLabel(String(localized: "About \(info.title)", comment: "Spoken label of the info icon beside a Privacy switch. %@ is the name of the switch."))
            Toggle(info.title, isOn: isOn)
                .labelsHidden()
                .tint(Palette.petrol)
        }
        .panelRow()
    }

    private func infoSheet(_ info: PrivacyInfo) -> some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    Text(info.title)
                        .font(.title3.weight(.semibold))
                    ForEach(info.paragraphs, id: \.self) { paragraph in
                        Text(paragraph)
                            .font(.body)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding()
            }
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { shownInfo = nil }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private var actionsSection: some View {
        Section {
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
            if !showsAccountGroup { buildInfoFooter }
        }
    }

    private var buildInfoFooter: some View {
        Text(AppModel.buildInfo)
            .foregroundColor(Palette.muted)
            .padding(.top, 8)
    }

    // MARK: account

    /// The Account group shows on the US App Store only (the app creates accounts there, so
    /// Apple wants a way to start deleting one inside the app, and its rules allow the link),
    /// and only when the relay says this phone uses Tabsend's service (`GroupService`, from
    /// `GET /v1/group`): a self-hosted relay says nothing, so a self-hoster never sees it, and a
    /// phone paired from a link made on a computer does.
    private var showsAccountGroup: Bool {
        model.accountSetupAvailable && model.servicePlan != nil
    }

    private var accountSection: some View {
        Section {
            Button {
                accountPage = .account
            } label: {
                HStack {
                    Text("Manage account")
                        .foregroundColor(.primary)
                    Spacer()
                    Image(systemName: "arrow.up.right.square")
                        .foregroundColor(Palette.muted)
                        .accessibilityHidden(true)
                }
                .frame(minHeight: 36)
            }
            .panelRow()
            Button(role: .destructive) {
                showDeleteAccount = true
            } label: {
                HStack {
                    Text("Delete account")
                        .foregroundColor(Palette.danger)
                    Spacer()
                    Image(systemName: "arrow.up.right.square")
                        .foregroundColor(Palette.muted)
                        .accessibilityHidden(true)
                }
                .frame(minHeight: 36)
            }
            .panelRow()
        } header: {
            PanelSectionHeader("Account")
        } footer: {
            buildInfoFooter
        }
    }
}
