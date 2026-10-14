# Chunk 6b — Harden & package

**Stage 3.5.** Pays the debt list from chunks 4/5a/5b/5c, packages the extension for the
stores, and writes the self-host deploy story. Built in an isolated worktree; commits are
incremental. The owner's live relay on `:8787` and his SQLite DB were **never** touched —
every server test uses a temp DB on an ephemeral port.

## Done-gate (this worktree)

| Gate | Result |
|---|---|
| `pnpm lint` (biome) | **0 errors** (146 files) |
| `pnpm typecheck` | **5/5 packages** |
| `pnpm test` | **129 tests** (26 files) — +24 over chunk-5b (recovery round-trip, wordlist, rate-limit, body-cap, dead-sub pruning, console recover) |
| `pnpm e2e` (bundled Chromium) | **7/7** (~10 s) |
| `pnpm e2e:push` (real branded Chrome + real FCM) | **5/5** (see latencies below) |
| `./gradlew test` (android, debug + release) | **16 tests, 0 failures** — libsodium interop vector green with the new BC crypto |
| `pnpm package:chrome` / `package:firefox` | zips built + verified |

`pnpm e2e:push` latencies (real FCM, this Mac): (3) foreground **87 ms** (<1 s), (2) cold-wake
**245 ms** (<5 s), (4) WS-severed **126 ms**, (1) killed→relaunch **1758 ms**, (6) TTL-expired
**never delivered**. First attempt stalled in `beforeAll` (a transient real-Chrome/GCM launch
hang, no rig contention present); a clean retry went 5/5 — my changes don't touch the push
path (extension crypto is byte-identical to the green baseline).

## Debts paid

### 1. Real BIP39 wordlist  →  **owner's existing kit is SAFE**
The 96-word placeholder is replaced by the canonical **2048-word BIP39 English list**
(`server/src/bip39-english.txt`, public domain / CC0 from the Bitcoin BIPs repo, SHA-256
`2f5eed53…` — verified against the well-known reference digest; `recovery.ts` re-asserts the
2048-word shape at boot).

**Impact on the owner's live group: none.** The relay stores only `recoveryVerifier(phrase)`
= `SHA-256(phrase)` (ADR-0003), never the phrase and never any wordlist index. Verification
hashes the literal phrase the user types — it never re-derives words from the list — so the
wordlist participates *only* in minting a NEW phrase. The owner's phrase was minted from the
old list, but it's a normal lowercase word string; its stored verifier is unchanged, and it
still verifies byte-for-byte. No versioning is needed (nothing consumes a wordlist index);
this is documented at length in `recovery.ts`. Bonus: `recoveryVerifier` now normalises
case/whitespace, so a re-typed phrase with stray spacing/capitalisation still matches.

### 2. Recovery re-join flow (ADR-0003)  →  **wired end-to-end, round-trip tested**
- **Server:** additive, sanctioned `POST /v1/endpoints/recover` (`RecoverRequest` /
  `RecoverResponse` in `shared/src/types.ts` §10, hand-formatted). Unauthenticated (every
  device may be lost), verifies the phrase against the stored verifier, and enrolls a fresh
  endpoint into the group — the join path authorised by the phrase instead of a pairing code.
  A wrong phrase → `unauthorized` (401), a uniform "credential rejected" with no
  group-existence oracle. Rate-limited (see hardening).
- **Console:** the "not yet wired" panel is now wired — a **"Lost every device? Recover with
  your phrase"** block on the onboarding screen (phrase + relay URL) calling
  `controller.recover()`, plus an updated account note.
- **E2E honesty:** recovery restores **membership, not old history**. The recovering device
  gets a new keypair; it receives new sends sealed to it, but history sealed to the lost
  devices' keys stays unreadable (inherent to ADR-0005). Stated in the UI and the contract.
- **Tests:** full round-trip (create group → recover on a fresh key → the recovered endpoint
  appears in the group and drains a send sealed to its new key), wrong-phrase 401,
  non-existent-group 401, case/whitespace tolerance, no-kit-re-mint.

### 3. Android crypto swap  →  **hand-roll deleted, interop vector still green**
The XSalsa20 keystream now runs on Bouncy Castle's vetted **`XSalsa20Engine`**. BC exposes no
standalone HSalsa20, so `crypto_box_beforenm`'s HSalsa20 uses BC's public
**`Salsa20Engine.salsaCore`** (undoing its feed-forward add). All hand-rolled Salsa20 round
arithmetic (`doubleRound`, the block function, the keystream loop) is gone; `CryptoBox.kt` is
untouched. The committed libsodium interop vector — open + re-seal byte-for-byte + keyId — is
the proof: `./gradlew test` green (debug + release).

### 4. Bundle slimming  →  **attempted, documented, NOT shipped (debt remains)**
`background.js` is **752 kB** (251 kB gzip), dominated by libsodium's base64-embedded WASM/asm
runtime. Of the three suggested levers:
- **sumo → non-sumo:** already non-sumo.
- **ESM entry workaround:** unavailable — libsodium 0.7.x's ESM entry is broken upstream
  (imports a `./libsodium.mjs` shipped in a sibling package), which is exactly why chunk-3
  aliases the bare specifier to the CJS build.
- **dynamic import code-splitting:** *works as a build* — it cuts `background.js` **752 kB →
  26 kB** (libsodium becomes a lazily-loaded 728 kB chunk) — but **breaks crypto in the MV3
  service worker under the `pnpm e2e` gate.** A/B, same rig: static import **7/7 in 10.8 s**;
  dynamic import **0/7** (registration's `generateKeyPair` never resolves — the SW hangs on
  the dynamic import). So it's not viable while `pnpm e2e` (bundled Chromium) is the gate.

Kept the static import. Total shipped bytes are unchanged; the debt stands with a clear reason.
Revisit if upstream ships a working ESM build, or if SW dynamic-import proves reliable in the
gate's Chromium.

### 5. Server hardening  →  **all three, with tests**
- **Dead push-subscription pruning:** N consecutive 404/410 push failures
  (`PUSH_DEAD_THRESHOLD`, default 3) marks a subscription dead and **skips its wakes** (the WS
  event + poll still deliver); the client's heartbeat rotation — the chunk-4 VAPID self-heal —
  resets the counter (`push_failures` cleared on a fresh subscription). New `endpoints.push_failures`
  column via the same additive, dialect-agnostic in-place migration (SQLite + Postgres), so
  the owner's live relay upgrades in place. Verified against the self-heal path.
- **Rate limiting:** an in-process fixed-window limiter keyed by client IP on the auth-free
  write routes (register, recover) → the contract's `rate_limited` (429) + `Retry-After`
  (`RATE_LIMIT_MAX`/`_WINDOW_SECONDS`, default 30 / 600 s; `0` disables). Per-instance, matching
  the single-instance WS hub; fails safe. OFF by default in tests so multi-register suites
  don't self-throttle.
- **Request size cap:** `MAX_BODY_BYTES` (default 1 MiB) → Fastify `bodyLimit` → 413.
- `TRUST_PROXY` added so rate limits key on the real client IP behind the reverse proxy.

### 6. Packaging  →  **store-ready zips + single-source version**
- `scripts/pack.mjs` + root scripts: `pnpm package:chrome` → `dist-packages/tabsend-chrome-<v>.zip`
  (manifest at the archive root), `pnpm package:firefox` → `web-ext build` →
  `tabsend-firefox-<v>.zip` (an xpi is a zip; AMO-signable), `pnpm package` for both.
  **Verified:** chrome 282 kB (manifest_version 3), firefox 279 kB (gecko settings), version
  stamped.
- **Version from one place:** the root `package.json` `version` is stamped into the emitted
  manifest by the Vite build (dev + packages agree).
- `web-ext` 8.9.0 pinned as an extension devDependency; its transitive `spawn-sync` native
  build explicitly disabled in `pnpm-workspace.yaml` `allowBuilds`.
- `docs/AMO_SOURCE.md`: reproducibility / source-submission notes for AMO.

### 7. Deploy story
- `docs/DEPLOY.md`: bare-Node quickstart, annotated env table, SQLite vs Postgres (same
  migrations, **auto-migrate on boot**), **HTTPS-is-mandatory** with a Caddy example, a
  hardened **systemd** unit, Docker + compose, SQLite-file vs `pg_dump` **backups**, and the
  **single-instance WS fan-out** limitation stated honestly (latency-only; queue + push + poll
  always deliver).
- **`Dockerfile`** (multi-stage, non-root uid 10001, tsx-from-source CMD, `/data` volume,
  `/v1/config` healthcheck) + **`docker-compose.yml`** (relay + Postgres 17) + `.dockerignore`
  + `server/.env.example`.
- **Docker build note:** Docker was unavailable in this environment, so the image was **not**
  CI-built here. The exact `CMD` runtime path **was** verified locally — the relay boots and
  serves `GET /v1/config` via `server/node_modules/.bin/tsx server/src/server.ts` (what the
  container runs). Watch the first `better-sqlite3` native-compile step on a real build (the
  build stage installs `python3/make/g++` in case there's no prebuilt for the Node ABI).

### 8. README
`README.md` at repo root: what Tabsend is, the monorepo map, dev quickstart, store-package +
self-host pointers, an honest per-component status table, Apache-2.0.

## Contract & decisions
- `shared/src/types.ts` §10 gains `RecoverRequest` + `RecoverResponse` — the only wire additions
  this chunk; both additive, existing rows/clients unaffected.
- Recorded as **ADR-0012** in `docs/DECISIONS.md`.

## Owner flags
1. **Bundle size debt remains** (#4 above) — documented with the A/B proof; not a regression,
   just not improvable within the sanctioned levers + the e2e gate today.
2. **Docker image not CI-built here** (no Docker in-env). Build it once on your VPS/CI and
   watch the `better-sqlite3` compile; the runtime CMD is locally verified.
3. **AMO pre-submission items** (QR `innerHTML` → DOM; gecko `data_collection_permissions`) —
   listed in `docs/AMO_SOURCE.md`, deferred so `web-ext run` stays simple for dogfood.
4. **`base image node:26`** — the Dockerfile pins it to satisfy `engines.node >= 26`; confirm
   the tag exists for your registry (your local Node is 26.5.0).
5. **`e2e:push` first-run stall** — a transient real-Chrome/GCM launch hang; a retry went 5/5.
   If it recurs, `rm -rf ~/.cache/tabsend-e2e-profiles` re-mints (one fresh mint is fine;
   rapid re-minting trips GCM rate limits — chunk-4 note).
6. **Recovery / wordlist did NOT touch your live group** — the wordlist swap and the new
   recover route are additive; your existing recovery phrase still verifies (proof in #1).
   The `push_failures` migration upgrades your live relay's `endpoints` table in place on next
   boot (nullable-safe, backfilled to 0).
