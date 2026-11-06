import SwiftUI
import TabsendKit

@main
struct TabsendApp: App {
    /// Only for the two things SwiftUI has no equivalent of: the APNs device token,
    /// and the silent push that wakes this app to drain (ADR-0032).
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var model = AppModel.shared
    @Environment(\.scenePhase) private var scenePhase

    init() {
        BackgroundRefresh.register()
        Notifications.installDelegate()
        // Before the first navigation bar exists: the bars read their appearance
        // when they are created (docs/APP_UI.md, phone ground + Archivo titles).
        ThemeAppearance.apply()
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(model)
                // The first screen's account door and the Account group in Settings show on the
                // US App Store only (docs/PLANS.md P-25), so the app follows the storefront.
                .task {
                    model.openLinkFromLaunchSettings()
                    await model.watchStorefront()
                }
                .onOpenURL { url in
                    // A universal link from the account site's email (docs/PLANS.md P-19), or
                    // a pairing link.
                    model.openIncoming(url)
                }
        }
        .onChange(of: scenePhase) { phase in
            switch phase {
            case .active: model.appBecameActive()
            case .background: model.appWentToBackground()
            default: break
            }
        }
    }
}

struct RootView: View {
    @EnvironmentObject private var model: AppModel
    /// The account site's sign-in page, in a sheet over whatever screen is up (a sign-in link
    /// from the email, docs/PLANS.md P-19).
    @State private var showSignIn = false

    var body: some View {
        Group {
            if model.registration != nil {
                MainTabsView()
            } else {
                NavigationStack {
                    JoinView()
                        // The pairing screen hides the bar and shows the wordmark instead.
                        .navigationTitle(Text(verbatim: "Tabsend")) // l10n-ignore: product name
                        .navigationBarTitleDisplayMode(.large)
                }
                .tint(Palette.accent)
            }
        }
        // The screens below close their own account sheet when this link arrives (a phone
        // shows one sheet at a time), so this waits a moment for it to go.
        .onChange(of: model.accountSignInURL) { url in
            guard url != nil else { return }
            Task {
                try? await Task.sleep(nanoseconds: 700_000_000)
                showSignIn = model.accountSignInURL != nil
            }
        }
        .sheet(isPresented: $showSignIn, onDismiss: { model.accountSignInURL = nil }) {
            if let url = model.accountSignInURL {
                AccountSheet(url: url) { showSignIn = false }
                    .ignoresSafeArea()
                    .presentationDragIndicator(.visible)
            }
        }
    }
}

/// The three tabs of a paired phone (docs/HISTORY_PREVIEWS_PLAN.md). The selection
/// lives here, so pairing again after an unpair starts on Home.
struct MainTabsView: View {
    enum Tab {
        case home, history, settings
    }

    @State private var tab = Tab.home

    var body: some View {
        TabView(selection: $tab) {
            NavigationStack {
                PairedView(tab: $tab)
                    .navigationTitle(Text(verbatim: "Tabsend")) // l10n-ignore: product name
                    .navigationBarTitleDisplayMode(.large)
            }
            .tabItem { Label("Home", systemImage: "house") }
            .tag(Tab.home)

            NavigationStack {
                HistoryView()
            }
            .tabItem { Label("History", systemImage: "clock.arrow.circlepath") }
            .tag(Tab.history)

            NavigationStack {
                SettingsView()
            }
            .tabItem { Label("Settings", systemImage: "gearshape") }
            .tag(Tab.settings)
        }
        .tint(Palette.accent)
    }
}
