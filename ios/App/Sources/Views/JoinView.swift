import SwiftUI
import TabsendKit

/// Unpaired state, and the app's one signature moment (docs/APP_UI.md, "Phones:
/// native-leaning"): the wordmark, ONE outlined card with the hard offset shadow,
/// the browser → phone illustration, the Archivo headline, and the one outlined,
/// shadowed button in the app. It keeps the generic brand tokens (`Palette.Brand`)
/// so it matches the extension and the website.
///
/// Behaviour is the same as before the restyle: scan a QR (or arrive by deep
/// link) to fill in a complete pairing link, or paste one; name the device; Join.
/// The paste field lives behind "Paste a pairing link instead" and shows by
/// itself as soon as there is a link to join with.
struct JoinView: View {
    @EnvironmentObject private var model: AppModel

    @State private var pairingLink = ""
    @State private var deviceName = AppModel.defaultDeviceName
    @State private var showScanner = false
    /// The user asked to paste a link rather than scan.
    @State private var showPaste = false
    @State private var showHowItWorks = false
    @FocusState private var linkFocused: Bool

    private var hasLink: Bool {
        !pairingLink.trimmingCharacters(in: .whitespaces).isEmpty
    }

    /// The link + name fields: shown once there is a link (scanned, deep-linked or
    /// typed), or once the user asks to paste one.
    private var showsForm: Bool { showPaste || hasLink }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                Text("Tabsend")
                    .font(.archivo(.extrabold, size: 22, relativeTo: .title2))
                    .foregroundColor(Palette.Brand.ink)
                    .accessibilityAddTraits(.isHeader)

                signatureCard

                if showsForm {
                    linkForm
                }

                if let banner = model.banner {
                    Text(banner)
                        .font(.subheadline)
                        .foregroundColor(Palette.Brand.ink)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Text(AppModel.buildInfo)
                    .font(.caption)
                    .foregroundColor(Palette.Brand.muted)
            }
            .padding(.horizontal, 20)
            .padding(.top, 12)
            .padding(.bottom, 16)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .scrollDismissesKeyboard(.interactively)
        .safeAreaInset(edge: .bottom) { actions }
        .background(Palette.Brand.ground.ignoresSafeArea())
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
        .alert("How pairing works", isPresented: $showHowItWorks) {
            Button("OK", role: .cancel) {}
        } message: {
            Text("Every browser and phone you link joins one private group on your relay. The code your browser shows holds your relay's address and a one-time code; it works once and expires in about 10 minutes. You can also scan the code another paired phone shows, or paste its pairing link.")
        }
        .onAppear {
            if let pending = model.pendingDeepLink {
                model.pendingDeepLink = nil
                apply(parsed: pending)
            }
        }
        .onChange(of: model.pendingDeepLink) { pending in
            if let pending {
                model.pendingDeepLink = nil
                apply(parsed: pending)
            }
        }
    }

    // MARK: the card

    private var signatureCard: some View {
        VStack(alignment: .leading, spacing: 16) {
            PairingIllustration()
                .frame(maxWidth: .infinity)
                .padding(.vertical, 8)
            Text("Link this phone to your browsers")
                .font(.archivo(.extrabold, size: 30, relativeTo: .largeTitle))
                .foregroundColor(Palette.Brand.ink)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            Text("On your computer, click the Tabsend button and choose New browser. Then scan the code it shows.")
                .font(.body)
                .foregroundColor(Palette.Brand.muted)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .outlinedCard()
    }

    // MARK: link + name

    private var linkForm: some View {
        VStack(alignment: .leading, spacing: 8) {
            fieldLabel("Pairing link")
            // Never auto-capitalise: a pairing link's fp= fingerprint is
            // case-sensitive base64url, and uppercasing it silently breaks
            // certificate pinning. Pairing.parse uppercases only the internal secret.
            TextField("https://your-relay/pair#c=…", text: $pairingLink)
                .font(.body.monospaced())
                .foregroundColor(Palette.Brand.ink)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .focused($linkFocused)
                .accessibilityLabel("Pairing link")
                .modifier(FieldBackground())

            fieldLabel("Name this device")
                .padding(.top, 8)
            TextField("iPhone", text: $deviceName)
                .font(.body)
                .foregroundColor(Palette.Brand.ink)
                .accessibilityLabel("Name this device")
                .modifier(FieldBackground())
        }
    }

    private func fieldLabel(_ text: String) -> some View {
        Text(text)
            .font(.footnote.weight(.semibold))
            .foregroundColor(Palette.Brand.muted)
            .accessibilityHidden(true)
    }

    // MARK: actions

    /// Bottom of the screen: the one signature button, then the quiet ways round.
    /// Before there is a link the signature button scans; once there is one, it
    /// joins, and scanning steps down to a plain button.
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
                        Text("Join")
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

                if !showPaste {
                    Button {
                        showPaste = true
                        // Next turn of the run loop: the field doesn't exist until
                        // this state change has rendered it.
                        DispatchQueue.main.async { linkFocused = true }
                    } label: {
                        Text("Paste a pairing link instead")
                            .frame(minHeight: 44)
                    }
                }
            }

            Button {
                showHowItWorks = true
            } label: {
                Text("How pairing works")
                    .font(.footnote)
                    .frame(minHeight: 44)
            }
        }
        .padding(.horizontal, 20)
        .padding(.top, 12)
        .frame(maxWidth: .infinity)
        // Opaque, so the scrolled card doesn't show through behind the buttons.
        .background(Palette.Brand.ground.ignoresSafeArea())
    }

    private func apply(parsed: Pairing.Parsed?) {
        guard let parsed else {
            model.banner = "That QR code isn't a Tabsend pairing code."
            return
        }
        pairingLink = Pairing.link(
            relayUrl: parsed.relayUrl, code: parsed.code,
            certFingerprint: parsed.certFingerprint
        )
    }
}

/// A flat field on the `card` colour, no outline (the card above is this screen's
/// one outlined element).
private struct FieldBackground: ViewModifier {
    func body(content: Content) -> some View {
        content
            .padding(.horizontal, 12)
            .padding(.vertical, 12)
            .background(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(Palette.Brand.card)
            )
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
