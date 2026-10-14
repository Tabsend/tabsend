# Chunk 3 — Chrome extension MVP (a tab actually travels)

**Stage 1.2–1.3.** Done-gate green from repo root: `pnpm lint` (0 errors), `pnpm typecheck`
(5/5 packages), `pnpm test` (7 files, **35 tests**), and **`pnpm e2e` — the Playwright rig
passes 7/7 in ~10 s** (≈11 s wall including the extension build; first-ever run adds a
one-time ~2-min Chromium download via `playwright install chromium`).

Stack (locked by orchestrator): **Vite 8** build, **no extension framework**, manual
`manifest.json`, TypeScript strict, **libsodium-wrappers** (ISC) for crypto. New root
script: **`pnpm e2e`**. Playwright (Apache-2.0) is the only other new dep.

---

## What was built

### `extension/` — a real MV3 extension

- **Build**: `vite.config.ts` with three entries — `background.js` (module service worker,
  stable filename), `chooser.html` (the toolbar popup), `firstrun.html` (onboarding tab).
  `public/manifest.json` is copied verbatim. `pnpm --filter @tabsend/extension build` →
  loadable `extension/dist/`. CSP includes `wasm-unsafe-eval` for libsodium.
- **Identity & registration** (`src/background/identity.ts`): X25519 `crypto_box` keypair
  generated once per install; `keyId = base64url(sha256(utf8(pubkeyB64)))` — bit-identical
  to the server's `keyIdFor` (unit test proves parity against `node:crypto`). First-run page
  offers **Create group** (device name pre-filled from UA per ADR-0004; recovery phrase
  shown once, "I saved it" acknowledgement) or **Join with code**; relay base URL is
  configurable behind a "Relay server" disclosure (default `http://localhost:8787`, the
  chunk-2 dev default). `deviceToken` + keys live in `chrome.storage.local`.
- **Send pipeline** (`src/background/send.ts`): capture `{url,title,favicon,sentAt}` from
  the active tab (data-URL favicons > 8 KB dropped; extension pages never captured — if the
  active tab is one of ours, the most recently used real tab is sent instead) → seal per
  target with `crypto_box` (fresh 24-byte nonce per message; `senderKeyId`/`targetKeyId`
  per the server fingerprint rule) → `POST /v1/messages` with a client-generated UUID.
  Relay unreachable ⇒ the sealed item is held in a **local outbound queue**
  (`chrome.storage`) and retried by alarm; per-item rejections and API errors are hard
  failures (badge ✗), not retries.
- **Surfaces (MVP slice)**: toolbar popup chooser — target list = `GET /v1/endpoints`
  minus self minus `kind === 'console'`, ordered primary → MRU → alphabetical (ADR-0002),
  presence dots + "last seen", click row = send, in-popup ✓ then close; **n = 1 ⇒ the open
  itself sends directly** (adaptive rule §2.7); **n = 0 ⇒ empty state** linking to
  first-run **plus "Show pairing code"** so a paired profile can mint the code for the next
  one (`POST /v1/pairing`, rendered with the `PAIRING_LINK` fragment format). Page + link
  context menus (`Send tab to ▸` / `Send link to ▸`, flattened at n = 1, "pair a device"
  at n = 0) rebuilt whenever the endpoint list changes. Feedback = action badge ✓/…/✗
  (ADR-0008 restricted-page fallback is the MVP default; in-page toasts are Chunk 5).
  `SourcePrefs` MRU updated on every send, device-local only (ADR-0009).
- **Receive** (`src/background/receive.ts`): `GET /v1/messages?pending=1` on **every SW
  boot** (top-level `bootstrap()`), **every 30 s alarm**, and **every popup open**; for
  each message: verify `senderKeyId` against the group's current pubkeys (unknown sender ⇒
  refused, blocks relay link-injection per ADR-0009), open the envelope, `chrome.tabs.create
  ({active:false})`, then ack. **Idempotency**: a seen-message-id set in
  `chrome.storage.local` (pruned after 14 d = 2× TTL) is checked **before** `tabs.create`
  and written **before** the tab opens; polls are serialized through a promise chain so
  boot/alarm/popup polls can't interleave. A seen-but-unacked message is re-acked (drain)
  without reopening.
- **Presence**: every authenticated call bumps `last_seen_at` server-side, and the 30 s
  poll keeps the endpoint inside the 90 s presence window — no separate heartbeat needed
  (the client for `POST …/heartbeat` exists in `lib/api.ts` for Chunk 4's rotation path).

### `e2e/` — the Playwright rig (permanent harness)

`pnpm e2e` = `playwright install chromium && vitest run` inside `e2e/`. **Deliberately not
in the root `pnpm test`** (root vitest projects unchanged): the rig builds the extension,
launches real Chromium twice, and needs a browser download — it would ruin the fast gate.
CI still typechecks `e2e/` (`pnpm -r run typecheck`); running the rig in CI is a follow-up
(needs the browser cache step).

Topology — the rig spawns the **real chunk-2 server** (`tsx src/server.ts`, temp SQLite,
ephemeral port) and a ~60-line **fault-injection proxy** in front of it for profile B that
can be told to fail acks (503):

```
profile A ──────────────► relay (real server process, temp SQLite)
profile B ──► ack-proxy ─► relay
```

Blocking acks holds a delivered message in the delivered-but-unacked window — the exact
window where a duplicate tab could happen — so the no-dupe assertions are real, not
vacuous. The story (`e2e/src/travel.e2e.ts`, 7 tests, strictly sequential):

1. **A creates a group** via the first-run UI; recovery phrase (≥ 8 words) shown;
   registration lands in storage.
2. **A mints a pairing code from the popup** zero-target state (8 chars, unambiguous
   alphabet asserted).
3. **B joins with the code** through the proxy; distinct endpointId.
4. **A sends its active tab → the tab OPENS in B.** Acks blocked first; A's chooser open
   auto-sends (n = 1 rule) the most recent real page; B pulls on the popup-open path
   (pollNow RPC); rig asserts the page appears in B's context, the ack was attempted and
   blocked, and A's outbox (`GET /v1/messages?outbox=1`, via API) shows the unacked row.
5. **Re-polls never duplicate**: 3 extra polls against a genuinely still-pending message ⇒
   exactly one tab.
6. **Full browser restart of B** (same user-data dir, fresh SW boot; boot-poll + explicit
   poll against the still-pending message) ⇒ zero re-opened tabs — the seen-set survived
   restart.
7. **Ack unblocked** ⇒ ack lands, **A's outbox drains to []** (API check), B's pending is
   `[]` (ack-then-delete), still no duplicate anywhere.

Browser loading: Playwright **bundled Chromium** (`channel: 'chromium'`, new headless) with
`--load-extension` — fine for this chunk since no Web Push is involved. The launcher is one
function (`e2e/src/browser.ts` `launchProfile()`) behind a `Profile` interface, so Chunk 4
swaps in **branded Chrome via CDP `Extensions.loadUnpacked` + `--enable-unsafe-extension-
debugging`** (spike §6) without touching the rest of the rig.

---

## Decisions (this chunk, not in the wire contract)

- **Receive is short-poll (30 s alarm + boot + popup-open)** per the sanctioned
  BUILD_SEQUENCE MVP scope. Push wake + WS fast path are Chunk 4; the alarm keeps presence
  online as a side effect.
- **Page ↔ SW RPC** (`lib/model.ts`): the popup/first-run pages are thin views; every
  decision (capture, seal, send, poll, mint) runs in the service worker so there is exactly
  one pipeline regardless of surface (INTERACTION_FLOWS §1).
- **n = 1 adaptive rule in the popup** = the open itself fires the send (the click that
  opened the popup *is* the gesture). n = 0 routes to onboarding. The full quick-send mode /
  hotkeys / toasts / settings remain Chunk 5 (ADR-0008).
- **keyId parity is unit-tested**, not just asserted: `crypto.test.ts` recomputes the
  fingerprint with `node:crypto` exactly as `server/src/ids.ts` does.
- **libsodium-wrappers 0.7.16 ESM entry is broken upstream** (imports a relative
  `./libsodium.mjs` it doesn't ship). Both `extension/vite.config.ts` and
  `vitest.config.ts` alias the bare specifier to the package's CJS build
  (`createRequire().resolve`) — remove when upstream fixes the `exports` map.
- **Seen-set written before `tabs.create`** (crash ⇒ at worst an unopened-but-seen message
  that the still-pending row would re-ack; never a double tab). If `tabs.create` itself
  throws, the id is un-seen so a later poll retries.

## Debts / flags for the owner & Chunk 4

1. **Push-subscription placeholder (Chunk 4 debt, client-side only).** The contract
   requires `pushSubscription` on register; a real VAPID subscription arrives with Chunk
   4c. The extension registers a well-formed inert placeholder
   (`https://push.placeholder.tabsend.invalid/…`). **No server changes were needed** — the
   chunk-2 validator only requires non-empty fields, so the sanctioned validation-
   relaxation lever was not pulled. If the MVP relay ever runs *with* VAPID keys, wakes to
   the placeholder fail harmlessly (logged; queue+poll still deliver). Chunk 4 replaces it
   via `POST …/heartbeat { pushSubscription }` rotation.
2. **Chooser ⏳ pending row currently reads only the local outbound queue** (source-offline
   sends), not `GET ?outbox=1` (sent-but-unacked). The outbox endpoint is exercised by the
   rig via API; wiring it into the row + live WS `acked` drain is Chunk 4/5 UI work.
3. **background.js is ~740 kB** (libsodium asm.js/wasm inlined by the CJS build). Loads
   locally, irrelevant to runtime latency, but store review may care — consider the
   `libsodium-wrappers` ESM/wasm path once upstream fixes packaging, or lazy-loading.
4. **No extension icons yet** (default puzzle-piece glyph; badge ✓/✗ works on it). Assets
   pass is Chunk 5.
5. **Firefox**: nothing here is Chrome-only by design (module SW, alarms, storage,
   contextMenus), but the port (event page + WS wake per spike §3b) is Chunk 5 as planned.
6. **Rig in CI**: `pnpm e2e` is local-only for now; add a CI job with Playwright browser
   caching if the owner wants it gating PRs.
7. **`e2e/` uses `*.e2e.ts` naming** so nothing under root `pnpm test` picks it up; the
   e2e vitest config sets 120 s test timeouts and no file parallelism.

## How to run

```bash
pnpm install
pnpm lint && pnpm typecheck && pnpm test   # fast gate (~4 s)
pnpm e2e                                   # the rig (~10 s after first browser install)

# manual two-profile smoke:
pnpm --filter @tabsend/server start        # relay on :8787
pnpm --filter @tabsend/extension build     # → extension/dist
# chrome://extensions → Load unpacked (extension/dist) in two profiles;
# create group in one, "Show pairing code" in its popup, join in the other.
```
