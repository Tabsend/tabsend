import SwiftUI
import TabsendKit

/// The group's history [ADR-0028]: one timeline, newest first, sent and received
/// together, including transfers between two other devices.
///
/// This evolves P-7's received-tabs screen rather than replacing it. That screen
/// closed half the problem — a received tab lived only in its notification, so one
/// swipe lost it — and could not close the other half at all: a tab that is sent,
/// never arrives, and whose source tab is then closed existed nowhere, because the
/// sender drops its copy the moment the relay accepts it.
///
/// Notifications stay the primary surface (PRD §6.4: Tabsend never intercepts, the
/// user taps). This is the backstop, which is why an already-opened tab stays
/// listed but dimmed rather than disappearing: the screen has to be worth opening
/// even on the days nothing was lost.
struct HistoryView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.openURL) private var openURL
    /// What a "Send again" did. Held here rather than in the app-wide banner: this
    /// screen is pushed on top of the one that renders those, so the answer would
    /// arrive behind the user.
    @State private var resendNotice: String?

    private var selfEndpointId: String { model.registration?.endpointId ?? "" }

    /// A day's worth of groups, under one section header.
    private struct DaySection: Identifiable {
        let id: Int
        let title: String
        var groups: [HistoryGroup]
    }

    /// Today / Yesterday / Earlier, in the timeline's own newest-first order. A
    /// group goes under the day of its first (newest) row; a stamp that will not
    /// parse files under "Earlier" rather than claiming a day it can't prove.
    private var daySections: [DaySection] {
        var sections: [DaySection] = []
        for group in model.historyGroups {
            let title = Self.dayTitle(group.items.first?.createdAt)
            if let last = sections.last, last.title == title {
                sections[sections.count - 1].groups.append(group)
            } else {
                sections.append(DaySection(id: sections.count, title: title, groups: [group]))
            }
        }
        return sections
    }

    private static func dayTitle(_ iso: String?) -> String {
        guard let iso, let date = WireDate.date(from: iso) else { return "Earlier" }
        let calendar = Calendar.current
        if calendar.isDateInToday(date) { return "Today" }
        if calendar.isDateInYesterday(date) { return "Yesterday" }
        return "Earlier"
    }

    var body: some View {
        // Read once per render: the footer below needs to know which section is last.
        let sections = daySections
        List {
            if let resendNotice {
                Section {
                    Text(resendNotice)
                        .font(.subheadline)
                        .foregroundColor(.primary)
                        .panelRow()
                }
            }

            if model.historyGroups.isEmpty {
                Section {
                    Text(emptyLine)
                        .font(.body)
                        .foregroundColor(Palette.muted)
                        .padding(.vertical, 4)
                        .panelRow()
                } footer: {
                    retentionFooter
                }
            }

            ForEach(sections) { section in
                Section {
                    ForEach(section.groups) { group in
                        // Only a real multi-tab send gets a heading. A single send under
                        // a "1 tabs" heading would be noise, and its row already names
                        // both the route and the age.
                        if group.batchId != nil, let first = group.items.first {
                            Text(
                                "\(Inbox.batchHeading(group)) · "
                                + History.route(first, direction: direction(first))
                                + " · \(Inbox.relativeTime(first.createdAt))"
                            )
                            .font(.footnote.weight(.semibold))
                            .foregroundColor(Palette.muted)
                            .accessibilityAddTraits(.isHeader)
                            .panelRow()
                        }
                        ForEach(group.items) { item in
                            row(item, grouped: group.batchId != nil)
                        }
                    }
                } header: {
                    PanelSectionHeader(section.title)
                } footer: {
                    // The retention line closes the list, under its last section.
                    if section.id == sections.count - 1 {
                        retentionFooter
                    }
                }
            }
        }
        .groupedListBackground()
        .navigationTitle("History")
        .navigationBarTitleDisplayMode(.large)
        // Rebuilt on every appearance rather than once: the user leaves this screen
        // BY opening a tab, and comes back to a row that should now be dimmed.
        // Arrivals while it is open land the same way.
        .onAppear { model.refreshHistory() }
    }

    private var retentionFooter: some View {
        Text(History.retentionLine(relayKeepsHistory: model.relayKeepsHistory))
            .foregroundColor(Palette.muted)
    }

    /// Why the list is empty, which is two different situations. A relay that
    /// predates ADR-0028 is not broken and needs no action from the user's phone,
    /// so the sentence says what is missing and where it lives.
    private var emptyLine: String {
        model.relayKeepsHistory
            ? """
            Nothing here yet. Tabs you send and tabs that arrive both show up on \
            this screen, so a swiped notification or a closed tab doesn't lose one.
            """
            : """
            Your relay is older than group history, so it keeps no record of what \
            was sent. Sending and receiving work normally. Update the relay to see \
            this screen fill in.
            """
    }

    // There is deliberately no "Open all" button. iOS hands control to the browser
    // on the first open and does not promise to honour the rest, so the control
    // would open some unknown number of the tabs and claim it opened all of them.
    // Android has it because Android can actually do it.
    private func row(_ item: HistoryItem, grouped: Bool) -> some View {
        let direction = direction(item)
        let state = History.state(item)
        let openable = item.payload.flatMap { LinkURLPolicy.openableURL(from: $0.url) }
        let flagged = direction == .sent && state == .neverArrived
        return VStack(alignment: .leading, spacing: 6) {
            Button {
                open(item)
            } label: {
                HStack(alignment: .top, spacing: 12) {
                    // Mail imagery, never a bare arrow (ADR-0028 decision 9): a
                    // paper plane for what this phone sent, a tray for what it
                    // received, a neutral exchange glyph when neither end is here.
                    SymbolTile(systemName: History.symbol(direction), color: Self.tileColor(direction))
                    VStack(alignment: .leading, spacing: 2) {
                        Text(History.displayTitle(item))
                            .font(.body)
                            .foregroundColor(.primary)
                            .lineLimit(2)
                        Text(History.subtitle(item, direction: direction, grouped: grouped))
                            .font(.subheadline)
                            .foregroundColor(Palette.muted)
                            .lineLimit(2)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            // Plain, not the default style: a tinted button paints its WHOLE label
            // in the accent colour, which turned every row blue and left the dimmed
            // already-opened rows barely distinguishable from the rest. The row is
            // still fully tappable (contentShape above).
            .buttonStyle(.plain)
            .disabled(openable == nil)

            // Only a sent row reports state. A received row arriving is what put it
            // on the screen, and a transfer between two other devices is not this
            // phone's to chase. Every state is an icon AND a word, never colour alone.
            if direction == .sent, let line = History.stateLine(item) {
                HStack(spacing: 6) {
                    Image(systemName: Self.stateSymbol(state))
                        .font(.caption.weight(.bold))
                        .accessibilityHidden(true)
                    Text(line)
                        .font(.footnote.weight(.semibold))
                    if state == .neverArrived, History.sendAgainPayload(item) != nil {
                        Spacer()
                        Button("Send again") {
                            Task { resendNotice = await model.sendAgain(item) }
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                        .tint(Palette.accent)
                    }
                }
                .foregroundColor(Self.stateColor(state))
                // Under the title: the 30 pt tile plus the row's 12 pt spacing.
                .padding(.leading, 42)
            }
        }
        .padding(.vertical, 4)
        // Dimmed once opened, still listed. The contrast is the point: what is
        // full-strength here is what has not been dealt with yet. A row this phone
        // did not receive has nothing to open, so it never dims.
        .opacity(item.openedAt == nil ? 1 : 0.5)
        // A never-arrived send is the one row on this screen that is asking for
        // something, so it is the one row with a tint behind it.
        .listRowBackground(
            ZStack {
                Palette.panel
                if flagged { Palette.danger.opacity(0.08) }
            }
        )
        .listRowSeparatorTint(Palette.separator)
    }

    /// Tile colour by direction: `petrol` for what arrived here, `accentFill`
    /// for what this phone sent, grey for a transfer between two other devices.
    private static func tileColor(_ direction: HistoryDirection) -> Color {
        switch direction {
        case .received: return Palette.petrol
        case .sent: return Palette.accentFill
        case .between: return Palette.tileGrey
        }
    }

    private static func stateSymbol(_ state: HistoryState) -> String {
        switch state {
        case .arrived: return "checkmark.circle.fill"
        case .waiting: return "clock"
        case .neverArrived: return "exclamationmark.circle.fill"
        }
    }

    private static func stateColor(_ state: HistoryState) -> Color {
        switch state {
        case .arrived: return Palette.success
        case .waiting: return Palette.waitingText
        case .neverArrived: return Palette.danger
        }
    }

    private func direction(_ item: HistoryItem) -> HistoryDirection {
        History.direction(item, selfEndpointId: selfEndpointId)
    }

    private func open(_ item: HistoryItem) {
        // Re-check the scheme here, not only at receipt: this is the step that
        // turns a stored string back into a navigation, and the check that makes
        // that safe belongs next to the tap.
        guard let payload = item.payload,
              let url = LinkURLPolicy.openableURL(from: payload.url)
        else { return }
        openURL(url)
        model.markReceivedOpened([item.id])
    }
}
