# Chunk 5b — Web console (device management + E2E history)

**Stage 3 (parallel).** A real SPA in `console/`, replacing the scaffold stub. It pairs
into a group as a `kind:'console'` endpoint (ADR-0010), manages devices, and renders the
E2E history copies sealed to it — decrypted client-side, honest about what the contract
actually exposes.

## Done-gate (green in this worktree)

| Gate | Result |
|---|---|
| `pnpm lint` (biome) | **0 errors, 0 warnings** (130 files) |
| `pnpm typecheck` | **5/5 packages** |
| `pnpm test` (root) | **22 files, 105 tests** — console adds 43 across 8 files |
| `pnpm --filter @tabsend/console test:live` | **1/1** — spawns a real relay, pairs a console, records a sealed copy, asserts ack deletes the payload |
| `pnpm --filter @tabsend/console build` | **OK** → `console/dist` (index.html + hashed css/js) |
| Browser verification | Drove the built UI in a real browser against a throwaway relay (port 8799, never :8787): onboarding → pair-in → **Live** WS → devices → live `endpoint_added` → live history copy decrypt+render → account/recovery → add-device QR mint. |

The live e2e and the browser run both use their own throwaway relay on an ephemeral port
with a temp SQLite db. **The owner's live relay on :8787 was never bound or tested against.**

## Stack & why

- **Vite 8 + TypeScript strict.** Same major as the extension, so zero lockfile churn.
- **No UI framework.** A ~60-line reactive store (`src/lib/store.ts`: `signal`/`effect`/
  `computed`) drives the panels. The surface is a handful of views; a framework would be
  more machinery than the console justifies, and every KB is a KB the relay serves. This is
  the "small reactive lib is acceptable if you justify it" path — hand-rolled, dependency-free.
- **libsodium-wrappers** (aliased to the CJS build in vite/vitest — the 0.7.x ESM entry is
  broken, same trap the extension documented) for opening `crypto_box` copies.
- **qrcode-generator** (MIT) for the "add a device" QR — mirrors the extension's helper.
- No GPL deps.

## What it does / looks like

A calm, single-accent SPA (light + dark, theme-aware) with three tabs behind a header that
shows a live connection badge and the console's own label.

- **Onboarding / pair-in.** Paste a pairing code **or** a full pairing link (auto-fills a
  self-host relay origin from the link fragment), name the console, Pair. It generates an
  X25519 keypair, registers as `kind:'console'` with `browser:null` (a console isn't a send
  target — no browser guess, per DOGFOOD #1), and stores its device token + keys in
  localStorage. Honest E2E note up front: "the console can only read history sealed to it… it
  never opens tabs and is never a send target."
- **Devices.** The whole group with presence dots, `last seen`, an **inactive** tag past the
  30-day horizon (ADR-0004 / chunk-4b, no wire field), a **THIS CONSOLE** tag on self, and a
  **console** tag on other consoles. Rename (PATCH) and Remove (DELETE) — Remove opens a
  confirm dialog that names the consequence ("stops receiving tabs… must be re-paired…";
  self-removal ends the session). **Add a device** mints a code (POST /v1/pairing) and shows
  a QR + short code + copy-link.
- **History.** Decrypted copies newest-first: `source → target`, title (a real link,
  `rel=noopener`, only for http/https), hostname, "sent N ago", copy-link. Favicons render
  **only** from `data:` URLs — a remote favicon is never fetched (it would leak the recorded
  browsing to that origin). Persisted in IndexedDB (the relay deletes the payload on ack).
- **Account & recovery.** Relay base, group/endpoint ids, push status, the honest recovery
  panel (below), and an Unpair (local-only) action.
- **Live.** A WS `/v1/stream` client (hello → ping → reconnect w/ backoff): `message` →
  pull+record, `presence`/`endpoint_added`/`endpoint_removed` → refresh. A 20s poll runs
  **regardless** (correctness path); the badge degrades Live → Polling → Offline. Nothing
  depends on the socket.

## Serving decision (no CORS, no server changes)

The relay has no CORS and no static route, so the console talks to it **same-origin** and
never triggers CORS:

- **Dev:** `pnpm --filter @tabsend/console dev` runs Vite, which **proxies** `/v1/*` and the
  `/v1/stream` WebSocket to the relay (`TABSEND_RELAY`, default `http://localhost:8787`). The
  browser sees the console's own origin.
- **Prod:** `pnpm --filter @tabsend/console build` → `console/dist`, static files with
  **relative** asset URLs (`base:'./'`) so they serve from any origin or sub-path. Serve
  `dist/` on the **same origin** as the relay (a reverse proxy: `/` → static, `/v1` → relay),
  and the same-origin `/v1/*` calls just work.

The API base is same-origin (`''`) by default and configurable per session (a cross-origin
pairing link pins its own relay origin). **I did not touch `server/`** — the static-serve
path is a deployment concern, documented here rather than wired, to keep the parallel merge
clean. If a relay static route is later wanted it's additive (`@fastify/static` at `/`).

## Contract findings & owner flags

1. **The extension does NOT yet mint console history copies (ADR-0010 §2).** The console's
   consumption path is fully built and verified (decrypt + verify-sender + persist + ack, via
   a real sender in the live test and the browser run). **But** `extension/src/background/
   send.ts::sendToTarget` seals only for the one real target — it never enumerates
   `kind:'console'` endpoints to seal the extra copy ADR-0010 requires. **Against the owner's
   live relay with today's extension, History stays empty** until the extension mints those
   copies. This is the extension agent's / orchestrator's to close (I can't touch `extension/`).
   → **flag for the extension agent.**

2. **The console can't honestly show the ORIGINAL send's delivered/acked timeline.** The task
   asked for a queued/delivered/acked/expired timeline from "outbox projections + WS events."
   Under the contract as built, the console can't see that for the *real* send: the `acked` WS
   event is delivered to the **source** endpoint only (`messages.ts` → `toEndpoint(source…)`),
   and `?outbox=1` returns **the calling endpoint's** sends — the console is never the source,
   so it has no window into another endpoint's delivery state. What the console *can* honestly
   show — and does — is sender → target, the link/title, the sender-stamped `sentAt`, and the
   target's **current** presence. I did **not** fabricate delivery ticks. If per-message
   delivery state in history is wanted, it needs a **contract addition** (e.g. an `acked`
   fan-out to group consoles, or a console-visible outbox), which is a `types.ts` change — I
   **stopped and did not invent one**. → **flag: owner decision + future contract work.**

3. **Console-kind exclusion — verified.** `extension/src/background/endpoints.ts:24` filters
   `endpoint.kind !== 'console'` out of the send targets; the **server does not** filter
   consoles from `GET /v1/endpoints` (by design — console-targeted items *are* the history
   mechanism, ADR-0010 / chunk-2 note). The live test asserts the console appears in the group
   list tagged `kind:'console'`. Correct and consistent.

4. **Recovery re-join is not wired server-side.** Per chunk-2/4, the relay stores only a
   recovery *verifier* and exposes **no `restore` route** (the wordlist is still a placeholder;
   no route consumes the phrase). I built the honest UI shell — the Account panel states
   plainly that re-join isn't wired yet and that the phrase lives on the group's first device —
   and **did not half-implement any recovery crypto.** → **flag: needs the server-side flow.**

5. **The console has no push channel.** It registers a `.invalid` UnifiedPush placeholder (the
   contract requires *a* subscription; there is no "none"), and pulls over WS + the 20s poll
   (chunk-4 said the console needs no push). When a copy is sealed to the console the relay may
   log one harmless `push wake failed` — that's the queued path, which is correct here. Minor.

6. **Bundle ~775 kB (260 kB gzip), libsodium-dominated** — the same inherited debt as the
   extension (chunk-4 debt #6, broken upstream ESM packaging). It loads once in a tab;
   acceptable for v1. Could lazy-load libsodium (only History needs it) later.

**No `shared/src/types.ts` changes.** The contract already covered the console; where I found a
genuine gap (finding #2) I stopped and flagged it rather than editing the contract.

## How the owner opens it against his live relay

Relay already running on `:8787` (per chunk-4 dogfood). Then:

```bash
pnpm install                                   # picks up the console's deps
# dev server proxies /v1 (+ the WS) to the relay → same-origin, no CORS:
TABSEND_RELAY=http://localhost:8787 pnpm --filter @tabsend/console dev
# open the printed URL (http://localhost:5173)
```

1. In an already-paired browser extension, open **Pair a device** and copy the 8-char code
   (or the pairing link).
2. In the console's onboarding, paste the code/link, name the console, **Pair console**. It
   appears in every device's list (tagged *console*, excluded from choosers).
3. **Devices**: rename/remove any device; **Add a device** mints a QR + code from the console
   itself (the "manage devices" surface).
4. **History**: shows sealed copies **once the extension mints console copies** (finding #1).
   To see the end-to-end path today, the live test / browser-run seals a copy as the extension
   will; wire the extension's minting to light this up against the live relay.

Cross-machine: serve `console/dist` same-origin behind the relay (reverse proxy), or run the
dev server with `TABSEND_RELAY` pointing at the LAN relay URL.

## Files (all under `console/`)

- `src/lib/` — `store` (reactive core), `api` (REST), `crypto` (open/keyId, no seal),
  `receive` (the consume/verify/decrypt/record loop), `stream` (WS), `persist` (IndexedDB +
  in-memory), `session` (localStorage), `pairing`, `time`, `view`, `controller` (orchestrator),
  `model`, `fixtures` (test-only).
- `src/ui/` — `app` (the reactive shell + panels + dialogs), `dom` (safe element helpers,
  textContent-only for group-authored strings), `qr`.
- `src/main.ts`, `src/styles.css`, `index.html`, `vite.config.ts`, `vitest.config.ts`,
  `vitest.live.config.ts`.
- `test/console.live.test.ts` — the spawn-a-relay end-to-end slice.
