import SafariServices
import SwiftUI
import TabsendKit

/// The account site's page in a sheet inside the app, not in the Safari app. Apple calls
/// sending a person to the default browser to register inappropriate (docs/PLANS.md P-19),
/// so the sign-up, "Manage account" and the last step of "Delete account" all open here.
/// `SFSafariViewController` is the system's own: the page's address and a Done button show
/// on it, and the app cannot read what is typed into it.
struct AccountSheet: UIViewControllerRepresentable {
    let url: URL
    var onDone: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onDone: onDone) }

    func makeUIViewController(context: Context) -> SFSafariViewController {
        let configuration = SFSafariViewController.Configuration()
        configuration.entersReaderIfAvailable = false
        let controller = SFSafariViewController(url: url, configuration: configuration)
        controller.dismissButtonStyle = .done
        // The app's own colours around the page (the phone ground and its link blue).
        controller.preferredBarTintColor = UIPalette.ground
        controller.preferredControlTintColor = UIPalette.accent
        controller.delegate = context.coordinator
        return controller
    }

    func updateUIViewController(_ controller: SFSafariViewController, context: Context) {}

    final class Coordinator: NSObject, SFSafariViewControllerDelegate {
        let onDone: () -> Void
        init(onDone: @escaping () -> Void) { self.onDone = onDone }

        func safariViewControllerDidFinish(_ controller: SFSafariViewController) { onDone() }
    }
}

/// Which account page a sheet shows. `Identifiable`, so a sheet can be opened with `.sheet(item:)`.
enum AccountPage: Identifiable {
    case account
    case delete

    var id: Int { self == .account ? 0 : 1 }

    var url: URL? {
        AccountSite.url(for: self == .account ? .account : .delete)
    }
}
