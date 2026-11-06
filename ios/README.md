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

### A TestFlight build (no iPhone needed)

```sh
ios/tools/testflight-build.sh 723           # signs a copy and checks it, uploads nothing
ios/tools/testflight-build.sh 723 upload    # signs it and sends it to App Store Connect, without the permission check
```

The number is the build number: each upload needs one higher than the last (TestFlight showed 579
on 2026-11-03; 723, the commit count, on 2026-11-05). A plain Xcode archive does not work here: it
asks for a development profile, which needs a registered iPhone, and the team has none (the error
reads "Your team has no devices"). So the script archives unsigned, puts the permissions back by
hand (with the team's prefix filled in), and lets Xcode sign for the App Store with the Apple
account it is signed in to. The check step reads the finished file and refuses it if Associated
Domains, the App Group, the shared keychain group or production push is missing. It does not touch
`project.yml`. Apple's privacy manifest, `App/PrivacyInfo.xcprivacy`, is copied into the app, the
share extension and the notification extension by `project.yml` (it declares App Group UserDefaults); a new extension target needs
its own copy, or Apple can refuse the upload. Needs the capabilities on the App IDs (Associated Domains is on since 2026-11-05)
and `xcodegen`. It writes to `~/Library/Developer/Xcode/DerivedData/Tabsend-testflight`: delete it
afterwards, disk space is tight. The same method is in `voice-mode-ios/tools/testflight-build.sh`.

## Text and languages

Every sentence the app shows is in a String Catalog, so a language can be added later by
translating catalogs only. English is the one shipped language. The shared rules are in
`docs/L10N.md`; this is the iOS part.

| Catalog | What is in it |
|---|---|
| `App/Sources/Localizable.xcstrings` | the app's screens, dialogs and notifications |
| `App/ShareExtension/Localizable.xcstrings` | the share sheet and its toast |
| `App/Shared/Shared.xcstrings` (table `Shared`) | text in code both of them compile: device kinds, "Online", "Main" |
| `TabsendKit/Sources/TabsendKit/Resources/Localizable.xcstrings` | sentences built from names, counts, times and relay errors, and the notification text |
| `App/Sources/InfoPlist.xcstrings`, `App/ShareExtension/InfoPlist.xcstrings` | the app name and the camera prompt |

**The key is the English text** (Apple's convention, `docs/L10N.md` rule 6), so a missing
translation shows English and never a raw key. Placeholders are the platform's `%@` and
`%lld`, not named ones; the translator comment on each string names them, and a translation
may reorder them (`%2$@ ... %1$@`).

**How to add a string**

1. In SwiftUI write the literal (`Text("...")`, `Button`, `Label`, `.navigationTitle`,
   `PanelSectionHeader`, `TileLabel(title:)`). Anywhere else write
   `String(localized: "...", comment: "...")`; in TabsendKit add `bundle: .module`, in
   code under `App/Shared` add `table: "Shared"`. One whole sentence per string, never
   pieces joined in code. A count goes inside the sentence (`"\(count) tabs"`).
2. Run `ios/tools/l10n-sync.sh`. It builds, then adds the new key to the right catalog
   (a few minutes). Xcode does the same by itself when you build in its window.
3. Fill in the catalog: a translator comment (where it shows, what each placeholder is, a
   length limit if the space is tight), an English value, and for a count the plural forms
   (right-click the string in Xcode, Vary by Plural). If the sentence does not print the
   number ("it" or "them"), use two strings instead.
4. Run `node ios/tools/check-l10n.mjs` and `ios/TabsendKit/test.sh`. A sentence built in
   TabsendKit from names or counts also gets a line in `EnglishCopyGoldenTests`.
5. Text that is not shown to people (a product name, an address, a log line) is not put in a
   catalog. Mark its line `// l10n-ignore: <reason>`, or the check reports it.
6. An error from the relay is shown with `RelayErrorText.line(error, during:)`, never with
   `error.message`. A new relay error code gets its sentence there. A time since something
   happened uses `L10n.minutesAgo` and the other ages; a list of names uses `L10n.list`.

**How to add a language** (German as the example)

1. Open the six catalogs in Xcode, add German, translate every string, and fill the plural
   forms German needs. Translate the comments' meaning, not the comments.
2. Run `xcodegen generate`. It reads the languages out of the catalogs and lists them as the
   project's known regions, so `project.yml` does not change. **That is the whole project
   change for a new language: none.** (Checked: one German string in a catalog turns
   `knownRegions` from `Base, en` into `Base, de, en`, and the next regeneration keeps it, since
   it is read from the catalogs each time. A fresh project that says `Base, en` today is not a
   bug: no catalog has a German string yet.)
3. `node ios/tools/check-l10n.mjs` now also checks that German has every string and the
   same placeholders as English.
4. Run the Simulator in German (Settings > General > Language & Region, or the scheme's
   App Language) and look at every screen, including the share sheet and the notifications.
5. The store text is separate (`docs/STORE_LISTING.md`); add the language in App Store
   Connect when the build is ready.
6. `ios/TabsendKit/test.sh` runs the package tests in English whatever the Mac's own language is:
   the golden file and the wording tests read the catalog, and once German is in it a Mac set to
   German would read German and fail them (it did, on 2026-11-05: 545 assertions). On such a Mac the
   script goes through `xcodebuild test -testLanguage en` instead of `swift test`. A language is
   tested by naming it (`locale:` in `GermanFormatTests`), not by switching the machine.

**Checked for German, 2026-11-05** (docs/PLANS.md P-27). With a few German values in each of the six catalogs,
a Simulator build in German showed it in the app (first screen), in the text TabsendKit builds
("gerade eben", "vor 5 Min.", "A, B und C") and in the name under the icon (`InfoPlist.xcstrings`);
a Simulator in English showed English. Every bundle (app, share extension, TabsendKit) got a
`de.lproj`. Forcing `knownRegions` back to `Base, en` by hand gave byte-identical bundles, so
the list is a label for Xcode and does not decide what a phone loads. The share sheet's own
screen was not opened in the Simulator; its German text is in the extension's bundle. The
helpers in `TabsendKit/L10n.swift` take a `locale:` argument only so `GermanFormatTests` can
name German; the app never passes it.

**Checking the text** (what the check cannot see)

- `node ios/tools/check-l10n.mjs` runs in `scripts/check.sh`. It fails on a sentence-like
  literal that is not in a catalog (and not marked `l10n-ignore`), on a catalog string with
  no comment or no plural forms for a count, on a string no code uses, on an em dash in the
  English text, and on a screen that shows the relay's own `error.message`. It does not see
  a sentence assembled at run time.
- `ios/tools/l10n-sync.sh --check` compares the catalogs with the list of strings the
  compiler found. It needs the full build, so it is not in `scripts/check.sh`.
- **Double-Length Pseudolanguage**: in Xcode, Product > Scheme > Edit Scheme > Run >
  Options > App Language > Double-Length Pseudolanguage. From the command line, with the
  app installed in a booted Simulator:

  ```sh
  xcrun simctl launch booted io.tabsend.app -NSDoubleLocalizedStrings YES
  ```

  Every string that comes from a catalog is shown twice as long, so a layout that breaks
  when German is longer breaks now, and text that does not double never went through a
  catalog. Page titles and device names should not double: they are the person's own data.
  The doubled copy of a string with a placeholder looks garbled (iOS repeats the format);
  that is the flag, not the app.
- **Missing strings**: add `-NSShowNonLocalizedStrings YES` to the same command. iOS then
  prints in CAPITALS any string it looked up and did not find, such as a new `Text("...")`
  that was never synced into the catalog. Every string has an explicit English value so
  that this works; do not remove them.
- Right-to-left and accented pseudolanguages are in the same scheme menu. Right-to-left
  layouts are not in scope for this pass.

**Left in English on purpose**

- Product names (Tabsend, Chrome, Firefox) and addresses. The one name the person sees and
  keeps, the default name of the phone ("iPhone", used when iOS gives the phone no name), is a
  catalog message (`docs/L10N.md` rule 12). The `deviceName` the relay is told stays "iPhone"
  in every language, since other devices read it to tell a phone from a tablet.
- The stand-in phrases for a missing device name ("that device", "your device", "The device it
  was for") are catalog messages whose notes say which sentences they sit in
  (`docs/L10N.md` rule 13).
- The relay's own error text (`ApiError.message`) is never shown: it is English, written for
  a log, and free to change. A screen asks `RelayErrorText.line(error, during:)`, which words
  every relay error code in the catalog (a failed rename, device removal, pairing link,
  stop-the-reset, a join, a relay-address check). The phone says less than the relay did, for
  instance not the number of pairing links in the limit. Android, the browser extension and
  the console still show the relay's text on their equivalent screens.
- Compact ages ("3m ago", "2h ago") and device lists ("A, B and C") come from the platform's
  formatters, in the app's language, so they need no translation: a German phone gets
  "vor 3 Min." and "A, B und C" by itself. English is pinned to the words every client shares
  (no comma before "and" in a list), so nothing changed for English readers. "just now" is a
  catalog phrase, since the formatter has no wording for under a minute.
- A date or time inside a sentence follows the app's language, not the phone's region:
  English text gets "October 30 at 2:05 PM" for every region, as before.
- The phone's language chooses the language; there is no switch inside the app
  (`docs/L10N.md` rule 9).

If a changed catalog text does not show in the app after a normal Xcode build, clean the
build folder: Xcode can keep an older copy of TabsendKit's resource bundle inside the app.

## First run and the account door (PLANS.md P-19, P-25)

The iPhone app is paid for up front on the App Store, so it has no purchase code, no unlock
screen and no restore button. The first-run work is about the first screen and the account only.

- **The storefront decides.** `StorefrontWatcher` reads StoreKit's `Storefront.current` (country
  code `USA` for the US App Store; `AccountSetup.allowsAccountSetup`, tested). An unknown
  storefront counts as not US.
- **US storefront:** the first screen has "Set up an account" under the two pairing buttons. It
  opens the account site's `/start?from=app` in a sheet inside the app (`SFSafariViewController`,
  not the Safari app), which shows the app's own look and words. The site then emails a
  **universal link** (`https://account.tabsend.org/app-start#t=...`); tapped in Mail it opens the
  app (Associated Domains entitlement `applinks:account.tabsend.org`, `project.yml`; the site's
  `apple-app-site-association` file names `/app-start` and `/app-signin` only). The app uses the
  token itself (`AccountSiteClient.redeem`, `POST /api/app/redeem`), is handed the group's first
  setup link, closes the sheet and shows "Name this phone" (with "your trial has started, it runs
  until ..." only when that sign-up made the account), keeping the link out of sight. A
  `/app-signin` link (after Manage account or Delete account asks for a sign-in) opens the sheet
  on the sign-in page with the token, so it signs in there. `tabsend://` stays refused: any web page
  can open a custom scheme (`AccountLink` accepts only the account site's own host and those two
  paths). **A universal link needs the Associated Domains capability on the App ID and a signed
  build, so it can only be proven from TestFlight on a real phone**; where it does not arrive,
  the person signs in on the web and pastes the setup link, as before. Settings gets an Account
  group (Manage account, Delete account) when the relay says this phone uses Tabsend's service
  (see the next point). Delete account asks once, then opens the account page's delete section
  (which opens, not only scrolls) in the same sheet.
- **The plan comes from the relay, never from the phone's guess.** `GET /v1/group` carries
  `service` only when the account site wrote it: `trial` with the end date, `trial_ended`, or
  `account`. `GroupService` keeps the last answer (`GroupReset.refresh` asks once for both), and
  a self-hosted relay, which sends nothing, clears it. That drives the "Tabsend service / Free
  trial, Until Nov 18" line on the home list (screen 5), the amber "Your free trial has ended"
  card (screen 8) and the Account group in Settings (US storefront and a plan word). This fixes
  the old rule that marked a phone from a tap: a phone paired from a link made on a computer now
  gets the group, and a self-hoster who tapped the button does not.
- **Everywhere else:** the first screen is the pairing card with Scan code and Paste a setup link,
  nothing about an account or a price, and Settings has no Account group. One line sits under a
  divider, in full-size dark text: "Learn more about setting up Tabsend's service at tabsend.org."
  It is plain text on purpose, no link, no button, no price (`serviceNote` in `JoinView.swift`;
  PLANS P-25 says why and what to do if App Review refuses it: delete it).
- **How pairing works** is a short sheet (two steps and the 10-minute limit), not an alert.
- **One ground.** The first screen and "Name this phone" use the phone ground and panel, like every
  later screen.
- **Paused rows.** While the relay says `trial_ended`, each row of "Your devices" has "Paused"
  as its second line instead of the kind and the online or offline word: "This phone · Paused"
  for this phone, "Chrome · Paused" for another device (`GroupService.pausedLine`, shown by
  `DeviceRow.pausedLine`). Any other word, or none, leaves the rows as they were.
- **Not built:** the line "Your devices stay paired." the design draws under the paused list
  (`docs/PLANS.md` P-19).
- **Looking at both in the Simulator.** A debug build reads four launch settings (a release build
  ignores them): `-TabsendServicePlan trial` (or `trial_ended`, `account`) stands in for the
  relay's plan words, `-TabsendStorefront USA` (or `GBR`, any code) stands in for the App Store,
  `-TabsendAccountSite http://localhost:8790` points the sheets at a local account site, and
  `-TabsendOpenLink <link>` hands the app a link as if iOS had opened it, which the Simulator
  cannot do for a universal link: the emailed `http://localhost:8790/app-start#t=...` link (with
  the account site and relay running, see `control/README.md`), or a plain setup link. With the
  emailed link, "Name this phone" appears after the app has used the token.

  ```sh
  xcrun simctl launch --terminate-running-process <device> io.tabsend.app -TabsendStorefront USA
  ```

## Delivery model (read this once)

iOS freezes backgrounded apps: no held connection, no timer, no self-wake
(PLANS.md P-5). The only reliable wake is APNs, and APNs takes instructions
only from a key Apple issues per developer account — which is why the wake-up
forwarder exists (`forwarder/PROTOCOL.md`, HOSTED_PLAN §6, ADR-0032). The app
uses `https://wake.tabsend.org` by default. Instant delivery is on by default,
but the service must also have Apple's push key and the app must be signed with
the push capability. The Apple path still needs a real-device test after developer
account approval. A build may override the address in `TabsendForwarderURL`.

**Without a forwarder URL**,
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

**The iPhone path has not yet been run against real APNs or a physical device.**
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
has met Apple on a physical device. A physical-device run still has to show:

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
