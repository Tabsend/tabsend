import SwiftUI
import UIKit
import CoreText
import TabsendKit

// The phone look (docs/APP_UI.md, "Phones: native-leaning"), compiled into both
// the app and the share extension. Everything here is plain SwiftUI/UIKit
// available at iOS 16, the deployment target in project.yml.
//
// Tabsend should feel built in: grouped inset lists, SF Symbols on coloured
// tiles, native controls tinted with brand colours, the system font at the
// platform's text styles. Archivo is for screen titles and the wordmark only.
// The outlined card with the hard offset shadow belongs to ONE screen, the
// first-run pairing screen (JoinView), and nowhere else.

// MARK: - Colour tokens

/// The colour tokens from docs/APP_UI.md, each a light/dark dynamic colour.
///
/// Two layers. The phone tokens (`ground`, `panel`, `separator`, `petrol`,
/// `accentFill`, `muted`) dress every ordinary screen. The generic brand tokens
/// (`Palette.Brand`) are for the pairing screen only, so it matches the extension
/// and the website.
enum Palette {
    // Phone tokens (the "Phone tokens" table, iOS columns).
    static let ground = Color(uiColor: UIPalette.ground)
    static let panel = Color(uiColor: UIPalette.panel)
    static let separator = Color(uiColor: UIPalette.separator)
    static let petrol = Color(uiColor: UIPalette.petrol)
    /// The fill of a primary (`.borderedProminent`) button.
    static let accentFill = Color(uiColor: UIPalette.accentFill)
    static let muted = Color(uiColor: UIPalette.muted)

    /// Links, toolbar buttons and selection: the generic `accent`, which keeps
    /// 4.5:1 as TEXT on the dark panel where the darker fill blue would not.
    static let accent = Color(uiColor: UIPalette.accent)

    static let success = Color(uiColor: UIPalette.success)
    /// The amber FILL for "held for an asleep device" (icon discs, tiles).
    static let waitingFill = Color(uiColor: UIPalette.waitingFill)
    /// The amber for TEXT, darker in light mode so it still meets 4.5:1.
    static let waitingText = Color(uiColor: UIPalette.waitingText)
    static let danger = Color(uiColor: UIPalette.danger)

    /// Tile fills (behind a white glyph, like iOS Settings). A fill is not text,
    /// so these stay saturated in dark mode instead of following the text colours.
    static let tileGrey = Color(uiColor: UIPalette.tileGrey)
    static let tileDanger = Color(uiColor: UIPalette.tileDanger)

    /// The generic brand layer, for the pairing screen's signature moment.
    enum Brand {
        static let ground = Color(uiColor: UIPalette.Brand.ground)
        static let card = Color(uiColor: UIPalette.Brand.card)
        static let chip = Color(uiColor: UIPalette.Brand.chip)
        static let ink = Color(uiColor: UIPalette.Brand.ink)
        static let muted = Color(uiColor: UIPalette.Brand.muted)
        static let shadow = Color(uiColor: UIPalette.Brand.shadow)
        static let accent = Color(uiColor: UIPalette.accent)
        static let onAccent = Color(uiColor: UIPalette.Brand.onAccent)
    }
}

/// The same tokens as UIColor, for UIKit appearance proxies.
enum UIPalette {
    static let ground = UIColor.dynamic(light: 0xEEF3F1, dark: 0x071A18)
    static let panel = UIColor.dynamic(light: 0xFFFFFF, dark: 0x12302C)
    static let separator = UIColor.dynamic(light: 0xCAD6D2, dark: 0x2A4743)
    static let petrol = UIColor.dynamic(light: 0x1F6F63, dark: 0x2A8C7D)
    static let accentFill = UIColor.dynamic(light: 0x2450A8, dark: 0x3D6AD6)
    static let muted = UIColor.dynamic(light: 0x5C6D69, dark: 0x8FA8A2)

    static let accent = UIColor.dynamic(light: 0x2450A8, dark: 0xA9C4FF)
    static let success = UIColor.dynamic(light: 0x2F7A22, dark: 0x8FD27A)
    static let waitingFill = UIColor.dynamic(light: 0xE0A11B, dark: 0xE0A11B)
    static let waitingText = UIColor.dynamic(light: 0x7A5200, dark: 0xF0C463)
    static let danger = UIColor.dynamic(light: 0xA4361C, dark: 0xF08A6E)

    static let tileGrey = UIColor.dynamic(light: 0x5C6D69, dark: 0x4F625E)
    static let tileDanger = UIColor.dynamic(light: 0xA4361C, dark: 0xB8432A)

    enum Brand {
        static let ground = UIColor.dynamic(light: 0xE9F0EE, dark: 0x0A2C29)
        static let card = UIColor.dynamic(light: 0xFFFFFF, dark: 0x0F3B36)
        static let chip = UIColor.dynamic(light: 0xD9E5E2, dark: 0x14544C)
        static let ink = UIColor.dynamic(light: 0x10201E, dark: 0xEAF1EF)
        static let muted = UIColor.dynamic(light: 0x4F625E, dark: 0xA9C2BC)
        static let shadow = UIColor.dynamic(light: 0x10201E, dark: 0x041513)
        static let onAccent = UIColor.dynamic(light: 0xFFFFFF, dark: 0x0A2C29)
    }
}

extension UIColor {
    /// A colour that follows the trait collection's light/dark style.
    static func dynamic(light: UInt32, dark: UInt32, darkAlpha: CGFloat = 1) -> UIColor {
        UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? UIColor(rgb: dark, alpha: darkAlpha)
                : UIColor(rgb: light, alpha: 1)
        }
    }

    convenience init(rgb: UInt32, alpha: CGFloat) {
        self.init(
            red: CGFloat((rgb >> 16) & 0xFF) / 255,
            green: CGFloat((rgb >> 8) & 0xFF) / 255,
            blue: CGFloat(rgb & 0xFF) / 255,
            alpha: alpha
        )
    }
}

// MARK: - Type

/// The shipped static instances, cut from the site's variable Archivo. These are
/// the PostScript names the files carry (checked with fontTools).
enum ArchivoWeight {
    case regular, semibold, bold, extrabold

    var postScriptName: String {
        switch self {
        case .regular: return "Archivo-Regular"
        case .semibold: return "Archivo-SemiBold"
        case .bold: return "Archivo-Bold"
        case .extrabold: return "Archivo-ExtraBold"
        }
    }

    var systemWeight: Font.Weight {
        switch self {
        case .regular: return .regular
        case .semibold: return .semibold
        case .bold: return .bold
        case .extrabold: return .heavy
        }
    }

    var uiWeight: UIFont.Weight {
        switch self {
        case .regular: return .regular
        case .semibold: return .semibold
        case .bold: return .bold
        case .extrabold: return .heavy
        }
    }
}

enum ThemeFonts {
    static let courierPostScriptName = "CourierPrime-Regular"

    /// Bundle file names (no extension), as listed in UIAppFonts in project.yml.
    private static let files = [
        "archivo_regular", "archivo_semibold", "archivo_bold", "archivo_extrabold",
        "courierprime-400",
    ]

    private static let allNames = [
        ArchivoWeight.regular.postScriptName, ArchivoWeight.semibold.postScriptName,
        ArchivoWeight.bold.postScriptName, ArchivoWeight.extrabold.postScriptName,
        courierPostScriptName,
    ]

    /// The PostScript names that actually resolve in this process. UIAppFonts
    /// normally registers them before any code runs; if a font is missing from the
    /// plist (or the extension's bundle), this registers it from the bundle once.
    /// Anything still missing falls back to the system font, never to a crash.
    static let available: Set<String> = {
        var found = Set<String>()
        for name in allNames where UIFont(name: name, size: 12) != nil {
            found.insert(name)
        }
        if found.count < allNames.count {
            for file in files {
                guard let url = Bundle.main.url(forResource: file, withExtension: "ttf") else { continue }
                // Fails harmlessly ("already registered") for fonts UIAppFonts loaded.
                _ = CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
            }
            for name in allNames where UIFont(name: name, size: 12) != nil {
                found.insert(name)
            }
        }
        return found
    }()

    /// A UIFont for UIKit surfaces (the navigation bar), scaled for Dynamic Type.
    static func uiArchivo(_ weight: ArchivoWeight, size: CGFloat, textStyle: UIFont.TextStyle) -> UIFont {
        let system = UIFont.systemFont(ofSize: size, weight: weight.uiWeight)
        var base: UIFont = system
        if available.contains(weight.postScriptName), let custom = UIFont(name: weight.postScriptName, size: size) {
            base = custom
        }
        return UIFontMetrics(forTextStyle: textStyle).scaledFont(for: base)
    }
}

extension Font {
    /// Archivo at a spec size, scaling with Dynamic Type relative to `style`.
    /// For screen titles, the wordmark and the pairing headline ONLY: every other
    /// piece of text uses a system text style (.body, .subheadline, .footnote…).
    static func archivo(_ weight: ArchivoWeight, size: CGFloat, relativeTo style: Font.TextStyle = .body) -> Font {
        if ThemeFonts.available.contains(weight.postScriptName) {
            return .custom(weight.postScriptName, size: size, relativeTo: style)
        }
        return .system(style).weight(weight.systemWeight)
    }
}

// MARK: - Navigation bar

enum ThemeAppearance {
    /// Navigation bars on the phone `ground`, with Archivo titles (the one place
    /// besides the wordmark that Archivo is used). Called once at launch by the app
    /// and by the share extension (each is its own process, so each sets its own).
    static func apply() {
        let bar = UINavigationBar.appearance()
        bar.standardAppearance = make(transparent: false)
        bar.compactAppearance = make(transparent: false)
        // At the top of a scroll the bar melts into the ground, like iOS Settings;
        // the hairline and the bar's own fill appear once content scrolls under.
        bar.scrollEdgeAppearance = make(transparent: true)
        bar.tintColor = UIPalette.accent
    }

    private static func make(transparent: Bool) -> UINavigationBarAppearance {
        let appearance = UINavigationBarAppearance()
        if transparent {
            appearance.configureWithTransparentBackground()
        } else {
            appearance.configureWithOpaqueBackground()
            appearance.backgroundColor = UIPalette.ground
            appearance.shadowColor = UIPalette.separator
        }
        appearance.titleTextAttributes = [
            .foregroundColor: UIColor.label,
            .font: ThemeFonts.uiArchivo(.bold, size: 17, textStyle: .headline),
        ]
        appearance.largeTitleTextAttributes = [
            .foregroundColor: UIColor.label,
            .font: ThemeFonts.uiArchivo(.extrabold, size: 34, textStyle: .largeTitle),
        ]
        return appearance
    }
}

// MARK: - Grouped lists

extension View {
    /// A row in a grouped inset `List`: a `panel` background and `separator`
    /// hairlines. Applied per row (or per ForEach), since that is where SwiftUI
    /// reads row backgrounds.
    func panelRow() -> some View {
        self
            .listRowBackground(Palette.panel)
            .listRowSeparatorTint(Palette.separator)
    }

    /// The tinted `ground` behind a grouped inset `List`, in place of the system's
    /// grouped background. `scrollContentBackground` is iOS 16, the deployment
    /// target, so it needs no availability check.
    func groupedListBackground() -> some View {
        self
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .background(Palette.ground.ignoresSafeArea())
    }
}

/// A standard List section header in the `muted` token. The text style, case and
/// spacing are the system's own.
struct PanelSectionHeader: View {
    let text: String

    init(_ text: String) { self.text = text }

    var body: some View {
        Text(text).foregroundColor(Palette.muted)
    }
}

// MARK: - Tiles

/// An SF Symbol on a 30 pt rounded-square tile, white glyph, like iOS Settings.
/// The brand shows in the tile colour, not in the icon's drawing.
struct SymbolTile: View {
    let systemName: String
    var color: Color = Palette.petrol

    var body: some View {
        Image(systemName: systemName)
            .font(.system(size: 15, weight: .regular))
            .foregroundColor(.white)
            .frame(width: 30, height: 30)
            .background(
                RoundedRectangle(cornerRadius: 7, style: .continuous).fill(color)
            )
            .accessibilityHidden(true)
    }
}

/// A row label with a tile in front, for rows that open or do something.
struct TileLabel: View {
    let title: String
    let systemName: String
    var tile: Color = Palette.petrol
    var titleColor: Color = .primary

    var body: some View {
        HStack(spacing: 12) {
            SymbolTile(systemName: systemName, color: tile)
            Text(title)
                .font(.body)
                .foregroundColor(titleColor)
        }
        .frame(minHeight: 44)
    }
}

// MARK: - Signature (pairing screen only)

/// The one raised element in the app: `card` fill, 1.5 pt `ink` outline, hard
/// offset shadow. Used by the first-run pairing screen ONLY (docs/APP_UI.md,
/// "The signature moment"). No other phone screen uses outline or offset shadow.
struct OutlinedCardModifier: ViewModifier {
    var cornerRadius: CGFloat = 16
    var fill: Color = Palette.Brand.card
    var shadowOffset: CGFloat = 4

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        return content
            .background(shape.fill(fill))
            .overlay(shape.strokeBorder(Palette.Brand.ink, lineWidth: 1.5))
            .background(
                shape
                    .fill(Palette.Brand.shadow)
                    .offset(x: shadowOffset, y: shadowOffset)
                    .accessibilityHidden(true)
            )
            // Keep the offset shadow inside the layout box so a parent doesn't clip it.
            .padding(.trailing, shadowOffset)
            .padding(.bottom, shadowOffset)
    }
}

extension View {
    func outlinedCard(cornerRadius: CGFloat = 16, fill: Color = Palette.Brand.card, shadowOffset: CGFloat = 4) -> some View {
        modifier(OutlinedCardModifier(cornerRadius: cornerRadius, fill: fill, shadowOffset: shadowOffset))
    }
}

/// `accent` fill, `on-accent` text, `ink` outline + offset shadow: the ONE such
/// button in the app, on the pairing screen. Everywhere else uses system button
/// styles (`.borderedProminent` tinted `accentFill` for a screen's primary action).
struct SignatureButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        let shape = RoundedRectangle(cornerRadius: 12, style: .continuous)
        let offset: CGFloat = configuration.isPressed ? 1 : 4
        return configuration.label
            .font(.headline)
            .foregroundColor(Palette.Brand.onAccent)
            .frame(maxWidth: .infinity, minHeight: 50)
            .padding(.horizontal, 16)
            .background(shape.fill(Palette.Brand.accent))
            .overlay(shape.strokeBorder(Palette.Brand.ink, lineWidth: 1.5))
            .background(shape.fill(Palette.Brand.shadow).offset(x: offset, y: offset))
            // Pressing moves the button into its shadow, like the landing page.
            .offset(x: configuration.isPressed ? 3 : 0, y: configuration.isPressed ? 3 : 0)
            .opacity(isEnabled ? 1 : 0.5)
            .padding(.trailing, 4)
            .padding(.bottom, 4)
            .contentShape(Rectangle())
    }
}

// MARK: - Devices

extension Endpoint {
    /// The SF Symbol for this device's kind: phone, tablet, browser or console.
    /// Every name is checked at run time and falls back to an iOS 13 symbol.
    var themeSymbol: String {
        switch kind {
        case "mobile":
            if (deviceName ?? label).localizedCaseInsensitiveContains("ipad") {
                return DeviceSymbol.resolve("ipad", fallback: "rectangle")
            }
            if platform == "android" {
                return DeviceSymbol.resolve("smartphone", fallback: "iphone")
            }
            return DeviceSymbol.resolve("iphone", fallback: "phone")
        case "console":
            return DeviceSymbol.resolve("terminal", fallback: "laptopcomputer")
        default:
            // "extension": a browser profile. Tabsend's browsers have no single
            // brand glyph to borrow, so the neutral globe stands for all of them.
            return "globe"
        }
    }

    /// The first half of "Kind · status".
    var kindWord: String {
        switch kind {
        case "mobile":
            if (deviceName ?? label).localizedCaseInsensitiveContains("ipad") { return "iPad" }
            if platform == "ios" { return "iPhone" }
            if platform == "android" { return "Android phone" }
            return "Phone"
        case "console":
            return "Console"
        default:
            switch browser ?? "" {
            case "chrome": return "Chrome"
            case "firefox": return "Firefox"
            case "edge": return "Edge"
            case "brave": return "Brave"
            case "opera": return "Opera"
            case "vivaldi": return "Vivaldi"
            case "arc": return "Arc"
            default: return "Browser"
            }
        }
    }
}

enum DeviceSymbol {
    static func resolve(_ preferred: String, fallback: String) -> String {
        UIImage(systemName: preferred) != nil ? preferred : fallback
    }
}

/// How sure a device row can be about presence.
enum PresenceWord {
    case online, offline, unknown

    var text: String {
        switch self {
        case .online: return "Online"
        case .offline: return "Offline"
        case .unknown: return "Status unknown"
        }
    }
}

/// Device row: `petrol` tile + name over "Kind · status" (muted; the status word
/// in `success` when online). The primary device carries "Main" in `accent`.
struct DeviceRow: View {
    let name: String
    let symbol: String
    let kind: String
    var presence: PresenceWord?
    /// Replaces the status half, e.g. "this phone".
    var note: String?
    var isMain = false
    var isStale = false

    var body: some View {
        HStack(spacing: 12) {
            SymbolTile(systemName: symbol, color: Palette.petrol)
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(name)
                        .font(.body)
                        .foregroundColor(.primary)
                        .lineLimit(2)
                    if isMain {
                        Text("Main")
                            .font(.caption.weight(.semibold))
                            .foregroundColor(Palette.accent)
                    }
                }
                detail
                    .font(.subheadline)
                    .lineLimit(2)
            }
            Spacer(minLength: 0)
        }
        .frame(minHeight: 44)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    private var detail: Text {
        var text = Text(kind).foregroundColor(Palette.muted)
        if let note {
            text = text + Text(" · \(note)").foregroundColor(Palette.muted)
        } else if let presence {
            text = text + Text(" · ").foregroundColor(Palette.muted)
                + Text(presence.text)
                    .foregroundColor(presence == .online ? Palette.success : Palette.muted)
        }
        if isStale {
            text = text + Text(" · inactive").foregroundColor(Palette.muted)
        }
        return text
    }
}
