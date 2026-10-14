import Intents
import UIKit
import TabsendKit

/// Donates one conversation per paired device, so `Reddit → Share → MacBook Pro`
/// lands in one tap instead of three (INTERACTION_FLOWS §2.6). The iOS half of
/// android/.../send/ShareShortcuts.kt.
///
/// The mechanism is Apple's "sharing suggestions": an `INSendMessageIntent`
/// donated in an `INInteraction` puts a conversation in the share sheet's
/// suggestions row, and picking one launches our share extension with that intent
/// on `extensionContext.intent` — same extension, same send path, minus the
/// chooser. A device is not a person, so `recipients` stays nil and the device
/// name travels as `speakableGroupName`: the moment an `INPerson` is attached the
/// row renders it as a contact, falls back to a Contacts lookup when it has no
/// image, and can put a real human's face on a laptop.
///
/// Lives outside TabsendKit because Intents has no Linux port and TabsendKit is
/// unit-tested there; the selection itself is `SuggestionPlan`, which is pure.
/// Compiled into BOTH the app and the share extension, because both donate.
///
/// Nothing here reaches the network or the relay: the device list is already on
/// the phone, and a donation carries only a label the user chose themselves.
enum ShareSuggestions {

    private enum Key {
        static let signature = "suggest.signature"
        static let donatedIds = "suggest.ids"
    }

    /// App Group, so the app and the share extension agree about what has already
    /// been donated — they are separate processes donating to one shared surface.
    private static let defaults =
        UserDefaults(suiteName: AppGroupStore.defaultAppGroup) ?? .standard

    /// Re-donate the suggestion set from a freshly-known device list, and return
    /// what it now believes is on offer.
    ///
    /// Called from every place that already refreshes endpoints, so the row tracks
    /// pairings, renames and MRU order without a job of its own.
    ///
    /// Work is skipped when the donated set already matches. That is not just an
    /// optimisation: unlike Android's shortcut set, which is replaced wholesale on
    /// every publish, each donation is a separate interaction the system keeps —
    /// so re-donating an unchanged set on every drain would pile up records that
    /// say nothing new and flatten the recency signal that ranks the row.
    @discardableResult
    static func sync(endpoints: [Endpoint], store: TabsendStore) -> [SuggestionTarget] {
        guard let reg = store.registration else {
            clear()
            return []
        }
        let rows = Chooser.build(
            endpoints: endpoints,
            selfEndpointId: reg.endpointId,
            prefs: store.sourcePrefs
        )
        let plan = SuggestionPlan.build(rows: rows)

        let signature = SuggestionPlan.signature(plan)
        guard signature != defaults.string(forKey: Key.signature) else { return plan }

        // Endpoints that left the plan are DELETED, not merely left un-donated.
        // This is where iOS and Android diverge and the difference bites: on
        // Android a shortcut disappears the moment it stops being published,
        // whereas a donation persists on its own until something removes it. So
        // an unpaired laptop — or one that has gone dark long enough to fail the
        // staleness test — would otherwise keep its place in the sheet forever.
        let keep = Set(plan.map(\.endpointId))
        for endpointId in (defaults.stringArray(forKey: Key.donatedIds) ?? []) where !keep.contains(endpointId) {
            INInteraction.delete(with: SuggestionPlan.conversationId(for: endpointId))
        }

        // Tail first, head last. iOS takes no ordering hint — the row is ranked by
        // the system's own model — so donation recency is the only lever there is,
        // and spending it on the chooser's head is what keeps the two agreeing.
        for target in plan.reversed() { donate(target) }

        // Recorded now rather than in the completion handlers: a donation fails
        // either transiently (one refresh missed, the next one re-donates once
        // anything changes) or because the Info.plist declaration is missing, and
        // that second kind is permanent — retrying it on every drain forever would
        // buy nothing.
        defaults.set(signature, forKey: Key.signature)
        defaults.set(plan.map(\.endpointId), forKey: Key.donatedIds)
        return plan
    }

    /// Tell the system a target was actually used, so frequently-used devices
    /// float up the suggestions row. Ranking is the platform's to decide; a
    /// donation is the only signal we get to feed it.
    ///
    /// Takes the plan rather than looking it up, so a target that has no slot
    /// cannot be given one through the back door: sending to a month-dark device
    /// from the chooser is allowed (presence is non-gating, ADR-0001) and must not
    /// be what puts it in the sheet.
    ///
    /// History is keyed on the conversation id, which is built from the relay's
    /// endpoint id: renaming a device therefore keeps its accumulated ranking, and
    /// only unpairing (a new endpoint id, plus the purge in [clear]) resets it.
    static func reportUsed(_ endpointId: String, in plan: [SuggestionTarget]) {
        guard let target = plan.first(where: { $0.endpointId == endpointId }) else { return }
        donate(target)
    }

    /// Unpair: the group is gone, so no device may keep a slot in the share sheet.
    ///
    /// `deleteAll` is safe to reach for because sharing suggestions are the only
    /// thing Tabsend ever donates.
    static func clear() {
        INInteraction.deleteAll()
        defaults.removeObject(forKey: Key.signature)
        defaults.removeObject(forKey: Key.donatedIds)
    }

    private static func donate(_ target: SuggestionTarget) {
        let conversationId = SuggestionPlan.conversationId(for: target.endpointId)
        let intent = INSendMessageIntent(
            recipients: nil,
            outgoingMessageType: .outgoingMessageText,
            content: nil,
            speakableGroupName: INSpeakableString(spokenPhrase: target.label),
            conversationIdentifier: conversationId,
            serviceName: nil,
            sender: nil,
            attachments: nil
        )
        if let avatar = avatar(for: target.kind) {
            intent.setImage(avatar, forParameterNamed: \.speakableGroupName)
        }

        let interaction = INInteraction(intent: intent, response: nil)
        interaction.direction = .outgoing
        // Grouped on the conversation id so unpairing a single device can drop
        // every interaction it ever accumulated in one call, without disturbing
        // the devices that stayed.
        interaction.groupIdentifier = conversationId
        interaction.donate { _ in
            // Best-effort surface: the plain "Send tab to" extension entry is
            // always there, and a send must never fail because a hint didn't land.
        }
    }

    /// The badge the suggestion carries, mirroring Android's `ic_shortcut_*`.
    ///
    /// The circle is drawn rather than left to the surface, for the same reason it
    /// is on Android: a bare glyph on transparent looks broken wherever the sheet
    /// doesn't mask it. Rendered to PNG data rather than handed over as a file URL
    /// — an `INImage(url:)` points at a file the system does not copy, so the
    /// avatar vanishes a day or two later when the container is cleaned up while
    /// the donation itself lives on, leaving a nameless blank in the row.
    private static func avatar(for kind: String) -> INImage? {
        // 360pt square: Apple's documented floor for images attached to a shared
        // intent, and comfortably above any avatar size the row asks for.
        let side: CGFloat = 360
        let symbolName = kind == "mobile" ? "iphone" : "macwindow"
        let configuration = UIImage.SymbolConfiguration(pointSize: side * 0.5, weight: .regular)
        guard let glyph = UIImage(systemName: symbolName, withConfiguration: configuration) else {
            return nil
        }

        // #2F6FED / white, the same pair as Android's colors.xml.
        let brand = UIColor(red: 47.0 / 255, green: 111.0 / 255, blue: 237.0 / 255, alpha: 1)
        let size = CGSize(width: side, height: side)
        let rendered = UIGraphicsImageRenderer(size: size).image { context in
            brand.setFill()
            context.cgContext.fillEllipse(in: CGRect(origin: .zero, size: size))
            let tinted = glyph.withTintColor(.white, renderingMode: .alwaysOriginal)
            tinted.draw(in: CGRect(
                x: (side - tinted.size.width) / 2,
                y: (side - tinted.size.height) / 2,
                width: tinted.size.width,
                height: tinted.size.height
            ))
        }
        guard let data = rendered.pngData() else { return nil }
        return INImage(imageData: data)
    }
}
