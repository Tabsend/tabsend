# Chunk 2 — Server MVP (contract-complete relay)

**Stage 1.1.** Done-gate green from repo root: `pnpm lint` (0 errors/0 warnings), `pnpm typecheck` (4/4 packages), `pnpm test` (5 files, **25 tests**, all pass). A real `pnpm --filter @tabsend/server start` boots, migrates SQLite, and round-trips register → list → pairing over HTTP.

Stack (locked by orchestrator): **Fastify 5**, **Kysely 0.29 + better-sqlite3 12**, TypeScript strict, ESM. Run/dev via **tsx**. Push via **web-push**.

---

## What was built

`server/src/` — a contract-complete relay implementing the full v1 wire contract from `shared/src/types.ts` §10–11:

- **Config** (`config.ts`): env-driven with dev defaults — `PORT` (8787), `HOST` (127.0.0.1), `DATABASE_URL` (`sqlite:./.data/tabsend.db`; also `sqlite:`/`file:`/bare path/`:memory:`; a `postgres://` URL throws a "Chunk 4a" pointer), `PUBLIC_RELAY_URL`, `MESSAGE_TTL_DAYS` (+ `MESSAGE_TTL_SECONDS` for short-TTL testing), `PAIRING_CODE_TTL_MINUTES`, `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`/`VAPID_SUBJECT`.
- **Store** (`db/`): Kysely schema written **dialect-agnostically** (TEXT ISO-8601 timestamps that sort chronologically; INTEGER 0/1 booleans; `ON CONFLICT DO NOTHING`; `is`/`is not null`). `createDatabase()` + idempotent `migrate()`. Tables: `groups`, `endpoints`, `messages`, `pairing_codes`.
- **Routes**: `endpoints.ts` (register/heartbeat/list/patch/delete), `messages.ts` (send/pending/outbox/ack), `pairing.ts` (mint), `stream.ts` (WS).
- **Auth** (`context.ts`): `Authorization: Bearer <deviceToken>` preHandler; resolves the token to its endpoint and **refreshes presence on every authenticated call**.
- **Push** (`push.ts`): `PushSender` interface behind which sit `WebPushSender` (real VAPID, empty wake tickle), `NoopPushSender` (no VAPID configured), and `FakePushSender` (tests). Integration tests never touch a real push service.
- **WS hub** (`hub.ts`): in-process registry of authenticated sockets; `toEndpoint` / `toGroup` fan-out.
- **Scripts**: `pnpm --filter @tabsend/server gen:vapid` prints a VAPID keypair as env lines.

Tests (`server/test/`, Vitest, **real HTTP against a live in-process instance, temp SQLite per test file, injected clock + fake push**): full lifecycle register→pair→join→send→pending→ack; idempotent send replay (no dup row); idempotent ack (ackedAt not overwritten); TTL expiry; auth (missing/bad token, A-cannot-act-as-B on heartbeat & ack, cross-group isolation); pairing single-use + expiry + unknown; per-item `unknown_target`/`not_in_group`/`expired_key`; outbox drains on ack; presence flips with the clock + heartbeat; push-failure resilience; WS hello-auth (bad token & non-hello-first both close 1008), `message` on send, `acked` to source, `endpoint_added`/`endpoint_removed`.

---

## Additive types locked into `shared/src/types.ts` (additive only, hand-formatted style preserved)

- **Auth** (new §10a): `AUTH_SCHEME = 'Bearer'`, `AUTH_HEADER = 'authorization'`, `bearerAuth(token)` helper.
- **Error envelope** (new §10b): `ApiError = { error: { code, message } }` with a **closed** `ApiErrorCode` set: `unauthorized` (401), `forbidden` (403), `not_found` (404), `invalid_request` (400), `invalid_pairing_code` (400), `rate_limited` (429, reserved/unused in v1), `internal` (500). Per-item `SendResponse.rejected` reasons are a separate set and are **not** errors (a partial send is still HTTP 200).
- **Presence**: `PRESENCE_ONLINE_THRESHOLD_SECONDS = 90` (§12). Presence = `lastSeenAt` within the window **OR** a live WS.
- **WS lifecycle**: a doc block by §11 (hello-first, ping→pong, latency-only reconnect) + `WS_CLIENT_PING_INTERVAL_SECONDS = 30` (§12).

All four `console`/`extension` typecheck unchanged; `shared` still excluded from Biome (its hand-formatting is intact).

---

## Key decisions (server-side, not in the wire contract)

- **Token format**: `deviceToken` = 32 random bytes (base64url). The server stores only **SHA-256(token)** (`device_token_hash`), never the raw token.
- **keyId / `expired_key` convention** *(matters for Chunk 3)*: the server validates `EncryptedEnvelope.targetKeyId` against `base64url(sha256(utf8(target.e2ePubkey)))`; a mismatch → per-item `expired_key`. This is a plain content hash for stale-key detection, **not** E2E crypto (the relay still seals/opens nothing). The extension MUST fill `targetKeyId` (and, by convention, `senderKeyId`) with this same fingerprint. It is one function (`ids.keyIdFor`) to change if a different scheme is later chosen.
- **Pairing code**: 8 chars from an unambiguous alphabet (`23456789ABCDEFGHJKMNPQRSTUVWXYZ`, no `0/O/1/I/L`). Consumed atomically (guarded `UPDATE … WHERE consumed_at IS NULL AND expires_at > now`), so it's genuinely single-use even under races.
- **`delivered_at` semantics**: set when the target **first pulls** the message via `?pending=1` (it now holds it). `acked_at` + envelope-deletion happen on ack. So outbox rows read: queued (no deliveredAt) → delivered (awaiting ack) → gone (acked).
- **Ack authz**: acking a message not addressed to you → **404** (not 403), to avoid revealing other endpoints' message ids.
- **PATCH/DELETE scope**: allowed for any endpoint **in the caller's group** (group/console management); cross-group → 404. Heartbeat and ack are self-only (A-cannot-act-as-B).
- **Recovery kit**: minted once on group creation, returned once; server stores only a SHA-256 verifier. The wordlist (`recovery.ts`, ~96 words) is a documented **placeholder** — swap the full 2048-word BIP39 list in with the client crypto (Chunk 4c). No Chunk 2 route consumes the phrase.
- **Register returns 201**; `recovery` present only on group creation, absent on join.

---

## Deviations & flags for the orchestrator/owner

1. **`web-push` is MPL-2.0, not MIT** as PRD §8 / the transport spike claim. MPL-2.0 is **file-level weak copyleft, not GPL** — fine under ADR-0007 (no-GPL) for an unmodified dependency, and compatible with the Apache-2.0 core. **Suggest the owner correct the PRD/spike note.** (Other deps: fastify, @fastify/websocket, kysely, better-sqlite3, tsx = MIT.)
2. **Root `pnpm lint` was already red before Chunk 2** — the committed throwaway spike artifacts (`spikes/transport/*.json` + driver JS, created in Chunk 1) fail Biome. Their own `.gitignore` calls them "not for the build," so I **excluded `spikes/` from Biome** (`biome.json` `includes: ["**", "!shared/src", "!spikes"]`), mirroring Chunk 0's `shared/src` exclusion. No spike file was modified.
3. **pnpm build allowlist**: `pnpm-workspace.yaml` now has `allowBuilds: { better-sqlite3: true, esbuild: true }` — pnpm 11 blocks native/binary install scripts by default. CI (`pnpm install --frozen-lockfile`) honors this workspace config, so no CI change is needed; the lockfile is updated.
4. **Entry-guard fix**: the repo path contains a space (`Coding Projects`), which percent-encodes in `import.meta.url` — the naive `import.meta.url === file://${argv[1]}` main-check never matched. `server.ts` now compares `realpathSync(fileURLToPath(...))` to `realpathSync(argv[1])`.
5. Added `server/.data/` + `*.db`/`*.sqlite*` to `.gitignore`.

---

## For Chunk 3 (extension)

- **Credential**: store the `deviceToken` from register/join; send `Authorization: Bearer <token>` on everything except `POST /v1/endpoints/register`.
- **Envelope fingerprints**: set `targetKeyId = base64url(sha256(utf8(targetPubkey)))` or the relay rejects the item `expired_key`. Recompute after any re-pair (the target's key changed).
- **Deliver path**: on push wake / SW boot / WS reconnect → `GET /v1/messages?pending=1`, open tabs, then `POST /v1/messages/:id/ack`. **Dedupe by message id locally too** — a re-wake can re-hand you the same row until you ack (and the WS `message` event carries the same envelope for the sub-second path).
- **Push wake is an empty tickle** — carries no data; always pull on wake.
- **Outbox**: `GET /v1/messages?outbox=1` rebuilds the chooser's ⏳ pending row across restarts; live drain comes from the WS `acked` event.
- **WS**: send `{type:'hello', deviceToken}` as the first frame, then ping every `WS_CLIENT_PING_INTERVAL_SECONDS` (30s), reconnect with backoff. Handle `message` / `acked` / `presence` / `endpoint_added` / `endpoint_removed` / `pong`. The socket is latency-only — never gate correctness on it.
- **Heartbeat cadence must be < 90s** (`PRESENCE_ONLINE_THRESHOLD_SECONDS`) or a live endpoint will flap offline. Firefox's ~60s alarm fits.
- **Console-kind endpoints are NOT filtered server-side** from `GET /v1/endpoints` — the client excludes `kind === 'console'` from the chooser/target list (ADR-0010). Console history copies are ordinary `SendItem`s targeted at the console.
- Peer-facing `Endpoint` **never** includes the push subscription — verified in tests.

## For Chunk 4 (Postgres / reliability core)

- **Postgres dialect**: schema/queries are dialect-agnostic. Add a `PostgresDialect` branch in `createDatabase()` (parse `postgres://`) and reuse `db/schema.ts` interfaces. Consider migrating TEXT timestamps → `timestamptz`, or keep ISO-text (portable, already chronologically sortable).
- **TTL sweep (privacy gap to close)**: TTL is currently enforced **lazily** — expired messages are filtered from `pending`/`outbox` but their envelope ciphertext is **not** deleted until ack. PRD §6.6 wants payloads deleted on ack **or TTL expiry**. Add a durable-queue sweeper that nulls envelopes / prunes rows past `expires_at`. (Deletion-on-ack already works.)
- **WS fan-out is single-instance**: `hub.ts` holds sockets in-process. Horizontal scale needs shared fan-out (Postgres LISTEN/NOTIFY or Redis pub/sub) so a `message`/`acked`/`presence` event reaches a socket on another node, and so push subscriptions are reachable cluster-wide.
- **Idempotency/dedupe** (client-id PK + `ON CONFLICT DO NOTHING`) and **idempotent ack** are already in place and dialect-portable.
- **Recovery**: swap the placeholder wordlist for full BIP39 when the recovery flow + client crypto land.
- **Dead push subscriptions**: `WebPushSender` currently logs+continues on failure. A 404/410 from the push service should prune the subscription (endpoint went away) — wire that in with presence/last-seen pruning.
