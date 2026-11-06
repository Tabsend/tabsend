import StoreKit
import TabsendKit

/// Which App Store the app was installed from, and where the account site is, for the two
/// places the first-run work asks (docs/PLANS.md P-25: the sign-up door and the Account
/// group show on the US storefront only).
///
/// There is no purchase anywhere in here. The app is paid for up front on the App Store, so
/// StoreKit is used for one thing: reading the storefront's country.
enum StorefrontWatcher {
    /// DEBUG builds only: `-TabsendStorefront USA` (or `GBR`, or any code) on the launch line
    /// stands in for the storefront, because the Simulator has no App Store account to read
    /// one from. A release build ignores it, so nobody can ask a shipped app for the US door.
    private static var debugCode: String? {
        #if DEBUG
        return UserDefaults.standard.string(forKey: "TabsendStorefront") // l10n-ignore: launch setting name
        #else
        return nil
        #endif
    }

    /// The storefront's country code now (`USA` for the US App Store), or nil when StoreKit
    /// does not say.
    static func currentCountryCode() async -> String? {
        if let forced = debugCode { return forced }
        return await Storefront.current?.countryCode
    }

    /// Every later change of storefront, for a person who moves their App Store account to
    /// another country while the app is running. Never ends in a debug run with a stand-in.
    static func changes() -> AsyncStream<String?> {
        AsyncStream { continuation in
            if debugCode != nil { return }
            let task = Task {
                for await storefront in Storefront.updates {
                    continuation.yield(storefront.countryCode)
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}

/// The account site's pages, opened in a sheet inside the app.
enum AccountSite {
    /// The account site's address. DEBUG builds only: `-TabsendAccountSite http://localhost:8790`
    /// points the sheets, the emailed-link check and the sign-up call at a local account site.
    static var base: String {
        #if DEBUG
        if let site = UserDefaults.standard.string(forKey: "TabsendAccountSite") { // l10n-ignore: launch setting name
            return site
        }
        #endif
        return AccountSetup.defaultSite
    }

    static func url(for page: AccountSetup.Page) -> URL? {
        AccountSetup.url(for: page, site: base)
    }
}
