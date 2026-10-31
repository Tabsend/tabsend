import SwiftUI
import TabsendKit

/// Move to another relay: one field, a Check, one verdict, then exactly one
/// matching action. The iOS mirror of Android's `promptMoveRelay` and the
/// extension's "Where is your relay now?" panel, with the same words.
///
/// A verdict describes the address just checked, not whatever is typed now, so
/// editing the field drops it and the button goes back to "Check".
struct RelayMoveView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss

    @State private var address: String
    @State private var checking = false
    @State private var verdict: RelayMove.Verdict?
    /// A line that isn't a verdict: an empty field, or a switch that failed.
    @State private var note: String?
    @State private var confirmFresh = false

    init(currentUrl: String) {
        _address = State(initialValue: currentUrl)
    }

    private var candidate: String { Pairing.normalizeRelayUrl(address) }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    TextField("https://", text: $address)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.go)
                        .onSubmit { Task { await runCheck() } }
                        .onChange(of: address) { _ in
                            verdict = nil
                            note = nil
                        }
                        .panelRow()
                } header: {
                    PanelSectionHeader(RelayMove.hint)
                }

                if let status {
                    Section {
                        Label {
                            Text(status.text)
                                .fixedSize(horizontal: false, vertical: true)
                        } icon: {
                            Image(systemName: status.symbol)
                        }
                        .font(.subheadline)
                        .foregroundColor(status.color)
                        .padding(.vertical, 4)
                        .panelRow()
                    }
                }

                Section {
                    Button {
                        Task { await act() }
                    } label: {
                        Text(actionTitle)
                            .frame(maxWidth: .infinity)
                    }
                    .disabled(checking)
                    .panelRow()
                }
            }
            .groupedListBackground()
            .tint(Palette.accent)
            .navigationTitle(RelayMove.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
            .confirmationDialog(
                RelayMove.startFreshTitle(candidate),
                isPresented: $confirmFresh,
                titleVisibility: .visible
            ) {
                Button(RelayMove.switchRelay, role: .destructive) {
                    dismiss()
                    Task { await model.startFresh() }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text(RelayMove.startFreshBody)
            }
        }
    }

    private struct Status {
        var text: String
        var symbol: String
        var color: Color
    }

    private var status: Status? {
        if checking {
            return Status(text: RelayMove.checking, symbol: "hourglass", color: Palette.muted)
        }
        if let note {
            return Status(text: note, symbol: "exclamationmark.circle", color: Palette.danger)
        }
        switch verdict {
        case .same(_, let verified)?:
            return Status(
                text: verified ? RelayMove.same : RelayMove.sameUnverified,
                symbol: "checkmark.circle", color: Palette.success
            )
        case .different?:
            return Status(text: RelayMove.different, symbol: "exclamationmark.triangle", color: Palette.waitingText)
        case .unreachable(let url)?:
            return Status(text: RelayMove.unreachable(url), symbol: "exclamationmark.circle", color: Palette.danger)
        case .error(_, let detail)?:
            return Status(text: detail, symbol: "exclamationmark.circle", color: Palette.danger)
        case nil:
            return nil
        }
    }

    private var actionTitle: String {
        switch verdict {
        case .same?: return RelayMove.switchAddress
        case .different?: return RelayMove.switchRelay
        default: return RelayMove.check
        }
    }

    private func act() async {
        switch verdict {
        case .same(let url, _)?:
            checking = true
            let failure = await model.switchRelayAddress(to: url)
            checking = false
            if let failure {
                verdict = nil
                note = failure
            } else {
                dismiss()
            }
        case .different?:
            confirmFresh = true
        default:
            await runCheck()
        }
    }

    private func runCheck() async {
        note = nil
        verdict = nil
        guard !candidate.isEmpty else {
            note = RelayMove.empty
            return
        }
        let checked = candidate
        checking = true
        let result = await model.probeRelay(checked)
        checking = false
        // The field changed while the check ran: this verdict is about an old address.
        if candidate == checked { verdict = result }
    }
}
