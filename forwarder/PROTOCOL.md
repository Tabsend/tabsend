# Tabsend wake-up forwarder — protocol

**Status:** design of record for `@tabsend/forwarder`, written before the implementation and
kept in step with it.
**Implements:** [`docs/HOSTED_PLAN.md`](../docs/HOSTED_PLAN.md) §6 (the wake-up forwarder,
its abuse contract, and the Apache-2.0 publication ruling) and
[`docs/PLANS.md`](../docs/PLANS.md) P-5 option 1 (the design constraints at the end of that
section).
**Relates to:** ADR-0009 §3 (a secret rides the fragment so it never reaches a server log —
the same instinct forbids wake tokens in URLs here), ADR-0015 (Android is push-less by
default) and ADR-0034 (an Android build with Google push is rung through this service too,
via FCM), ADR-0005 (the relay is a blind pipe; this service is blinder still).

---

## 1. What this service is

One HTTP service that holds the project's APNs key and Google push credential and rings
phones on behalf of **any** Tabsend relay, hosted or self-hosted. A relay that wants a phone
woken calls it; it tells Apple or Google "ring device Y"; the phone wakes and fetches from
**its own relay**.

The whole trust story is one sentence, and it has to stay literally true:

> Your data stays on your relay. We only ring the doorbell.

So the forwarder has no idea what any relay is holding, who the user is, or what arrived. It
learns that a device was woken, and when. Never what. §5 states that cost precisely, because
a promise this narrow is worth nothing if the metadata it does keep is left vague.

**One service, called the same way by every relay.** The hosted relay gets no private key,
no shortcut path, and no extra endpoint. It differs from a relay in someone's flat by one
configured URL and nothing else. That is what keeps `HOSTED_PLAN.md` §2.1's no-fork promise
true for iOS rather than true-except-iOS.

### What it is not

- Not a queue. Nothing is stored to be delivered later. A wake either goes to Apple or
  Google now or does not happen.
- Not a message path. No request or response body ever carries user content, and there is no
  field in which content could be smuggled: the wake request carries a token and nothing
  else.
- Not an account system. There is no signup, no email, no password, no session. A phone
  app registers a device and gets a token back; that is the entire enrolment story.

---

## 2. The three parties and what each one holds

| | Holds | Learns |
|---|---|---|
| **Phone app** | its wake token; its APNs device token or FCM registration token | everything, it is the user |
| **The user's relay** | the wake token, handed to it at pairing | that this endpoint can be woken |
| **The forwarder** | APNs or FCM device token, hash of the wake token, counters | that some device was woken, and when |

Apple and Google are a fourth party, outside this table because nothing here can change
what they see: the device's push address, and that it was rung and when. Never what, since
the push they deliver is empty.

The wake token is minted by the forwarder, given to the app, and handed by the app to its
own relay. Not the reverse: the relay never talks to the forwarder about registration, so
the forwarder never learns which relay a device belongs to except by the IP that rings it.

---

## 3. API

Four routes. Bodies are JSON; responses are JSON except where noted.

### 3.1 `POST /v1/register` — mint or replace a wake token

**Caller:** the iOS or Android app, directly. **Auth:** none.

```jsonc
// request — an iPhone
{ "apnsToken": "<hex device token from Apple>", "environment": "production" }
// request — an Android phone
{ "fcmToken": "<registration token from FirebaseMessaging.getToken()>" }
// response 200, identical either way
{ "wakeToken": "<43-char base64url>" }
```

**Exactly one address per registration.** Both together is `400`, neither is `400`. One
field per provider rather than a `platform` discriminator beside a generic `token`, for two
reasons: the iOS body above is unchanged from before Android existed, and a field that names
its own provider cannot be sent with the wrong platform beside it.

`environment` is optional, applies to Apple only, and is `production` or `sandbox` (a
development build of the app gets a sandbox token from Apple, and Apple's two environments
do not share device tokens). It selects between two fixed Apple hostnames and nothing else;
there is no caller-supplied host anywhere in this service. Google has no equivalent split —
one Firebase project serves debug and release builds alike — so an Android registration
ignores the field.

**A forwarder refuses the provider it cannot reach**: `501 unsupported` when an Android
phone registers at a forwarder with no Google credentials, or an iPhone at one with no Apple
credentials. Refused rather than accepted, because the alternative is a phone that believes
it is set up and never rings — the failure §10 exists to prevent. This is the one error code
that is about the deployment rather than the request, and it says nothing about any token,
so §4's oracle argument does not reach it. Since 2026-10-20 an Android phone also gets `501`
while the forwarder's last attempt to get an access token from Google failed (a deleted or
wrong key, a skewed clock): until then such a forwarder signed phones up that it could not
ring, which is worse than refusing them (`docs/SECURITY_REVIEW.md` G13). It takes them again
as soon as an exchange succeeds.

**A forwarder that holds `MAX_DEVICES` phones answers `503 unavailable`** to a phone it does
not already hold [2026-10-20, G16]. A phone already registered can always register again,
since that replaces its own row. Without a ceiling a flood of sign-ups for invented
addresses, which are never rung and so never cleaned up, grew until the disk the forwarder
shares with a relay was full. A Google token is at most 512 characters for the same reason
(it was 1024). Both refusals are about the deployment; the one thing a full table tells a
caller is whether a push address it already holds is registered, and holding the address
already lets it register it.

**A nearly full table is trimmed** [2026-10-20], so a flood cannot hold it full for good:
once an hour, on a fixed schedule, a table at 95% of `MAX_DEVICES` or more loses its oldest
rows that were never rung, down to 90%. Nothing is removed below 95%, whatever its age:
neither app signs up again on a schedule (an iPhone or an Android phone registers when it
pairs and when Apple or Google gives it a new push address), so a removed row is a phone
unrung until it pairs again, with nothing to tell it. Real phones are at risk only while a
flood is filling the table, and then only those never rung. On the timer rather than at a
sign-up, so no sign-up is sometimes slower for paying for it.

**Not cleaned up at all: the row of a phone that was rung and whose relay then went
away.** Telling that apart from a phone whose relay is only quiet needs the apps to sign
up again on a schedule, which they do not (`docs/SECURITY_REVIEW.md`, G26).

**Registering a device token that is already known REPLACES its wake token.** The old one
stops working the instant the new one is minted, in the same transaction. This is the
mechanism behind two things `HOSTED_PLAN.md` §6 asks for at once: a leaked token rings
exactly one phone *until that phone notices*, and a phone that reinstalls or re-pairs is
never stuck with a token someone else has seen. The provider's device token is the identity
here because it is the only stable thing the forwarder legitimately holds.

The same rule means **whoever holds a phone's device token can cut that phone off and ring
it**: registering it retires the phone's real wake token and returns a new one. The phone,
Apple and Google hold device tokens anyway; the forwarder's own store is the one place a
list of them could leak from, so it keeps them encrypted under a key held outside the
database (§5) [2026-10-02].

Rate limited per caller IP (§6). No route reveals whether a device token was already known:
the response shape is identical for a first registration and a replacement.

### 3.2 `POST /v1/wake` — ring one device

**Caller:** any relay. **Auth:** the wake token, in the `Authorization: Bearer <wakeToken>`
header. Empty JSON body (`{}`), or no body at all.

```jsonc
// response 202, always
{ "status": "accepted" }
```

The forwarder looks up the token hash, and if it finds a live device sends APNs a background
push:

| APNs field | Value | Why |
|---|---|---|
| `apns-push-type` | `background` | It is not a notification. Nothing is shown to the user. |
| `apns-priority` | `5` | The priority Apple requires for background pushes. |
| `apns-topic` | the app bundle id (`io.tabsend.app` by default) | Apple's addressing. |
| `apns-expiration` | now + 300s | A doorbell that stops ringing after five minutes. Past that, drain-on-open is the honest answer anyway. |
| `apns-collapse-id` | `wake` | Repeated rings collapse into one at Apple. Idempotence, belt and braces. |
| payload | `{"aps":{"content-available":1}}` | The whole payload. There is no room in it for content, by construction. |

For an Android row the same ring goes to FCM's HTTP v1 API instead
(`POST /v1/projects/<project>/messages:send`):

| FCM field | Value | Why |
|---|---|---|
| `data` | `{"wake":"1"}` | The whole payload. A message must carry something; this says only "wake up". |
| *(no `notification`)* | — | Its absence is what makes the push silent. With one, Android would draw it itself. |
| `android.priority` | `high` | The only priority that reaches a dozing phone. Normal may be held until the device wakes for its own reasons, which is the delay this path exists to remove. |
| `android.ttl` | `300s` | The same five-minute doorbell as Apple's expiration. |
| `android.collapse_key` | `wake` | Undelivered rings coalesce at Google, as they do at Apple. |

**Replays are harmless by construction.** There is no payload to replay, and ringing a
doorbell twice is ringing a doorbell. The collapse id (Apple) and collapse key (Google) make
both providers agree.

**Nothing on the wire says which provider answered.** A relay holds a wake token and posts
to `/v1/wake`; the platform is a column in this service's own table. That is what let Android
be added without a wire change on either side of the relay.

**202 means accepted, not rung.** The reply goes out before the token is even looked up;
everything else — the lookup, recording the wake, the call to Apple or Google — is
dispatched after it, at a random point in the next half second, and never holds the
response open. 202 is the correct code for exactly that, and §4 explains why waiting would
be worse than pointless.

**202 is the ONLY success answer, and a caller should treat every other status as a
failure — including a 2xx one, and including a redirect.** A relay that accepted any 2xx
would read a `WAKE_FORWARDER_URL` pointing at a health page or an unrelated service as a
working doorbell, and go on reporting delivered wakes while no phone rang. One that
followed a 3xx would count a 202 from whatever answered at the far end, which never rang
anything either. `server/src/push.ts` requires 202 exactly and does not follow redirects,
for those reasons.

**A token over its per-device limit (§6) is answered 202 as well, and simply not rung.**
§4 explains why that limit must not answer differently.

**The response is 202 whether or not the token is known.** See §4.

### 3.3 `POST /v1/revoke` — retire a wake token

**Caller:** the phone app, on unpair. **Auth:** the wake token in `Authorization: Bearer`.

```jsonc
// response 200, always
{ "status": "ok" }
```

The row is deleted, after the reply is written (§4). Unknown or already-revoked tokens get
the same 200 and the same body, for the same reason as §4. Nothing waits on the delete. An
iPhone revokes once, best effort; an Android phone keeps the token queued and asks again
until it gets a 2xx (since 2026-10-02), which every well-formed token gets, so the answer
still says nothing about the token. A revoke cut off by a crash leaves a token that rings
a phone with nothing to fetch, exactly as a forwarder that was down would.

Revocation is why this service is not the sealed-stateless-token design an earlier sketch
imagined. A self-contained signed token cannot be withdrawn without a revocation list, and a
revocation list is a store — so the store may as well be the token record itself, which is
smaller and easier to reason about. §5 argues that keeping it does not cost the "stateless"
intent anything that intent actually meant.

### 3.4 `GET /healthz` — liveness

**Auth:** none.

```jsonc
{ "status": "ok", "version": "0.7.0", "uptimeSeconds": 1234 }
```

Deliberately says nothing else. Device counts and wake tallies are operator business and go
to the log, not to an unauthenticated route: a public counter of registered devices is
metadata about the user base that no caller needs.

---

## 4. The unknown-token decision

**Every well-formed wake and revoke gets the same response, whether the token is live,
never-existed, or revoked minutes ago: 202 (wake) or 200 (revoke), same body, and the same
work done before the reply.**

The alternative — 404 for an unknown token — turns `POST /v1/wake` into a **token-validity
oracle** for anyone on the internet. That matters more here than the size of the endpoint
suggests. Wake tokens are the forwarder's only credential, they are held by a relay whose
security posture the project does not control, and a prober who can distinguish live from
dead tokens can confirm a leaked one, or enumerate for live ones, without ever ringing a
phone he was going to ring anyway. Uniform responses plus the §6 limits mean a prober learns
nothing from a probe, so probing has no product.

The cost is real and worth stating: **a relay cannot tell the difference between "I rang the
doorbell" and "the token you gave me is dead".** That is accepted, because the relay must
treat a wake as best-effort regardless (§7) and a dead wake token degrades to exactly the
behaviour of no forwarder at all. The device notices its own revocation the way it notices
everything else, by being re-registered at the next pairing.

Two corollaries, so this is not quietly undone later:

- **The rate limits must not become the oracle either.** A known and an unknown token
  consume the same buckets, in the same order, and the per-device bucket never answers at
  all: a token over its limit gets the same 202 as any other and is simply not rung.
  It used to answer 429 with a `Retry-After`, and because the relay that legitimately
  rings a phone draws on the same bucket, a prober holding a leaked token could read in
  that answer that the token was live, in use, and roughly when its relay had last rung
  it [revised 2026-10-01]. The per-caller bucket still answers 429: it is the caller's
  own, and says nothing about any token.
- **Provider outcomes never reach the caller.** An APNs 400, a 410 for a dead device token,
  a Google `UNREGISTERED`, and a total outage at either provider all still answer 202.
  Otherwise an outage would flip the response for
  live tokens only, which is the oracle again, wearing a hat. The operator reads outcomes in
  the log; the relay never needed them.
- **The clock must not become the oracle either.** Nothing Apple says reaches the caller,
  so nothing is gained by waiting for it, and one thing is lost: a wake that awaited Apple
  would answer a live token in however long Apple took while answering an unknown one
  immediately. That is the same distinction this section spends its length denying, handed
  over to anyone with a stopwatch and no need to ring a real phone at all. **Everything
  that depends on which kind of token it was is therefore dispatched after the reply, not
  before it** — the store lookup, the wake tally, the APNs or FCM call, and the log line
  for an unknown token alike, and on revoke the delete and its log line [revised
  2026-10-01, and on 2026-10-02 for the lookup, which now decrypts a live row's address
  (§5)]. Before the reply, every well-formed wake does the same thing: hash the token and
  charge the two rate-limit buckets.

  Detaching the APNs call alone is **not** enough, and the first version of this only did
  that. A live token still paid, before its 202, for the `recordWake` write and for
  whatever the sender does synchronously before its first await: opening an HTTP/2 session,
  signing an ES256 JWT, building the request. An unknown token returned from the lookup
  having done none of it. `app.ts` schedules the whole branch on a macrotask (a timer, or
  `setImmediate` when the delay below is zero), so the reply chain drains first — and
  `forwarder/test/wake.test.ts` asserts
  the ordering at the moment the reply's bytes reach the socket, with an `onSend` hook
  in the chain that holds the write back by fifty microtask turns. Any deferral built
  from promises or `queueMicrotask` runs ahead of that write and fails the test; both
  were tried. (The first version marked the reply in an `onSend` hook, which runs
  before the write and could not tell the difference.) What the tests cannot model is
  a plugin whose `onSend` does real async I/O, compression for example: that would delay
  the write past even a macrotask. The forwarder registers no such hook, and adding one
  would reopen this.

  **The busy time after the reply, and what is done about it [revised 2026-10-02].** The
  deferred work still runs on the one event loop, so a request that arrives while a live
  token's ring is being set up waits that long. This section used to call that tens of
  microseconds, readable only with a great many samples. The 2026-10-02 review measured it
  (`docs/SECURITY_REVIEW.md`, G14): about 0.24 ms for an iPhone and, for an Android phone,
  0.6 ms, 1.4 to 1.6 ms when Google's access token was refreshed, and about 3 ms on a new
  TLS connection, which most Android rings needed. Probing `/healthz` straight after a
  wake told live from dead, and Android from iPhone, in a handful of samples. Five changes
  answer it:

  - **Nothing before the reply depends on the token**, the lookup included (above).
  - **The work starts at a random point in the next 500 ms** (`RING_DELAY_MAX_MS` in
    `app.ts`), for wakes and revokes alike, so a probe cannot be lined up with it. Half a
    second is nothing to a doorbell; Apple and Google take longer to deliver.
  - **A ring touches no disk.** The wake tallies are counted in memory and written once a
    minute (§5), every minute, whether or not anything rang. The write itself is small
    (SQLite here does not sync to disk on each commit); it moved because it was work
    only a live token caused.
  - **Google's access token is refreshed on a timer**, from start-up, five minutes before
    it expires, never by whichever ring found it stale (§9.2).
  - **The Google connection is always open**: one HTTP/2 session, opened at start-up,
    checked with a PING every two minutes and reopened in the background whenever it
    closes, so no ring pays for a new one (§9.2). `fetch` dropped the connection after
    four seconds idle. The first fix closed it after four idle minutes instead, and the
    verification pass showed that was not enough: a prober who spaced its rings more than
    four minutes apart got a new connection on every live ring, about 4 to 5 ms of extra
    work, and told live from dead from outside at p = 0.016 to 0.049 in 60 rings.

  Measured again on 2026-10-02, on a laptop with interleaved runs of the old and the new
  build against local fakes of Apple and Google. The laptop was heavily loaded, which
  inflates every figure, so they are for comparing with each other, not with the review's.
  The CPU time one wake costs the forwarder, unknown token / iPhone / Android phone
  (medians of 12, two rounds), went from about 3.0 / 7.6 / 14.6 ms to about 4.0 / 6.4 /
  6.5 ms: a live token now costs about 2.5 ms more than a dead one on either platform,
  where it cost 4 to 5 ms (iPhone) and 11 to 12 ms (Android). From outside (worst
  `/healthz` delay after a wake, 20 samples each), the old build told an Android phone
  from a dead token at p = 0.007 (medians 11.2 against 4.7 ms) with a 40 ms window; the
  new one, probed over a 560 ms window that covers the delay, told neither an Android
  phone (p = 0.21) nor an iPhone (p = 0.39) from a dead token. At that load the iPhone's
  smaller difference was already hidden in the old build too. The verification pass
  repeated the outside probe with 60 rings each against an open connection (p = 0.43 and
  0.72) and measured the CPU difference there at 1.3 to 1.8 ms.

  **What it still does not hide: the total.** The delay moves the work, it does not
  remove it. A prober close to the forwarder, on a quiet machine, adding up the busy time
  over the whole window could still accumulate a live token's extra work over enough
  samples, and the delay gives the most cover when other traffic is there to hide in.
  Every sample rings the victim's phone, and the per-device limit allows six a minute.
  One rarer case is in the same spirit: after Apple or Google closes the connection, a ring
  that comes in the pause before the background reconnect (one to thirty seconds) opens
  one itself. A prober cannot cause that, but could be lucky. That residual is accepted and stated here rather than claimed away. The Apple sender opened
  its connection on a ring until 2026-10-20; it now keeps it open as the Google sender
  does (`docs/SECURITY_REVIEW.md`, G25).

  This also removes a mismatch that was operationally silly on its own: a relay gives up on
  the doorbell in about three seconds, while the APNs call is allowed five, so the last two
  seconds of every slow ring were spent holding open a connection nobody was listening on.

Malformed input is different and is refused normally: a missing token, or one that is not
43 base64url characters, gets a 400 with an actionable message. That leaks nothing about
which tokens exist, and refusing garbage before touching the store is what makes a wake
cheap to refuse.

---

## 5. What is stored, and why "stateless" survives it

Two SQLite tables: the devices, and a small `meta` table holding the key check (below),
the time of the last tally write, and, while a migration's clean-up is unfinished, a
marker for it. That is the whole persistent state of the service.

```sql
CREATE TABLE devices (
  wake_token_hash  TEXT PRIMARY KEY,     -- base64url(sha256(wakeToken)). Never the token.
  platform         TEXT NOT NULL,        -- 'ios' | 'android'. Which provider rings this row.
  device_token_mac TEXT NOT NULL UNIQUE, -- HMAC of the doorbell address, under the key
  device_token_enc TEXT NOT NULL,        -- the doorbell address, AES-256-GCM, same key
  environment      TEXT NOT NULL,        -- 'production' | 'sandbox'. Apple only.
  created_at       INTEGER NOT NULL,     -- ms since epoch, when this token was minted
  last_wake_at     INTEGER,              -- ms since epoch, or NULL until first ring
  wake_count       INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);  -- key check, tally time
```

Schema version 3 [2026-10-02]. Version 1 was iOS-only (`apns_token`, no `platform`);
version 2 renamed the column and defaulted `platform` to `'ios'`, which is correct because
every row that existed under version 1 was an iPhone. Version 3 replaced `device_token` with
the two keyed columns, in one transaction that drops the old table with `secure_delete` on,
so the pages it frees are zeroed as they are freed. The transaction also leaves a marker,
and while it stands the forwarder rewrites the file (`VACUUM`) and empties its WAL, at every
start and every once-a-minute flush, until that has completed; a reader holding the file
open, a stop part-way, or a full disk only delay it. So no clear-text address stays in the
file for good. A fresh file and an upgraded one end identically.

The file is created readable by its owner only (0600), and an existing one is tightened to
that at start-up. SQLite gives the `-wal` and `-shm` files the same permissions.

Field by field, with the reason each one has to exist:

- **`wake_token_hash`, not the token.** The forwarder never needs to reproduce a wake token
  after minting it, only to recognise one, so it keeps a SHA-256 and discards the original.
  No wake token can be read out of this database. (No salt and no slow KDF: the input is 32
  bytes of `randomBytes`, which is not guessable by any amount of hashing effort, and a slow
  hash on the wake path would make the doorbell expensive to answer.)
- **The doorbell address, under a key held elsewhere** [2026-10-02]. The honest centre of
  §5's cost. The forwarder must present this exact string to Apple or Google to ring the
  phone, so it cannot be hashed away; and it is the one thing in this table worth stealing,
  because the replacement rule of §3.1 lets whoever holds an address retire that phone's
  real wake token and get one that rings it. Until 2026-10-02 it was stored in the clear,
  so a copy of the database, or of a backup, let its holder cut off and ring every phone,
  which this section used to deny (`docs/SECURITY_REVIEW.md`, G15). Now two columns
  replace it, both keyed from `DEVICE_TOKEN_KEY` (§10), which the operator keeps with the
  other secrets and out of the database and its backups:
  - `device_token_mac`, an HMAC-SHA256. Deterministic, so it carries the `UNIQUE` that *is*
    the replacement rule: one device, one live wake token, enforced by the database rather
    than by remembering to. Without the key it cannot be reversed or checked against a
    guess.
  - `device_token_enc`, the address under AES-256-GCM with a fresh nonce, bound to its MAC.
    Read only after a wake's reply (§4).

  The forwarder refuses to start with a key the file was not written with: with the wrong
  key it could ring nobody. **What this does not cover:** someone with the key as well as
  the file can still do what a copy used to allow. That person has the forwarder's
  environment, which holds the Apple and Google credentials too. A proof-of-possession step
  at sign-up would close even that, at the price of a wire change on both phones; ADR-0034's
  2026-10-02 amendment records why it was not chosen.
- **`platform`.** Which provider to call. Two values, and the only reason the column exists:
  Apple and Google are reached over different protocols. It never leaves this service — the
  wire contract between a relay and the forwarder names no platform at all.
- **`environment`.** Which Apple host to call. Two values, meaningless for an Android row and
  stored as the forwarder default there.
- **`created_at`, `last_wake_at`, `wake_count`.** Enough for an operator to answer "is this
  service being abused" and "is anything still using it" without per-request records. This
  is the deliberate *stopping point*: no per-wake row, no history, no relay identity, no IP.
  A wake overwrites `last_wake_at` and increments a counter, so the hundredth ring leaves
  exactly as much trace as the first. The two are counted in memory and written once a
  minute, so a ring itself never waits on the disk (§4).

**Why this still honours the plan's "stateless" intent.** `HOSTED_PLAN.md` §6 and P-5 both
say "stateless", and both are arguing for one thing: that the forwarder cannot become a
place where user data accumulates. Read as "holds no rows", it is unimplementable — a
revocation that cannot be recorded is not a revocation, and §6's own abuse contract *requires*
revoke-on-unpair and replace-on-re-register. Read as what it defends, it is fully satisfied
here:

| The intent | How this design keeps it |
|---|---|
| No accounts | There is no user, no email, no login, nothing that survives a device. |
| No content, ever | No route accepts content. Neither provider's payload has a field for it. |
| No queues | Nothing is stored for later delivery. A wake happens now or not at all. |
| Nothing to subpoena but the doorbell | The store holds an encrypted address and three counters per device. |

So: not "no state", but **no state beyond the doorbell address**. That is the promise this
service can actually keep, and it is the one written on the tin.

### The metadata cost, stated verbatim

The following sentence appears in `README.md` and here, identically, and is the wording to
reuse wherever the forwarder is described:

> The forwarder learns that a device received something, and when. Never what.

---

## 6. Abuse contract

A wake is a doorbell. More than a few rings a minute is abuse, not traffic.

| Limit | Key | Default | Why |
|---|---|---|---|
| Wakes per token | SHA-256 of the presented token | 6 / 60s | One phone cannot need more. Bounds what a leaked token can do to one person's battery. Over it, a wake is answered 202 and not rung (§4). |
| Wakes per caller | client IP | 120 / 60s | Bounds a hostile or broken relay, and the enumeration described in §4. A hosted relay is one caller for all of its tenants, so size this to the relay's phones, Android phones included (`CALLER_RATE_LIMIT_MAX`, §10). |
| Registrations per caller | client IP, an IPv6 address by its /64 | 10 / 600s | Registration is the only route that writes a new row. A /64 is what one subscriber or one server is normally given, so keyed per address one connection had 2^64 allowances (`docs/SECURITY_REVIEW.md` G16). The two wake limits keep the whole address: some hosts put several customers' servers, and so several relays, in one /64, and a wake writes nothing. |

Fixed-window, in-memory, per-process, and keyed by caller address, which is therefore
held until a timed sweep finds its window closed, within two windows of the last call
(§8). The forwarder is a single-instance deployment; if
that ever stops being true these move to a shared store, and until then a `Map` is the
dependency-free fit. (The relay made that move in [0030], and its limiter now lives in its
database. This one has not, because the forwarder's SQLite file sits on the same machine as
the single process that owns it: counters there would be no more shared than the `Map`, and
slower.) Both wake buckets are consumed on every wake in the same order
regardless of whether the token resolves, per §4.

**The `Map` is bounded, and not by luck.** The per-token bucket is keyed by the hash of
whatever token the caller presented, and it is charged before the store is consulted, so a
prober mints a key nobody will ever present again on every single request. Buckets whose
window has closed are therefore swept in full on a fixed interval of hits, rather than
being tidied only when their own key comes back. What the process holds is the keys of one
open window plus at most one sweep interval of newcomers, whatever a prober does.

Behind a proxy, set `TRUST_PROXY=1` or every caller shares one bucket. The per-caller key is
the client IP and not a relay-declared identifier, because an unauthenticated relay could
simply declare a fresh one per request.

`HOSTED_PLAN.md` §6's other abuse-contract items land as follows:

- **Token scoped per device.** One row, one phone. A leaked token rings that phone and no
  other, and re-registering ends it.
- **Revoked on unpair.** §3.3.
- **Replaced on re-register.** §3.1, enforced by the `UNIQUE` constraint.
- **Replay-safe.** §3.2. No payload, collapse id, same limits absorb the repeats.
- **The APNs key rotates server-side without touching any device.** Wake tokens are the
  forwarder's own, not Apple's, so the key behind them is an implementation detail. Rotation
  is: put the new `.p8` where the config points, restart. No device re-registers, no relay
  reconfigures, nothing in the store changes.

### Secrets in URLs: never

**A wake token travels in a header or a JSON body. Never in a path, never in a query
string.** URLs are logged by proxies, kept in browser and shell history, and forwarded in
`Referer` headers, which is exactly why ADR-0009 §3 put the pairing secret in the link
fragment. The same reasoning binds every route here, and the shape of the API enforces it:
no route has a path parameter at all.

One asymmetry to name rather than hide: **Apple's** API takes the device token in the path
(`POST /3/device/<token>`). That is Apple's protocol, over TLS to Apple, and not ours to
change. The forwarder never logs that URL.

---

## 7. Degradation contract

**When the forwarder is down, delivery degrades to exactly the pre-forwarder behaviour:
drain-on-open.** Nothing is lost, because nothing was ever in the forwarder to lose — the
message is sitting in the user's own relay, which is where it was going to be fetched from
anyway. The phone gets it the next time it opens, or the next time a wake succeeds. *(One
exception since ADR-0034: an Android phone on Google push has closed its own connection,
which was its pre-forwarder behaviour, so it falls back to polling every few minutes
instead. Recorded in `docs/SECURITY_REVIEW.md`, the 2026-10-02 review.)*

This binds the relay side, which is a separate piece of work:

- **A relay treats a wake as best-effort and never lets it fail a send.** A wake that times
  out, 429s, or hits a connection error is logged and dropped. It never turns into a failed
  send, a rejected item, a retry storm, or a user-visible error. `SendResponse` does not
  learn a new rejection reason for it, because a send that reached the relay succeeded.
- **`WAKE_FORWARDER_URL` unset means today's behaviour, unchanged.** No wake, drain on open,
  no warning beyond the ordinary.
- **Timeouts are short.** A doorbell nobody answers must not hold a send path open.

---

## 8. Logging

IDs, timestamps, and sizes. That is the whole permitted vocabulary, per
`HOSTED_SECURITY_PLAN.md`'s control-plane gates ("logs and traces contain IDs and aggregate
sizes only — never tokens").

- **A wake token never appears in a log line, in any form.** Not at debug level, not in an
  error, not in a stack. Where a log line needs to distinguish one device from another it
  carries `tokenRef`: the first 8 characters of the token's SHA-256. Enough to correlate two
  lines, useless for reconstructing the token.
- **A device token never appears either**, from either provider. Same rule, same reason. The
  Android half is asserted the same way: a test drives a full Android register/wake cycle and
  fails if the FCM registration token shows up in any line.
- There is nothing content-shaped to leak, because no route accepts content. This is stated
  anyway, so a future route that wants to accept something has to argue with it.

- **A caller's address never appears either** [2026-10-02]. Fastify's default request log
  wrote each caller's address and port under the same request id as the `tokenRef` lines,
  so the log kept a history of rings with relay and phone addresses, which §5 says nothing
  here keeps (`docs/SECURITY_REVIEW.md`, G7). That log is off, and the serializers drop
  addresses, ports and query strings from any request object a line includes, and reduce
  an error to its name, message, code and stack.

A test asserts the first bullet directly: it captures every log line emitted during a full
register/wake/revoke cycle and fails if any of them contains the token. Another drives a
full cycle, refusals included, through a trusted proxy with documentation-range addresses
and fails if any line holds an address.

**What the process holds in memory, and for how long.** The rate limits of §6 are keyed by
the caller's address, so the process holds the addresses that called it recently: each is
dropped by a sweep that runs once a window, so within two windows of its last call (two
minutes for wakes and revokes, twenty for registrations), whether or not anyone else calls
(until 2026-10-02 the only sweep ran every 512 calls, so a quiet forwarder kept its last
callers' addresses for days). Never written to disk, never logged, gone at restart. The
wake tallies of §5 are held for up to a minute before they are written. (The log does
carry other addresses: the forwarder's own, in Fastify's start-up line, and Apple's or
Google's, in the reason a failed connection gives. Never a caller's.)

---

## 9. Provider authentication

### 9.1 APNs

Token-based (JWT), not certificate-based. A `.p8` key from the Apple developer account,
identified by a key id and a team id, signs a short JWT that goes in the `authorization`
header of each APNs request.

- **ES256, signed with `node:crypto` alone.** No JWT library. The signature is
  `sign('SHA256', …, { dsaEncoding: 'ieee-p1363' })`, which is P-256 ECDSA in the raw
  `r || s` form JOSE requires — the only fiddly part of the format, handled by a flag.
- **The JWT is cached and refreshed every 45 minutes.** Apple rejects tokens older than an
  hour and rejects a client that mints them more often than every 20 minutes, so anything in
  the middle works; 45 minutes leaves margin on both sides.
- **The key never leaves the forwarder.** It cannot be given to self-hosters (P-5: it is not
  per-user, and anyone holding it could notify every Tabsend user). That single fact is the
  whole reason this service exists rather than being a relay feature.
- **HTTP/2 via `node:http2`**, because APNs speaks nothing else. One kept session per
  environment, handled exactly as Google's is below (`src/h2-session.ts`): both are opened
  at start-up and kept open with a PING every two minutes and replaced in the background
  when they close. At most `APNS_MAX_IN_FLIGHT` rings (64) wait on Apple at once.
  Rings on a new connection wait for Apple's settings. Until 2026-10-20 the connection was
  opened on a ring and its streams sent at once, which lost every ring past the few Apple
  takes before its settings arrive (fifty at once against a limit of two delivered two;
  `docs/SECURITY_REVIEW.md` G25). No HTTP client dependency.
- **The credential is checked once at start-up** [2026-10-20]: one ring to an invented
  device (64 zeros), read as `ok` on `400 BadDeviceToken` and as refused on a `403`,
  logged as one `apns credential check: …` line (README, "Running your own"). Apple does
  not document the order it checks a request in, so `ok` is what is observed, not what is
  promised.

### 9.2 FCM

A Firebase **service-account JSON**, which already carries the project id, the client email
and the private key — so unlike Apple's bare `.p8` there is one secret to configure and
nothing to keep in sync beside it.

- **RS256, signed with `node:crypto` alone.** No JWT library and no `googleapis` dependency,
  for the same reason as Apple's.
- **One extra hop Apple does not have.** Apple accepts the signed JWT directly as its bearer
  token; Google makes you EXCHANGE it for an access token at `oauth2.googleapis.com/token`
  first. So the Google path makes a network call to refresh and holds the token it is given
  for the hour Google grants. Since 2026-10-02 it exchanges at start-up and then on a
  timer, five minutes before expiry, with back-off when Google refuses, so no ring pays for
  an exchange (§4); a ring exchanges for itself only when there is no usable token at all.
  Concurrent callers share one exchange rather than starting one each, and a failed
  exchange is not cached. Since 2026-10-20 (`docs/SECURITY_REVIEW.md` G13, G17): the key
  must be RSA, which is all Google accepts; a failed exchange starts a back-off (30 s,
  doubling to 10 minutes) that holds for rings too, so a ring inside it fails at once
  instead of signing and posting an assertion of its own; an empty token, or one with no
  lifetime, is never cached; a `401` on a send drops the token and fetches another at once,
  at most every 30 seconds; and the exchange follows no redirect and reads at most 64 KiB.
- **The credential never leaves the forwarder**, exactly as Apple's does not. The client
  values that ship inside the Android app (`google-services.json`'s project id, app id, api
  key and sender id) are not credentials and cannot send a push; this service holds the one
  thing that can.
- **HTTP/2 via `node:http2`, one session that is always open.** It was plain `fetch` until
  2026-10-02, which dropped an idle connection after four seconds, so most rings opened a
  new TLS connection after their reply (§4). Now the session is opened at start-up and never
  closed for being idle: a PING every two minutes keeps it, and when it closes (Google
  sends it away, or the network drops it) the next one is opened in the background after a
  random pause of one to thirty seconds, never on a ring. A reply is read up to 64 KiB and
  no further.
- **Bounded, and it backs off when Google asks** [2026-10-20, G17]. At most
  `FCM_MAX_IN_FLIGHT` rings (64) wait on Google at once; past that a ring is dropped at once
  rather than queued (600 rings against a stalled Google used to add 145 MB on a 1 GB
  machine). A `429` or `503` pauses every send for as long as its `Retry-After` says (at
  most an hour), or for a minute after a `429` and ten seconds after a `503` that says
  nothing; rings in the pause are dropped. A dropped ring is what a refused ring always
  was: the phone picks up when it next checks in or opens (§7).
- **A new connection's first rings wait for Google's settings**, inside their own deadline.
  Before those arrive Node assumes a server takes a hundred streams at once and sends that
  many, and a server allowing fewer refuses the rest (fifty rings at once against a limit
  of two lost forty-eight). Once the settings have arrived, Node queues streams past the
  limit itself.
- **A ring that gets no answer makes the sender doubt the connection.** One that never
  finished setting up is dropped at once; one that did is sent a PING and dropped unless
  Google answers within the same deadline, or after three rings in a row went unanswered
  regardless. So a connection that stalled or went silent cannot fail every ring that
  follows it, as it could while rings kept it from ever being idle.
- **Only `404 UNREGISTERED` proves a device is gone.** `400 INVALID_ARGUMENT` does not, and
  is deliberately excluded: Google gives it both for a malformed token and for a live token
  presented with a DIFFERENT project's credentials, and the answer does not say which. That is
  the same asymmetry that keeps Apple's `BadDeviceToken` out of the delete path — an operator
  pointed at the wrong Firebase project would otherwise unregister every working phone on its
  first ring. The row is kept and the operator is told the fix.

Dead device tokens clean themselves up: an APNs **`410`**, or a Google **`404 UNREGISTERED`**,
deletes the row. Apple is
authoritative about which of its device tokens still exist, it returns 410 when the app has
been removed from the device, and a doorbell address that no longer rings anything is not
worth keeping. The caller still gets 202 (§4).

**A `400 BadDeviceToken` does not delete anything**, though it reads like the same signal.
Apple returns it for a live token presented to the wrong environment just as readily as for
a token that is genuinely wrong, and the response does not say which. A Release build
signed with a development profile gets a sandbox token (see `ios/`'s `ApnsEnvironment`), so
a forwarder configured for production is told `BadDeviceToken` for a perfectly healthy
phone, on every wake, forever. Deleting on that answer would unregister that phone the
first time its relay rang it, with nothing shown to the user and nothing to notice: the
next wake would find no row and answer 202 like everything else. The asymmetry decides it.
A row kept in error is one stale address in a table; a row deleted in error costs the user
every wake until they happen to re-pair. So the row stays, and the operator gets a warning
that names the environment mismatch and says where to check.

---

## 10. Configuration

| Env var | Default | Meaning |
|---|---|---|
| `HOST` | `127.0.0.1` | Listen address. |
| `PORT` | `8788` | Listen port. Deliberately not the relay's 8787, so both run on one dev box. |
| `DATABASE_PATH` | `./.data/forwarder.db` | SQLite file, created owner-only. `:memory:` is accepted for tests. |
| `DEVICE_TOKEN_KEY` | — | Required. 32 random bytes as base64, from `openssl rand -base64 32`. Encrypts each phone's push address in the database (§5). Keep it with the other secrets, never beside the database file or in its backups. Changing it, or losing it, means every phone signs up again; the forwarder refuses to start with a key the file was not written with. |
| `DEVICE_TOKEN_KEY_PATH` | — | The same key read from a file. Exactly one of the two. |
| `APNS_KEY_PATH` | — | Path to the `.p8`. Exactly one of this and `APNS_KEY_PEM`. |
| `APNS_KEY_PEM` | — | The key inline, for a secret store that injects env rather than files. |
| `APNS_KEY_ID` | — | Required. The 10-character key id Apple shows next to the `.p8`. |
| `APNS_TEAM_ID` | — | Required. The 10-character Apple team id. |
| `APNS_TOPIC` | `io.tabsend.app` | The app bundle id. |
| `APNS_DEFAULT_ENVIRONMENT` | `production` | Used when a registration omits `environment`. |
| `APNS_TIMEOUT_MS` | `5000` | Per-request ceiling on the Apple call. A whole number from 100 to 60000. |
| `APNS_DRY_RUN` | off | Run with no Apple key at all: every wake is accepted and dropped. Local development only. |
| `FCM_SERVICE_ACCOUNT_PATH` | — | Path to the Firebase service-account JSON. Exactly one of this and `FCM_SERVICE_ACCOUNT_JSON`. Absent ⇒ this forwarder refuses Android registrations with `501`. |
| `FCM_SERVICE_ACCOUNT_JSON` | — | The same credential inline, for a secret store that injects env rather than files. |
| `FCM_TIMEOUT_MS` | `5000` | Per-request ceiling on the Google call. A whole number from 100 to 60000. |
| `FCM_MAX_IN_FLIGHT` | `64` | Android rings allowed to wait on Google at once (§9.2). |
| `APNS_MAX_IN_FLIGHT` | `64` | iPhone rings allowed to wait on Apple at once (§9.1). |
| `FCM_DRY_RUN` | off | Run with no Google credential: every Android wake is accepted and dropped. Local development only. |
| `TRUST_PROXY` | off | Read `X-Forwarded-For` for the per-caller rate-limit key. |
| `MAX_BODY_BYTES` | `4096` | Bodies here are one short string. A small cap is itself a guard. |
| `WAKE_RATE_LIMIT_MAX` / `WAKE_RATE_LIMIT_WINDOW_SECONDS` | `6` / `60` | Per token. |
| `CALLER_RATE_LIMIT_MAX` / `CALLER_RATE_LIMIT_WINDOW_SECONDS` | `120` / `60` | Per caller IP. |
| `REGISTER_RATE_LIMIT_MAX` / `REGISTER_RATE_LIMIT_WINDOW_SECONDS` | `10` / `600` | Per caller IP, an IPv6 address by its /64. |
| `MAX_DEVICES` | `200000` | Phones held at most (§3.1). About 1.2 KB of disk each at the longest token. |
| `LOG_LEVEL` | `info` | Fastify/pino level. |

**At least one provider must be configured, and partial credentials are still refused.** A
forwarder whose whole job is ringing must not start able to ring nobody, so booting with
neither Apple nor Google credentials (and neither dry-run flag) fails with the fix in the
message. The generalisation for Android does not weaken that: setting *any* `APNS_` variable
commits you to a complete Apple set, so a typo'd `APNS_KEY_PATH` fails exactly as it did
before, and the only way to have no Apple credentials is to set no Apple variables at all.
A forwarder may legitimately serve one platform; it then refuses the other at registration
(§3.1) rather than accepting rows it could never ring.

Configuration is validated at boot by a pure `loadConfig(env)` that throws on anything
incoherent, the same shape as `server/src/config.ts`. A forwarder configured for neither
provider (no Apple key, no Google credential, and no dry-run flag) refuses to start, rather
than starting and silently ringing nobody: unlike the relay, whose push is one of several
delivery paths, ringing is the only thing this service does.

---

## 11. Open items

- **Nothing here has been run against real APNs.** Every APNs interaction is exercised
  against a fake. The JWT is verified cryptographically in tests, and the header set is
  written from Apple's documented requirements, but the first real `.p8` will be the first
  proof. Whoever does that should confirm the 200 path and the `410` cleanup path
  specifically, and should point a sandbox-signed build at a production forwarder once, to
  see §9's `BadDeviceToken` warning appear with the registration still in place.
- **Nothing here has been run against real FCM either** (ADR-0034). Since 2026-10-02 the
  real sender runs end to end in the tests against a local fake of FCM over TLS and
  HTTP/2, which proves the request and the error handling against Google's documented
  shapes, not against Google. Whoever first points this at a Firebase project should
  confirm the 200 path, the `404 UNREGISTERED` cleanup path, and what a token from a
  different project actually returns: the code treats `400 INVALID_ARGUMENT` as that case,
  Google's documentation names `403 SENDER_ID_MISMATCH`, and only `404 UNREGISTERED`
  deletes a row. See `docs/SECURITY_REVIEW.md`, the 2026-10-02 review.
- ~~**The relay side is not built here.**~~ Built 2026-08-20 (ADR-0032):
  `WAKE_FORWARDER_URL`, the `POST /v1/wake` call-out, and §7's best-effort discipline all
  live in `server/`, reached by a new `{transport:'forwarder', wakeToken}` push variant.
  A relay with no forwarder configured refuses that transport at registration rather than
  accepting it and never ringing, and advertises `wakeForwarder` on `GET /v1/config` so a
  client can pick its transport before it registers. §4's uniform 202 has one consequence
  worth repeating there: a wake failure is **always** transient to the relay and never
  marks a subscription dead, because nothing this service answers is evidence about a
  phone.
- ~~**The iOS side is not built here** either~~ Built 2026-08-20: registration at pairing,
  the token handed to the relay via the `forwarder` transport, best-effort revoke on
  unpair, and P-5's on-by-default posture with an explicit opt-out all live in `ios/`.
  What remains unproven is everything that needs Apple: no physical device, real APNs,
  or deployed forwarder instance has been part of any test yet (`docs/IOS_TEST_MATRIX.md`
  gates stay open, and PLANS.md P-9 records the silent instance-mismatch risk).
