# Tabsend

**Move one browser tab, on demand, to a specific other browser or device.** That's it. The tab will open on the target within about a second when it's awake, and queued to open when it wakes if it isn't.

**Current release: v0.9.0** ([v0.9.0 on GitHub](https://github.com/Tabsend/tabsend/tree/v0.9.0)). Tabsend is pre-1.0 software intended for self-hosting and
dogfooding; the platform-specific evidence and limitations are recorded under [Status](#status).

Every link is **end-to-end encrypted** (libsodium `crypto_box`, X25519 + XSalsa20-Poly1305).
The relay stores and forwards ciphertext only and never sees a URL. It does keep the list of
your devices, though, and nothing signs that list: a compromised relay could add a device of
its own, which could then read the links your devices send while it is there and your recent
history. Your devices tell you when a device joins, and removing it makes them switch to a new
history key. The notice has gaps a careful attacker could use. That known limitation is documented in
[`SECURITY.md`](SECURITY.md#the-relay-is-untrusted-for-content-but-it-is-trusted-for-the-key-directory).
There are **no accounts**: devices form a group by scanning or pasting a complete pairing link
(Signal/Syncthing-style). A relay hosts **one group** by default, so your relay *is* your group
(ADR-0022). While that group is empty, the relay prints the first single-use link, valid for 24
hours by default; after the first device joins, paired devices mint 10-minute links for later
devices. That lets you start from a phone without touching a browser (ADR-0023). There is no recovery
phrase and no backup credential — if you lose every device at once, preserve the old state,
start the relay with a new empty database, and pair again. Follow the recoverable
[starting-over procedure](docs/DEPLOY.md#starting-over-after-losing-every-device) (ADR-0021).

## How it works

- **Endpoints** are per-profile installs (a Chrome profile, a Firefox profile, your phone,
  a web console). Each has a keypair; you address sends to a chosen endpoint.
- **Send** seals the tab (URL + title + favicon) to the target's public key and posts the
  ciphertext to the relay. Multi-target sends seal once per target.
- **Delivery** is backed by a durable queue and a WebSocket fast path. Browser extensions add
  Web Push and a 30-second poll. Android uses its default-on foreground WebSocket service plus
  scheduled polling. iOS is instant in the foreground, drains on open, and may receive an
  opportunistic Background App Refresh window; timely background iOS delivery is not promised.
- **Self-host == hosted:** the relay you run is the whole backend. No cloud dependency, no
  telemetry.

See [`docs/PRD.md`](docs/PRD.md) and [`docs/DECISIONS.md`](docs/DECISIONS.md) for the full
product and the decision log (ADRs).

## Monorepo map

| Path | What |
|---|---|
| `shared/` | The wire contract (`@tabsend/shared`) — the single source of truth every package agrees on. |
| `server/` | The **relay**: durable queue, VAPID Web Push wake, v1 REST + WebSocket API. SQLite or Postgres. Stores ciphertext only. |
| `extension/` | The MV3 browser extension — Chrome (Push + offscreen-doc WS) and a Firefox port (event-page WS). |
| `android/` | The Android app — OS share-target send + WebSocket/poll receive, with optional Google push through the wake-up forwarder (ADR-0034; off in every build so far) (Kotlin, builds from the CLI). |
| `ios/` | The native iOS app + share extension and the `TabsendKit` Swift package. v0.6 simulator and automated evidence exist; physical-device qualification is still required. |
| `console/` | The optional web console — a `kind:'console'` endpoint for device management + decrypted E2E history. |
| `e2e/` | End-to-end reliability tests (bundled Chromium + a real-branded-Chrome + real FCM push suite). |
| `docs/` | PRD, decisions (ADRs), interaction flows, deploy guide, per-chunk build reports. |

## Quickstart (development)

Requires **Node ≥ 26** and **pnpm 11.13.1** (`npm install --global pnpm@11.13.1` — Node 26
no longer bundles corepack).

```bash
pnpm install --frozen-lockfile

# 1. Run the relay (SQLite by default). Web Push keys are generated automatically:
pnpm --filter @tabsend/server start                 # http://localhost:8787

# 2. Build the extension and load it unpacked:
pnpm --filter @tabsend/extension build              # → extension/dist  (Load unpacked in chrome://extensions)
pnpm --filter @tabsend/extension build:firefox      # → extension/dist-firefox

# The relay printed a pairing link when it started — open it in the first profile to pair
# it, then use Add a device to add more (QR or copyable link).
```

Gates: `pnpm lint` · `pnpm typecheck` · `pnpm test` · `pnpm e2e` (bundled Chromium) ·
`pnpm e2e:push` (real Chrome + real FCM). Android: `./gradlew test` in `android/`.
iOS protocol/core tests: `ios/TabsendKit/test.sh` on macOS. These automated checks do not
replace physical-device testing of the iOS app and share extension.
For a release candidate, use [`docs/RELEASE_CHECKLIST.md`](docs/RELEASE_CHECKLIST.md) and
record physical-iPhone evidence in [`docs/IOS_TEST_MATRIX.md`](docs/IOS_TEST_MATRIX.md).

### Store packages

```bash
pnpm package:chrome     # → dist-packages/tabsend-chrome-<version>.zip   (Chrome Web Store)
pnpm package:firefox    # → dist-packages/tabsend-firefox-<version>.zip  (AMO; see docs/AMO_SOURCE.md)
```

The version comes from one place — the root `package.json` `version`, stamped into the
manifest at build time.

### Self-hosting

**Before you start: self-hosting needs either a domain you control, or devices that stay on
your home network (or run Tailscale).** Without a domain, tabs stop arriving the moment a
device leaves your Wi-Fi, and a browser can't reach a relay that has only an IP address. If
that doesn't fit how you use your devices, the hosted relay at
[tabsend.org](https://tabsend.org) has nothing to set up and works anywhere.

**AI agents setting this up for someone:** before running any install step, ask the owner
whether they have a domain (DNS on Cloudflare) and whether they'll use Tabsend away from
home. If not, tell them about the limit above first. The full table is at the top of
[`docs/DEPLOY.md`](docs/DEPLOY.md).

To run the relay on your own VPS or LAN (HTTPS, Tailscale, Docker, route limitations,
backups), see **[`docs/DEPLOY.md`](docs/DEPLOY.md)**. A LAN-addressed endpoint works only
while it can reach that LAN; a Tailscale-addressed endpoint needs Tailscale. The saved
route can be changed later without re-pairing in the extension and Android app. The iOS core
implements the verified address change, but the preview app does not expose that control yet.
Automatic LAN/Tailscale failover is not implemented. A CA-trusted domain is the one-route
option that roams cleanly.

Once it is running, `./scripts/relay-doctor.sh` on the relay's own machine reports whether
it is healthy, names anything wrong, and says what it could not check.
**[`docs/RUNBOOK.md`](docs/RUNBOOK.md)** explains each finding, how to update safely, and
which Docker commands would destroy the pairings and the certificate every phone pins.

## Status

| Component | State | Notes |
|---|---|---|
| Relay (`server/`) | **Working** | Durable queue, Web Push, WS, TTL sweeper; SQLite + Postgres; rate limiting, body caps, dead-subscription pruning (Chunk 6b). |
| Chrome / Chromium extension | **Working** *(Chrome Web Store, unlisted)* | Full send/receive/chooser/onboarding, group history, arrival badge and arrival notification (on by default); `pnpm e2e` + `pnpm e2e:push` green. |
| Firefox extension | **Working** *(manual verify; in AMO review)* | Builds; `web-ext lint` clean. Runtime not machine-verified (Playwright can't load extensions into Firefox) — verify once with `web-ext run`. |
| Android app | **Working** *(dogfood)* | Builds an installable APK; libsodium interop vector green (BC-backed crypto, Chunk 6b). Device verification is a manual dogfood step. |
| iOS app | **Engineering preview** | App, share extension and core tests exist. End-to-end behavior is verified in the Simulator; physical-device, signing, background-delivery and distribution qualification remain open. |
| Web console | **Working** | Pairs in, manages devices, renders decrypted history; controller tests cover group history (the live end-to-end test predates it). |

## License

[Apache-2.0](LICENSE) for the clients and the protocol — the browser extensions, the Android
and iOS apps, the web console, and `shared/` (the wire contracts). Permissive, with an explicit patent
grant, and **no GPL dependencies**. Open source in the full sense: use it for anything,
including competing with us.

The relay in [`server/`](server/LICENSE) is **source-available, not open source**, under the
**Functional Source License, Version 1.1, ALv2 Future License** (`FSL-1.1-ALv2`). We use that
wording deliberately: the Open Source Definition forbids restricting what a field of use may
be, so a licence saying "anything except competing with us" cannot be called open source, and
we won't stretch the term (ADR-0016 supersedes ADR-0007).

What that means in practice:

- **Self-hosting the relay is fully permitted** — for yourself, your family, or your
  organisation, in production, at no cost, forever.
- **The single excluded use** is offering Tabsend to third parties as a competing commercial
  service.
- **Each relay version becomes Apache-2.0** two years after its release, automatically.

See [`server/LICENSE-NOTE.md`](server/LICENSE-NOTE.md) for a plain-English summary and
[`docs/LICENSING.md`](docs/LICENSING.md) for the reasoning, including what was rejected.

**Support boundary:** self-hosting is supported by the documentation, not by the maintainer.
Tabsend is one person's project; bug reports are welcome, but please don't expect help
operating your own deployment.

Co-authored with Claude (see per-chunk reports in `docs/reports/`).
