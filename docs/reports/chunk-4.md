# Chunk 4 — Reliability core (Postgres queue · pairing/presence · push wake + WS fast path)

**Stage 2.** Done-gate green from repo root: `pnpm lint` (0 errors), `pnpm typecheck` (5/5
packages), `pnpm test` (12 files, **62 tests**, SQLite), the same server suite on **Postgres**
(`TABSEND_TEST_PG=1`, 30 tests), **`pnpm e2e`** (7/7, bundled Chromium, ~10 s), and
**`pnpm e2e:push`** (5/5 reliability scenarios on **real branded Google Chrome 150 with real
FCM Web Push**, ~4.5 min).

## Measured latencies vs. the §3 bar (branded Chrome, real FCM, this Mac)

| Scenario | Measured | Bar | Margin |
|---|---|---|---|
| (3) Foreground send → tab open (WS + push live) | **209 ms** | < 1 000 ms | 4.8× |
| (2) Send after idle window → push wakes → tab open | **222 ms** | < 5 000 ms | 22× |
| (4) WS forcibly severed mid-flight → push/poll carries it | **126 ms** | correctness only | — |
| (1) Target browser KILLED → send → relaunch → boot-poll opens tab | **3 439 ms** (incl. Chrome boot) | within TTL | — |
| (6) TTL-expired message | **never delivered** (asserted) | must never deliver | ✓ |
| (5) Ack-blocked restart (chunk-3 rig, re-run green) | no duplicate tabs | no dupes | ✓ |

Every scenario also asserts **exactly one tab, no duplicates** (unique URL per scenario).
Numbers land in `$TMPDIR/tabsend-push-results.txt` on every `pnpm e2e:push` run.

Honesty notes:
- In scenario (2) the SW never *observably* idle-terminated during the 150 s wait — the
  product's own 30 s poll alarm plus the offscreen document keep it effectively warm, which
  is the shipped behavior. The genuinely-cold path is covered by scenario (1) (killed
  browser) and by the transport spike's direct measurement (cold-wake median 225 ms, deep
  cold 432 ms — `docs/spikes/transport.md` §2).
- Scenario (4) proves the architecture's core claim: with the fast-path socket dead, the
  message still arrived in 126 ms (via push), and would arrive via the 30 s poll with push
  off too. The socket is latency-only, never correctness.

## Dialect matrix

| Suite | SQLite (default) | Postgres 17 |
|---|---|---|
| server integration (30 tests: lifecycle, auth, WS, TTL sweep, concurrent dedupe, config) | ✅ | ✅ (`TABSEND_TEST_PG=1`) |

Same migrations, same queries (TEXT ISO-8601 timestamps, INTEGER booleans, `ON CONFLICT DO
NOTHING`) — zero dialect-specific SQL was needed. CI (`.github/workflows/ci.yml`) runs the
matrix with a `postgres:17` service container.

**Local Postgres** is a project-local `pg_ctl` cluster (NOT `brew services`), so it's
isolated and disposable:

```bash
brew install postgresql@17          # once
scripts/pg.sh init                  # once — creates .pgdata/ (gitignored) on port 55432
scripts/pg.sh start                 # start (stop / status / nuke also available)
scripts/pg.sh createdb              # creates tabsend_test
TABSEND_TEST_PG=1 pnpm --filter @tabsend/server test
# server against Postgres for real:
DATABASE_URL="$(scripts/pg.sh url)" pnpm --filter @tabsend/server start
```

---

## What was built

### 4a — Durable Postgres queue + TTL
- **Postgres dialect** (`server/src/db/index.ts`): `postgres://` DATABASE_URL → Kysely
  `PostgresDialect` (pg Pool); anything else → better-sqlite3 as before. Tests get
  schema-per-suite isolation (`pgSchema` option pins `search_path`).
- **TTL sweeper** (`server/src/sweep.ts`, wired in `server.ts`, `SWEEP_INTERVAL_SECONDS`
  default 60): an expired-but-unacked message has its ciphertext **nulled immediately**
  (mirrors the ack model — envelope gone, routing tombstone retained so an idempotent replay
  can't resurrect it); tombstones are hard-deleted once `SWEEP_GRACE_SECONDS` (default = one
  TTL ⇒ total retention ≈ 2× TTL, matching the extension's seen-set) past expiry. Delivery
  of expired rows was already impossible (reads filter `expires_at > now`); the sweeper
  closes the chunk-2 **payload-retention privacy gap**.
- **Dedupe hardened**: new test fires 12 identical sends concurrently (true pool-level races
  on Postgres) → exactly one row, and a replay after ack never resurrects the message.

### 4b — Pairing polish + presence
- **QR pairing** (`extension/src/lib/qr.ts`, qrcode-generator, MIT): popup pairing box shows
  a QR of the full `PAIRING_LINK` (relay + code in the fragment) next to the short code.
- **Join via pasted link** (`lib/pairing.ts`): the join field accepts a bare code OR a full
  pairing link; a link auto-fills the relay URL for self-hosters (code stays in the
  fragment — never in server logs, ADR-0009).
- **Heartbeat loop** (`background/heartbeat.ts`): SW boot + every 30 s alarm — well under
  the 90 s presence window — and it **rotates the real push subscription** to the relay,
  replacing chunk-3's placeholder.
- **Stale endpoints** (ADR-0004 follow-up, decided): the relay **never auto-deletes**;
  endpoints offline > 30 d render as "inactive" in the chooser (derived from `lastSeenAt`,
  no wire change); removal stays a user action (`DELETE /v1/endpoints/:id` — devices UI in
  Chunk 5).
- **Recovery kit re-download**: first-run/options page keeps "Show recovery phrase again"
  for the group creator and re-nudges while unsaved (client-local flag).

### 4c — Real push wake + WS fast path + queued visibility
- **Contract lock (sanctioned, the only wire addition)**: `GET /v1/config` →
  `ServerConfigResponse { vapidPublicKey }` in `shared/src/types.ts` §10c. Unauthenticated —
  the VAPID public key IS the browser's `applicationServerKey`, not a secret. Empty string ⇒
  push disabled, client skips subscribing.
- **Real Web Push** (`background/push.ts`): subscribe from the ACTIVE SW,
  `userVisibleOnly:false` (fallback `true`), backoff per spike §6. Push handler pulls
  pending → the one idempotent deliver path.
- **VAPID-rotation self-healing** (found the hard way — see debts/findings): the extension
  stores the key it subscribed against, compares to `/v1/config` each boot, verifies the
  browser subscription via `PushSubscription.options.applicationServerKey`, and
  unsubscribes/resubscribes on mismatch. Without this, a relay key rotation leaves a
  healthy-looking subscription whose pushes all 403 — silent wake loss.
- **Offscreen-document WebSocket** (`extension/src/offscreen/`, `background/offscreen.ts`,
  `background/stream.ts`): hello auth, ping/pong on the shared cadence, reconnect with
  backoff + jitter. WS `message` events deliver through the SAME serialized, seen-set
  idempotent loop as polling (`receive.ts` refactor) — WS + push + poll can never
  double-open. `acked`/presence/endpoint events refresh open popups live via a port.
  **Empirical:** offscreen docs have no `chrome.storage` — config flows from the SW over
  runtime messaging (`need-config` pull + push on registration change).
- **Pending row pays chunk-3's debt**: the chooser's ⏳ row reads the **server outbox**
  (sent-but-unacked) as source of truth, plus local not-yet-accepted sends; drains live on
  the WS `acked` event.
- **Queued visibility (ADR-0008)**: exact INTERACTION_FLOWS §4 strings live in
  `extension/src/lib/strings.ts` (Chunk 5's in-page toasts reuse it verbatim). Today they
  route through the badge tooltip + the popup status line — offline targets read
  "Sent to X — opens when it wakes".

### Reliability e2e (e2e/)
- **`pnpm e2e`** (unchanged scope, still green): bundled Chromium, no push — the fast gate.
- **`pnpm e2e:push`**: branded Chrome via CDP `Extensions.loadUnpacked` +
  `--enable-unsafe-extension-debugging` (`e2e/src/cdp.ts`), CDP dropped after load so the SW
  lifecycle stays natural. Persistent profile in `~/.cache/tabsend-e2e-profiles`
  (override: `TABSEND_E2E_PROFILE_DIR`) so the GCM check-in survives runs; **VAPID keys
  persist next to it** (`vapid.json`) so the cached subscription stays valid. Cleanup:
  `rm -rf ~/.cache/tabsend-e2e-profiles` (next run re-mints everything; one fresh mint is
  fine — it's rapid re-minting that trips GCM rate limits). The sender side is node-based
  (`e2e/src/sender.ts`): registers into the group over the API and seals with libsodium
  exactly as the extension does, so the target's verify/open path is the real crypto.

## Hard-won findings (the rig will bite anyone who re-learns these)

1. **A persistent profile CACHES the unpacked extension's service-worker script.** Relaunch
   + `Extensions.loadUnpacked` + even `chrome.runtime.reload()` can keep executing LAST
   run's worker — silently testing stale code. Fix in the rig: stamp a fresh
   `manifest.version` on every build (`e2e/src/browser.ts`) so Chrome treats it as an
   extension update and re-fetches the worker; plus a `runtime.reload()` after load.
2. **Session restore resurrects last run's tabs** whose extension contexts were invalidated
   by the update — evaluating against one throws `chrome.storage undefined`-style errors,
   and stale tabs pollute tab-count assertions. The launcher closes all restored pages.
3. **Offscreen documents can't use `chrome.storage`** (only `chrome.runtime` messaging).
4. **A push subscription silently dies when the VAPID key changes** (FCM 403: "the VAPID
   credentials … do not correspond to the credentials used to create the subscription").
   Both the product fix (self-healing resubscribe) and the rig fix (persist VAPID keys with
   the profile) exist now.
5. Chrome's `DEPRECATED_ENDPOINT`/`PHONE_REGISTRATION_ERROR` stderr lines appear even on
   fully working runs — not diagnostic (spike §6 said so; still true).

## Decisions (recorded as ADR-0011)

Dual dialect/one migration · sweep mirrors ack (purge → tombstone → grace-pruned) · server
never auto-deletes endpoints (30 d "inactive" marking, user-action removal) · `/v1/config`
discovery route · offscreen WS with BLOBS reason + runtime-messaging config · one deliver
path · client-side VAPID-rotation detection.

## Debts / flags for the owner

1. **Scenario (2) measures the practical wake, not an isolated push-cold-wake** — the 30 s
   alarm + offscreen doc keep the SW warm in practice (that IS the product). Raw cold push
   numbers stand in the spike (§2). If a pure re-measure is ever wanted: disable the poll
   alarm + offscreen doc in a test build and re-run — not worth rig complexity now.
2. **Offscreen `BLOBS` reason is an approximation** (no "network connection" reason exists).
   Store review may ask; the justification string states the real purpose.
3. **WS fan-out is still single-instance** (`hub.ts` in-process). Horizontal scale needs
   LISTEN/NOTIFY or Redis — unchanged from chunk-2, not a v1 blocker.
4. **Recovery wordlist is still the ~96-word placeholder** (chunk-2 debt). Swap in full
   BIP39 when the recovery *flow* lands (no route consumes the phrase yet).
5. **Dead push subscriptions aren't pruned server-side** (a 404/410 from the push service
   should clear the stored subscription). Low urgency: the client now self-heals its own
   subscription, and stale endpoints surface as offline/inactive.
6. **background.js is ~745 kB** (libsodium CJS build inlined) — unchanged chunk-3 debt;
   revisit when upstream fixes their ESM packaging.
7. `e2e:push` pops visible Chrome windows on this Mac — by design (it's the test bench).
8. Manual-verification complement (optional, not required by the gate): pair two real
   Chrome profiles per the dogfood steps below, then quit the target Chrome entirely, send
   to it, relaunch → the tab must open on boot; and DevTools-close the offscreen doc
   (chrome://extensions → service worker → Application) mid-send to watch push carry it.

## For Chunk 5's three parallel agents

- **Extension-UX / Firefox**: Firefox has NO Push API and NO offscreen documents — the wake
  strategy is event page + WS + `alarms(1 min)` + user-activity listeners (spike §3b). The
  WS client logic in `src/offscreen/index.ts` is reusable, but its config transport
  (runtime messaging from the SW) is Chrome-specific — on Firefox the event page can read
  storage directly. In-page toasts: consume `lib/strings.ts` verbatim (`sendFeedbackLine`,
  `pendingRow`); the SendResult shape already distinguishes online/queued/source-offline.
  Devices UI: render `stale` from `ChooserRow` ("inactive"), wire `DELETE /v1/endpoints/:id`
  for removal. Settings surface keys exist in `ClientSettings` (unused so far).
- **Console**: it's a `kind: 'console'` endpoint — pair normally, pull/ack history copies
  (`SendPayload.historyOf`), never open tabs. `GET /v1/config` tells you if the relay does
  push (console likely doesn't need it — WS + poll suffice in an open tab). The outbox/acked
  flow is live server-side; ack-visibility events arrive on the WS.
- **Android**: UnifiedPush endpoints are plain Web Push — the relay already sends to them
  (same `WebPushSender`). Get `vapidPublicKey` from `GET /v1/config` for the distributor
  registration where required. Heartbeat cadence < 90 s when the app is alive; queue+poll
  covers everything else. Seal/open with lazysodium `crypto_box` — the keyId convention is
  `base64url(sha256(utf8(pubkeyB64)))` (unit-tested parity server/extension).

## Dogfood setup (owner: start here)

```bash
# 1. One-time: install deps + generate push keys
pnpm install
pnpm --filter @tabsend/server gen:vapid >> server/.env   # creates VAPID_* lines

# 2. Run the relay (SQLite default; reads server/.env if you export it, or inline:)
cd server && set -a && source .env && set +a && cd ..
pnpm --filter @tabsend/server start                       # http://localhost:8787

# 3. Build the extension
pnpm --filter @tabsend/extension build                    # → extension/dist
```

Then in **each real Chrome profile** you want in the group:
1. `chrome://extensions` → enable Developer mode → **Load unpacked** → pick `extension/dist`.
2. First profile: the first-run tab opens → "Create group" (relay URL default
   `http://localhost:8787` is already right) → save the recovery phrase.
3. Every other profile/browser: click the Tabsend toolbar icon in an already-paired profile
   → "Pair a device" → scan the QR with a phone later, or copy the 8-char code / the
   pairing link into the new profile's first-run "Join" box.
4. Send: toolbar icon (chooser), or right-click a page/link → "Send tab/link to …".

Notes for daily use:
- Without VAPID keys the relay still works — delivery just falls back to the 30 s poll
  (the startup log warns). With keys, delivery is push-woken (~200 ms class).
- The relay must be reachable from every device; for cross-machine dogfood run it on a
  LAN-reachable host and set `PUBLIC_RELAY_URL` (it's what pairing QRs embed) plus change
  the relay URL on first-run.
- Messages expire after 7 days (`MESSAGE_TTL_DAYS`); expired ciphertext is purged by the
  sweeper and expired sends are never delivered.
- If you rotate VAPID keys later, clients notice on their next SW boot and resubscribe
  themselves — no re-pair needed.
