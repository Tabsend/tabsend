import SwiftUI
import TabsendKit

/// Screen 4 of the first-run sheet (docs/design/first-run): back in the app after the account
/// site's email link handed the phone its setup link. One field, already filled in, and the
/// setup link itself stays out of sight. Above the title, a notice that the trial has started,
/// only when this sign-up made the account (a person who already had one is not told a trial
/// started).
struct NamePhoneView: View {
    @EnvironmentObject private var model: AppModel

    /// What the account site handed over: the complete setup link, and whether it made the account.
    let arrival: AccountArrival
    private var link: String { arrival.link }
    /// Pairing did not work. The first screen comes back, with the reason in its banner.
    var onFailed: () -> Void

    @State private var name = AppModel.defaultDeviceName
    @FocusState private var nameFocused: Bool

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if arrival.accountCreated {
                    HStack(alignment: .top, spacing: 12) {
                        SymbolTile(systemName: "checkmark")
                        Text(GroupService.startedNotice(endsAt: arrival.trialEndsAt))
                            .font(.body)
                            .foregroundColor(.primary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(14)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(
                        RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Palette.panel)
                    )
                    .accessibilityElement(children: .combine)
                }
                Text("Name this phone")
                    .font(.archivo(.extrabold, size: 30, relativeTo: .largeTitle))
                    .foregroundColor(Palette.Brand.ink)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
                Text("Choose the name your other devices will see.")
                    .font(.body)
                    .foregroundColor(Palette.muted)
                    .fixedSize(horizontal: false, vertical: true)

                HStack(spacing: 12) {
                    Text("Name")
                        .font(.body)
                        .foregroundColor(.primary)
                        .accessibilityHidden(true)
                    TextField(AppModel.phoneFallbackName, text: $name)
                        .font(.body)
                        .multilineTextAlignment(.trailing)
                        .focused($nameFocused)
                        .accessibilityLabel("Name")
                        .submitLabel(.done)
                }
                .padding(.horizontal, 16)
                .frame(minHeight: 48)
                .background(
                    RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Palette.panel)
                )

                Text("You can change it later in Tabsend.")
                    .font(.footnote)
                    .foregroundColor(Palette.muted)
                    .padding(.horizontal, 4)

                if let banner = model.banner {
                    Text(banner)
                        .font(.subheadline)
                        .foregroundColor(.primary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, 24)
            .padding(.bottom, 16)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .scrollDismissesKeyboard(.interactively)
        .safeAreaInset(edge: .bottom) {
            Button {
                Task { await pair() }
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
            .disabled(model.joining)
            .padding(.horizontal, 20)
            .padding(.top, 12)
            .frame(maxWidth: .infinity)
            // Opaque, so the scrolled content doesn't show through behind the button.
            .background(Palette.ground.ignoresSafeArea())
        }
        .background(Palette.ground.ignoresSafeArea())
        .onAppear { model.banner = nil }
    }

    private func pair() async {
        nameFocused = false
        await model.join(.init(pairingLink: link, deviceName: name))
        // Paired: the app moves on by itself. Not paired: back to the first screen, whose
        // banner says why.
        if model.registration == nil { onFailed() }
    }
}
