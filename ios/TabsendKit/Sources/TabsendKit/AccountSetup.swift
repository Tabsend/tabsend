import Foundation

/// Where the iPhone app may offer an account, and what this phone remembers about one
/// (docs/PLANS.md P-19 and P-25).
///
/// The app is paid for up front on the App Store, so none of this has to do with buying
/// anything. It only decides what the first screen and Settings show.
public enum AccountSetup {
    // MARK: the storefront rule

    /// Apple's rule 3.1.1(a) lets an app carry a sign-up button and a price for an outside
    /// service on the US storefront only, so the account door shows there and nowhere else
    /// (owner's pick, 2026-11-04). StoreKit names the US App Store "USA" (a three-letter
    /// ISO code). An unknown storefront, which StoreKit reports as nil, counts as not US:
    /// the screen without the door is the safe one to show by mistake.
    public static func allowsAccountSetup(storefrontCountryCode: String?) -> Bool {
        storefrontCountryCode?.uppercased() == "USA"
    }

    // MARK: what this phone remembers

    /// How long after "Set up an account" a setup link that arrives is taken for the account's
    /// own link. The email can wait in a mailbox for a while, and the link itself is good for
    /// 15 minutes once opened, so a day is generous and still ends by itself.
    public static let pendingWindow: TimeInterval = 24 * 60 * 60

    private static let startedKey = "accountSetupStartedAt"

    /// The person opened the sign-up sheet. A setup link that arrives within the window is
    /// from that account, so the app asks for a name instead of showing the raw link.
    public static func markStarted(now: Date = Date(), in defaults: UserDefaults = .standard) {
        defaults.set(now.timeIntervalSince1970, forKey: startedKey)
    }

    /// True while a sign-up the person began is still waiting for its setup link.
    public static func isPending(now: Date = Date(), in defaults: UserDefaults = .standard) -> Bool {
        guard let started = defaults.object(forKey: startedKey) as? Double else { return false }
        let age = now.timeIntervalSince1970 - started
        return age >= 0 && age <= pendingWindow
    }

    /// The sign-up ended: the phone paired, so nothing is waiting for a link any more. (Whether
    /// this phone uses Tabsend's service is not remembered from the tap: the relay says so,
    /// `GroupService`.)
    public static func finishStarted(in defaults: UserDefaults = .standard) {
        defaults.removeObject(forKey: startedKey)
    }

    /// Unpairing forgets it, like everything else this phone knew about its group.
    public static func clear(in defaults: UserDefaults = .standard) {
        defaults.removeObject(forKey: startedKey)
    }

    // MARK: the account site

    /// The account site's pages the app opens in a sheet. `from=app` tells the page it was
    /// opened from the app: it answers with the app's own look and words, leaves the website
    /// out, and emails a link the app opens (docs/PLANS.md P-19).
    public enum Page {
        case start
        case account
        case delete

        public var path: String {
            switch self {
            case .start: return "/start?from=app"
            case .account: return "/account?from=app"
            case .delete: return "/account?from=app#danger"
            }
        }
    }

    /// The default address of the account site. A debug build can point at another one.
    public static let defaultSite = "https://account.tabsend.org" // l10n-ignore: address

    public static func url(for page: Page, site: String = defaultSite) -> URL? {
        var base = site
        while base.hasSuffix("/") { base.removeLast() }
        return URL(string: base + page.path)
    }
}
