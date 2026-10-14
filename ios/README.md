# Tabsend for iOS

Native iOS client: pair with your group, send tabs from the share sheet,
receive links as notifications that open in your default browser.

## Status

**v0.6 engineering preview, built and verified end-to-end in the iOS Simulator** (Xcode 26.6,
iPhone 17 Pro, iOS 26.5) against a real relay running with
`TLS_SELF_SIGNED=1`:

- paired over HTTPS with a **pinned self-signed certificate**,
- appeared on the relay as an **online** `mobile` endpoint (WebSocket held),
- **received** a link sealed by libsodium on the Mac — notification showed the
  decrypted title and URL within a second, and the message was acked,
- **sent** a tab from Safari through the **share extension** ("Send tab to"),
  which the Mac peer decrypted back to `{url, title, sentAt}`.

What exists:

- **`TabsendKit/`** — the protocol + crypto core as a Swift package with no
  external dependencies. NaCl `crypto_box` (X25519 + XSalsa20-Poly1305) is
  implemented in Swift on top of CryptoKit and pinned byte-for-byte to
  libsodium by the same interop vector the Android app uses. Also: relay REST
  client, `/v1/stream` WebSocket client, self-signed TLS pinning (ADR-0019),
  pairing-link parsing, relay address change (ADR-0020), the send path with
  offline queue, the idempotent receive drain, and the wake-up forwarder
  client plus the transport decision it feeds (`Forwarder.swift`,
  `WakePath.swift`, ADR-0032).
- **`App/Sources/`** — the SwiftUI app: join screen (paste or scan a complete
  pairing link), paired screen (device list, pair another device with QR,
  rename, unpair), link notifications, WebSocket while the app is open,
  opportunistic Background App Refresh drains, and the APNs side of the wake
  path (`AppDelegate.swift`), which shares one background sequence with the
  refresh task (`BackgroundDrain.swift`) rather than repeating it.
- **`App/ShareExtension/`** — the share-sheet target ("Send tab to") with the
  same chooser ordering and feedback copy as Android and the extension.
- **`App/Shared/`** — code compiled into both the app and the share extension.
  Today that is `ShareSuggestions`, which donates one `INSendMessageIntent` per
  paired device so the devices appear in the share sheet's **suggestions row**
  and a share can land on a named device in one tap (the iOS answer to Android's
  Sharing Shortcuts, INTERACTION_FLOWS §2.6). The selection itself is
  `SuggestionPlan` in TabsendKit; only the Intents calls live here, because
  Intents has no Linux port. Suggestions need a real device — the simulator's
  share sheet never shows the row.
- **`App/Assets.xcassets`** — the app icon. Same brand mark as the extension and
  Android, adapted for iOS: full-bleed and square-cornered, because iOS applies
  its own corner mask, and with no alpha channel, because App Store Connect
  rejects an icon that has one. Regenerate from `assets/tabsend-icon-ios.svg`
  with `ios/tools/make-app-icon.sh` (uses Quick Look, so no extra tooling).
- **`project.yml`** — XcodeGen definition for the two targets.

This is not physical-device or App Store evidence. App/extension Keychain sharing, signed
entitlements, share-sheet behavior, notification presentation and Background App Refresh
still need qualification on real iPhones before the iOS client should be described as a
published or production-ready release.

Verified with automated macOS tests, including

- byte-exact seal/open against the libsodium interop vector,
- SPKI pin fingerprints cross-checked against openssl (RSA 2048 + EC P-256),
- a full **integration run against a real relay** with self-signed TLS:
  register → mint pairing → join → send sealed → drain → ack, plus wrong-pin
  rejection and WebSocket delivery.

```sh
ios/TabsendKit/test.sh
```

To include the integration tests, start a relay with `TLS_SELF_SIGNED=1` and
pass its URL and pin:

```sh
TABSEND_RELAY_URL=https://127.0.0.1:18787 \
TABSEND_RELAY_FP=<pin from the relay boot log> \
ios/TabsendKit/test.sh --filter RelayIntegration
```

## Building the app

Needs **Xcode** (the Command Line Tools alone cannot build an iOS app) and
XcodeGen. `Tabsend.xcodeproj` is generated from `project.yml` and is
git-ignored — regenerate it rather than editing it.

```sh
brew install xcodegen
cd ios && xcodegen generate && open Tabsend.xcodeproj
```

In Xcode, select your signing team for both targets (Tabsend and
TabsendShare), pick a simulator or device, and run. From the command line:

```sh
xcodebuild -project ios/Tabsend.xcodeproj -scheme Tabsend -sdk iphonesimulator -destination 'platform=iOS Simulator,name=iPhone 17 Pro' build
```

To run on your own iPhone you need an Apple Developer account; with the free
tier the install expires after 7 days (PLANS.md P-5 discusses why that is and
what the long-term distribution options are).

## Delivery model (read this once)

iOS freezes backgrounded apps: no held connection, no timer, no self-wake
(PLANS.md P-5). The only reliable wake is APNs, and APNs takes instructions
only from a key Apple issues per developer account — which is why the wake-up
forwarder exists (`forwarder/PROTOCOL.md`, HOSTED_PLAN §6, ADR-0032). The app
holds that whole path but **it is dormant in this build**, for one reason:

> **No official forwarder instance is deployed yet, so no URL is baked in.**
> `ForwarderConfig.officialInstance` is `nil` and marked with the comment that
> says where the address goes before store publication. With no URL the app
> asks Apple for nothing, registers `{transport: "none"}`, and behaves exactly
> as v0.6 did. A default pointing at an address that cannot answer would make
> every install look broken with nothing on the phone able to explain why.

**Without a forwarder URL** (today, and on any build that does not set one),
the app registers `pushSubscription: {transport: "none"}` like Android
(ADR-0015), and delivery is:

- **instant** while the app is in the foreground (WebSocket),
- **on open** otherwise (drain on every foregrounding),
- **occasionally in between**, when iOS grants a Background App Refresh
  window — a bonus, never a promise.

**With a forwarder URL, and a relay whose operator configured one**, the app
registers `{transport: "forwarder", wakeToken}` and delivery is timely
whether or not the app is open. The sequence:

1. The app asks Apple for a device token at every launch and hands it to the
   forwarder, which returns a **wake token** (`POST /v1/register`).
2. The app hands that token to **its own relay**, at pairing and on every
   heartbeat. The relay never learns which forwarder minted it; it rings the
   one its own operator configured, and no URL travels in either direction.
3. A send makes the relay ring the forwarder, the forwarder tells Apple to
   wake this phone, and the phone **fetches the tab from its own relay** and
   decrypts it — the same drain as a Background App Refresh, same code path.
4. On unpair, or when the toggle goes off, the app revokes the wake token
   (`POST /v1/revoke`). Apple rotating the device token re-registers, which
   replaces the old wake token in the same transaction.

**The wake carries no content and none is read.** The payload is
`{"aps":{"content-available":1}}` and its arrival is the entire message.
Metadata cost, stated in the same words everywhere this path is described:
*the forwarder learns that a device received something, and when. Never what.*

Two rules the app must not break, both tested:

- **`forwarder` is never sent to a relay that does not advertise one.** The
  relay publishes `wakeForwarder` on `GET /v1/config` only where its operator
  set `WAKE_FORWARDER_URL`, and refuses the transport with `invalid_request`
  otherwise. The app reads the hint first and falls back to `none`.
- **Both transitions are handled on the heartbeat.** A relay that gains a
  forwarder starts being sent one at the next beat; a relay that loses one
  falls back without re-pairing, including the race where the loss happens
  between reading the hint and sending the beat.

**Instant delivery is on by default** once a URL is known (P-5): pairing turns
it on with no separate setup step. The paired screen carries the opt-out, and
it appears only where it would do something — this build knows a forwarder
**and** the paired relay has one. Turning it off revokes the wake token, tells
Apple to stop, and moves the relay back to `{transport: "none"}` on the same
beat.

**Nothing on this path has been run against real APNs or a real forwarder.**
See "Not yet proven" below.

## Deliberate differences from Android

- The private key and device token live in the **Keychain** (shared with the
  extension via an access group), not in preferences. They use
  `AfterFirstUnlockThisDeviceOnly`: background work can read them after the first
  unlock, but a backup restored to another phone does not clone the endpoint. The
  restored phone must pair as a new device.
- Received-tab history is plaintext only after on-device decryption, capped at 50,
  stored with iOS file protection, and excluded from device backups. v0.6's App Group
  preferences copy migrates to that protected file on first access.
- The "Instant delivery" toggle is **not** Android's. Android's switches a
  persistent foreground service that holds a WebSocket; iOS has no equivalent
  and never will. This one switches the APNs wake path (ADR-0032) and appears
  only where there is a forwarder on both ends to switch.

## Not yet proven

The wake path compiles and its logic is unit-tested against stubs. None of it
has met Apple or a running forwarder. A physical-device run still has to show:

- **register → wake → drain end to end**: a signed build on a real iPhone gets
  a device token, mints a wake token, hands it to a relay running with
  `WAKE_FORWARDER_URL`, and a send to the backgrounded phone produces the tab
  within seconds.
- **`aps-environment` is right in each build.** A locally-signed build gets a
  sandbox device token and a TestFlight one gets production, and
  `ApnsEnvironment.current` has to agree with what Apple actually issued or
  the forwarder calls the wrong Apple host. It now reads the answer out of the
  embedded provisioning profile instead of guessing from the build
  configuration, which is what a locally-signed Release build got wrong. Only a
  signed install can show the profile is read as expected: check a
  development-signed Release build reports sandbox, and a TestFlight build
  production.
- **Token rotation.** Restore or reinstall the app, confirm the new device
  token is registered again and the relay is given the replacement.
- **Revoke on unpair**, and on the opt-out toggle: the old token stops waking
  the phone.
- **App Group and Keychain sharing of the wake registration.** It sits beside
  the device token, so it inherits that gate: an unsigned Simulator build has
  empty entitlements and cannot prove it.
- **The background window ending early.** When iOS takes a Background App
  Refresh window back, the drain has to stop and the task has to be reported
  complete exactly once. Pause the running app in Xcode and force it:

  ```
  e -l objc -- (void)[[BGTaskScheduler sharedScheduler] _simulateLaunchForTaskWithIdentifier:@"io.tabsend.app.refresh"]
  e -l objc -- (void)[[BGTaskScheduler sharedScheduler] _simulateExpirationForTaskWithIdentifier:@"io.tabsend.app.refresh"]
  ```

  The relay requests in flight should stop, and the console should carry no
  complaint about a task being completed twice.

`docs/IOS_TEST_MATRIX.md` gates stay open until those are recorded.
