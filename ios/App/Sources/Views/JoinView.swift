import SwiftUI
import TabsendKit

/// Unpaired state, and the app's one signature moment (docs/APP_UI.md, "Phones: native-leaning"):
/// the wordmark, ONE outlined card with the hard offset shadow, the browser → phone illustration,
/// the Archivo headline, and the one outlined, shadowed button in the app.
///
/// It sits on the phone ground like every screen after it (one green per platform, owner's
/// ruling 2026-11-04); the card is the phone panel. Ink, the outline and the shadow stay the
/// brand's, so the card still matches the extension and the website.
///
/// Two ways in, scan a code or paste a setup link. On the US App Store there is a third door,
/// "Set up an account", which opens the account site in a sheet (docs/PLANS.md P-19, P-25).
/// Everywhere else the screen has no account button and no price: Apple does not allow them
/// there, and a newcomer signs up on tabsend.org and taps the setup link.
///
/// Behaviour is the same as before the restyle: scan a QR (or arrive by deep link) to fill in a
/// complete pairing link, or paste one; name the device; pair. The paste field lives behind
/// "Paste a setup link instead" and shows by itself as soon as there is a link to pair with.
struct JoinView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dynamicTypeSize) private var typeSize

    @State private var pairingLink = ""
    @State private var deviceName = AppModel.defaultDeviceName
    @State private var showScanner = false
    /// The user asked to paste a link rather than scan.
    @State private var showPaste = false
    @State private var showHowItWorks = false
    /// The sign-up sheet is open.
    @State private var showSignup = false
    @FocusState private var linkFocused: Bool

    /// Placeholder that shows the shape of an address: not a sentence, so not translated. Typed
    /// as `String` on purpose, since a literal would be looked up as a catalog key.
    private static let pairingLinkExample: String = "https://your-relay/pair#c=…" // l10n-ignore: example address
    /// The example in the empty name box is the default name itself (docs/L10N.md rule 12).
    private static var deviceNameExample: String { AppModel.phoneFallbackName }

    private var hasLink: Bool {
        !pairingLink.trimmingCharacters(in: .whitespaces).isEmpty
    }

    /// The link + name fields: shown once there is a link (scanned, deep-linked or
    /// typed), or once the user asks to paste one.
    private var showsForm: Bool { showPaste || hasLink }

    /// The account door shows on the US App Store only, and only while there is no link yet
    /// (a person who already holds a link is pairing, not signing up).
    private var showsAccountDoor: Bool { model.accountSetupAvailable && !hasLink }

    /// Everywhere else: one plain line that says where to learn about the service. Text only,
    /// no link, no button, no price (docs/PLANS.md P-25).
    private var showsServiceNote: Bool { !model.accountSetupAvailable && !hasLink }

    /// At the largest text sizes the pinned buttons would fill the screen, so the account door
    /// moves into the scrolling part and only the two pairing buttons stay pinned.
    private var doorScrolls: Bool { typeSize.isAccessibilitySize }

    var body: some View {
        Group {
            // The setup link the account site handed back after a sign-up this phone began.
            if let arrival = model.accountArrival {
                NamePhoneView(arrival: arrival) { model.accountArrival = nil }
            } else {
                firstScreen
            }
        }
        .background(Palette.ground.ignoresSafeArea())
        // The wordmark stands in for the navigation title on this screen.
        .toolbar(.hidden, for: .navigationBar)
        .tint(Palette.Brand.accent)
        .sheet(isPresented: $showScanner) {
            QRScannerView { scanned in
                showScanner = false
                apply(parsed: Pairing.parse(scanned))
            }
            .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $showSignup) {
            if let url = AccountSite.url(for: .start) {
                AccountSheet(url: url) { showSignup = false }
                    .ignoresSafeArea()
                    .presentationDragIndicator(.visible)
            }
        }
        .sheet(isPresented: $showHowItWorks) {
            PairingHelpSheet()
                .presentationDetents([.medium])
                .presentationDragIndicator(.visible)
        }
        // The setup link arrived (from the email): the sign-up sheet has done its work.
        // A sign-in link has the root show its own sheet, so this one goes first.
        .onChange(of: model.accountArrival) { arrival in
            if arrival != nil { showSignup = false }
        }
        .onChange(of: model.accountSignInURL) { url in
            if url != nil { showSignup = false }
        }
        .onAppear {
            if let pending = model.pendingDeepLink {
                model.pendingDeepLink = nil
                handle(deepLink: pending)
            }
        }
        .onChange(of: model.pendingDeepLink) { pending in
            if let pending {
                model.pendingDeepLink = nil
                handle(deepLink: pending)
            }
        }
    }

    private var firstScreen: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                Text(verbatim: "Tabsend") // l10n-ignore: product name
                    .font(.archivo(.extrabold, size: 22, relativeTo: .title2))
                    .foregroundColor(Palette.Brand.ink)
                    .accessibilityAddTraits(.isHeader)

                signatureCard

                if showsForm {
                    linkForm
                }

                if showsAccountDoor && doorScrolls {
                    accountDoor
                }

                if showsServiceNote && doorScrolls {
                    serviceNote
                }

                if let banner = model.banner {
                    Text(banner)
                        .font(.subheadline)
                        .foregroundColor(.primary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Button {
                    showHowItWorks = true
                } label: {
                    Text("How pairing works")
                        .font(.footnote)
                        .frame(minHeight: 44)
                }

                Text(AppModel.buildInfo)
                    .font(.caption)
                    .foregroundColor(Palette.muted)
            }
            .padding(.horizontal, 20)
            .padding(.top, 12)
            .padding(.bottom, 16)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .scrollDismissesKeyboard(.interactively)
        .safeAreaInset(edge: .bottom) { actions }
    }

    // MARK: the card

    private var signatureCard: some View {
        VStack(alignment: .leading, spacing: 16) {
            PairingIllustration()
                .frame(maxWidth: .infinity)
                .padding(.vertical, 8)
            Text("Send links to this phone")
                .font(.archivo(.extrabold, size: 30, relativeTo: .largeTitle))
                .foregroundColor(Palette.Brand.ink)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            Text("Pair it once with a browser or another phone. As soon as that's done, you can share links between these devices.")
                .font(.body)
                .foregroundColor(Palette.muted)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .outlinedCard(fill: Palette.panel)
    }

    // MARK: link + name

    private var linkForm: some View {
        VStack(alignment: .leading, spacing: 8) {
            fieldLabel("Setup link")
            // Never auto-capitalise: a pairing link's fp= fingerprint is
            // case-sensitive base64url, and uppercasing it silently breaks
            // certificate pinning. Pairing.parse uppercases only the internal secret.
            TextField(Self.pairingLinkExample, text: $pairingLink)
                .font(.body.monospaced())
                .foregroundColor(Palette.Brand.ink)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .focused($linkFocused)
                .accessibilityLabel("Setup link")
                .modifier(FieldBackground())

            fieldLabel("Name this device")
                .padding(.top, 8)
            TextField(Self.deviceNameExample, text: $deviceName)
                .font(.body)
                .foregroundColor(Palette.Brand.ink)
                .accessibilityLabel("Name this device")
                .modifier(FieldBackground())
        }
    }

    private func fieldLabel(_ text: LocalizedStringKey) -> some View {
        Text(text)
            .font(.footnote.weight(.semibold))
            .foregroundColor(Palette.muted)
            .accessibilityHidden(true)
    }

    // MARK: actions

    /// Bottom of the screen: the one signature button, then the quiet ways round, then
    /// (US App Store only) the account door. Before there is a link the signature button
    /// scans; once there is one, it pairs, and scanning steps down to a plain button.
    private var actions: some View {
        VStack(spacing: 6) {
            if hasLink {
                Button {
                    Task {
                        await model.join(.init(
                            pairingLink: pairingLink,
                            deviceName: deviceName
                        ))
                    }
                } label: {
                    if model.joining {
                        ProgressView()
                            .tint(Palette.Brand.onAccent)
                            .accessibilityLabel("Joining")
                    } else {
                        Text("Pair this phone")
                    }
                }
                .buttonStyle(SignatureButtonStyle())
                .disabled(model.joining || !hasLink)

                Button {
                    showScanner = true
                } label: {
                    Label("Scan code", systemImage: "qrcode.viewfinder")
                        .frame(minHeight: 44)
                }
            } else {
                Button {
                    showScanner = true
                } label: {
                    Label("Scan code", systemImage: "qrcode.viewfinder")
                }
                .buttonStyle(SignatureButtonStyle())

                // Scanning a code without the app lands on the install page, whose
                // Install button copies the setup link first. The system Paste button
                // reads it back without iOS's "Allow Paste" prompt.
                if UIPasteboard.general.hasStrings {
                    PasteButton(payloadType: String.self) { strings in
                        let text = strings.first ?? ""
                        DispatchQueue.main.async {
                            if let parsed = Pairing.parse(text) {
                                apply(parsed: parsed)
                            } else {
                                model.banner = String(
                                    localized: "What you copied isn't a Tabsend setup link.",
                                    comment: "Banner on the first-run screen after Paste, when the text on the clipboard is not a setup link. A setup link is the pairing link another device shows."
                                )
                            }
                        }
                    }
                    .labelStyle(.titleAndIcon)
                    .frame(minHeight: 44)
                }

                if !showPaste {
                    Button {
                        showPaste = true
                        // Next turn of the run loop: the field doesn't exist until
                        // this state change has rendered it.
                        DispatchQueue.main.async { linkFocused = true }
                    } label: {
                        Text("Paste a setup link instead")
                            .frame(minHeight: 44)
                    }
                }

                if showsAccountDoor && !doorScrolls {
                    Rectangle()
                        .fill(Palette.separator)
                        .frame(height: 1.5)
                        .padding(.top, 2)
                        .padding(.bottom, 8)
                        .accessibilityHidden(true)
                    accountDoor
                }

                if showsServiceNote && !doorScrolls {
                    Rectangle()
                        .fill(Palette.separator)
                        .frame(height: 1.5)
                        .padding(.top, 2)
                        .padding(.bottom, 8)
                        .accessibilityHidden(true)
                    serviceNote
                }
            }
        }
        .padding(.horizontal, 20)
        .padding(.top, 12)
        .padding(.bottom, 4)
        .frame(maxWidth: .infinity)
        // Opaque, so the scrolled card doesn't show through behind the buttons.
        .background(Palette.ground.ignoresSafeArea())
    }

    /// The third way in, US App Store only: make an account in a sheet inside the app. It says
    /// what the account is and that it is paid after the trial, without a price (the sheet's
    /// own page states that).
    private var accountDoor: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("New to Tabsend?")
                .font(.subheadline)
                .foregroundColor(Palette.muted)
            Button {
                model.accountSignupStarted()
                showSignup = true
            } label: {
                Text("Set up an account")
            }
            .buttonStyle(OutlinedButtonStyle())
            Text("Uses Tabsend's service: free for 14 days, no card needed, paid after that.")
                .font(.footnote)
                .foregroundColor(Palette.muted)
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    /// The line outside the US App Store. Plain text on purpose (no link, no button, no price),
    /// but not hidden: body size and full contrast, so a person who wants the service sees it.
    private var serviceNote: some View {
        Text("Learn more about setting up Tabsend's service at tabsend.org.")
            .font(.body)
            .foregroundColor(.primary)
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity)
            .fixedSize(horizontal: false, vertical: true)
    }

    /// A link that opened the app. When a sign-up this phone began is waiting for its link,
    /// the link is that account's: the sheet closes and the person is asked for a name.
    /// Otherwise it fills the link field like a scanned code.
    private func handle(deepLink parsed: Pairing.Parsed) {
        guard AccountSetup.isPending() else {
            apply(parsed: parsed)
            return
        }
        showSignup = false
        model.accountArrival = AccountArrival(
            link: Pairing.link(
                relayUrl: parsed.relayUrl, code: parsed.code,
                certFingerprint: parsed.certFingerprint, vouched: parsed.vouched
            ),
            accountCreated: false,
            trialEndsAt: nil
        )
    }

    private func apply(parsed: Pairing.Parsed?) {
        guard let parsed else {
            model.banner = String(
                localized: "That QR code isn't a Tabsend pairing code.",
                comment: "Banner on the first-run screen after scanning a QR code that is not a Tabsend pairing code."
            )
            return
        }
        // The device tags stay on the link (P-23): the join reads them from this field.
        pairingLink = Pairing.link(
            relayUrl: parsed.relayUrl, code: parsed.code,
            certFingerprint: parsed.certFingerprint, vouched: parsed.vouched
        )
    }
}

/// A flat field on the `panel` colour, no outline (the card above is this screen's one
/// outlined element).
private struct FieldBackground: ViewModifier {
    func body(content: Content) -> some View {
        content
            .padding(.horizontal, 12)
            .padding(.vertical, 12)
            .background(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(Palette.panel)
            )
    }
}

/// The quiet button under the signature one: `panel` fill and the `ink` outline, no shadow
/// (docs/APP_UI.md, "Secondary").
private struct OutlinedButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        let shape = RoundedRectangle(cornerRadius: 12, style: .continuous)
        return configuration.label
            .font(.headline)
            .foregroundColor(Palette.Brand.ink)
            .frame(maxWidth: .infinity, minHeight: 50)
            .padding(.horizontal, 16)
            .background(shape.fill(Palette.panel))
            .overlay(shape.strokeBorder(Palette.Brand.ink, lineWidth: 1.5))
            .opacity(isEnabled ? (configuration.isPressed ? 0.7 : 1) : 0.5)
            .contentShape(Rectangle())
    }
}

// MARK: - Illustration

/// A browser tile, a dashed arrow, a phone tile: what pairing does, drawn with the
/// site's ink outlines. Decorative; the headline and body say the same in words.
private struct PairingIllustration: View {
    /// Dark glyph on the amber fill, in both modes (amber is the same in both).
    private static let onWaiting = Color(uiColor: UIColor(rgb: 0x10201E, alpha: 1))

    var body: some View {
        HStack(spacing: 12) {
            browserTile
            DashedArrow()
                .frame(width: 64, height: 16)
            phoneTile
        }
        .accessibilityHidden(true)
    }

    private var browserTile: some View {
        let shape = RoundedRectangle(cornerRadius: 10, style: .continuous)
        return VStack(spacing: 0) {
            // The window's title bar: three dots and a rule under them.
            HStack(spacing: 4) {
                ForEach(0..<3, id: \.self) { _ in
                    Circle()
                        .strokeBorder(Palette.Brand.ink, lineWidth: 1.2)
                        .frame(width: 6, height: 6)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 8)
            .frame(height: 16)
            Rectangle()
                .fill(Palette.Brand.ink)
                .frame(height: 1.5)
            Image(systemName: "globe")
                .font(.system(size: 22, weight: .regular))
                .foregroundColor(Palette.Brand.ink)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .frame(width: 92, height: 68)
        .background(shape.fill(Palette.Brand.chip))
        .overlay(shape.strokeBorder(Palette.Brand.ink, lineWidth: 1.5))
        .clipShape(shape)
    }

    private var phoneTile: some View {
        let shape = RoundedRectangle(cornerRadius: 10, style: .continuous)
        return VStack(spacing: 0) {
            Capsule()
                .fill(Self.onWaiting)
                .frame(width: 14, height: 3)
                .padding(.top, 7)
            Image(systemName: "qrcode")
                .font(.system(size: 18, weight: .regular))
                .foregroundColor(Self.onWaiting)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .frame(width: 46, height: 78)
        .background(shape.fill(Palette.waitingFill))
        .overlay(shape.strokeBorder(Palette.Brand.ink, lineWidth: 1.5))
    }
}

/// A dashed shaft with a solid arrowhead, pointing right.
private struct DashedArrow: View {
    var body: some View {
        ZStack {
            ArrowShaft()
                .stroke(Palette.Brand.ink, style: StrokeStyle(lineWidth: 1.5, lineCap: .round, dash: [4, 4]))
            ArrowHead()
                .stroke(Palette.Brand.ink, style: StrokeStyle(lineWidth: 1.5, lineCap: .round, lineJoin: .round))
        }
    }

    private struct ArrowShaft: Shape {
        func path(in rect: CGRect) -> Path {
            var path = Path()
            path.move(to: CGPoint(x: rect.minX, y: rect.midY))
            path.addLine(to: CGPoint(x: rect.maxX - 2, y: rect.midY))
            return path
        }
    }

    private struct ArrowHead: Shape {
        func path(in rect: CGRect) -> Path {
            let size = min(rect.height / 2, 7)
            var path = Path()
            path.move(to: CGPoint(x: rect.maxX - size, y: rect.midY - size))
            path.addLine(to: CGPoint(x: rect.maxX, y: rect.midY))
            path.addLine(to: CGPoint(x: rect.maxX - size, y: rect.midY + size))
            return path
        }
    }
}

/// What pairing is, in three short lines. It replaces an alert that was long, small and could
/// not be formatted. Strong text on the phone ground, numbered steps, nothing else.
private struct PairingHelpSheet: View {
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 20) {
                row(
                    badge: Text(verbatim: "1").font(.subheadline.weight(.bold)),
                    text: Text("In a browser, or on a phone that's already paired, open Tabsend and show a code.")
                )
                row(
                    badge: Text(verbatim: "2").font(.subheadline.weight(.bold)),
                    text: Text("Scan the code here, or paste its setup link.")
                )
                row(
                    badge: Image(systemName: "clock").font(.subheadline.weight(.bold)),
                    text: Text("The code works once and expires in 10 minutes.")
                )
                Spacer(minLength: 0)
            }
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Palette.ground.ignoresSafeArea())
            .navigationTitle("How pairing works")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                Button("Close") { dismiss() }
            }
        }
        .tint(Palette.accent)
    }

    private func row<Badge: View>(badge: Badge, text: Text) -> some View {
        HStack(alignment: .top, spacing: 14) {
            badge
                .foregroundColor(Palette.Brand.onAccent)
                .frame(width: 30, height: 30)
                .background(Circle().fill(Palette.accentFill))
                .accessibilityHidden(true)
            text
                .font(.body)
                .foregroundColor(.primary)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 3)
        }
    }
}
