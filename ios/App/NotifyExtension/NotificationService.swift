import Foundation
import UserNotifications
import TabsendKit

/// The notification extension (docs/PLANS.md P-29).
///
/// A phone rung in the `alert` style gets a visible push whose only text is "New link"
/// (the key `NEW_LINK`, looked up in the app's catalog). Before iOS shows it, it runs this
/// extension, which does what the app does on a silent wake: fetch what is waiting from
/// the phone's own relay, decrypt it, and present it. The first link becomes the push's
/// own content, so the notification on screen shows its title and address; any other
/// waiting link is posted beside it, as the app would post it. The link never passes
/// through Apple or the forwarder: the push only says that something is waiting.
///
/// What this test build does not do yet (P-29 steps 3 and 4):
/// - It takes no lock against the app draining at the same moment, so a link can show
///   twice if both run together.
/// - The first link is acknowledged when the extension takes it, before iOS shows it; a
///   crash in between leaves it in History but not on screen.
/// - Held tabs waiting to be sent, group keys and history stay with the app, which does
///   them the next time it runs.
///
/// When it cannot fill the push in (time runs out, the relay does not answer, the phone
/// has not been unlocked since it restarted so the keys cannot be read, or the only thing
/// waiting is a blocked link), iOS shows the plain "New link" text, and the app collects
/// the link when it next opens.
final class NotificationService: UNNotificationServiceExtension {
    private let reply = Reply()
    private var work: Task<Void, Never>?

    override func didReceive(
        _ request: UNNotificationRequest,
        withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
    ) {
        reply.start(fallback: request.content, handler: contentHandler)
        let reply = self.reply
        work = Task {
            await Self.collect(reply: reply)
            reply.finish()
        }
    }

    /// iOS's last call before it ends the extension, about 30 seconds in. Whatever was
    /// found by now is shown; the drain stops at its next network call.
    override func serviceExtensionTimeWillExpire() {
        work?.cancel()
        reply.finish()
    }

    private static func collect(reply: Reply) async {
        let store = AppGroupStore()
        // Instant delivery switched off: this ring is one that was queued at Apple before, and
        // the switch says the phone does not drain from a push (review P7). The plain text stands.
        guard !store.instantDeliveryOptOut else { return }
        // No registration: not paired, or the phone has not been unlocked since it
        // restarted and the Keychain cannot be read yet. The plain text stands.
        guard let reg = store.registration else { return }
        let deliverer = Deliverer(store: store) { payload, messageId in
            // A blocked link (not http or https) is left on the relay for the app, which
            // has the wording for it.
            guard let content = LinkNotification.content(payload: payload, messageId: messageId) else {
                return false
            }
            if reply.offerFirst(content) { return true }
            return await LinkNotification.post(content, identifier: messageId)
        }
        // The drain's device list runs the new-device rule (P-10, P-23), which hands each device
        // over once: it is announced from here, or never. So it is posted the moment the rule
        // has it, not after the whole drain: iOS can end this process at its time limit, and a
        // notice saved as told but not shown is lost for good (security review v0.11.0, P1).
        await deliverer.announceNewDevices { announcement in
            await LinkNotification.postNewDevices(announcement)
        }
        _ = await deliverer.drain()
        // A reset rings the same doorbell (`provisioning.ts`), so this ring may be about
        // one, with no link waiting at all.
        let api = ApiClient(
            relayUrl: reg.relayUrl,
            deviceToken: reg.deviceToken,
            certFingerprint: reg.certFingerprint
        )
        if let reset = await GroupReset.refresh(api: api, store: store) {
            await LinkNotification.postGroupReset(reset)
        }
    }
}

/// The one answer iOS gets, given exactly once: the first link's content when one was
/// found, the push as it came otherwise. Locked, because the drain and the expiry call
/// arrive on different threads.
private final class Reply: @unchecked Sendable {
    private let lock = NSLock()
    private var handler: ((UNNotificationContent) -> Void)?
    private var fallback: UNNotificationContent?
    private var first: UNNotificationContent?
    private var answered = false

    func start(fallback: UNNotificationContent, handler: @escaping (UNNotificationContent) -> Void) {
        lock.withLock {
            self.fallback = fallback
            self.handler = handler
        }
    }

    /// Take this content as the push's own, if no link has been taken and iOS has not
    /// been answered. False means the caller posts it as a notification of its own.
    func offerFirst(_ content: UNNotificationContent) -> Bool {
        lock.withLock {
            guard first == nil, !answered else { return false }
            first = content
            return true
        }
    }

    func finish() {
        let answer: ((UNNotificationContent) -> Void, UNNotificationContent)? = lock.withLock {
            guard !answered, let handler, let content = first ?? fallback else { return nil }
            answered = true
            return (handler, content)
        }
        if let (handler, content) = answer { handler(content) }
    }
}
