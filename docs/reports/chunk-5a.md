# Chunk 5a — Extension UX completion + Firefox port

**Stage 3 (extension track).** Completes the ADR-0008 interaction model, folds in
every DOGFOOD pass-1 + pass-2 item in the extension's lane, and ports the
extension to Firefox MV3. Built in an isolated worktree; commit history is
incremental so an infra cutoff never loses a whole piece.

## Done-gate (this worktree)

| Gate | Result |
|---|---|
| `pnpm lint` | 0 errors (biome, 111 files) |
| `pnpm typecheck` | 5/5 packages |
| `pnpm test` | **70 tests** (17 files) — +8 over chunk-4 (ua brand suggestion, console history copies, deviceName passthrough, live-data migration) |
| `pnpm e2e` | 7/7, bundled Chromium (~10 s) — drives the reworked onboarding + the n=1 legible confirmation |
| `pnpm --filter @tabsend/extension build` | chrome → `dist/` |
| `pnpm --filter @tabsend/extension build:firefox` | firefox → `dist-firefox/` |
| `web-ext lint dist-firefox` | **0 errors, 0 notices, 2 warnings** (benign QR-SVG `innerHTML`, our own data) |
| `pnpm e2e:push` | **5/5 twice consecutively** after the launcher root-fix — see note below |

Never bound to or tested against port 8787 (the owner's live relay). The rigs use
their own ephemeral ports and throwaway profiles.

**`pnpm e2e:push` scenario (1) — the full root-cause chain (supersedes two
earlier wrong theories: "environmental contention", then "retry the reload").**
After merge the failure reproduced with zero contention, so the launcher was
instrumented to ground truth (`TABSEND_E2E_TRACE=1` traces in `e2e/src/cdp.ts`,
kept). Three layers deep, all in the RIG — no product change was needed at any
point; the extension delivered correctly every time:

1. **The trigger (why chunk 5a exposed it):** chunk 5a's heavier service-worker
   boot shifted a knife-edge timing in the rig's branded-Chrome launcher. For
   the first ~100 ms of a freshly-booted SW context the `chrome.*` bindings are
   not yet installed — measured: a CDP `Runtime.evaluate('chrome.runtime.
   reload()')` at **+98 ms succeeded** while at **+104 ms it threw** `TypeError:
   Cannot read properties of undefined (reading 'reload')`. The launcher issued
   that evaluate once, fire-and-forget, catch swallowed. Landing early ⇒ **no
   reload ever issued** ⇒ the wait-for-fresh-SW stalled its full 20 s ⇒ the
   running SW's boot poll **delivered and acked the queued tab during the
   stall** (verified: sender outbox drained, id in the seen-set) ⇒ the "close
   restored pages" cleanup then **closed the just-delivered tab** (visible in
   the trace's close list). Acked + seen ⇒ never redelivered ⇒ 40 s timeout.
   The product behaved correctly; the rig destroyed the evidence.
2. **First fix attempt — wrong:** retrying the reload until "issued" made
   things worse: a reload issued over an attached CDP evaluate can **wedge the
   extension outright** — the SW tears down and never returns, every subsequent
   context reporting no `chrome.*` bindings (observed reproducibly: one run
   passed scenario (1) only at 23 999 ms after a 20 s wedge-stall; the next run
   wedged permanently in `beforeAll`, 5 skipped).
3. **The actual fix — delete the reload, make freshness deterministic:** a new
   `globalThis.__tabsendBuild` tag (baked into the worker per build) exposed the
   real reason the reload had existed: the chunk-4 manifest.version stamp is
   only **probabilistic** at busting Chrome's worker-script cache (one run
   updated cleanly; the very next served the previous run's cached worker with
   the new manifest — caught loudly by the new assertion). The deterministic
   replacement: **rotate the service-worker FILENAME per build**
   (`background-<stamp>.js`, `e2e/src/browser.ts`) — a never-before-seen URL
   cannot be served stale by any cache, and a same-build relaunch reuses a URL
   whose cached bytes are identical. The launcher no longer mutates the
   extension over CDP at all; it only **verifies** the running worker reports
   the expected build tag and fails loudly on mismatch.

Hardening that rode along (all rig): snapshot-based cleanup (page targets
snapshotted before the extension loads; only true restored pages + stale
extension pages are ever closed — a tab delivered mid-launch cannot be),
bindings-aware `evaluate` (probes that `chrome.*` is live before evaluating, and
skips dead session-restored duplicate contexts), a zombie-process guard
(`pkill -f 'tabsend-e2e-profile[s]'` before each push run, matching only
rig-launched Chrome), and a root-level `pnpm e2e:push` alias.

Result: launches went from 2–22 s to under 1 s, and the suite ran **5/5 green
twice consecutively** (this scenario's bar for "proven"):

| Scenario | Run 1 | Run 2 | Bar |
|---|---|---|---|
| (3) foreground send→tab | 117 ms | 115 ms | < 1 000 ms |
| (2) cold-wake send→tab | 427 ms | 510 ms | < 5 000 ms |
| (4) WS severed, still delivers | 163 ms | 126 ms | correctness |
| (1) killed → relaunch → boot-poll | 3 989 ms | 1 940 ms | within TTL (chunk-4: 3 439 ms) |
| (6) TTL-expired | never delivered | never delivered | must never deliver |

---

## A. Sanctioned additive contract change

The ONLY `shared/src/types.ts` change, matching the file's hand-formatted style:

- `Endpoint.deviceName?: string` — the device an endpoint lives on, a grouping hint.
- `RegisterRequest.deviceName?: string` — set at register (create path) or left
  unset (join path, patched after the device step).
- `UpdateEndpointRequest.deviceName?: string` — set/change the tie via PATCH,
  alongside `label`; omitted ⇒ tie untouched.

All optional; **existing rows without the field keep working** — the `label`
stays the authoritative display string, `deviceName` only powers device grouping
and the join "which device is this?" select.

**Server (minimal, for that field only):** nullable `endpoints.device_name`
column; an idempotent, introspection-based `ALTER TABLE … ADD COLUMN` migration
(dialect-agnostic, SQLite + Postgres) so the owner's **live relay data upgrades
in place**; optional validation (`optString`); register + PATCH passthrough; the
mapper projects `deviceName` only when the column is non-null (a null column stays
absent on the wire, matching the optional field). Covered by a new lifecycle test.

---

## B. UX completion (Chromium)

### New onboarding, screen by screen

1. **Connection screen** (new first screen, dogfood pass-1 #3 / pass-2 #2).
   "How will Tabsend connect?" — two cards:
   - **Hosted service** — a disabled "Coming soon" placeholder. *No invented
     billing or signup* (owner decision pending).
   - **Self-hosted** — the visible default for dev builds: a **prominent,
     always-visible Relay URL field** (no collapsed `<details>` anymore) plus a
     pointer to the run steps in `docs/reports/chunk-4.md` ("Dogfood setup").
   Continue → name screen.

2. **Name screen** (pass-2 #1). "Name this browser" — prominent, **editable**,
   with a trustworthy default when we can verify the brand and an **empty field
   with examples** when we can't (see "Browser naming" below). Then either:
   - **Start a new group** → also names the device (create-a-device), then Create.
   - **Join an existing group** → a pairing code / link field, then Join.

3. **Device screen** (join only, pass-2 #1). "Which device is this browser on?"
   — the group's **existing device names** (fetched after auth) as one-click
   chips (CREATE **or** SELECT), plus an "Add a new device" field. Confirming
   PATCHes the label to `browser · device`.

4. **Recovery** (create only) — the phrase shown once, unchanged behaviour.

5. **Manage-devices surface** (pass-2 #4) — the flow now **ends here, not on a
   dead page**: every endpoint (incl. self, tagged "This browser") with a
   presence dot + "online / last seen / inactive", inline **Rename** (any
   endpoint) and **Remove** (non-self), a **Pair another device** block with QR,
   the short code, and a **"Copy pairing link"** button (pass-2 #3), the recovery
   re-download affordance, and an honest "You can close this page now."

**Human relay errors (pass-1 #1):** a register/join/patch that can't reach the
relay now reads *"Couldn't reach the relay at <url>. Is it running? See the setup
steps (docs/reports/chunk-4.md)."* instead of a raw "Failed to fetch".

### Browser naming (pass-2 #1 — never a confident wrong guess)

`browserNameSuggestion()` reads `navigator.userAgentData.brands`:
- A distinct second brand (Edge, Brave, Opera, Vivaldi, Arc) → **confident**, prefilled.
- Firefox's honest UA (no client hints) → **confident** "Firefox".
- Bare "Chromium"/"Google Chrome" only (which a fork like **Dia** reports
  identically to real Chrome) → **not confident**: the field opens **empty** with
  an examples hint, so Dia never gets a confident wrong "Chrome" pinned on it.

The `browser` family enum (for the glyph) is still detected and sent; the label is
now `${browserName} · ${deviceName}` from the two user-named parts. Rename UI
(self + any endpoint) is wired to the existing `PATCH /v1/endpoints/:id`.

### ADR-0008 send interaction

- **Toolbar click mode** (setting, default Chooser). Applied at runtime via
  `action.setPopup` — Chooser = open the rich chooser; Quick-send = clear the
  popup so a click fires `action.onClicked` → send to primary. In Quick-send mode
  the icon's right-click menu carries "Open Tabsend chooser…" so the chooser
  stays reachable.
- **Hotkeys** (`manifest.commands`): `_execute_action` (default **Ctrl/Cmd+Shift+S**,
  native — opens the chooser, or quick-sends in Quick-send mode) and an optional
  unbound `send-to-primary` blind-fire.
- **4s undo window** — see "UX / ADR deviations" below.
- **In-page toast** confirmations (`scripting.executeScript`, shadow-DOM isolated,
  auto-dismiss) carrying the exact `INTERACTION_FLOWS §4` copy incl. the offline
  "— opens when it wakes" variant. On restricted pages (`chrome://`, Web Store,
  PDF) it degrades to the action-badge ✓ + title (the honest documented limit).
- **n=1 legible confirmation (pass-2 #6)** — the popup no longer flash-and-vanishes.
  Every successful send (online too) shows a calm centered **"Sent to ⟨target⟩ ✓"**
  for ~1.4 s before closing. The e2e asserts it.
- **Settings/options page** (§7): toolbar mode, **per-source primary target
  view / change / PIN** (ADR-0002), success-toast toggle, pending-row toggle,
  context-menu visibility toggle, and a pointer to the browser's shortcut settings.

### Console history copies (cross-agent finding, ADR-0010 §2)

Folded in per the orchestrator's mid-task message: the send pipeline now seals one
E2E **history copy per `kind:'console'` endpoint** on every send (same payload +
`historyOf:{targetEndpointId}` inside the ciphertext, sealed to the console's own
key, addressed to the console). Copies ride in the **same POST** as the real item
so a rejected/failed copy can never fail or delay the real send; on a source
outage they queue and drain like any item. Consoles stay excluded from choosers.
Hermetic unit tests prove addressing, `historyOf` embedding, and best-effort skip.

---

## C. Firefox port

Shared code; divergence behind one build-time flag (`src/lib/platform.ts`,
`__TABSEND_PLATFORM__` via Vite `define`) so dead branches tree-shake per variant.

- **API shim** (`lib/ext.ts`): `browser ?? chrome`, so awaited API calls work on
  both engines (Firefox's `chrome.*` alias is callback-style). Every runtime call
  was swept `chrome.*` → `ext.*`; type references stay on the `@types/chrome`
  namespace.
- **Wake strategy** (transport spike §3b, verified): Firefox has **no Push API**
  and **no offscreen documents**, so the **event page holds the WebSocket
  directly** (`background/fxwake.ts`, in-process — no runtime round-trip) and
  wakes on **≥1-min alarms** + **user-activity events** (`tabs.onActivated` /
  `onUpdated` / `windows.onFocusChanged`). Same single idempotent deliver loop.
  Chrome keeps its Push + offscreen-doc WS path. The WS lifecycle is a shared
  `lib/ws.ts` both hosts reuse.
- **Manifest** (`public/manifest.firefox.json`): MV3 event page
  (`background.scripts` + `type: module`), `browser_specific_settings.gecko.id`,
  no `offscreen` permission, `scripting` present.
- **Build**: `pnpm --filter @tabsend/extension build:firefox` → `dist-firefox/`
  with the FF manifest emitted as `manifest.json` (publicDir off, so neither
  engine's manifest leaks into the other's build).

**Machine-verified:** both variants build; `web-ext lint dist-firefox` = 0 errors;
static analysis confirms the FF bundle drops `createDocument` (offscreen) and
`applicationServerKey` (push) and compiles in `onFocusChanged` (activity wake) —
and the exact inverse for the Chrome bundle. The module background's `./assets/*`
imports resolve within the package.

**NOT machine-verified:** runtime behaviour on a real Firefox. Playwright cannot
load extensions into Firefox, so there is no automated FF e2e. Scripted manual
check (do this once during dogfood):

```bash
pnpm --filter @tabsend/extension build:firefox          # → extension/dist-firefox
cd extension
npx web-ext run --source-dir dist-firefox --start-url about:debugging
# In the temporary Firefox: open the Tabsend toolbar icon → onboarding.
# Point it at your relay, create a group (or join). Send a tab from a Chrome
# profile in the same group → it should open in Firefox within ~1 min worst case
# (instant if you touch a Firefox tab/window — the activity wake). Watch
# about:debugging → This Firefox → Tabsend → Inspect for WS connect logs.
```

---

## UX / ADR deviations (flag for the owner)

1. **4s undo window vs. ADR-0008 "toast-only, no undo".** The task explicitly
   asked for a 4s undo window; ADR-0008 §Mis-send safety chose "no cancel window,
   no retraction message to build." **Resolution (amends ADR-0008):** the
   blind-fire send (Quick-send click / `send-to-primary` hotkey) is **held
   locally** for 4 s and only dispatched when the window elapses, so an **Undo is
   a pure local delete — nothing is ever transmitted that must be retracted**,
   which honours the ADR's actual constraint ("no retraction message"). The hold
   is persisted (not just an in-worker timer), so a service-worker suspension
   inside the window can't drop the send: a later wake (boot or poll alarm)
   dispatches it. **Cost:** blind-fire delivery is delayed by ~4 s (only on the
   blind-fire paths; the chooser path sends immediately with no undo). **Owner
   decision:** keep the undo (recommend) or drop it back to pure toast-only — it's
   a localized change in `background/quicksend.ts`. Chooser-path sends are
   unaffected either way.

2. **`Ctrl/Cmd+Shift+S` behaviour depends on toolbar mode.** In Chooser mode it
   opens the chooser (INTERACTION_FLOWS §2.5); in Quick-send mode the same key
   quick-sends (with the undo). The optional `send-to-primary` command is the
   always-blind-fire binding (unbound by default). This reconciles the task's
   "hotkey with undo" with §2.5's "primary command opens the chooser".

3. **No copy deviations** from the `INTERACTION_FLOWS §4` table — the toast/badge
   strings come from `lib/strings.ts` verbatim. New onboarding/settings copy is
   additive (there was no prior spec string for those screens).

---

## Debts / flags

1. **Firefox runtime is not machine-verified** (Playwright limitation) — the
   web-ext run check above is the manual gate. Worth 5 minutes during dogfood.
2. **`web-ext lint` two warnings**: the QR SVG is injected via `innerHTML`
   (`qrSvg()` output, our own locally-generated data — not remote/user content).
   Benign for dogfood; before an AMO submission, rebuild the SVG via DOM to clear
   it. `browser_specific_settings.gecko.data_collection_permissions` (required by
   AMO on FF ≥140) is also a pre-submission add — omitted here so `web-ext run`
   stays simple on the dev build.
3. **`offscreen.html` still ships in `dist-firefox/`** as a dead, unreferenced
   file (the FF manifest never loads it). Harmless; could be excluded from the FF
   input list later.
4. **4s blind-fire latency** — see deviation #1.
5. **background.js ~752 kB** (libsodium CJS inlined) — unchanged chunk-3/4 debt.
6. **Console-copy e2e** is a hermetic unit test (crypto-valid seal/open), not a
   live two-endpoint e2e; the console *consume* path is verified by the console
   agent (chunk-5b). A full mint→console-pending e2e is a cheap future add.

---

## Owner reload steps (dogfood profiles)

After the orchestrator merges this branch:

```bash
pnpm install
pnpm --filter @tabsend/extension build            # Chrome → extension/dist
pnpm --filter @tabsend/extension build:firefox    # Firefox → extension/dist-firefox
# relay: your existing one (chunk-4 Dogfood setup). Do NOT change ports.
```

**Chrome / Chromium (incl. Dia):**
1. `chrome://extensions` → **remove the old Tabsend**, then **Load unpacked** →
   pick `extension/dist` (a fresh load avoids a stale cached service worker).
2. The reworked first-run tab opens: **Continue** on the connection screen (relay
   URL is prefilled/editable) → **name this browser** (Dia users: the field is
   empty with examples — type "Dia") → name the device or Create/Join.
3. Try the new bits: right-click the toolbar icon → **Options** (toolbar mode,
   primary pin, toggles); flip to **Quick-send** and click the icon (watch the
   in-page "Sent to … · Undo" toast); send with **Cmd+Shift+S**.
4. Renaming/removing devices now lives on the first-run page's manage surface, and
   in the popup footer's "Pair a device" (with **Copy pairing link**).

**Firefox (new):**
1. `pnpm --filter @tabsend/extension build:firefox`, then
   `cd extension && npx web-ext run --source-dir dist-firefox`.
2. Same onboarding. Delivery uses the WS while Firefox is in front and an ~≤1-min
   alarm when it's backgrounded (a Firefox platform ceiling, spike §3b) — touch a
   Firefox tab/window and a queued tab lands immediately.

Existing paired Chrome profiles keep working — the additive `deviceName` column
upgrades in place, and endpoints without it just show their old `label`.
