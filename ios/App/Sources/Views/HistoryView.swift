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
/// listed rather than disappearing: the screen has to be worth opening
/// even on the days nothing was lost.
struct HistoryView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.openURL) private var openURL
    /// What a "Send again" did. Held here rather than in the app-wide banner, which
    /// Home renders: the answer would arrive on a tab the user is not looking at.
    @State private var resendNotice: String?

    private var selfEndpointId: String { model.registration?.endpointId ?? "" }

    /// Which day a group of rows is filed under.
    private enum Day {
        case today, yesterday, earlier

        var title: LocalizedStringKey {
            switch self {
            case .today: return "Today"
            case .yesterday: return "Yesterday"
            case .earlier: return "Earlier"
            }
        }
    }

    /// A day's worth of groups, under one section header.
    private struct DaySection: Identifiable {
        let id: Int
        let day: Day
        var groups: [HistoryGroup]
    }

    /// Today / Yesterday / Earlier, in the timeline's own newest-first order. A
    /// group goes under the day of its first (newest) row; a stamp that will not
    /// parse files under "Earlier" rather than claiming a day it can't prove.
    private var daySections: [DaySection] {
        var sections: [DaySection] = []
        for group in model.historyGroups {
            let day = Self.day(group.items.first?.createdAt)
            if let last = sections.last, last.day == day {
                sections[sections.count - 1].groups.append(group)
            } else {
                sections.append(DaySection(id: sections.count, day: day, groups: [group]))
            }
        }
        return sections
    }

    private static func day(_ iso: String?) -> Day {
        guard let iso, let date = WireDate.date(from: iso) else { return .earlier }
        let calendar = Calendar.current
        if calendar.isDateInToday(date) { return .today }
        if calendar.isDateInYesterday(date) { return .yesterday }
        return .earlier
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
                            let heading = Inbox.batchHeading(group)
                            let moved = History.route(first, direction: direction(first))
                            let age = Inbox.relativeTime(first.createdAt)
                            Text("\(heading) · \(moved) · \(age)")
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
                    PanelSectionHeader(section.day.title)
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
        .refreshable { await model.drain() }
        // Rebuilt on every appearance rather than once: the user leaves this screen
        // by opening a tab, and comes back to a row whose state has changed.
        // Arrivals while it is open land the same way.
        .onAppear { model.refreshHistory() }
    }

    private var retentionFooter: some View {
        let retention = History.retentionLine(relayKeepsHistory: model.relayKeepsHistory)
        let line = model.websiteImagesOn
            ? Text("\(retention)\n\nWebsite images load from linked sites, which can see requests from this device.")
            : Text(verbatim: retention)
        return line
            .foregroundColor(Palette.muted)
    }

    /// Why the list is empty, which is two different situations. A relay that
    /// predates ADR-0028 is not broken and needs no action from the user's phone,
    /// so the sentence says what is missing and where it lives.
    private var emptyLine: String {
        if model.relayKeepsHistory {
            return String(
                localized: "Nothing here yet. Tabs you send and tabs that arrive both show up on this screen, so a swiped notification or a closed tab doesn't lose one.",
                comment: "Message on the empty History screen. Explains what will appear here."
            )
        }
        return String(
            localized: "Your relay is older than group history, so it keeps no record of what was sent. Sending and receiving work normally. Update the relay to see this screen fill in.",
            comment: "Message on the empty History screen when the relay (the server that passes tabs between devices) is too old to keep a history. Nothing is wrong with the phone."
        )
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
        let isNew = History.isNew(item, direction: direction) && openable != nil
        // A delivered send says so on its one line; a line of its own is for a send
        // that still has something to tell.
        let delivered = direction == .sent && state == .arrived
        return VStack(alignment: .leading, spacing: 6) {
            LinkPreviewReader(item: item) { preview in
                Button {
                    open(item)
                } label: {
                    HStack(spacing: 12) {
                        // Mail imagery, never a bare arrow (ADR-0028 decision 9): a
                        // paper plane for what this phone sent, a tray for what it
                        // received, a neutral exchange glyph when neither end is here.
                        // Decorative: the line under the title says the same in words.
                        Image(systemName: History.symbol(direction))
                            .font(.system(size: 16))
                            .foregroundColor(flagged ? Palette.danger : Palette.muted)
                            .frame(width: Self.glyphWidth)
                            .accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(Self.title(item, preview: preview))
                                .font(.body)
                                .foregroundColor(.primary)
                                .lineLimit(1)
                            Text(
                                History.subtitle(item, direction: direction, grouped: grouped)
                                    + (delivered ? " · Delivered" : "")
                            )
                                .font(.subheadline)
                                .foregroundColor(Palette.muted)
                                .lineLimit(2)
                            if isNew {
                                HStack(spacing: 5) {
                                    Circle()
                                        .fill(Palette.accent)
                                        .frame(width: 8, height: 8)
                                        .accessibilityHidden(true)
                                    Text("New")
                                        .font(.caption.weight(.semibold))
                                        .foregroundColor(Palette.accent)
                                }
                            }
                        }
                        Spacer(minLength: 0)
                        SitePicture(slot: preview.slot, letter: History.siteLetter(item))
                            .frame(width: 44, height: 44)
                            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                }
                // Plain avoids tinting the whole label; the row remains fully tappable.
                .buttonStyle(.plain)
                .disabled(openable == nil)
            }

            // Only a sent row reports state. A received row arriving is what put it
            // on the screen, and a transfer between two other devices is not this
            // phone's to chase. Every state is an icon AND a word, never colour alone.
            if direction == .sent, !delivered, let line = History.stateLine(item) {
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
                // Under the title: the glyph plus the row's 12 pt spacing.
                .padding(.leading, Self.glyphWidth + 12)
            }
        }
        .padding(.vertical, 2)
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

    private static let glyphWidth: CGFloat = 22

    /// The tab's own title, else the page's, else the site.
    private static func title(_ item: HistoryItem, preview: LinkPreviewState) -> String {
        let own = item.payload?.title?.trimmingCharacters(in: .whitespaces) ?? ""
        return own.isEmpty ? (preview.pageTitle ?? History.displayTitle(item)) : History.displayTitle(item)
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
