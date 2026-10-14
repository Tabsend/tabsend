# iOS physical-device test matrix

This matrix is the release gate for the Tabsend iOS app and share extension. Run it
against the exact signed candidate that will be distributed. An iOS Simulator cannot
prove App Group/Keychain sharing, real camera behavior, background scheduling,
notifications, signing entitlements, cellular networking, or device backup/restore.

Nothing in this document is marked as passed in advance. Check a box only when the
evidence record identifies the device, build, relay, result, and any issue.

## Required coverage

Test the complete blocking matrix on both columns:

| Coverage column | Required physical device | Device / iOS / owner | Evidence record |
| --- | --- | --- | --- |
| **MIN** | A physical iPhone running the minimum supported major version from `ios/project.yml` (currently iOS 16) | _Not recorded_ | _Not recorded_ |
| **CURRENT** | A physical iPhone running the current public iOS release | _Not recorded_ | _Not recorded_ |

If a physical phone on the minimum version is unavailable, do not silently replace it
with a simulator. Record a time-limited release exception, its owner, why the risk is
acceptable, and when a real device will be tested. A simulator may supplement that
exception but does not close it.

Also record:

- Candidate version and build number: _Not recorded_
- Candidate full commit SHA: _Not recorded_
- TestFlight group or signed-install source: _Not recorded_
- IPA/archive SHA-256 or App Store Connect build identifier: _Not recorded_
- Disposable relay version and commit: _Not recorded_
- Relay mode: CA-issued TLS / pinned self-signed TLS: _Not recorded_
- Peer clients and versions: _Not recorded_
- Tester and dates (UTC): _Not recorded_

## Evidence rules

For each ID, record one result for **MIN** and one for **CURRENT**:

```text
Test ID:
Device model / iOS version:
Tabsend version / build:
Relay version / TLS mode:
Network:
Result: PASS / FAIL / BLOCKED / NOT APPLICABLE
Observed behavior:
Evidence location:
Issue link, if any:
Tester / UTC time:
```

- Never attach a pairing link, device token, private key, password, full private URL,
  QR-code screenshot, or notification screenshot containing sensitive URL text.
- Redact IP addresses and private hostnames when evidence is shared publicly.
- A screenshot alone is insufficient when it does not identify the build. Record the
  in-app version/build or TestFlight build alongside it.
- **FAIL** and **BLOCKED** require an issue. **NOT APPLICABLE** requires a reason.
- Run tests labelled **BLOCKING** on both MIN and CURRENT. Run **SUPPLEMENTAL** at least
  once on a physical phone unless the row says otherwise.

## 1. Candidate and test environment

| Done | ID | Level | Check |
| --- | --- | --- | --- |
| [ ] | ENV-01 | BLOCKING | Installed build version, build number, and source match the release candidate record. |
| [ ] | ENV-02 | BLOCKING | App and share extension are signed by the expected team and both have the intended App Group and shared Keychain access group. |
| [ ] | ENV-03 | BLOCKING | A disposable relay and at least one known-good browser peer are available; no production user data is used. |
| [ ] | ENV-04 | BLOCKING | Notifications, Background App Refresh, cellular access, Low Power Mode, and VPN state are recorded before testing. |
| [ ] | ENV-05 | BLOCKING | Device time is automatic and the device has enough free storage to avoid unrelated failures. |
| [ ] | ENV-06 | SUPPLEMENTAL | VoiceOver/text-size/appearance settings used during accessibility checks are recorded. |

## 2. Installation, first run, and pairing

| Done | ID | Level | Check |
| --- | --- | --- | --- |
| [ ] | PAIR-01 | BLOCKING | Fresh install launches without a crash, stale identity, or unexplained blank screen. |
| [ ] | PAIR-02 | BLOCKING | Camera permission copy is accurate; denying permission does not trap the user and pasted-link pairing remains available. |
| [ ] | PAIR-03 | BLOCKING | A complete, valid pairing QR joins the expected group and creates exactly one iOS endpoint. |
| [ ] | PAIR-04 | BLOCKING | A complete, valid pasted pairing link produces the same result as QR pairing. |
| [ ] | PAIR-05 | BLOCKING | An expired, already-used, truncated, or malformed pairing credential is rejected with a specific, actionable error and creates no endpoint. |
| [ ] | PAIR-06 | BLOCKING | A loopback or otherwise unreachable relay address is explained accurately; the app does not blame a reachable relay for certificate or protocol failures. |
| [ ] | PAIR-07 | BLOCKING | App and share extension see the same identity and endpoint list after pairing, proving shared Keychain/App Group access on the signed physical build. |
| [ ] | PAIR-08 | BLOCKING | Rename, pair-another-device, and unpair update the relay and all relevant screens without stale entries. |
| [ ] | PAIR-09 | BLOCKING | Unpair/revoke prevents later send/drain operations with the old credential and gives a clear recovery path. |
| [ ] | PAIR-10 | SUPPLEMENTAL | QR scanning works in dim light, with a small code, and after camera permission is denied then enabled in Settings. |

## 3. Share extension and sending

| Done | ID | Level | Check |
| --- | --- | --- | --- |
| [ ] | SEND-01 | BLOCKING | Sharing a Safari web page shows Tabsend and sends the correct URL and title to the selected browser peer. |
| [ ] | SEND-02 | BLOCKING | Sharing a plain-text message containing a valid HTTP/HTTPS URL behaves as documented. |
| [ ] | SEND-03 | BLOCKING | Unsupported content, empty input, malformed URLs, and unexpected URL schemes are refused safely with useful feedback. |
| [ ] | SEND-04 | BLOCKING | With multiple targets, chooser labels and ordering identify the intended endpoint and one tap sends only once. |
| [ ] | SEND-05 | BLOCKING | With no eligible target, the extension explains what is missing and does not hang or dismiss silently. |
| [ ] | SEND-06 | BLOCKING | While offline, the extension gives truthful feedback and queues or rejects according to documented behavior; reconnection causes no duplicate. |
| [ ] | SEND-07 | BLOCKING | Closing or timing out the share extension during a send leaves state recoverable and does not corrupt the outbound queue. |
| [ ] | SEND-08 | BLOCKING | The app and share extension can operate close together without losing, overwriting, or repeatedly sending queued items. |
| [ ] | SEND-09 | BLOCKING | A relay error, certificate failure, revoked credential, and protocol mismatch are distinguishable from ordinary offline status. |
| [ ] | SEND-10 | SUPPLEMENTAL | Share from at least one non-Safari browser and one other app that supplies a web URL. |

## 4. Receiving, notifications, and link opening

| Done | ID | Level | Check |
| --- | --- | --- | --- |
| [ ] | RECV-01 | BLOCKING | With the app foregrounded, a browser peer's send arrives promptly, decrypts once, displays once, and is acknowledged once. |
| [ ] | RECV-02 | BLOCKING | With the app backgrounded, reopening it drains pending messages without loss or duplicate notification. |
| [ ] | RECV-03 | BLOCKING | With the app not running, a pending message is delivered on the next supported wake/open path; copy does not promise instant background delivery. |
| [ ] | RECV-04 | BLOCKING | Notification permission denied: messages remain recoverable and the app explains the limitation without repeatedly prompting. |
| [ ] | RECV-05 | BLOCKING | Notification permission later enabled in Settings: subsequent delivery works without reinstalling or re-pairing. |
| [ ] | RECV-06 | BLOCKING | Notification title/body and lock-screen preview match the documented privacy choice and disclose no more than intended. |
| [ ] | RECV-07 | BLOCKING | Tapping an allowed `https://` or `http://` notification opens the expected default browser destination. |
| [ ] | RECV-08 | BLOCKING | Unexpected schemes such as `file:`, `javascript:`, `data:`, custom app schemes, and malformed links do not launch an OS handler. |
| [ ] | RECV-09 | BLOCKING | Duplicate/replayed message IDs do not create duplicate user-visible deliveries. |
| [ ] | RECV-10 | BLOCKING | Undecryptable, corrupted, oversized, or expired content does not crash the app, leak plaintext, or block later valid messages. |
| [ ] | RECV-11 | SUPPLEMENTAL | Notification grouping and repeated sends remain understandable with 10 or more pending links. |

## 5. Lifecycle and operating-system controls

| Done | ID | Level | Check |
| --- | --- | --- | --- |
| [ ] | LIFE-01 | BLOCKING | Background → foreground repeatedly preserves pairing, target list, pending queue, and receive state. |
| [ ] | LIFE-02 | BLOCKING | Force-quitting and reopening restores state and drains pending messages without duplicates. Record that iOS may intentionally restrict background work after a force-quit. |
| [ ] | LIFE-03 | BLOCKING | Device reboot followed by first unlock and app open restores credentials and normal send/receive behavior. |
| [ ] | LIFE-04 | BLOCKING | Locking/unlocking the phone does not expose protected data or permanently break Keychain access. |
| [ ] | LIFE-05 | BLOCKING | Background App Refresh disabled: foreground/open delivery still works and the UI makes no false background promise. |
| [ ] | LIFE-06 | BLOCKING | Low Power Mode enabled: behavior degrades safely and recovers when disabled. |
| [ ] | LIFE-07 | BLOCKING | The OS terminates the backgrounded app under memory pressure; reopening recovers without lost or duplicate state. |
| [ ] | LIFE-08 | SUPPLEMENTAL | Leave the app unused overnight with pending and new messages; record when delivery occurs and whether opening drains all items. Do not treat opportunistic timing as a guaranteed service level. |
| [ ] | LIFE-09 | SUPPLEMENTAL | Large Dynamic Type, dark/light mode, VoiceOver, and reduced motion leave pairing, chooser, errors, and send feedback usable. |

## 6. Network and TLS

| Done | ID | Level | Check |
| --- | --- | --- | --- |
| [ ] | NET-01 | BLOCKING | CA-issued HTTPS relay pairs, sends, receives, reconnects, and rejects an invalid certificate. |
| [ ] | NET-02 | BLOCKING | Self-signed HTTPS relay with the correct fingerprint pairs, sends, receives, and reconnects. |
| [ ] | NET-03 | BLOCKING | Wrong, missing, or changed self-signed fingerprint fails closed and is reported as a certificate problem, not a generic relay outage. |
| [ ] | NET-04 | BLOCKING | Plain HTTP to an off-device relay is refused according to the documented transport policy. |
| [ ] | NET-05 | BLOCKING | Wi-Fi loss and recovery preserve state, retry safely, and do not duplicate a send. |
| [ ] | NET-06 | BLOCKING | Wi-Fi → cellular → Wi-Fi transition reconnects or recovers on open without re-pairing. |
| [ ] | NET-07 | BLOCKING | Relay restart during an active connection recovers without losing already acknowledged state. |
| [ ] | NET-08 | BLOCKING | Relay unavailable, DNS failure, timeout, TLS failure, revoked token, and protocol mismatch produce meaningfully different guidance. |
| [ ] | NET-09 | BLOCKING | Supported relay-address change verifies the new relay before committing it and retains the old working address after failure. |
| [ ] | NET-10 | SUPPLEMENTAL | IPv6-only or IPv6-preferred network completes pairing and send/receive, or the limitation is documented. |
| [ ] | NET-11 | SUPPLEMENTAL | VPN, private relay, captive portal, and poor/latent network fail safely and recover when normal connectivity returns. |
| [ ] | NET-12 | SUPPLEMENTAL | Local-network permission denied then enabled behaves predictably for a LAN relay. |

## 7. Upgrade, reinstall, backup, and restore

Use disposable identities and explicitly record which credential behavior is intended.
A surprising result here is a release blocker even when ordinary send/receive works.

The intended policy is device-bound identity: the private key and device token use
`AfterFirstUnlockThisDeviceOnly` and must not migrate to another phone. A restored phone
re-pairs as a new endpoint. The received-tabs file is protected after first unlock and
excluded from backup. Reinstall behavior on the same physical phone still needs to be
observed because Keychain and App Group lifetimes differ.

| Done | ID | Level | Check |
| --- | --- | --- | --- |
| [ ] | DATA-01 | BLOCKING | Install the candidate over the previous released iOS build; pairing, key identity, settings, MRU, and queued sends remain intact. |
| [ ] | DATA-02 | BLOCKING | Upgrade the relay while the prior iOS app is installed; compatibility or the required upgrade error matches release notes. |
| [ ] | DATA-03 | BLOCKING | Upgrade the iOS app while the prior relay is installed; compatibility or the required relay-upgrade error matches release notes. |
| [ ] | DATA-04 | BLOCKING | Delete and reinstall the app; observed Keychain/identity behavior matches the documented policy and does not silently create two active copies of one endpoint. |
| [ ] | DATA-05 | BLOCKING | Restore a device backup onto a different physical iPhone, or run the closest approved Apple-supported restore test; endpoint keys/tokens do **not** migrate and the restored phone clearly requires pairing as a new endpoint. |
| [ ] | DATA-06 | BLOCKING | The original and restored phones cannot operate as cloned copies of one endpoint; after re-pairing, each has a distinct key/token and the old endpoint can be revoked. |
| [ ] | DATA-07 | BLOCKING | Queued outbound URLs/titles and endpoint metadata receive the intended OS backup behavior; keys/tokens are device-only; received-tab history is file-protected and absent from the restored backup. |
| [ ] | DATA-08 | BLOCKING | Unpair/account reset removes access and local sensitive state according to policy; ordinary user data is not left visible to the share extension. |
| [ ] | DATA-09 | SUPPLEMENTAL | Upgrade with at least 10 queued outbound or inbound items; every item has one clear final state after recovery. |

## 8. Peer compatibility

Complete each row for every peer included in the same release. Mark a row N/A only when
the peer is not distributed or supported, and record that reason.

| Done | ID | Direction | Peer/version | Result/evidence |
| --- | --- | --- | --- | --- |
| [ ] | PEER-01 | iOS ↔ Chrome | _Not recorded_ | _Not recorded_ |
| [ ] | PEER-02 | iOS ↔ Firefox | _Not recorded_ | _Not recorded_ |
| [ ] | PEER-03 | iOS ↔ Android | _Not recorded_ | _Not recorded_ |
| [ ] | PEER-04 | iOS ↔ iOS | _Not recorded_ | _Not recorded_ |
| [ ] | PEER-05 | iOS ↔ web console | _Not recorded_ | _Not recorded_ |

For each direction, verify the correct title and URL, exactly one delivery, acknowledgement,
target rename propagation, unpair/revoke behavior, and an incompatible-version error.

## 9. Privacy and diagnostics

| Done | ID | Level | Check |
| --- | --- | --- | --- |
| [ ] | PRIV-01 | BLOCKING | Device logs, Xcode console, diagnostics, crash reports, and screenshots used as evidence contain no pairing links, tokens, private keys, plaintext message bodies, or full private URLs. |
| [ ] | PRIV-02 | BLOCKING | The app makes no network request other than the configured relay and documented Apple platform services. |
| [ ] | PRIV-03 | BLOCKING | Notification previews, clipboard use, camera use, local-network access, and retained queues match in-app and published privacy descriptions. |
| [ ] | PRIV-04 | BLOCKING | Privacy policy, App Store privacy answers, export-compliance answers, and any privacy manifest match the tested binary. |
| [ ] | PRIV-05 | BLOCKING | Error reporting gives enough build/context information to diagnose failures without asking a tester to reveal credentials or message contents. |

## 10. Exit decision

- [ ] Every **BLOCKING** row has PASS evidence on both MIN and CURRENT physical phones,
      or a written, owner-approved, time-limited exception.
- [ ] Every FAIL/BLOCKED result has a linked issue, severity, owner, and release decision.
- [ ] The exact TestFlight/App Store Connect build or archive is the one tested; it was
      not rebuilt after sign-off.
- [ ] No evidence bundle contains a credential or private message content.
- [ ] Known iOS limitations—especially opportunistic background delivery—are visible in
      release notes and user documentation.
- [ ] The release owner records **GO** or **NO-GO**, UTC time, and the evidence location
      in [`RELEASE_CHECKLIST.md`](RELEASE_CHECKLIST.md)'s release record.
