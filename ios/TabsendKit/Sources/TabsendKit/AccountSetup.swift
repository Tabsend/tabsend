import Foundation
import Security

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
    private static let numberKey = "accountPhoneNumber"
    private static let numberAtKey = "accountPhoneNumberAt"

    /// The person opened the sign-up sheet. A setup link that arrives within the window is
    /// from that account, so the app asks for a name instead of showing the raw link.
    public static func markStarted(now: Date = Date(), in defaults: UserDefaults = .standard) {
        defaults.set(now.timeIntervalSince1970, forKey: startedKey)
        // The link this sign-up emails is tied to this phone by the number made here.
        _ = phoneNumber(now: now, in: defaults)
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
        forgetPhoneNumber(in: defaults)
    }

    /// Unpairing forgets it, like everything else this phone knew about its group.
    public static func clear(in defaults: UserDefaults = .standard) {
        defaults.removeObject(forKey: startedKey)
        forgetPhoneNumber(in: defaults)
    }

    // MARK: the phone's number (docs/SECURITY_REVIEW.md AL1, AL3)

    /// A link the account site emails works only on the phone that asked for it. This phone
    /// makes a random number when it opens a sheet that can ask for a link, and gives it to the
    /// page. The page sends it with the request for the link; the site keeps only a hash of it
    /// with the link, and takes the link only from whoever shows the same number again. The
    /// number is never in the email, so a link forwarded to another phone is useless there.
    ///
    /// 32 random bytes, written as 43 characters of A-Z, a-z, 0-9, `-` and `_`: the shape the
    /// account site accepts (22 to 128 of those).
    static let numberBytes = 32

    /// The number this phone is using, or a new one if it has none that is still good. A
    /// number is good for the same day a pending sign-up is (`pendingWindow`), counted from the
    /// last time a sheet asked for it: a second request for a link inside that day keeps it, so
    /// both links open on this phone, and a sign-up never outlives its number.
    public static func phoneNumber(now: Date = Date(), in defaults: UserDefaults = .standard) -> String {
        if let kept = livePhoneNumber(now: now, in: defaults) {
            defaults.set(now.timeIntervalSince1970, forKey: numberAtKey)
            return kept
        }
        var bytes = [UInt8](repeating: 0, count: numberBytes)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        precondition(status == errSecSuccess, "SecRandomCopyBytes failed") // l10n-ignore: crash message, never shown
        let number = Base64X.encodeUrlNoPad(bytes)
        defaults.set(number, forKey: numberKey)
        defaults.set(now.timeIntervalSince1970, forKey: numberAtKey)
        return number
    }

    /// The number this phone made, if it is still good. Nil for a link that arrives when this
    /// phone asked for nothing (or asked too long ago): such a link is not this phone's.
    public static func livePhoneNumber(now: Date = Date(), in defaults: UserDefaults = .standard) -> String? {
        guard let number = defaults.string(forKey: numberKey), isPlausible(number: number),
              let made = defaults.object(forKey: numberAtKey) as? Double
        else { return nil }
        let age = now.timeIntervalSince1970 - made
        return age >= 0 && age <= pendingWindow ? number : nil
    }

    private static func forgetPhoneNumber(in defaults: UserDefaults) {
        defaults.removeObject(forKey: numberKey)
        defaults.removeObject(forKey: numberAtKey)
    }

    /// The shape the account site accepts as a phone's number.
    static func isPlausible(number: String) -> Bool {
        (22...128).contains(number.utf8.count) && number.utf8.allSatisfy { byte in
            (byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x5A)
                || (byte >= 0x61 && byte <= 0x7A) || byte == 0x2D || byte == 0x5F
        }
    }

    // MARK: the account site

    /// The account site's pages the app opens in a sheet. `from=app` tells the page it was
    /// opened from the app: it answers with the app's own look and words, leaves the website
    /// out, and emails a link the app opens (docs/PLANS.md P-19).
    public enum Page {
        case start
        case account
        case delete
        /// The Share page: the personal link, and the $5 credit.
        case share

        public var path: String {
            switch self {
            case .start: return "/start?from=app"
            case .account: return "/account?from=app"
            case .delete: return "/account?from=app#danger"
            case .share: return "/share?from=app"
            }
        }
    }

    /// The default address of the account site. A debug build can point at another one.
    public static let defaultSite = "https://account.tabsend.org" // l10n-ignore: address

    /// The page's address. `number` is this phone's number (`phoneNumber`): it goes after the
    /// `#`, where it is never sent to the site by the browser, and the page reads it from there
    /// and takes it off the address. Every page that can lead to a sign-in or a sign-up carries
    /// it. Without one the page asks for an ordinary web link, which the phone's app does not take.
    public static func url(for page: Page, site: String = defaultSite, number: String? = nil) -> URL? {
        var base = site
        while base.hasSuffix("/") { base.removeLast() }
        guard let number, isPlausible(number: number) else { return URL(string: base + page.path) }
        // `#danger` is a marker the page looks for as it is; the number follows it after `&`.
        let joiner = page.path.contains("#") ? "&" : "#"
        return URL(string: base + page.path + joiner + "n=" + number)
    }
}
