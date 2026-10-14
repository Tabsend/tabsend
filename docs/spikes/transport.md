# Spike A — Transport (VAPID Web Push wake)

**Date:** 2026-07-16 · **Status:** complete · **Decision input for:** ADR-0006
**Question:** does VAPID Web Push, implemented directly in our relay, wake extension endpoints fast enough — foreground <1s, cold-wake <5s — and what is the Firefox story?
**Answer: GO.** VAPID-direct beats both bars by an order of magnitude on Chrome. Firefox has **no Web Push for extensions at all** — but the pre-specified fallback (event page + WebSocket + alarms) is measured and workable, and the ntfy/UnifiedPush fallback would not fix Firefox either, so it buys nothing.

All spike code in `spikes/transport/` (throwaway; self-contained npm project). Raw data: `spikes/transport/results-main.json` (main run), `fx-lifecycle.json` (Firefox lifecycle), `probe-firefox.json` (Firefox API probe).

---

## 1. Setup

- **Relay:** plain Node `http` + `web-push` (MIT), VAPID keys generated locally. Sends `urgency: 'high'`, TTL 60s. Models the product path: *push wake → extension pulls pending → opens tab → acks*.
- **Extension:** throwaway MV3, `pushManager.subscribe({ userVisibleOnly: false })` — **no user prompt, no notification requirement** in extensions (Chrome 121+); worked exactly as documented.
- **Browser:** **real branded Google Chrome 150** (not Chromium/Chrome-for-Testing — only branded Chrome ships the Google push-service keys). Subscription registered against `fcm.googleapis.com`.
- **Clock:** everything on one machine; all numbers are ms relative to the relay's send timestamp, so no clock skew.
- **Cold-wake honesty:** a run counts as cold only after the SW target **disappeared from CDP `/json/list`** (definitive termination signal, no CDP attached to the SW). Every cold run's `bootΔ` (push-received − SW-boot) was 1–11 ms, proving genuine cold boots.

## 2. Latency table — Chrome (VAPID Web Push, end-to-end)

| Scenario | n | Stage | min | **median** | p90 | max | Bar | Verdict |
|---|---|---|---|---|---|---|---|---|
| **Foreground / warm** (SW alive) | 8 | push received | 81 | **96** | 213 | 228 | — | |
| | | pending fetched | 83 | **100** | 221 | 248 | — | |
| | | tab opened | 95 | **108** | 232 | 261 | **< 1 000** | **PASS ×9** |
| **Cold-wake** (SW terminated, ~30 s idle) | 6 | push received | 189 | **206** | 256 | 283 | — | |
| | | pending fetched | 192 | **210** | 262 | 287 | — | |
| | | tab opened | 200 | **225** | 279 | 305 | **< 5 000** | **PASS ×22** |
| **Deep cold** (SW dead + 3 min push-channel idle) | 2 | push received | 331 | **364** | — | 396 | — | |
| | | tab opened | 401 | **432** | — | 463 | **< 5 000** | **PASS ×11** |

*(all ms; "tab opened" includes an independent relay-side confirmation — the opened tab loading a relay URL — which matched the SW's own timestamps within ~10 ms)*

**Delivery reliability in-run: 16/16 measured pushes delivered** (plus ~10 warmup pushes). One transient timeout was observed across the whole spike — the *first-ever* push immediately after a fresh subscription — which the queue+pull-on-wake model absorbs by design.

**Reading:** cold-wake costs only ~100–250 ms over warm. Chrome's FCM channel stays hot even with the SW dead; after 3 minutes of full idle the total was still under half a second. The <5 s bar has enormous headroom for the real product's extra work (crypto_box open ≈ ms, SQLite/Postgres query ≈ ms).

## 3. Firefox — the critical unknown, resolved

### 3a. Verdict: Firefox exposes **no Push API to WebExtensions.** Confirmed empirically, not assumed.

Probe (temporary add-on via `web-ext`, Firefox 152.0.6): on the extension background page —
- `PushManager` / `PushSubscription` globals: **absent**
- `navigator.serviceWorker`: **not present at all** (so no SW registration → no `registration.pushManager` path)
- `browser.push` / `chrome.push`: **absent**

There is no route to a push subscription from a Firefox extension. (This is the long-standing gap; Bugzilla #1247687.) Raw result: `spikes/transport/probe-firefox.json`.

### 3b. Fallback measured: event page + WebSocket + `alarms(1 min)`

| Measurement | Result |
|---|---|
| WS delivery latency, socket live (n=6) | **1–2 ms** (tab open 5–16 ms) — crushes the foreground bar |
| Event-page suspension | **~30–40 s idle**, *despite* an open WebSocket, a 3 s `setInterval` heartbeat, and in-flight `fetch`es — Firefox does not count these as activity |
| Wake mechanism | the ≥1-min `alarms` fired, event page **re-booted fresh** (new bootAt), reconnected WS immediately — observed repeatedly, like clockwork |
| Observed dead windows | 27 s and 36 s in the 140 s observation (bounded above by the 60 s alarm period) |
| `persistent: true` background page | **also suspended** in our automated FF152 runs (fresh boots + alarm reconnects observed). Do not count on MV2 persistence surviving; re-verify once during dogfood on a normally-used profile |

**What this means for Tabsend on Firefox:**
- **Foreground bar (<1 s): met** whenever the socket is up — delivery is effectively instant.
- **Cold bar (<5 s): not meetable while the event page is suspended.** Worst case = the alarm period, i.e. **≤ ~60 s to reconnect-and-drain**. No transport choice fixes this — there is no push channel to wake Firefox faster; this is a Firefox platform ceiling, not a design defect.
- **Correctness is unaffected** — this is exactly the architecture's point: the queue holds the message; Firefox drains on wake. Zero silent drops.

**Chosen wake strategy for Firefox (build guidance):**
1. Event page holds the WS (fast path; 1–2 ms while alive).
2. `alarms` every 1 min → reconnect → `GET /messages?pending=1` → drain. Hard ceiling ~60 s.
3. **Register listeners on user-activity events** (`tabs.onActivated`/`onUpdated`, `windows.onFocusChanged`, toolbar/menu events): each wakes the event page → instant reconnect+drain. In practice the tab arrives the moment the user *looks at* Firefox — which is when a delivered tab matters.
4. Heartbeat on every wake keeps presence honest, so senders see accurate online/offline.

Document the ~1-min worst case as a known Firefox platform limit (it only bites when Firefox is running-but-untouched; a *closed* Firefox was always going to deliver on next launch).

## 4. Android / UnifiedPush — effort assessment (paper)

- **Relay: zero new work.** UnifiedPush 3.0 endpoints **are** standard Web Push endpoints (RFC 8030/8291/8292 incl. VAPID). The same `web-push` sender that hit `fcm.googleapis.com` in this spike POSTs to a UnifiedPush endpoint URL unchanged. `types.ts` §2 already models `UnifiedPushSubscription` as `{ transport, endpoint }` — correct as specced.
- **Android app:** the UnifiedPush connector library handles distributor discovery/registration and hands the app an endpoint URL to report on register/heartbeat. Days, not weeks; it's the same shape as the extension's subscribe-and-report.
- **Distributor story:** ntfy (Apache-2.0 — license confirmed, compatible with ADR-0007) is the canonical distributor; users install the ntfy app, self-hosters point it at their own ntfy. For stock-Android users with no distributor, UnifiedPush's **embedded FCM distributor** lib compiles an FCM fallback into our app — no separate app to install, matching ADR-0006's FCM-fallback plan.
- **Latency probe:** a quick probe against public `ntfy.sh` was attempted; the public instance's stream endpoint was flaky from this network (ECONNRESET), so no clean number — **assessment stands on the docs**, and Android latency gets measured for real in Chunk 5 when there's an app to measure.
- **Effort verdict: low.** No relay changes; one Android-side integration + one optional embedded-FCM dependency.

## 5. Decision — **GO: VAPID Web Push direct (ADR-0006 → Accepted)**

- Chrome-family: both bars beaten by 9–22×, with the deep-cold case still 11× under the bar.
- The ntfy/UnifiedPush-as-transport fallback (PRD §8 option B) is **strictly worse**: it cannot help Firefox (no push for extensions is a platform gap — ntfy's own browser delivery *is* Web Push), adds a dependency for desktop where VAPID-direct already excels, and its Android benefit is captured anyway by supporting UnifiedPush endpoints (§4) — which is just more Web Push.
- Firefox ships with the WS+alarms wake strategy (§3b) and a documented ~1-min worst case for the running-but-idle window. Correctness (queue, TTL, idempotent ack) identical on all platforms.

## 6. Findings the build must carry forward (hard-won)

1. **Stable Chrome ≥137 ignores `--load-extension`** (even with `--disable-features=DisableLoadExtensionCommandLineSwitch`). **Load unpacked extensions via CDP `Extensions.loadUnpacked`** with the browser launched with `--enable-unsafe-extension-debugging`. Browser-level CDP connection only; **disconnect after loading** so the SW lifecycle stays natural (an attached debugger keeps SWs alive and falsifies cold-wake tests). *The Chunk 3 e2e rig needs exactly this technique.*
2. **Use branded Chrome + a persistent test profile** for anything push-related. Chromium lacks the push-service API keys; and rapidly minting fresh ephemeral profiles gets GCM check-in rejected (`PHONE_REGISTRATION_ERROR` — rate-limiting). One reused profile = one check-in = reliable subscriptions. (Chrome's stderr `DEPRECATED_ENDPOINT`/`PHONE_REGISTRATION_ERROR` lines can appear even on successful runs — not diagnostic by themselves.)
3. **`pushManager.subscribe()` requires an *active* service worker.** Called during `install`/top-level eval it throws `AbortError: … no active Service Worker`. Subscribe from the `activate` handler (inside `waitUntil`), guard with a wait-for-`registration.active`, and **retry with backoff** — the first attempt can also fail transiently while GCM checks in.
4. **`userVisibleOnly: false` works in MV3 extensions** (Chrome 121+): no permission prompt, no notification requirement, pure data push. The product's silent tab-open path is real.
5. **MV3 SW idle-termination is real and fast** (~30 s, observed 28–115 s wall-clock) — the queue+push architecture is not optional, it's load-bearing (validates PRD §6.1).
6. **First-push-after-subscribe can be lossy** — one observed timeout right after a fresh subscription. Pull-on-wake + queue covers it; also pull pending on every SW boot, not only on push (belt and braces, and it's the deliver-on-reconnect path anyway).
7. **Firefox event pages ignore WS/timer/fetch activity for idle purposes** — only WebExtension API events reset the clock. Design the Firefox extension around alarms + event listeners, never around "the socket keeps us alive."

## 7. How to re-run

```bash
cd spikes/transport
npm install
node relay/server.js &                      # relay on :8080 (VAPID keys in relay/vapid.json)
N_WARM=8 N_COLD=6 node driver/run-chrome.js # loads ext into branded Chrome via CDP, prints table, writes results.json
# Firefox legs:
bash firefox/run-probe.sh                   # push-API probe -> probe-firefox.json
node relay/fx-relay.js &                    # fallback relay on :8081
node driver/run-firefox-fallback.js         # WS latency + lifecycle -> fx-lifecycle.json
```
