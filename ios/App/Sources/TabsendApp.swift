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
                .onOpenURL { url in
                    // tabsend://pair#c=CODE and https://<host>/pair#c=CODE deep links.
                    handleDeepLink(url)
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

    private func handleDeepLink(_ url: URL) {
        guard model.registration == nil else { return }
        // Parsed from the full link, so the device tags it vouches for come along (P-23).
        if let parsed = Pairing.parse(url.absoluteString) {
            model.pendingDeepLink = parsed
        }
    }
}

struct RootView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        NavigationStack {
            Group {
                if model.registration != nil {
                    PairedView()
                } else {
                    JoinView()
                }
            }
            // A large title that collapses on scroll. The pairing screen hides the
            // bar and shows the wordmark instead.
            .navigationTitle("Tabsend")
            .navigationBarTitleDisplayMode(.large)
        }
        .tint(Palette.accent)
    }
}
