# Security policy

Tabsend moves browser tabs between your own devices, end-to-end encrypted, over a relay that
is designed not to be trusted with the contents. If you've found a way to break that, this
page is how to tell the maintainer.

Please read [Scope](#what-is-in-scope) and [Out of scope](#what-is-out-of-scope) first. A
number of things that look alarming at first glance are documented, deliberate properties of
the design — most importantly, **the relay operator can see who sent what to whom and when.
That is a known property, not a vulnerability.**

---

## How to report

**Do not open a public GitHub issue for a security problem.**

Two private routes, either is fine:

1. **GitHub private security advisory** *(preferred)* — go to the
   [Security tab](https://github.com/Tabsend/tabsend/security/advisories) of the repository and
   choose "Report a vulnerability". This keeps the whole thread private, gives you a place to
   attach a proof of concept, and lets a fix and an advisory be published together.
2. **Email** — <contact@zinniadrive.com>, with `Tabsend security` in the subject line so it doesn't
   get lost.

There is **no PGP key** and no bug bounty. This is a one-person, pre-1.0 project with no
budget. Credit in the release notes and the advisory is offered gladly if you want it.

**What helps most in a report:** which component (relay, Chrome extension, Firefox extension,
Android app, iOS app, console, `shared/` contract), the version or commit, steps to reproduce, and what
an attacker actually gains. A working proof of concept — even a rough one — turns a maybe into
a definite far faster than a description does.

---

## What to expect from a solo maintainer

Tabsend is maintained by one person around a day job. Saying what's realistic is more useful
than promising something that won't happen.

- **Acknowledgement:** usually within a week. Not within 24 hours, and no SLA is offered.
  If two weeks pass with silence, send a follow-up — the first mail probably got buried.
- **Assessment:** typically within two weeks of acknowledging, saying whether it's accepted,
  what the severity looks like, and roughly when a fix is likely.
- **Fix:** serious problems get worked on ahead of everything else. Realistically that means
  days to a few weeks, not hours. Lower-severity issues may sit longer.
- **Disclosure:** coordinated, **90 days** as the default. If a fix will take longer, that
  gets negotiated with you rather than sprung on you. Publish sooner if it's already being
  exploited in the wild — tell the maintainer first if you can.

### Which versions get fixes

Tabsend is pre-1.0. As of the v0.7.2 release record, browser-store and production mobile
distribution are not evidenced. The public repository snapshot exists, but this repository
is the private source of truth. Only the current `main` branch and the most recent release
get security fixes. There is no backport policy and no long-term support branch.

The current repository security review is [`docs/SECURITY_REVIEW.md`](docs/SECURITY_REVIEW.md),
which reconciles the historical v0.5 review through v0.7.2 and the hosted groundwork. It is a code-and-release review, not
an independent penetration test or cryptographic audit.

---

## The security model, briefly

Understanding this makes it much clearer what counts as a bug. All of it is verifiable in the
code — the relevant files are named.

**The relay stores and forwards ciphertext, and performs no cryptography.** Content is sealed
by the sender to the target endpoint's public key using libsodium `crypto_box`
(X25519 + XSalsa20-Poly1305). The URL, page title and favicon all travel *inside* the
ciphertext. The relay cannot read them and holds no key that would let it.
See `extension/src/lib/crypto.ts`, `android/app/src/main/java/io/tabsend/app/crypto/`,
`ios/TabsendKit/Sources/TabsendKit/Crypto/`, and ADR-0005 in
[`docs/DECISIONS.md`](docs/DECISIONS.md).

**The relay also keeps an encrypted history, and that is a deliberate change to what it holds
at rest.** Since ADR-0028 a send carries one extra blob describing itself, sealed with
`crypto_secretbox` (XSalsa20-Poly1305) under a *group* key that every paired device holds and
the relay does not. Unlike a message payload, which is still deleted the moment its target
acknowledges it, this blob is retained on purpose — by default for 30 days — so that any of
your devices can answer "where did that tab go, and did it ever arrive". Set
`HISTORY_RETENTION_DAYS=0` to switch it off: the relay then accepts the blob and throws it away.
(Before 2026-10-13 it stored it anyway, for about 14 days with default settings.) Read
[`docs/DECISIONS.md`](docs/DECISIONS.md) ADR-0028 for why this was chosen over the simpler
option of letting the relay store URLs in plain text.

**There are no accounts.** A normal self-hosted relay creates its single group at startup. While
that group is empty, the relay prints a complete, single-use first-run pairing link with a
24-hour default lifetime. After the first endpoint joins, only a paired endpoint can mint the
complete 10-minute pairing links used by additional devices. The short code embedded in either
link is the secret credential and registration is rate-limited. Each endpoint then holds a
per-endpoint device token; the relay stores only its SHA-256 hash (`server/src/ids.ts`,
`server/src/db/schema.ts`). There is **no recovery phrase, key, or other standing credential**
that can later join an occupied group (ADR-0021, ADR-0023).

**Receiving clients verify the sender.** Before opening an envelope, a client checks that the
message's `senderKeyId` matches the public key of an endpoint currently in its group, and
drops the message if it doesn't. All four receiving clients do this —
`extension/src/background/receive.ts`, `console/src/lib/receive.ts`, and
`android/app/src/main/java/io/tabsend/app/receive/Deliverer.kt`, plus
`ios/TabsendKit/Sources/TabsendKit/Deliverer.swift`. This is what stops a relay
from injecting a link of its own choosing — subject to the important caveat in
[Known limitations](#known-limitations) below.

**Received links are limited to ordinary web URLs.** Before a decrypted URL reaches a browser
tab API, Android intent or iOS open handler, the client requires an absolute `http` or `https`
URL with a host. Other schemes and malformed values are consumed without invoking an operating-
system handler. The web console applies the same rule before rendering a clickable history link.

**A tab's own ciphertext has a short life on the relay.** (Its group-history copy does not;
see above.) Messages carry a TTL (7 days by default). The
ciphertext is erased the moment a message is acknowledged, and the TTL sweeper erases it at
expiry whether or not anyone acknowledged it; the routing row is kept a while longer as a
replay tombstone and then hard-deleted (`server/src/sweep.ts`,
`server/src/routes/messages.ts`).

---

## What is in scope

Roughly: anything that breaks the promises above.

**The relay (`server/`)**

- Reading, sending, acknowledging, or deleting anything belonging to a group you are not in
- Authenticating without a valid device token, or forging/predicting one
- Any weakness in pairing credentials — predicting the embedded code, brute-forcing it past the
  rate limiter, reusing a consumed or expired link, or using it for a different group
- Any route that enrolls an endpoint without a valid pairing credential, except the documented
  relay-minted first-run link while the default group has no endpoints
- Bypassing the rate limiter, the body-size cap, or the TTL sweeper (for example, keeping
  ciphertext alive past its TTL)
- SQL injection or query manipulation through the Kysely layer, in either dialect
- Leaking a server-held secret to a peer — the push subscription and the device-token hash are
  never supposed to be projected onto the wire (`server/src/mappers.ts`)
- Denial of service that goes meaningfully beyond the documented single-instance limits: an
  unauthenticated request that crashes the relay, an unbounded allocation, an amplification

**Cryptography**

- Anything that breaks confidentiality or authenticity of the sealed envelope: nonce reuse,
  key or identity confusion, a `keyId` collision usable to impersonate a sender
- A divergence between the Android `crypto_box` implementation and libsodium that is
  exploitable rather than merely a correctness bug
- A divergence between the iOS `crypto_box` implementation and libsodium that is exploitable
  rather than merely a correctness bug
- Key material leaving the device it was generated on, by any route

**Clients (`extension/`, `android/`, `ios/`, `console/`)**

- Getting a receiving endpoint to open a URL that no member of its group sent, or to open one
  that a group member sent to a *different* target
- XSS or script injection in the extension or console UI, especially anything reaching
  extension privileges or the private key
- A hostile web page reaching extension internals — a message-passing gap, an over-permissive
  `externally_connectable`, a content-script boundary hole
- The console leaking decrypted history or the private key beyond the browser it runs in
- Any path that writes the private key or device token somewhere it can be read by another app,
  another site, or the network

**Wire contract handling**

- Input the relay's validator (`server/src/validate.ts`) lets through that a client will then
  mishandle
- Anything where a malicious client can make a *different* client misbehave through the relay

---

## What is out of scope

These are documented properties of the design. Reports about them will be closed with a
pointer back here — not because they're unwelcome, but because they're already known and
accepted.

### The relay operator sees metadata

This is the big one. The relay stores, and its operator can read
(`server/src/db/schema.ts`):

- Group and endpoint IDs, and which endpoints belong to which group
- Endpoint labels and device names you typed (e.g. "Chrome · MacBook"), platform and browser
  family
- Every endpoint's public key
- Push subscription URLs, when push is in use
- For every message: sender endpoint, target endpoint, creation time, expiry, delivery and
  acknowledgement times, and the size of the ciphertext
- Since ADR-0028, that same routing row also carries an encrypted history blob and outlives the
  delivery it describes, so the metadata above is readable for the history window (default 30
  days) rather than only until acknowledgement
- Which device handed the group history key to which, and when (`group_keys`); a new key
  appearing marks a device leaving the group
- When a web console is paired, the extension also sends it a sealed copy of each tab
  (ADR-0010), which shows up as an extra message row
- Connection times and, at the network layer, the IP addresses your devices connect from

What it does **not** see is the URL, the page title, the favicon, or anything else inside the
envelope. "The relay operator can build a graph of which of your devices talk to which, and
when" is a true statement about Tabsend and an accepted trade-off (ADR-0005). It is not a
vulnerability report. **On a self-hosted relay, that operator is you.** A hosted relay is
also deployed for controlled testing, but its control plane, wake forwarder, and paid-service
operations are not yet complete.

### Consequences of the account-less design

- **Anyone holding a complete valid pairing link can join its group.** That is what the link is:
  the short code embedded in it is a bearer credential. Normal device-created links last 10
  minutes; the relay-created first-run link defaults to 24 hours because it must be recovered
  from startup logs. Both are single-use and registration is rate-limited. Protect the complete
  link and QR as a secret until it is consumed or expires.
- **Losing every device at once means losing the group.** Documented and deliberate
  (ADR-0021). There is no phrase, key, or admin escape hatch to get back in — which also
  means there is no standing credential for an attacker to steal. Starting over requires a new,
  empty relay database; follow [Starting over after losing every device](docs/DEPLOY.md#starting-over-after-losing-every-device)
  rather than deleting state without a backup.
- **If every device is lost, nothing recovers old history.** The group history key existed
  only on those devices. While any device survives, a newly paired one is handed the current
  key and can read history written under it (ADR-0028); a restored device-less group would
  have had nothing to restore.

### Keys at rest are protected by the platform, not by a passphrase

The X25519 private key and device token rely on each platform's app-storage boundary:
`chrome.storage.local` in the extension, private-mode `SharedPreferences` on Android
(`android/app/src/main/java/io/tabsend/app/store/Store.kt`), and the shared-access-group
Keychain on iOS (`ios/TabsendKit/Sources/TabsendKit/AppGroupStore.swift`). Android does not
currently put them in the Android Keystore, and Tabsend adds no separate user passphrase on
any platform. iOS credentials are device-bound and do not migrate in backups; its decrypted
received-tab history, and since 2026-10-13 its cached group history, are kept in protected,
backup-excluded local files. (Before that fix the cached group history sat in backed-up app
settings.) An attacker who
already has code execution as your user account, root-level
control of your phone, or physical access to an unlocked device may get them. Tabsend does not
claim to defend against a compromised endpoint; "malware on the device can read the key" is
out of scope.

### Self-hosting misconfiguration

Running the relay without TLS, exposing it directly instead of behind a reverse proxy, leaving
`TRUST_PROXY` unset behind a proxy so rate limits key on the proxy's IP, weak database
credentials, unencrypted backups — these are deployment issues, covered in
[`docs/DEPLOY.md`](docs/DEPLOY.md).

**The exception, and it's a real one:** if `docs/DEPLOY.md` *recommends* something insecure, or
omits a step that leaves a by-the-book deployment exposed, that **is** a valid security report.
Please send it.

### Documented operational limits

- **The relay is single-instance for delivery.** WebSocket fan-out is in-process by design
  (ADR-0012, and the "single-instance WS fan-out" section of `docs/DEPLOY.md`), so running
  several instances behind a load balancer and discovering that a socket on one does not
  hear an event from another is a documented limitation, not a finding. Rate limits and
  per-group limits are **no longer** part of that limitation: their counters moved into the
  relay database (ADR-0030, `server/src/quota.ts`), so instances sharing a database share one
  budget. A limit that turns out to be per-instance again *would* be a finding.
- **Push routes through a push service.** Chrome's Web Push endpoints go through Google's
  infrastructure; that is unavoidable for browser push and the payload is ciphertext
  (ADR-0006). A phone woken through the wake-up forwarder is rung by Apple's or Google's
  push service (ADR-0032, ADR-0034), and that push is empty. Push-service metadata
  exposure (that a device was rung, and when) is inherent, not a bug.
- **The Android app currently ships debug builds** for dogfooding, and a debug build is
  debuggable. That's a known property of this stage, not a finding.
- **The iOS app is not yet a qualified physical-device release.** Its current evidence is
  Swift tests and end-to-end Simulator testing. A reproducible security failure on a physical
  device is still welcome as a report; the absence of physical-device qualification itself is
  a release-readiness limitation, not evidence of a vulnerability.
- **Receiving clients now keep a bounded local inbox.** Since v0.6.0, iOS, Android, and the
  browser extension retain the newest 50 decrypted received URLs, titles, sender labels, and
  timestamps so a notification can be recovered after it is dismissed. This is device-local
  history protected by each platform's normal app-storage boundary, not relay storage or a
  passphrase-encrypted vault. The extension, Android and iOS also cache up to 50 decrypted
  group-history rows (the console keeps them in memory only),
  which can include tabs sent between two *other* devices. Users should treat both as
  sensitive browsing history. Unpairing clears the group history on every client, but the
  browser extension keeps its received list until it is removed or its data is cleared, so
  remove the extension or clear app data before handing a device to someone else.

### General

- Dependency CVEs with no demonstrated exploit path in Tabsend — open a normal issue instead
- Missing security headers on a JSON API, or automated scanner output, without a working
  proof of concept
- Traffic analysis: correlating ciphertext sizes or send timing against browsing behaviour
- Social engineering, phishing, or physical attacks against the maintainer or against users
- Anything requiring an attacker who already fully controls the device

---

## Known limitations

Not out of scope, not currently fixed — written down so nobody wastes a week discovering them,
and because pretending otherwise would be dishonest.

### The relay is untrusted for content, but it is trusted for the key directory

Sender verification works by checking a message's `senderKeyId` against the public keys of the
endpoints currently in the group — and that list comes from the relay (`GET /v1/endpoints`,
consumed identically by the extension, the console, Android and iOS). Endpoint public keys
are distributed through the relay at pairing time, with trust rooted in the pairing step
(ADR-0005), and nothing signs or pins that list afterwards.

The practical consequence: a **malicious or compromised relay** could add a fabricated endpoint
to your group's directory and then send a message from it, which a receiving client would
verify successfully and open. Injection resistance depends on the relay's directory being
honest, and so does confidentiality. Your devices automatically hand every new member the
group history key (ADR-0028), and every send leaves a history copy sealed to that key, so the
fabricated endpoint can read every link sent in your group while it is there, plus the retained
history written under the key it was handed (up to 30 days by default; `HISTORY_RETENTION_DAYS=0`
on an honest relay stores and serves no history, which a compromised one would simply ignore).
Removing it cuts it off: a device leaving the group makes your devices mint a new key, sealed
only to the devices that remain, and the device you remove it from records the removal at
once, so a relay that answers the removal and keeps listing the device, or lists it again under
a new id, still does not keep it on the key (a re-paired browser of your own needs one tap to
be let back in). The new key names the devices it replaces, and a device that owes a rotation accepts
only a key that does. What a compromised relay can still do is show different lists to
different devices: one it never told about the removal keeps handing the removed device the
key, and a key dated up to a day ahead that the removed device minted before it left, handed
over late by such a device, can outrank the new one (`docs/PLANS.md` P-14 item 9). *(Corrected
2026-10-13: until then no client rotated the key at all, so a removed device, or a relay that
had obtained the key, could read new history for ever.)* *(Corrected 2026-10-01: this paragraph used to say the relay "still cannot
read anything sent between your real devices". That stopped being true when group history
shipped, and was not caught at the time.)*

There is a partial mitigation and it's a human one: the fabricated endpoint shows up in your
device list, in the send chooser and in the console. Builds after v0.7.0 also *tell* you: each
of your devices compares every device list it fetches with the last one it saw, and a device
that was not there before, or a known device whose key has changed, raises an alert
(extension, Android, iOS) and a "New device: … Was this you?" banner (every client, the
console included) with a way to remove it (`docs/PLANS.md` P-10). That makes an added device
noisy, not impossible. The relay still chooses what each device's list shows, so it could try
to hide the device from the devices that neither send to it nor hand it the history key. The
first list a device sees, when it is paired or first runs a build with the notice, is not taken
on trust silently: a card lists the other devices in it and asks you once whether they are all
yours (and on an upgrade, the list the previous build kept is the starting point, so a device
added since is announced). A device that is shown once and then hidden again stays on screen as
"joined, then disappeared" until you dismiss it, and your devices replace the key, so it reads
only what was sent while it was listed (unless the relay also holds back key copies; see above).
Both rest on you reading what the relay shows: a device with a believable name passes a user
who does not look (`docs/SECURITY_REVIEW.md`, review of 2026-10-13). There is no automatic
out-of-band key verification today — no safety-number comparison, no fingerprint check between
paired devices.

For the shipping deployment this is a limited concern, because the relay is one you run
yourself. It matters more for any future hosted relay, and **the owner has accepted it there
too** (2026-10-01, `docs/HOSTED_PLAN.md` §9.11): the signed-membership fix
(`docs/MEMBERSHIP_PROTOCOL.md`) is parked, the "new device joined" notice is the hosted-beta
mitigation, and hosted claims will say plainly that we do not read links but that someone who
broke into the server could add a device. **Design proposals for pinning endpoint
keys at pairing time, or for out-of-band verification, are genuinely welcome** — as a normal
GitHub issue, since the limitation itself is already public here.

### Group history widens two exposures, on purpose

Both follow from ADR-0028 and neither is a bug report. They are stated here because
"end-to-end encrypted" invites more trust than any one sentence deserves.

**There is more ciphertext at rest, for longer.** Before, a message's ciphertext was deleted
as soon as its target acknowledged it, so a relay database usually held very little. Now it
also holds one history blob per send for the retention window (default 30 days), and so do its
backups. Someone who obtains the database still gets no plaintext and no key — but they get
considerably more ciphertext than they used to, and it describes a month of activity rather
than whatever happened to be in flight. `HISTORY_RETENTION_DAYS=0` returns the relay to the
older behaviour (true since 2026-10-13; before, the relay still stored each blob for about 14
days with default settings). Key copies already stored go on the next sweep.

**Compromising one device now exposes the whole group's history, not just that device's
traffic.** This is the feature working as intended: the point of a shared group key is that any
of your devices can read the group's history, including transfers between two *other* devices.
The security consequence is the same statement read the other way. Previously, a stolen phone
gave an attacker the tabs sealed to that phone; now it also gives them the group key, and with
access to the relay, up to a window's worth of history for every device. Removing the device
from the group rotates the key and cuts off everything after that point, and deletes its key
copies from the relay — but history written *before* the removal stays readable to whoever
holds the old key, which is the trade-off accepted when rotation was chosen over re-sealing
everything. The rotation happens on the next sync of one of your other devices after the
removal (built 2026-10-13; before that, nothing rotated, and this sentence was false).

### The cryptography has not been independently audited

Stated plainly, because it's true and because "end-to-end encrypted" invites more trust than
this project has earned yet.

**Nobody with cryptography credentials has reviewed this code.** There has been no audit,
formal or informal, paid or donated. Nothing in this repository claims otherwise.

What Tabsend actually does:

- **On the web side** — extension and console — sealing and opening go through **libsodium
  itself** (`libsodium-wrappers`, `crypto_box_easy` / `crypto_box_open_easy`). That is the
  reference implementation, not a re-implementation, which is the safest available choice.
- **On Android** there is no libsodium, so `crypto_box` is **reassembled from Bouncy Castle
  parts**: BC's `X25519Agreement` for the key exchange, BC's `XSalsa20Engine` for the
  keystream, BC's `Poly1305` for the tag. But the composition around them — the
  `crypto_box_beforenm` HSalsa20 step (built by reusing BC's `Salsa20Engine.salsaCore` and
  undoing its feed-forward add, because BC exposes no standalone HSalsa20), taking the first
  32 keystream bytes as the Poly1305 key, clamping `r` by hand, the XOR, and the constant-time
  tag comparison — is **Tabsend's own code**
  (`android/app/src/main/java/io/tabsend/app/crypto/CryptoBox.kt` and `Salsa20.kt`).
- **On iOS** there is also no libsodium dependency. CryptoKit supplies X25519, while Tabsend's
  Swift code implements the HSalsa20/XSalsa20 stream construction and Poly1305 composition
  (`ios/TabsendKit/Sources/TabsendKit/Crypto/`). The same committed libsodium interop vector
  covers the Swift implementation, but the surrounding composition is still Tabsend's code.

Standard primitives, custom glue. Glue is exactly where this kind of code goes wrong.

**What does exist** is a committed interop vector generated with libsodium on the TypeScript
side and checked byte-for-byte by Android's `CryptoInteropTest` and the iOS Swift tests on every
CI run (`android/app/src/test/`, `ios/TabsendKit/Tests/`, `.github/workflows/ci.yml`). Any
divergence from libsodium on that vector fails that test.
That is meaningful evidence of *correctness*, and it is genuinely more
than most hobby projects have. It is **not** an audit: it says nothing about side channels,
about behaviour on inputs the vector doesn't cover, or about the protocol composition around
the primitive — key distribution, nonce handling, replay, the directory-trust issue above.

Nonces are 24 random bytes per message, drawn from `randombytes_buf` on the web side and
`SecureRandom` on Android, and `SecRandomCopyBytes` on iOS. With XSalsa20's 192-bit nonce,
random per-message nonces are the intended usage and collision risk is negligible.

**What to take from this:** Tabsend is built carefully, uses standard primitives, and is honest
about where the custom code is. Treat it as good hygiene for moving your own links between your
own devices. Do not treat it as a reviewed, hardened tool for a situation where being wrong
about the cryptography would put someone in danger. If it ever is audited, this section will
say so and name the auditor.

---

*Some wording on this page touches legal territory — disclosure timelines and the like. It is a
non-binding draft written by the project owner, who is not a lawyer, and should be reviewed by
one before anything relies on it.*
