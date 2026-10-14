import SwiftUI
import UIKit
import TabsendKit

/// The send banner's states (docs/APP_UI.md "Send toast"), and exactly which
/// outcome of `Sender.send` produces each. Nothing here is a state the send path
/// cannot actually tell apart, and there is no Undo: a phone send is not held,
/// so there is nothing to take back.
enum SendToastState: Equatable {
    /// The POST is in flight.
    case sending(label: String, title: String)
    /// `banner.tone == .success`, target online: the relay accepted the tab.
    case sent(label: String, title: String)
    /// `banner.tone == .success` with `Result.queued`: the relay accepted it and is
    /// holding it because the target is asleep. Opens there when it wakes.
    case heldForDevice(label: String, title: String)
    /// `banner.tone == .pending`: the relay did NOT take it (unreachable, offline,
    /// 429/5xx, or a per-group cap). The tab stays in this phone's outbound queue
    /// and the ordinary flush retries it. Headline and reason are the shared copy.
    case heldOnPhone(SendBanner)
    /// `banner.tone == .error`: a final refusal; the tab left the queue unsent.
    case failed(SendBanner)

    static func outcome(
        of banner: SendBanner,
        relayHoldsForAsleepTarget: Bool,
        label: String,
        tabName: String
    ) -> SendToastState {
        switch banner.tone {
        case .success:
            return relayHoldsForAsleepTarget
                ? .heldForDevice(label: label, title: tabName)
                : .sent(label: label, title: tabName)
        case .pending:
            return .heldOnPhone(banner)
        case .error:
            return .failed(banner)
        }
    }

    var headline: String {
        switch self {
        case .sending(let label, _): return "Sending to \(label)…"
        case .sent(let label, _): return "Sent to \(label)"
        case .heldForDevice(let label, _): return "Waiting for \(label)"
        case .heldOnPhone(let banner), .failed(let banner): return banner.headline
        }
    }

    /// The tab's name, shown as its own line (not styled like the explanation).
    var tabLine: String? {
        switch self {
        case .sending(_, let title), .sent(_, let title): return title
        case .heldForDevice: return nil
        case .heldOnPhone(let banner), .failed(let banner): return banner.title
        }
    }

    /// The muted line: the reason, or what happens next.
    var detail: String? {
        switch self {
        case .sending, .sent: return nil
        case .heldForDevice: return "Opens there when it wakes"
        case .heldOnPhone(let banner), .failed(let banner): return banner.detail
        }
    }

    /// Only outcomes where the relay HAS the tab dismiss themselves.
    var autoDismissSeconds: Double? {
        switch self {
        case .sent: return 2.5
        case .heldForDevice: return 3
        case .sending, .heldOnPhone, .failed: return nil
        }
    }

    var showsClose: Bool {
        switch self {
        case .heldOnPhone, .failed: return true
        case .sending, .sent, .heldForDevice: return false
        }
    }

    /// What VoiceOver hears when the result lands.
    var announcement: String {
        [headline, tabLine, detail].compactMap { $0 }.joined(separator: ". ")
    }
}

/// An iOS-style banner that drops in at the top (docs/APP_UI.md, "Phones:
/// native-leaning", Send feedback), like AirDrop or Apple Pay confirmations: a
/// rounded `panel` with a soft blur shadow and no outline, a 34 pt round status
/// icon, one bold line and muted lines under it.
struct SendToast: View {
    let state: SendToastState
    let close: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            StatusDisc(state: state)
            VStack(alignment: .leading, spacing: 2) {
                Text(state.headline)
                    .font(.headline)
                    .foregroundColor(.primary)
                    .fixedSize(horizontal: false, vertical: true)
                if let tabLine = state.tabLine {
                    Text(tabLine)
                        .font(.subheadline)
                        .foregroundColor(.primary)
                        .lineLimit(1)
                }
                if let detail = state.detail {
                    Text(detail)
                        .font(.subheadline)
                        .foregroundColor(Palette.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if state.showsClose {
                    Button("Close", action: close)
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                        .tint(Palette.accent)
                        .padding(.top, 6)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .fill(Palette.panel)
                .shadow(color: Color.black.opacity(0.18), radius: 18, x: 0, y: 8)
        )
        .accessibilityElement(children: .contain)
    }
}

/// The 34 pt round status icon. Every state has a glyph as well as a colour.
private struct StatusDisc: View {
    let state: SendToastState

    /// Dark glyph on the amber fill, in both modes (amber is the same in both).
    private static let onWaiting = Color(uiColor: UIColor(rgb: 0x10201E, alpha: 1))

    var body: some View {
        ZStack {
            Circle().fill(fill)
            if isSending {
                ProgressView()
                    .tint(.primary)
                    .scaleEffect(0.8)
            } else {
                Image(systemName: symbol)
                    .font(.system(size: 15, weight: .bold))
                    .foregroundColor(glyph)
            }
        }
        .frame(width: 34, height: 34)
        .accessibilityHidden(true)
    }

    private var isSending: Bool {
        if case .sending = state { return true }
        return false
    }

    private var fill: Color {
        switch state {
        case .sending: return Palette.ground
        case .sent: return Palette.success
        case .heldForDevice, .heldOnPhone: return Palette.waitingFill
        case .failed: return Palette.danger
        }
    }

    /// `panel` on the success and danger fills: white in light mode, and the dark
    /// panel on dark mode's lighter success and danger colours.
    private var glyph: Color {
        switch state {
        case .sending: return .primary
        case .sent, .failed: return Palette.panel
        case .heldForDevice, .heldOnPhone: return Self.onWaiting
        }
    }

    private var symbol: String {
        switch state {
        case .sending: return "ellipsis"
        case .sent: return "checkmark"
        case .heldForDevice: return "clock"
        // Held on this phone and retried by the queue on its own.
        case .heldOnPhone: return "arrow.clockwise"
        case .failed: return "exclamationmark"
        }
    }
}
