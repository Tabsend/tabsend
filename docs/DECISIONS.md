# Tabsend — Decision Log

Lightweight ADR-style record of committed decisions. Newest at top. Each entry: context, the decision, and consequences/follow-ups. Open items still being worked live at the bottom under "Decision queue" and in PRD §11.

---

## 0035 — A hosted group can be reset, but only after a wait every paired device can stop

**Status:** Accepted · 2026-10-27 (owner's picks: the reset that waits, sketch 1B, card layout A; claimed against `origin/main` at merge)
**Relates to:** ADR-0021 (no recovery credential; its remedy, "create a fresh group", is what this does), ADR-0031 (provisioning: two factors, suspension deletes nothing, one deletion cascade), ADR-0032/0034 (the wake path reused to tell phones), `docs/PLANS.md` P-18 item 12, `HOSTED_PLAN.md` §5; `server/src/routes/group.ts`, `server/src/routes/provisioning.ts` (`/reset`, `/reset/run`), `server/src/tenancy.ts` (`runDueGroupReset`), `server/src/wake.ts`, `control/src/accounts.ts` (`requestReset`, `advanceReset`, `swapGroup`), the four clients' reset cards.

### Context
The account page mints a pairing link only while the group is empty (ADR-0031 §4), so even someone who takes over a customer's email cannot add a device. The price: a paying customer who loses every device has a paid group nobody can join, and the only way out was deleting the account, which ends the plan with no refund. ADR-0021's answer for a self-hoster ("create a fresh group") works there because the group costs nothing; on the hosted service the plan is tied to the account, not the group.

### Decision
**The account page may ask for the group to be replaced by a fresh, empty one, keeping the plan. It happens 72 hours later unless any paired device, or the page, stops it first.**

1. **A new group, never a way into the old one.** The swap is the existing cascade plus `POST /groups` plus the first link, run by the control plane. Nothing about the old group's devices, key or history carries over (ADR-0021's reasoning holds unchanged).
2. **The wait is the security.** The relay holds the pending reset (`groups.reset_requested_at`, `reset_at`, `reset_stopped_at`), shows it to every device (`GET /v1/group`, the `group_updated` stream event, a content-free wake for phones), and lets any device in the group stop it (`POST /v1/group/reset/stop`, not blocked by suspension). Each client shows a card on its main screen and one system notification per reset.
3. **The relay decides the last moment.** The control plane carries a reset out only through `POST .../reset/run`, which deletes only if the reset is still pending and due, inside the same serialized step a Stop takes. A Stop and a run can never both happen.
4. **A paused account stays paused.** Its new group is suspended before any link is minted.

### Consequences / follow-ups
- A device the customer no longer controls (a stolen phone still paired) can stop every reset. The customer is told by email and asked to reply; the owner handles it by hand.
- An older relay answers 404 to `GET /v1/group`; clients treat that as no reset. An older client simply never shows the card, so the email is then the only warning: ship clients before relying on this.
- Not yet seen on real phones (P-14's real-device check applies here too).

---

## 0034 — Android may be rung through Google, as one apk that decides at runtime

**Status:** Accepted · 2026-10-01 (merged to `main` 2026-10-02 as 0034, claimed against `origin/main` at that point)
**Relates to:** ADR-0015 (Android is push-less; the foreground service and the notification Android mandates for it — amended in its consequences, not withdrawn), ADR-0006 (transport; "minimising Google dependency" — **partially reversed here**, see consequences), ADR-0032 (the wake-up forwarder, the `forwarder` transport, and the operator URL — reused unchanged), ADR-0013 (changing relay is a re-registration, which is why an announcement target is tracked), `docs/PLANS.md` P-11 (the analysis and the pricing recommendation this implements) and P-9 (the forwarder-mismatch hazard, which now reaches Android), `HOSTED_PLAN.md` §1 and §7 (core features are never gated; the free path stays complete), PRD §6.1 (correctness never depends on a push arriving, and stream bytes are never trusted); `forwarder/src/fcm.ts`, `forwarder/src/fcm-auth.ts`, `forwarder/src/store.ts`, `forwarder/PROTOCOL.md` §3.1/§3.2/§5/§9.2/§10, `android/…/push/`, `android/app/build.gradle.kts`.

### Context

ADR-0015 made Android push-less and was right to: requiring a second app (a UnifiedPush distributor) to pair was the friction that killed it, and FCM at the time meant handing every self-hoster a Firebase credential. The price it accepted was a `specialUse` foreground service and, with it, the permanent notification Android mandates for any such service. `StreamService` already minimises that notification as far as the platform allows — `IMPORTANCE_MIN`, `PRIORITY_MIN`, no badge — and it is still a permanent row in the shade. The owner raised it as the live friction on 2026-10-01.

Two things changed since. First, **ADR-0032 built the wake-up forwarder**, precisely so a self-hosted relay could wake a phone without holding the push provider's key: the relay rings the forwarder with a wake token, the forwarder holds the credential, the phone wakes and fetches from its own relay. That removes the "every self-hoster needs Firebase credentials" half of the old refusal outright — the same argument, for a different provider. Second, the `forwarder` transport is **provider-neutral on the wire**: a relay holds a wake token and nothing else, so which provider answers is already the forwarder's private business.

What remained of the refusal was ADR-0006's actual objection: Google Play Services inside the Android build.

### Decision

**Android may be rung through Google's push service, via the existing forwarder. It is one apk that decides at runtime, it is not a paid feature, and the push-less path remains a first-class permanent fallback rather than a legacy one.**

1. **No wire change anywhere, and no relay change at all.** Android reuses `{transport:"forwarder", wakeToken}` from ADR-0032. The relay already rings its operator's `WAKE_FORWARDER_URL` for that transport and already advertises `wakeForwarder` on `/v1/config`. Nothing in `server/` was touched.
2. **One apk, three runtime questions.** There is deliberately **no `com.google.gms.google-services` plugin and no `google-services.json` in this repo** — that plugin fails the build when the file is absent, which would make a Firebase project a prerequisite for *compiling Tabsend*, for everyone. Firebase is initialised in code from four values (`FCM_APP_ID`, `FCM_PROJECT_ID`, `FCM_API_KEY`, `FCM_SENDER_ID`), supplied at build time and **blank in an ordinary build**. None is a secret: all four ship inside any app using Firebase, and the credential that can actually send a push lives only on the forwarder. Google push is used only when (a) this build carries those values, (b) the phone has Play Services, and (c) the paired relay has a forwarder. Any "no" falls back to `StreamService`. **A degoogled phone runs the same apk, unchanged, and loses nothing it had.**
3. **Pairing is still zero-prerequisite.** A phone registers `{transport:"none"}`, exactly as ADR-0015 ruled, and Google push is rotated in by **heartbeat** afterwards. Enrolment is therefore never on the pairing path and can fail without anyone noticing.
4. **The forwarder gains FCM beside APNs**, and refuses the provider it cannot reach at registration (`501 unsupported`) rather than accepting a row it would never ring. The device table generalises `apns_token` to `platform` + `device_token` (schema 2). Only `404 UNREGISTERED` proves a device gone — `400 INVALID_ARGUMENT` does not, for the same asymmetry that keeps Apple's `BadDeviceToken` out of the delete path.
5. **The screen keeps one switch** (P-11 option C). Instant delivery is on or off; the app picks the mechanism and states which it used in one line, offering "Don't use Google" where that choice means something. `Store.avoidGoogle` records a preference about *means*, separately from the switch, so it survives turning delivery off and on.
6. **Not a premium feature.** `HOSTED_PLAN.md` §7 gates no core feature and leaves the self-hosted path unrestricted, there is no recurring cost to recover (FCM is free per message; the forwarder already runs for iOS), and charging to switch off a notification the OS imposed would contradict the product's own pitch at the point of most friction. P-11 records the defensible paid shape if one is ever wanted: a Play Store build, priced as distribution, beside the free APK.

### Consequences / follow-ups

- **ADR-0006 is partially reversed, and exactly this much:** Google Play Services now enters the Android build. Everything else in it stands — the relay still needs no Firebase credential, no payload reaches Google (the push is a content-free `{"wake":"1"}` marker with no `notification` block), and ADR-0006 had already accepted Chrome's Web Push routing through Google's infrastructure for the same reason: an encrypted blob through a provider is not a dependency on that provider knowing anything.
- **ADR-0015 is amended, not withdrawn.** Push-less remains the default wherever Google push is unavailable or refused, which makes `StreamService` and its notification **permanent code with a permanent audience**, not a transitional step. Chunk 5c's known-limitation #1 (an FCM flavour) is resolved the opposite way to how it was written: by *not* building a flavour.
- **F-Droid would still need a stripped build**, because its policy flags the dependency itself rather than its use. APKs ship from GitHub today, so this is a later problem; it is the one case where a second build becomes unavoidable.
- **P-9's hazard now reaches Android.** An app registered with forwarder X, paired to a relay ringing forwarder Y, still reports success at every step and never rings. Unchanged and still undetectable by design; P-9 remains open and now covers two platforms. **Revised 2026-10-02 (security review): not unchanged on Android.** An iPhone in this state loses nothing it had. An Android phone has closed its own connection on the strength of its enrolment, so it drops to polling every few minutes, and the same follows from any forwarder that silently never rings it (a revoked token, an outage). See `SECURITY_REVIEW.md`, the 2026-10-02 review. **Since the amendment below, an Android phone notices** (tabs arriving with no wake near them) and goes back to its own connection, saying so; the mismatch itself is still not detectable in advance.
- **Relay switches are self-healed by an announcement target.** The wake token is the forwarder's and survives a relay change, but the new relay's *knowledge* of it does not (ADR-0013). `Store.pushAnnouncedTo` records `endpointId@relayUrl`, so the next sync notices a mismatch and re-announces rather than leaving a phone that believes it is reachable.
- **Unpair revokes before it wipes.** The wake token has to be revoked while it is still known, so `MainActivity` captures it and the old registration and hands both to `PushSetup.retireForUnpair`; reading the store from the background would race the wipe. **Superseded 2026-10-02** (amendment below): the wipe and the capture are one locked step that queues the token, and the queue retires it, retried until it lands, for Start fresh as well as Unpair.
- **Security review 2026-10-02:** `SECURITY_REVIEW.md` G1 to G24. They gate the first forwarder deployment and the first build with the four values, as listed there; one (G1, the delivery line blaming the phone) is live in every current build.
- **Still outstanding:** no Firebase project exists yet, so no shipped build carries the four values and nothing changes for any user until one does, apart from the delivery line G1 records. The forwarder's Google path has unit coverage against a fake and **has never spoken to real FCM**; the same physical-device qualification P-5 records for APNs applies here and belongs in a test matrix before any build ships with it on. *(2026-10-02: the real Google sender now runs end to end against a local fake of FCM over TLS and HTTP/2 in its tests; it has still never spoken to Google.)*

### Amendment — 2026-10-02 · what the security review changed, and device tokens at rest

The 2026-10-02 review (`SECURITY_REVIEW.md`, G1 to G24) found the design sound and the execution not ready. These are the decisions its fixes took; the review page records each item and what closed it.

**1. Device tokens are encrypted at rest, under a key held outside the database (G15). Chosen over proof of possession.** Registration replaces whatever row holds the same device token (`forwarder/PROTOCOL.md` §3.1), so a list of device tokens lets its holder retire every phone's real wake token and mint new ones that ring every phone, and the forwarder's database, or any backup of it, was that list, readable by every user on the machine. Two fixes were on the table:

- *Proof of possession at sign-up*: the forwarder pushes a code to the device token and the app must send it back. It closes the hole for anyone who learns a device token by any route, not only from the database. It also changes the wire contract between app and forwarder, on both platforms, so every built iOS app would stop being able to enrol; it puts a push that must arrive on the pairing path, which iOS does not promise for background pushes; and it leaves the tokens readable in a stolen copy.
- *Encryption*: `device_token_mac` (HMAC-SHA256, carrying `UNIQUE`, which is what the replacement rule needs) and `device_token_enc` (AES-256-GCM, a fresh nonce per row, the MAC as associated data), both keyed from `DEVICE_TOKEN_KEY`, an operator secret kept with the forwarder's other secrets and out of the database and its backups. Nothing changes on the wire, in either app, or at any relay.

**Encryption, because it closes the case the review found (a copy of the file) with no change outside the forwarder.** What it leaves open, stated so it is not lost: someone who has the key as well as the file can still cut phones off and ring them. That person has the forwarder's environment, which also holds the Apple and Google credentials, and can do worse with those. Proof of possession stays the outright fix if that ever matters more than the wire change costs. The database file is also created owner-only (0600) now, and an existing one is tightened. Schema 3 migrates a schema-2 file in place, in one transaction that drops the old table with `secure_delete` on (so its pages are zeroed as they are freed) and leaves a marker; the file is then rewritten and its WAL emptied, at every start and every flush until that has completed, so a stop or a full disk part-way cannot leave a clear-text token in the file for good. That is schema evolution inside the store's established migration list, house convention rather than one-time clean-up code. `DEVICE_TOKEN_KEY` is required on every forwarder, dry run included; the forwarder refuses to start with a key the file was not written with, because with the wrong key it could ring nobody, and refuses a key that looks typed rather than generated (every byte printable, or very few distinct bytes), because a copy of the file lets anyone test guesses against it. Losing the key means every phone signs up again. **Self-hosted relays are unaffected**: they never see a device token.

**2. The forwarder hides its post-reply work from the clock (G14), and logs no addresses (G7).** Nothing token-dependent runs before the reply, the lookup included; the work after it starts at a random point in the next 500 ms; a ring touches no disk (wake tallies are written once a minute); Google's access token is refreshed on a timer, not on whichever ring finds it stale; and the Google sender keeps one HTTP/2 connection open from start-up, checked with a PING every two minutes and reopened in the background after a random pause whenever it closes, so no ring pays for a connection (`fetch` reconnected after four seconds idle; closing after four idle minutes was not enough, because a prober can space its rings further apart). Because that connection now outlives any stall, a ring waits for a new connection's settings before sending, and a ring that goes unanswered makes the sender check the connection (dropped at once if it never finished setting up, otherwise after a PING Google does not answer, or three unanswered rings in a row). Fastify's request log is off, and the log serializers drop addresses and query strings even if something asks for them.

**3. "Don't use Google" now keeps the app away from Google (G3, G4, G5).** The manifest turns off Firebase Messaging's automatic set-up; Firebase starts only to enrol, or at launch when a registration may exist (because a wake can only arrive then); every retirement deletes the push token and the Firebase installation; Play Services is asked directly instead of inferred from Firebase starting; and an unpair keeps "Don't use Google", as iOS already kept its opt-out.

**4. Retirement is a queue, and "could not ask" is not an answer (G8, G9, G11).** The relay's wake-up service is yes, no, or unknown, and unknown changes nothing. Giving up Google push moves the wake token to a persisted queue: the relay must accept `{transport:"none"}` before the forwarder is told, each step is retried (from the heartbeat, at the next start, and on the next wake) until it lands, and the phone's own connection takes over at once (on Android 12 and later, if Android refuses that start from the background, the next time a Tabsend screen opens or a tab notification is tapped). Only a 2xx from the forwarder counts as told; an answer the app cannot read keeps the step queued rather than ending the app. The relay keeps one subscription per endpoint, so a `none` still queued for an endpoint is dropped once the relay takes a newer token for it: sent later, it would unhook the new enrolment. A new address for the same relay carries what is still owed to it. Unpair and Start fresh share one path that reads and queues the token in the same locked step as the wipe; there the relay left behind is told once, best effort, because it may be gone for good, and so is anything already queued for it. Every sync and retirement runs under one process-wide lock, and an enrolment is saved only if the pairing is still the one it was made for. A wake that arrives while paired is always drained.

**5. An Android phone notices when wakes stop arriving (G10).** A tab that a check-in finds (not a wake) three minutes or more after it was sent, with no wake within two minutes before it, is a strike, but only if the phone had reached its relay within twenty minutes before that check-in: a longer gap means it may have been offline the whole time, and its tabs prove nothing. Tab times are put on the phone's clock first, from the relay's clock in its heartbeat answer. A wake clears a strike, and a verdict too. A second such tab, sent after the first was noticed, sends the phone back to its own connection with the enrolment kept. On Android 12 and later that connection may not be allowed to start from the background; it then starts the next time a Tabsend screen opens or a tab notification is tapped. The screen says why and offers "Try Google push again" and "Don't use Google". Two strikes rather than one because a phone that was offline when a tab was sent never gets that tab's wake (Google keeps it five minutes) and finds the tab the same way. The same relay at a new address keeps what was decided, since it rings the same wake-up service; a different relay, or the user's retry, starts a fresh watch. This is the Android half of P-9; the iOS half is recorded there.

---

## 0033 — The hosted posture is a claim the relay checks at boot and refuses to run without, and the half it cannot check is a checklist

**Status:** Accepted · 2026-08-20
**Relates to:** `HOSTED_PLAN.md` §4.5 (the hosted security profile, and the **H2 gate**, whose relay-side items this closes), §7 (one machine, two trust domains: separate system users, per-service Postgres users, audit log and backups off-host), §5 (the two-hostname split), §8 (a paid service that stays silent while degraded is taking money for nothing — the argument this borrows for refusing rather than warning), §2.3 (mechanism open, policy closed); `HOSTED_SECURITY_PLAN.md`'s control-plane gate section, which is the list this turns into something checkable; ADR-0026 (application egress checks do not replace a network firewall — restated here as the reason the profile does not try), ADR-0019 (self-signed TLS is the self-host path, so a hosted relay must not be on it), ADR-0022 and ADR-0023 (the boot-log pairing link, the one line that carries a live credential on purpose), ADR-0029 (`provisioned`, the typo-is-a-boot-error precedent, and the reason a hosted relay prints no boot link), ADR-0030 (the caps this deliberately does not assert, and its open note about a stopped sweeper with a rate limit on, which this closes), ADR-0031 (the provisioning credential, its file form, and the audit mirror that is not the record), ADR-0012 (register is the one write route with no device token); `server/src/profile.ts`, `server/src/config.ts`, `server/src/server.ts`, `server/test/profile.test.ts`, `server/test/log-hygiene.test.ts`, `docs/HOSTED_PROFILE.md`.

### Context

Everything the hosted relay needs from this repo has now shipped except the posture it is supposed to run in: `provisioned` groups [0029], caps [0030], the provisioning API [0031], the wake path [0032]. Each of those is a *capability*. None of them is *switched on correctly* by existing, and every one of them has a setting that is right for a household relay and wrong for a paid one.

**The settings are individually documented and collectively unenforced.** `PUSH_ALLOW_PRIVATE_ENDPOINTS` says "never enable it on a multi-tenant/hosted relay" in `server/.env.example` and in `DEPLOY.md`. `GROUP_CREATION` explains that `open` lets a stranger start a group on your machine. `DEPLOY.md`'s domain deployment sets `TRUST_PROXY=1` in a comment nobody has to read. Every one of those is a sentence in a document, and the hosted relay will be deployed by one person, at intervals of months, from a machine where the last deploy's `.env` is still lying around.

**The other half of §4.5 is not a setting at all.** Network-layer egress deny, secrets in a managed store, separate system users, per-service database grants, backups shipped off-host: none of it is visible from inside the relay process, and most of it is not visible from inside the machine either. §4.5's own wording splits the work honestly — "a documented deployment posture, **and where cheap**, a boot assertion" — so the question was never "check everything" but "which half goes where".

**Log hygiene had drifted into partial coverage without anybody deciding it should.** [0031] asserted that the provisioning audit mirror carries no pairing link; [0032] asserted that a failed wake carries no wake token. Both are positive assertions about one line each, both were written by whoever added that line, and neither says anything about the line somebody adds next.

### Decision

**1. `TABSEND_PROFILE` is a CLAIM the relay checks, not a switch that changes behaviour.** Unset is the default and means today's relay exactly: nothing asserted, nothing warned about, no new log line, no behavioural difference of any kind. `hosted` changes nothing about how the relay runs either — it turns on a boot-time check that the relay is *already* configured the way a hosted relay must be. That distinction is the whole design: a profile that silently *applied* the right settings would be worse than no profile, because the operator's `.env` would then disagree with the running relay and neither would be wrong on its face. An unrecognised value is a boot error, on [0029]'s precedent: somebody who typed `TABSEND_PROFILE=hostd` asked to have a gate armed, and falling through to "no profile" hands them a relay that boots happily and checks nothing.

**2. Nine rules, each measured against one question: would this ever be wrong for a LEGITIMATE hosted deployment?** That is the bar for a rule that refuses to boot, and it is a higher bar than "hosted relays should probably do this". The list, with the one-line reason each survived it:
   - `PUSH_ALLOW_PRIVATE_ENDPOINTS` **off** — named verbatim as forbidden by `HOSTED_SECURITY_PLAN.md`; push endpoints arrive from unauthenticated strangers, so this switch is an SSRF lever handed to the internet.
   - `GROUP_CREATION=provisioned` — `HOSTED_PLAN` §4.1 says hosted runs it; `open` mints tenancies past signup and billing, `single` cannot host tenants at all.
   - **A provisioning credential set**, either form — under `provisioned` with no credential the routes are not registered [0031] and the public create path always refuses, so no tenancy could ever come into being. It boots, it answers, it sells nothing.
   - `DATABASE_URL` **is Postgres** — §7's per-service database and database user with no grants on the other's is not expressible in a SQLite file, and §8's restore drills are `pg_dump` ones.
   - `TLS_SELF_SIGNED` **off** — ADR-0019 is the no-domain self-host path; a hosted relay has a real domain and a real certificate, and this would put a pin in every pairing link for a certificate browsers cannot use.
   - `TRUST_PROXY` **on** — hosted sits behind Caddy (`DEPLOY.md`'s domain topology, `docker-compose.domain.yml`); without it every request looks like the proxy, so the per-IP register limit becomes one bucket shared by the whole internet.
   - `RATE_LIMIT_MAX` **above 0** — register is the one write route needing no device token [0012].
   - `SWEEP_INTERVAL_SECONDS` **above 0** — stopped, the relay holds expired ciphertext past the retention it promised and grows one quota row per client address per window forever. [0030] named that combination as something that "probably should be looked at" and left it unrefused; on a relay claiming this posture it is refused.
   - `PUBLIC_RELAY_URL` **explicit and https** — pairing links carry it to every device that joins, and the default advertises `http://localhost`, which no customer's phone can reach.

**3. Refusing to boot, not warning — and this is the one place the project's usual instinct inverts.** Every other misconfiguration in this relay produces a warning, and rightly: a self-hoster's relay half-working beats their relay not working, and they are the only person harmed either way. A paid multi-tenant relay has the opposite asymmetry. Silently running a weaker posture than the operator believes is `HOSTED_PLAN` §8's "taking money for nothing" applied to security rather than to uptime, and the people harmed are not the person who could fix it. Boot is also the one moment the fix is cheap: nobody has paired, no tenancy exists, and the failure is in front of the person deploying rather than in a log they will read next quarter.

**4. Every violation is reported at once, numbered, each naming its variable and its fix.** A check that threw on the first problem would cost one restart per problem, which is precisely the friction that makes an operator reach for the environment variable that switches the check off. `hostedProfileViolations` is therefore total and pure — it returns the whole list — and `assertProfile` is the thin wrapper that turns a non-empty list into the refusal. That split is also what makes the rules testable without booting anything: the suite drives real env bags through `loadConfig` rather than hand-building a `Config`, so a rule keeps naming the variable an operator actually sets even after somebody renames it.

**5. The half no process can check is `docs/HOSTED_PROFILE.md`, and it is a checklist with commands rather than a description.** Seven items — the two-hostname split, network-layer egress deny, separate system users, per-service Postgres databases and users, secrets from a managed store, audit log and backups off-host, and log hygiene on the running relay — each stating **what**, **why**, and **how to verify**, with the verification being a command that runs as written against the real deployment's real names and an expected output to compare against. A new file rather than a `DEPLOY.md` section: `DEPLOY.md` is *self-hosting*, it opens by saying so, and it is already long. Its two hosted subsections are settings on the relay; this is a posture for a machine, with a different audience and a different failure mode. One home, cross-linked from `DEPLOY.md`'s configuration table, its egress paragraph, and a section of its own.
   - **The egress verification includes a positive control**, deliberately: a firewall that blocks the metadata service and also blocks Web Push looks identical to a working one until the first customer notices nothing arrives.
   - **`HOST` is on the checklist and NOT a boot rule**, and the reason is worth recording as the shape of the whole split: `0.0.0.0` is correct inside a container where only the proxy is published and wrong on this bare-metal host, so a boot check would refuse a legitimate deployment while a checklist item catches the real mistake.

**6. Log hygiene gets one cross-cutting sweep rather than more per-line assertions.** `server/test/log-hygiene.test.ts` drives a hosted-shaped relay through every path that touches a secret — provisioning create/mint/usage/caps/suspend/delete, register consuming a bootstrap pairing code, device-to-device pairing and a second register, send with ciphertext, collect, ack, a WebSocket hello carrying a device token, a wake that fails and therefore logs, a refused register with a guessed pairing code, and a refused provisioning call with a near-miss credential — then asserts that none of fifteen named secrets appears anywhere in the captured output. The two existing narrow tests stay exactly where they are: they assert what their own lines *do* carry, which this cannot. What this adds is the absence check over lines nobody thought about, including Fastify's own request logging and whatever the next chunk adds in a hurry to debug something.
   - **Each secret is named in its own assertion** rather than folded into one "no secrets" boolean, so a failure says *which* one escaped.
   - **A companion test asserts the log is not empty of the things it SHOULD carry** (the group id, the mint expiry), because a sweep over a relay that logged nothing would pass for the wrong reason.
   - **The boot-log exception is asserted rather than assumed.** ADR-0023's first-run pairing link is the one line that carries a live credential on purpose, and [0029] already stops it under `provisioned`. That is now a test, because it is the exception that would make every other assertion here moot on a hosted deployment.

**Not done here, deliberately:**
- **No egress enforcement inside the relay beyond `push-egress.ts`.** The existing guard stays exactly as ADR-0026 left it and is not extended. The relay does not install firewall rules, does not probe its own egress, and does not report on either. It cannot install them (it is not root, and should not be), and it cannot honestly verify them — a relay that proved its own egress was blocked would have to make the calls the rule forbids. A check that passed because it could not look is worse than no check, because it reads as an assurance.
- **The profile does not configure anything.** Not the firewall, not the database grants, not the system users, not `GROUP_CREATION`. It reads configuration and refuses. `HOSTED_PROFILE.md` documents, and the operator verifies.
- **No per-group caps asserted**, though §4.3 exists for hosted. Caps are a per-group number the provisioning API sets at tenancy creation [0030]; a deployment that gives every group explicit caps and leaves the relay-wide defaults at unlimited is correct, and asserting the defaults would refuse it. The same test rejected `WAKE_FORWARDER_URL` (a hosted relay with no iPhone customers is a hosted relay), `HOST`, an explicit VAPID pair, and every retention setting. The rejected list is in `profile.ts` with its reasons, so a later reader does not add them back.
- **No `staging` or `selfhosted` profile.** `RelayProfile` is a union with one member rather than a boolean so the next posture can be added rather than substituted, but inventing one now would be inventing its rules too.
- **No runtime re-check.** The assertion runs once, before the database is opened. Nothing re-reads it, and an operator who changes the environment without restarting gets the relay they had.
- **`ALLOW_MULTIPLE_GROUPS` is not separately refused** under the profile. `GROUP_CREATION=provisioned` is required, and `loadConfig` already makes a contradictory pair a boot error [0029], so a second rule could only fire in a case that is already refused one layer down.

### Consequences / follow-ups

- **Nothing changes for a self-hosted relay.** No `TABSEND_PROFILE` means no check, no new log line, and no new code path entered. The only unconditional change in `server/src` is one field on `Config` that is `undefined` everywhere it is not set.
- **`shared/src/types.ts` is untouched.** No wire change, no protocol bump, no new `ApiErrorCode`. This is entirely deployment-facing: the profile is invisible to every client, deliberately, because "how strictly is this relay configured" is not something a client should be able to ask.
- **One boot line was added, and it is the smallest one that answers the question.** A silent pass is indistinguishable from a variable that was never read, so a compliant hosted relay logs `{ profile: 'hosted' }` once and points at the checklist. It names the profile and nothing about what was checked; that is documentation, not log volume.
- **`HOSTED_PLAN` §4.5 is closed for the relay half; §7's on-host boundaries are documented and verifiable but not proven.** Nothing in this change has run on a real VPS, because there is not one yet. Every command in `HOSTED_PROFILE.md` is written to run as-is and none of them has been run against the deployment it describes — the first pass through that checklist is itself a deliverable, and it will find things.
- **[0030]'s open note about `SWEEP_INTERVAL_SECONDS=0` with a rate limit on is now half-closed.** It is refused on a relay claiming the hosted profile and still permitted everywhere else, which is the right split: on a self-hosted relay the combination is the operator's own storage, and on a hosted one it is somebody else's retained ciphertext.
- **The egress recipe does not survive containerisation**, and says so. `meta skuid` matches the relay's user, and container traffic is NATed out of the bridge before that user is visible. The recommended hosted shape is the systemd one for exactly this reason; a containerised deployment needs the rule rewritten against the container's subnet and the verification re-run from inside it.
- **The log-hygiene sweep will get slower and more valuable at the same time.** It drives most of the relay's write paths through one test, so it is now among the more expensive tests in the suite, and every path added to it costs a little more. That is the trade: the alternative is a per-line assertion written by the same person who wrote the line, which is the pattern that produced the partial coverage this replaces.
- **The relay's audit mirror and the control plane's record are now something an operator is asked to RECONCILE**, not just to have. The checklist's verification counts today's mirror lines and compares them against the off-host record, and names what each direction of disagreement means. Nothing automates that comparison, and nothing can from this side of the boundary [0031].
- Open: **the unix socket of `HOSTED_PLAN` §7 is still deferred**, for the reason [0031] recorded — its access rule would have to differ from the TCP listener's, and the second factor there is a filesystem mode the relay cannot set. `HOSTED_PROFILE.md` therefore verifies the credential's file mode and the loopback binding instead, which is the same boundary enforced by the deployment rather than by the relay.

### Amendment — 2026-09-05 · a tenth rule: the wake forwarder's scheme

> **Revised 2026-10-01**, after a follow-up review (`SECURITY_REVIEW.md`): the rule held
> against every bypass tried. Its boot message asked the operator to fill in a
> placeholder port, and now names the forwarder's default (`http://127.0.0.1:8788`).

Decision 2's list is now ten. `WAKE_FORWARDER_URL` must be **https, or http to loopback**,
where it is set at all — the reasoning is in [0032]'s 2026-09-05 amendment, and it passes
decision 2's test cleanly: there is no legitimate hosted deployment that sends a bearer
credential for a shared service over cleartext to another host, and the one legitimate
http case (a forwarder as a second process on the same machine, reached at
`http://127.0.0.1:PORT`) is exactly what the loopback exception allows.

Its **presence** stays on the "weighed and deliberately not asserted" list, unchanged: a
hosted relay that wakes no phones is a hosted relay, and drain-on-open is a complete
delivery mode. The rule is not "you must have a forwarder", it is "if you ring one, do
not put the wake token on the wire". `profile.ts`'s rejected list says so, so a later
reader does not read the entry as covering both questions.


---

## 0032 — The iOS wake path is a transport slot plus one operator URL, and a wake may never fail a send

**Status:** Accepted · 2026-08-20
**Relates to:** `HOSTED_PLAN.md` §6 (the wake-up forwarder, its metadata cost, and the ruling that its relay side is open and configurable), §2.1 (one relay, unforked — the promise this keeps true for iOS rather than true-except-iOS), §2.3 (mechanism open, policy closed); `PLANS.md` P-5 option 1 and its design constraints; `forwarder/PROTOCOL.md` §3.2 (the wake route), §4 (why every answer is 202), §6 (a wake token never rides a URL), §7 (the degradation contract this is the relay half of), §8 (logging vocabulary); ADR-0006 and ADR-0015 (the transports that exist, and why Android is push-less — both untouched here), ADR-0017 (additive fields need no protocol bump, and P-6's degrade-to-catch-all applies to descriptive enums only), ADR-0009 §3 (a secret rides a fragment so it never reaches a server log), ADR-0022's `acceptsNewGroups` and ADR-0029 (the hint-versus-enforcement pattern this copies), ADR-0030 and ADR-0031 (the precedent for measuring a new wire literal against four hand-maintained client copy tables); `shared/src/types.ts` §2 and §10c, `server/src/push.ts`, `server/src/config.ts`, `server/src/validate.ts`, `server/src/routes/config.ts`, `server/src/routes/messages.ts`.

### Context

The forwarder itself landed as a working service with no caller. `forwarder/PROTOCOL.md` §11 said so in as many words: "the relay side is not built here". This is that side, and it is smaller than the service it calls — one URL, one HTTP POST, one new wire variant — which is exactly why the interesting decisions are all about what it must *refuse* to do.

**There was no way to say "wake this phone".** `PushSubscription` has four variants and every one of them is a *destination the relay can reach on its own*: two URLs it dials, an FCM token, and the explicit no-op. An iPhone is none of those. The relay cannot reach it at all — not for want of a route, but because Apple will not take instructions from a relay in somebody's flat (P-5). What the phone can offer instead is a token that some other party will honour, which is a shape the union had no room for.

**And the obvious way to add that shape is a security hole.** The lazy variant is `{ transport, url, token }` — the relay calls whatever the device named. That is a fully-formed SSRF lever handed to an *unauthenticated* register call: `POST /v1/endpoints/register` is the one write route that needs no device token, so anybody who can reach the relay could make it issue arbitrary outbound POSTs, at a URL of their choosing, from inside the operator's network. `push-egress.ts` exists because Web Push already forces the relay to dial a client-supplied URL and there is genuinely no alternative there — the browser's push service picks the endpoint. Here there *is* an alternative, so accepting the same risk twice would be a choice rather than a constraint.

**The third question is what a relay without a forwarder does with such a registration**, and it has two plausible answers that look equally reasonable from a distance.

### Decision

**1. One new variant, `{ transport: 'forwarder', wakeToken: string }`, and the absence of a URL field is the load-bearing part.** The app hands the relay one thing: the token the forwarder minted for it. The relay rings the forwarder **its own operator configured** and nothing else, ever. The doc comment in `shared/src/types.ts` §2 says so, and the validator makes it structural rather than a rule somebody has to remember: `reqPushSubscription` returns a **fresh literal** carrying only `transport` and `wakeToken`, so a `url` sent anyway is dropped on the floor rather than stored, and a later edit that wanted to honour one would have to add the field to the contract first and argue with the comment. A test registers a subscription carrying `http://169.254.169.254/…` and asserts both that the stored row does not contain it and that the wake still goes to the configured host.

**2. `transport` is a SEMANTIC enum, so an old relay 400s a new client, and that is correct rather than unfortunate.** P-6 (recorded in ADR-0017's consequences) degrades unknown *descriptive* enum values to a catch-all — `browser` → `other`, `platform` → `unknown` — because those values only label a device and a newer client must still be able to register. `kind` stays strict there because it selects behaviour. `transport` is the same kind of thing as `kind`, only more so: it does not describe the endpoint, it names the **mechanism by which the relay will attempt to reach it**, and there is no catch-all that could stand in. Confirmed by reading `reqPushSubscription` rather than assumed: it is a chain of literal comparisons ending in a throw, so a pre-0032 relay answers `invalid_request` (400) to `transport: 'forwarder'`. Degrading it to `none` would be worse than the 400 in the one way that matters — the phone would pair successfully and then be silent forever, with nothing anywhere to look at.

**3. The capability signal is one additive field on `ServerConfigResponse`, `wakeForwarder?: boolean`, and NO protocol bump.** Additive fields do not move `CLIENT_PROTOCOL` (ADR-0017), and this one must not: bumping would strand every device on every existing relay over a field that only concerns iPhones. It is emitted by `GET /v1/config` **only where `WAKE_FORWARDER_URL` is set**, so a relay without a forwarder is byte-for-byte the relay it was before this ADR — absent, not `false`. An old client ignores unknown fields in both directions, which is already true and already tested.
   - **Modelled on `acceptsNewGroups` (ADR-0022, ADR-0029), including the part that is easy to skip: it is a hint and never the enforcement.** The register call decides; this exists so a client can choose the transport it knows will work instead of discovering a refusal. It says only "configured / not configured".
   - **Never the URL.** `/v1/config` is the one unauthenticated read in the product. Which forwarder a relay rings is its operator's business, no client needs it in order to work, and publishing an internal address on an open route would be a gift to anyone mapping the deployment.

**4. Refuse the registration on a relay with no forwarder; do not accept it silently.** Both options were live, and the argument is asymmetric. Silent acceptance produces a phone that is paired, believes it has background delivery, and never rings — a failure with **no artefact anywhere**: no error, no log line, no field to inspect, and a user who blames the app. Refusal produces a 400 whose message names the cause and the two fixes, on a path where messages ride through to the user verbatim (ADR-0029). And it is a refusal the client can *avoid*: it reads §3's hint first and registers `{transport:'none'}` instead. So the cost of refusing is a diagnostic that a correct client never meets, and the cost of accepting is a silence nobody can debug. Refused at the heartbeat rotation too, because two paths that write the same column must not disagree about what is writable.
   - **`invalid_request` (400), not a new `ApiErrorCode`.** Same measurement ADR-0030 and ADR-0031 made and the same answer: a new code costs four hand-maintained client copy tables and buys nothing here, because the actionable half is the message and the register path already surfaces it verbatim.

**5. `WAKE_FORWARDER_URL` is operator configuration, and the push-egress guard deliberately does not apply to it.** This is the sentence a reviewer will look for, so it is in `config.ts` next to the field, in `push.ts` at the call, and here. `push-egress.ts` guards Web Push endpoints because they arrive in an unauthenticated register body from a stranger; pointing one at cloud metadata has to be impossible. This URL is set by whoever runs the relay, in the same file as `DATABASE_URL` — anyone who can change it can already run code as the relay, so guarding it would buy no security and would break the supported case of a self-hoster running their own forwarder on their own LAN. What it *is* checked for, at boot rather than at first wake: that it parses, that it is http or https, and that it carries **no query string or fragment**, because a wake token rides a header and never a URL (forwarder `PROTOCOL.md` §6, ADR-0009 §3 for the same instinct) and a query string here is either a typo or somebody attaching a secret to every wake. Unset is the default and means today's behaviour exactly: no wake, drain on open, no warning.

**6. `ForwarderWakeSender` wraps the existing sender rather than replacing it, and a wake is bounded and best-effort.** `POST {url}/v1/wake`, `Authorization: Bearer <wakeToken>`, body `{}`. Wrapping, because the two halves are independent — a relay may ring iPhones and serve no browser push at all, or both, or neither — so `createPushSender` layers it over whichever of `WebPushSender` / `NoopPushSender` the VAPID config produced, and everything that is not `forwarder` falls through untouched. `WebPushSender`'s switch gains an explicit `case 'forwarder'` that returns: reaching it means a stored subscription outlived the setting that let it register, which is a configuration change and not a delivery failure, and drain-on-open is what the forwarder's own contract promises anyway. The timeout is **3 s, not Web Push's 10**, because this call sits between "the rows are durable" and "the sender gets its response": every millisecond is charged to somebody's send, and the forwarder answers without waiting for Apple, so anything it is going to say it says quickly.

**7. A forwarder wake can NEVER mark a subscription dead. Only transient, always.** The dead-subscription counter exists for a push service that says *this subscription is gone* — a 404 or 410 that is authoritative about its own registry. The forwarder is constitutionally incapable of saying that: `PROTOCOL.md` §4 makes it answer **202 to a live token, a revoked one and an invented one alike**, precisely so that `POST /v1/wake` is not a token-validity oracle for the internet. So no answer it gives is evidence about the phone. A 404 from that URL means the **URL is wrong**, and counting it would let one misconfigured setting switch off wakes for every iPhone on the relay — endpoints that were never at fault, and that would then need a heartbeat rotation to recover from an operator's typo. Implemented twice over, deliberately: `ForwarderWakeError` carries `status` and not `statusCode`, so it cannot match the shape `isDeadSubscriptionError` looks for, **and** that function tests for the class explicitly, because "this error happens not to carry a `statusCode`" is exactly the accident a later refactor undoes without noticing.

**8. The metadata cost is stated wherever the forwarder is described, in the same words.** §6 of the plan requires it, so `server/.env.example` and `DEPLOY.md` both carry the forwarder's own sentence verbatim: *the forwarder learns that a device received something, and when — never what*, together with the list of what it therefore does not learn, and the fact that a self-hoster may run their own instance or use the project's. A promise this narrow is worth nothing if the metadata it does keep is left vague.

**Not done here, deliberately:**
- **The iOS app registers nothing yet.** Registering with the forwarder, handing the token to the relay, revoking on unpair, and P-5's "instant delivery on by default with an explicit opt-out" are a separate change in `ios/`. `ios/README.md` already anticipated that "a new push transport slot is the only wire change it would need"; this is that slot, and nothing on the phone reads it yet. Until then the only thing that can register `transport: 'forwarder'` is a test.
- **`unifiedpush` and `fcm` are untouched.** ADR-0006 chose them and ADR-0015 explains why Android needs neither; nothing here revisits either, and Android is unaffected by every line of this change.
- **No revoke call from the relay.** Revocation is the app's to do (`PROTOCOL.md` §3.3), on unpair, with the token it holds. A relay that revoked on removing an endpoint would be revoking a credential it does not own, for a device that may still be paired to a different relay.
- **No wake on anything but a send.** Not on a group key, not on an endpoint change, not on a sweep. A doorbell is for "something is waiting".
- **No retry, no queue, no backoff.** A wake that fails is logged once and dropped. Retrying would spend a send path's time on a doorbell, and the thing it would be protecting — the tab — is already durable and already drains on open.
- **No `/admin/status` counter for wakes.** The forwarder keeps the tallies that answer "is this being used" (`PROTOCOL.md` §5); a second, disagreeing count on every relay is not worth the row.

### Consequences / follow-ups

- **Nothing changes for a relay that does not set `WAKE_FORWARDER_URL`.** No new route, no new field on `/v1/config`, no new outbound call, and the one new transport is refused at the door. Every existing client is unaffected, including on relays that do set it.
- **`shared/src/types.ts` grew two sanctioned additive locks** under ADR-0009: `ForwarderSubscription` joins the `PushSubscription` union (the literal set changed by exactly one member), and `ServerConfigResponse` gains optional `wakeForwarder`. Hand-formatted to match, as that file requires. No protocol bump, and `CLIENT_PROTOCOL` stays 3.
- **The compatibility story, both directions.** *Old relay, new client:* the register is refused with `invalid_request` (400), which is honest and which the client avoids entirely by reading `wakeForwarder` from `/v1/config` first and falling back to `{transport:'none'}` — the same delivery model iOS ships with today. *New relay, old client:* nothing at all changes; unknown response fields are already ignored, and no client that does not ask for the forwarder transport can be given it.
- **No client-side typecheck fallout, measured rather than assumed.** Nothing in `extension/`, `console/` or `e2e/` switches exhaustively over `PushSubscription`; each one constructs the single variant it uses (`WebPushSubscription`, `NoPushSubscription`, `unifiedpush`) and never discriminates the union. This is the opposite of what widening `SendRejectionReason` cost in ADR-0030, and the difference is worth naming: that union is *read* by every client's copy table, this one is only ever *written* by the client that owns the endpoint.
- **`reqPushSubscription` now takes a policy object rather than a bare boolean.** Two adjacent booleans at a call site is a defect waiting to happen; the new `PushPolicy` is structurally a slice of `Config`, so both call sites pass `ctx.config` and nothing is unpacked and re-packed on the way in.
- **A target with a LIVE WebSocket is woken anyway, and for the forwarder that is newly expensive.** Verified against the running relay rather than read off the code: with the target connected and its socket already handed the `message` event, `routes/messages.ts` still calls `push.wake`. Harmless for Web Push, which is why nobody has minded. Not harmless here: the forwarder allows **6 wakes per token per 60 s** (`PROTOCOL.md` §6), so a foregrounded iPhone that is already receiving over its socket spends that budget on doorbells nobody needs, and a burst of tabs could leave a *later*, genuinely-needed wake rate-limited. The fix is one `ctx.hub.isOnline(target.id)` check before the wake, it applies to every transport, and it is deliberately not bundled into a change about a transport slot — but it should be the next thing done on this path. **Done 2026-10-01 for the forwarder only** (see the 2026-09-05 amendment below): a redundant Web Push wake costs nothing, and it is what still reaches a device whose socket died without the relay noticing.
- **The wake is still awaited inside the send handler, one target at a time.** That is the pre-existing shape (Web Push has always worked this way) and the 3 s ceiling bounds it, but a batch to several sleeping iPhones on an unreachable forwarder can add seconds to one response. Sending the wakes concurrently, or after the response, is a real improvement and is deliberately not bundled into a change about a transport slot.
- **A relay whose operator removes `WAKE_FORWARDER_URL` keeps stored `forwarder` subscriptions that nothing will ring.** They fall through `WebPushSender`'s explicit case and are silently dropped — right, because the tab still drains on open, but it does mean the refusal in §4 guards registration and not the existing rows. The device recovers by rotating its subscription at the next heartbeat, which is the same self-heal every other transport uses.
- **Nothing here has been run against the real forwarder**, only against an injected `fetch`. `PROTOCOL.md` §11 already records that the forwarder itself has never met real APNs; the first end-to-end proof of this path needs both halves and an iPhone, and belongs with the iOS registration change.
- **Device tokens at rest · 2026-10-02.** The forwarder's store keeps each phone's push address encrypted under a key held outside the database, and the file owner-only, because a copy of it let its holder cut every phone off and ring it through the registration route. Decided in [0034]'s 2026-10-02 amendment (encryption, chosen over proof of possession), which also covers iPhones.
- **A wake token minted by one forwarder is silently useless at a relay ringing another · found 2026-08-20, building the iOS half.** The app picks its forwarder from its own build configuration, the relay picks one from `WAKE_FORWARDER_URL`, and nothing compares them — decision 3 is exactly why nothing *can*, since `/v1/config` publishes that a forwarder is configured and never which. A mismatch produces uniform 202s (`PROTOCOL.md` §4), a relay that logs a delivered wake, and a phone that never rings: the no-artefact silence decision 4 refused, arriving through a different door. Not reachable while no official instance exists; a fix needs an owner ruling against decision 3 and would amend this ADR. Recorded as `PLANS.md` P-9.

### Amendment — 2026-09-05 · exactly 202, and hosted may not put the wake token on the wire

> **Revised 2026-10-01**, after a follow-up review (`SECURITY_REVIEW.md`): both rules
> below held against every bypass tried, and three changes joined them. A redirect from
> the forwarder is now a failed wake rather than a detour (`redirect: 'manual'`); a send
> rings each phone once, not once per tab; and it does not ring a phone whose socket has
> just taken the message, the check this ADR's consequences recorded as the next thing
> to do. That check is applied to the forwarder alone: a redundant Web Push wake is
> free, and it is what still reaches a device whose socket died unnoticed. The
> forwarder's own changes (revoke deferred past its reply, a silent per-device limit)
> are in `forwarder/PROTOCOL.md` §4.

Two defects from the same review as [0031]'s 2026-09-05 amendment, both on decision 4's
own ground: a wake path that fails silently is the thing this ADR set out not to build.

**Any 2xx was read as a delivered wake, and the forwarder has exactly one success
answer.** `PROTOCOL.md` §3.2 and §4 say 202 and nothing else, but `ForwarderWakeSender`
checked `response.ok`. A `WAKE_FORWARDER_URL` pointing at something that is not a
forwarder — a load balancer's health page, a static site, an unrelated API — answers 200
or 204 all day, so the relay logged delivered wakes, left `push_failures` at zero, and
reported a perfectly healthy doorbell while no phone ever rang. That is the no-artefact
silence decision 4 refused, arriving through a third door. It now requires `202` exactly;
everything else raises `ForwarderWakeError`, which is logged once and still never counted
against the endpoint, because a wrong URL is the operator's problem and not the phone's.

**Decision 5's "this URL is deliberately unguarded" needed one exception, and it is a
hosted-posture one rather than a change here.** The reasoning stands for a self-hoster:
whoever can set this variable can already run code as the relay, and a private forwarder
on your own LAN over http is a supported setup. What the reasoning does not cover is that
each phone's **wake token is a bearer credential** — one header, no binding to the
calling relay, no expiry (`PROTOCOL.md` §4, §6), so whoever holds it can ring that phone
from anywhere — and a hosted relay's traffic leaves its machine, so plain http to another
host puts those tokens in the clear on every ring. [0033] gains a rule: under `TABSEND_PROFILE=hosted`, `WAKE_FORWARDER_URL` must
be https, or http to loopback, where there is no wire. Its **presence** is still not
asserted, which was the right call and is a different question.


---

## 0031 — Provisioning needs two factors, suspension deletes nothing, and deletion is one cascade that is safe to re-run

**Status:** Accepted · 2026-08-20
**Relates to:** `HOSTED_PLAN.md` §4.2 (the provisioning API, and the SSRF argument that makes loopback insufficient), §5 (suspend/grace/deletion semantics, and the idempotent cascade), §7 (one machine, two trust domains), §2.2 (aggregate usage only, and the relay that knows no accounts), §2.3 (mechanism open, policy closed) and the **H2 gate**, which this is the third and last relay-side half of; ADR-0029 (the `provisioned` mode this API is the "somehow" for, and its **open question about a suspended tenancy, which this closes**), ADR-0030 (the caps this API sets, and the precedent for measuring a new `ApiErrorCode` against four hand-maintained client copy tables), ADR-0023 (the relay owns its group, and `mintFirstRunPairing`), ADR-0021 (a link only while the group is empty — extended here per group), ADR-0024 (the pairing link is the only credential, so a refusal must not burn one), ADR-0011 (one dialect-agnostic migration for SQLite and Postgres), ADR-0001 (the WebSocket is a latency path, which is why it authenticates once); `server/src/routes/provisioning.ts`, `server/src/tenancy.ts`, `server/src/bootstrap.ts`, `server/src/netguard.ts`, `server/src/config.ts`, `server/src/hub.ts`.

### Context

ADR-0029 shipped `GROUP_CREATION=provisioned` and said out loud what it left unfinished: on such a relay "groups are made by whoever can reach the database". That is honest for the owner's own machine and useless as a hosted product — a signup flow cannot open a psql session, and neither can a billing webhook that needs to suspend somebody at 3am. ADR-0030 then shipped per-group caps as **plain functions rather than routes**, on the explicit grounds that the route exposing them would need authentication and an audit trail that were "not this chunk's decision to make". This is that decision.

Three things had to be settled, and only one of them is about HTTP.

**Who is allowed to call it.** `/admin/status` is guarded by locality alone: loopback peer, no forwarding header. That works there because it is read-only diagnostics a process on the relay's host could reconstruct by opening the database, so the route grants nothing its caller did not already have. The same argument does not survive contact with a route that **creates and destroys tenancies**. Locality is a *location, not an identity*: it cannot tell the control plane from any other process on the same box, and it cannot tell either of them from the relay itself being walked through an SSRF — anything that can persuade the relay to fetch a URL is, from the socket's point of view, a loopback caller. HOSTED_PLAN §4.2 requires **both** factors for exactly this reason.

**What suspension means.** HOSTED_PLAN §5 gives the shape ("a suspended group stops accepting sends and says why; devices stay paired and the data stays put") and names the failure mode to avoid: somebody's card expires on holiday and their devices silently unpair themselves. What it does not settle is the middle of that sentence — whether tabs already in the queue may still be collected, whether acks still work, and whether the group may still invite devices. ADR-0029 left the last one open in as many words.

**What deletion has to survive.** Account deletion spans two systems, so the relay half has to be re-runnable until it reports done. A cascade that answers "no such group" on the second pass would make *already gone* look like a failure, and a control plane that stops there leaves a half-deleted tenant, which §5 calls worse than either state.

### Decision

**1. `/admin/provisioning/*`, six operations, gated on BOTH factors, answering 404 to every failure of either.** Create a group; mint its first pairing link; read and set its caps; read its usage; suspend and resume it; delete it. Access requires the `/admin/status` locality rule **and** a bearer credential (`PROVISIONING_TOKEN`, or `PROVISIONING_TOKEN_FILE` for a secret store; exactly one of the two, validated at boot). The locality test is now **one implementation** shared by both routes (`isDirectLocalCall`, moved into `netguard.ts`) rather than copied — two copies of that test would be two chances to fix one and forget the other, on the guard that decides whether an operator surface is reachable from the internet.
   - **The refusal is the ordinary 404, byte for byte** (`NOT_FOUND_BODY`, now one exported literal so the impersonation cannot drift), never 401 or 403. A 401 would advertise that there is something here worth authenticating to; the surface should be indistinguishable from a typo to anything scanning the relay. The operator still gets a `warn` line naming **which** factor failed, because "you called from the wrong place" and "your credential is stale" have completely different fixes.
   - **Comparison is constant-time over SHA-256 digests**, not over the raw strings. `timingSafeEqual` throws on a length mismatch, which would turn a wrong-length guess into an exception rather than a refusal and leak the expected length.
   - **Unset credential means the routes are not registered at all** — not registered-and-refusing. A self-hosted relay that never sets one is byte-for-byte the relay it was before this ADR, and `/admin/provisioning/…` there is a 404 because nothing is there. A credential that is *set but empty*, or short enough to guess, is a **boot error** instead: the failure this refuses to allow quietly is an operator who believes the API is protected, or believes it is reachable, and is wrong.

**2. Suspension is an ACCEPTANCE gate and nothing else, held in `groups.suspended_at`.** One additive nullable column (`// ADDITIVE [0031]`, migrated in place in both dialects, legacy-upgrade test included). Refused while suspended: **sending**, **joining**, and **minting a pairing link** — everything that adds work or devices to a tenancy nobody is currently paying for. Untouched: device tokens, collection of already-queued tabs, acks, group history, the endpoint list, heartbeats, live WebSockets.
   - **Letting the queue drain is not generosity, it is the only coherent answer.** Those tabs were accepted while the group was running, and **ack is what erases their ciphertext** (ADR-0011). A suspension that blocked acks would make the relay hold somebody's encrypted data *longer* because they stopped paying, which is the opposite of every promise in `SECURITY.md`.
   - **`POST /v1/group-keys` stays open**, deliberately. With joins refused it can only serve devices that are already members, and refusing it would break history reading (ADR-0028) for devices that are still paired and still entitled to read what they already have.
   - **A timestamp, not a flag**, because "since when" is the question a grace period is counted from — and re-suspending an already-suspended group **keeps the original timestamp**, so an idempotent retry of a webhook cannot silently restart the clock.
   - **Not spelled as "caps to zero"**, which is how §5's kill switch is described in passing. A cap says *how much* and suspension says *whether*; more practically, zeroing the caps would destroy whatever numbers the operator had set, and lifting the suspension would have to guess them back.
   - **This closes ADR-0029's open question**: yes, a suspended tenancy refuses `/v1/pairing`. It is refused at the mint as well as at the join, because a link that register would then turn away is worse than a refusal — the user would carry a credential they believe works and find out on the new device. A link minted **before** the suspension stays valid and is refused at register instead; invalidating outstanding links would mean deleting rows, and suspension is the one operation whose whole promise is that it deletes nothing.

**3. The refusal code is `forbidden` (403), reusing rather than minting, and it was measured the way [0030] measured its own.** ADR-0030 gave the extension's `relayErrorLine` and `rejectionLine` an unknown-code fallback, so a new `ApiErrorCode` would no longer break its typecheck — the objection that decided ADR-0029 is genuinely gone. It was still the wrong answer, for the opposite reason: with a new code **all four clients** fall through to "Something went wrong inside your relay", which is strictly less informative than what `forbidden` already produces. Measured, not assumed: `extension/src/lib/strings.ts`, `android/…/SendFeedback.kt` and `ios/…/SendFeedback.swift` each carry copy for `forbidden` today, and the extension's `classifySendFailure` treats 403 as **final** rather than as `relay-busy` — which is right, because a suspension clears when somebody acts, not on its own. The cost is stated rather than glossed: on a **send**, all three clients say "Your relay wouldn't let this browser send to *device*", which reads as a per-device permission problem rather than a tenancy state. It is not a lie — the relay did refuse — but it is the wrong flavour, and it is the strongest argument for the cross-client copy pass that [0030] already named as a follow-up. On the **register** path the message rides through verbatim (ADR-0029), so the join refusal reads exactly as written.

**4. The first pairing link is generalized per group, and the "only while empty" rule comes with it.** `mintFirstPairingForGroup` is ADR-0023's mechanism with the group named rather than assumed; `mintFirstRunPairing` becomes a thin `single`-mode wrapper over it, so boot and provisioning run the same code and the bootstrap TTL is one number. The rule it carries across is ADR-0021's, extended: **refused the moment the group holds any endpoint.** On a single-group relay that is what makes the boot-log link safe — the relay stands in for a member only while there is no member to stand in for. On a provisioned relay it is what stops the control plane, and therefore anyone who takes over an account's email, from minting a way into a **populated** group. That is precisely the bootstrap window HOSTED_PLAN §5 scopes, and this is the relay-side half of keeping it small.

**5. Usage is aggregates, and the shape is a boundary rather than a convenience.** Endpoint count, live queue depth, queued bytes, oldest-pending age, cap values, remaining headroom, suspended state, `created_at`. Every predicate mirrors `caps.ts` exactly, so the number a control plane reads and the number that refuses a send are counting the same rows. **Never** endpoint labels, device names, per-endpoint rows, push details or message ids — §4.2 names `/admin/status`'s device listing as the exact thing this must not become, or §2.2's "aggregate usage only" stops being true. A test asserts that over the live response, by key at every depth **and** by value, because a key check alone would pass a response that merely renamed the field.

**6. Deletion is one transaction, seven statements, idempotent by construction.** `messages` (queued ciphertext and the history blobs riding those rows), `group_keys`, `pairing_codes` (including unconsumed ones), `removed_endpoints` (the tombstones), `endpoints` — which is where `device_token_hash` lives, so deleting the row *is* revoking the token (ADR-0024) — `quota_counters` for `group_sends`, and finally the `groups` row, which carries the cap overrides and `suspended_at` as columns and so needs no statement of its own. **Order is load-bearing**: two of those group_id columns are real foreign keys and SQLite runs with `foreign_keys = ON`. Every statement is a group-scoped DELETE, so a second pass deletes nothing and still answers 200 with `existed: false`.
   - **The live WebSockets of the deleted endpoints are actively closed** (`Hub.disconnectGroup`, 1001 going away), after the commit. A socket authenticates ONCE, in its hello frame (ADR-0001), and then holds its registration for as long as it stays open. Nothing could still reach those sockets — there is no group left to broadcast to, and every HTTP call re-authenticates against a row that is gone — so this is not a hole being closed; it is the difference between "deleted" and "deleted, and the devices were told" instead of a socket idling for up to 90 seconds.
   - **A deleted tenancy's devices hear `unauthorized`, not `endpoint_removed`**, because the tombstones go too. That is deliberate: the client is told to hold on to its pairing rather than to wipe itself, which is the same answer a relay restored from a backup gives, and the relay genuinely cannot tell the two apart.

**7. The relay keeps an audit MIRROR; the control plane keeps the record.** One structured line per call — operation, group id, caller-supplied correlation id (`Idempotency-Key` or `X-Request-Id`, bounded and stripped to printable ASCII so a caller cannot forge a log entry), outcome, and the counts a destructive call produced. Written from an `onResponse` hook, so there is exactly one line per call whatever happened inside, refusals included, and the outcome is the status actually sent rather than what a handler believed it was sending. **IDs and sizes only**: the mint response is the one place in the module where a pairing link exists, and its audit line records the **expiry**, never the link. HOSTED_PLAN §4.2 keeps the authoritative append-only log in the control plane, shipped off-host with the backups, precisely so a later relay compromise cannot rewrite the history of what was asked of it — a mirror the compromised process owns could never do that job, and pretending otherwise would be the security theatre version of this ADR.

**Not done here, deliberately:**
- **No accounts, no emails, no billing state on the relay.** Nothing in this API takes an account id, a plan name or a payment status. A tenancy on the relay is a group row with caps and a suspension timestamp, which is what keeps §2.2's table true and ADR-0003 with it. The `group → account` mapping stays in the closed control plane, and so does every decision about *when* to call any of these six operations (§2.3).
- **No per-endpoint diagnostics through this API.** `/admin/status` keeps the device listing and stays operator-local, reached on the relay's own host. Two surfaces with two audiences, and the split is the promise.
- **The unix socket of HOSTED_PLAN §7 is deployment-deferred, and this is the reason rather than an omission.** A unix socket has **no peer address**, so `isDirectLocalCall` cannot run on it at all: the socket listener would need a *different* access rule from the TCP one, and the both-factors rule this ADR is built on would have an exception carved into it on the first day. The second factor there is a filesystem mode and an owner — a `chown` the relay cannot perform, decided by the deployment's users and, under the recommended Docker shape, by a shared volume and a matching uid. Shipping the socket while the enforcement lives somewhere the relay cannot see would advertise a boundary it does not hold. The credential and the locality rule hold on the TCP listener either way, the socket is purely additive on top, and it belongs with the hosted deployment configuration that can actually set its permissions.
- **No `Idempotency-Key` semantics**, only correlation. The key is logged so the relay's mirror can be lined up with the control plane's entry; it does not deduplicate. Five of the six operations are naturally idempotent (delete, suspend, resume, set caps, read), and the two that are not — create and mint — are the two where a silently replayed answer would be worse than a second call the caller can see and reconcile.
- **No relay-side grace period.** §5's 90 days is a control-plane policy: it decides when a suspension becomes a deletion, and calls this API to do it. `suspended_at` is here so that clock has something to count from, and nothing on the relay reads it on a timer.

### Consequences / follow-ups

- **Nothing changes for a self-hosted relay.** No credential means no routes. No group is ever suspended unless something calls the API, and `suspended_at` on every existing group is NULL, which reads as running.
- **`shared/src/types.ts` is untouched.** No protocol bump, no new `ApiErrorCode`, no new wire literal — the one contract change this work could have forced was the suspension refusal code, and §3 above is why it did not. The only client-visible change is that three existing routes can now answer `forbidden` in a situation they previously could not, which every shipped client already renders.
- **The `forbidden` copy on a SEND is the known wart.** "Your relay wouldn't let this browser send to *device*" is true and misleading at the same time. It joins `limit_reached` on the cross-client copy list [0030]; both want the same pass across extension, Android, iOS and console, and both are honest enough in the meantime that shipping without it is not a regression.
- **`effectiveCaps` gained a row-level sibling.** `capsFromRow` splits the resolution out of the read, and `readGroupGate` (tenancy.ts) does ONE select for both the suspension state and the caps. Without it the send and register paths would each have gained a round trip per call on every relay, capped or not — which [0030] went out of its way to avoid and this must not undo.
- **`/admin/status` gained `groups.suspended`, a relay-wide count.** Not per-group state, which belongs to this API: it exists because an operator debugging "sends are being refused and I do not know why" would otherwise have no way to see that a suspension is the answer short of reading the database.
- **The migration suite now covers `suspended_at` in both dialects**, including that it arrives nullable — NULL is the only spelling of "not suspended", and a NOT NULL DEFAULT would have needed a sentinel timestamp meaning "not really" that every reader would have had to know about.
- **`WsSocket` grew an optional `close`.** Optional so the existing test doubles are unaffected; the real `ws` socket always has it, and `disconnectGroup` is the only caller.
- **The credential is a new secret to hold, rotate and eventually leak.** That is the trade §4.2 accepts on the grounds that the alternative is worse, and it is worth restating what it does not buy: it defends against everything else on the machine, and against nothing at all if the relay process itself is compromised, because that process owns the database and needs no API.
- **The `groups` row is now the tenancy record**, which nothing had quite been before: caps, suspension, and the id the control plane maps an account to. Anything added to it later should be checked against §2.2's table before it lands, because the honest claim "the relay knows no accounts" is a claim about the columns of exactly this table.
- Open: **nothing has been run against a real control plane**, because there is not one yet. The suite drives all six operations end to end against a live relay in both dialects, which is the most that can be proved from this side.
- Open: **`quota_counters` rows keyed `register_ip` survive a tenancy deletion.** They are keyed by client IP, not group, so there is nothing group-scoped to delete; they age out on the sweeper's normal schedule. Worth knowing rather than fixing — the alternative would be storing which group an IP registered into, which is more retained metadata than the deletion saves.
- **Closed 2026-08-20: `Idempotency-Key` is now honoured on create, not merely logged.** As shipped, the header fed the audit line's `requestId` and nothing else, so the one call where a retry is expensive was the one call that was not idempotent: a create that succeeded and timed out on the way back left the account owning two tenancies, and the relay knows no accounts, so nothing anywhere would ever have connected the second one to anybody. The fix is a small additive table (`provisioning_idempotency`: key primary key, group id, created at) and one transaction that claims the key and creates the group together — the key's PRIMARY KEY is what decides a race, not a JavaScript branch, the same shape [0030]'s caps use. A repeat of a key answers **200** with the group the first call made (201 stays honest as "created"), and a call with no key behaves exactly as it always did. The row is a record of a CALL and deliberately outlives the group, so a create retried with the same key after a deletion answers `not_found` rather than resurrecting a tenancy somebody tore down; `deleteGroupCascade` leaves it alone for that reason. Other operations need none of this: they are already idempotent by shape (PATCH caps, suspend/resume, the delete cascade). The first-pairing mint is not, and deliberately: a second call on an empty group mints a second first link, and both stand until the first device joins and retires the other (this ADR's 2026-09-05 amendment, as revised 2026-10-01).

### Amendment — 2026-09-05, revised 2026-10-01 · three tenancy races, found by review, and what closes each

An adversarial read of the landed hosted work against `HOSTED_PLAN.md` turned up three
defects on this ADR's surface. All three are reachable on Postgres, which is the dialect
hosted runs (0033), and two of them lose data or hand out a credential. They are not
Postgres-only, which the first version of this amendment claimed: pairing-code growth and
a second live first-run link need no race at all and were live on every self-hosted
relay, and on SQLite a deletion's transaction can still run between two statements of
somebody else's request.

A follow-up review on 2026-10-01 (`SECURITY_REVIEW.md`, "Follow-up review") found the
first version of these fixes unfinished: it introduced a Postgres deadlock, broke the
pairing link a self-hosted relay had printed before a restart, and left a device removal
unordered. What follows is the design as revised; each revision says what it replaced.

**1. Deletion was atomic but not ORDERED, so it could leave what it reported deleting.**
`deleteGroupCascade` ran every statement in one transaction, which is what makes it
all-or-nothing. It is not what makes it final. A send or a group-key upload that had
already read past the group row could commit its own row **after** the teardown had
swept `messages` and **before** it removed the `groups` row: the control plane is told
the tenancy is gone, and the ciphertext or the sealed key material is still on the disk,
in a table nothing will ever look at again. Those two tables were exposed because they
are where those writes land and their `group_id` is not a real foreign key, so nothing
underneath refused the row; `removed_endpoints` and `quota_counters` have none either,
and their writers are ordered by the same hold below.

- **The group row is HELD, FIRST, by every path that writes a group-scoped row.**
  `lockGroup` (caps.ts) grew from a Postgres-only `SELECT … FOR UPDATE` into "take the
  row and say whether it is still there". The deletion takes it before it deletes
  anything; the send, the group-key upload, a device's link mint, the first-link mint,
  the join and the device removal take it before any other row lock. Both orders that
  remain are correct: a writer that gets the row first commits and is swept by the
  teardown behind it; a writer that arrives second blocks, is released when the teardown
  commits, re-reads under a fresh snapshot, finds no group, and writes nothing,
  answering `not_found` with a message saying so rather than 500-ing.
- **One lock order, group row first [revised 2026-10-01].** The first version took the
  row too late on the join: the join consumed its pairing code and only then reached the
  group row, through its endpoint insert's foreign key, while the deletion and the
  first-link mint held the group row and then deleted pairing codes. Two locks taken in
  opposite orders deadlock, and Postgres broke the cycle after a second by failing one
  side with a 500: a join, a mint, or a deletion its owner had asked for. Measured at 21
  deadlocks in 40 natural join-versus-re-mint races. The join now takes the group row
  before it consumes its code. And it judges the code first, without a lock: a used,
  expired or retired code is refused before anything is locked or queued, because a
  join needs no device token, and taking the row for a dead code let anybody holding one
  park pooled connections behind a group's row.
- **Targets are read under the hold, and a removal takes it too [revised 2026-10-01].**
  The device removal wrote its tombstone outside any transaction, so a removal racing a
  deletion could leave a token hash naming a tenancy reported as gone. And the send and
  the upload read their targets before taking the row, so a removal landing in between
  left a tab or a key copy stored for a device no longer in the group. Both now happen
  inside the hold, and the removal also closes the removed device's open WebSocket,
  which until then went on receiving the group's broadcasts (every later device's name
  and public key included) although its token had stopped working. A removal re-reads
  its own caller under the hold, as a mint does, so a device removed a moment ago cannot
  make one last removal of somebody else.
- **Authentication refuses a device that vanished mid-request [revised 2026-10-01].** It
  read the endpoint, then wrote its presence, and ignored a write that found no row. A
  removal or a deletion landing between the two let the request carry on as a device
  that no longer existed, which is how a WebSocket hello straddling a deletion
  registered a socket for a deleted tenancy. A presence write that finds nothing is now
  answered like the unknown token it has become.
- **This overturns [0030]'s "an uncapped relay pays for nothing".** The lock used to be
  taken only where a cap could refuse (`capsActive`), which is what left the uncapped
  path unserialised. It is now taken on every group-scoped write. What the caps still
  decide is which INSERT runs — an uncapped relay runs the same unguarded statement it
  always ran — so the cost is one indexed read and a transaction on a path that already
  ran N inserts.
- **Waiting writers wait in memory, not in the pool [revised 2026-10-01].** Holding the
  row on every write meant every request waiting for it held a pooled Postgres
  connection while it waited, and the pool is shared by every tenant: nine concurrent
  uploads from one group stalled an unrelated tenant's requests for as long as the row
  was held. Group-scoped writes now queue per group in process before they take a
  connection (`server/src/group-queue.ts`), so one group occupies at most one connection
  on these paths however hard it pushes; joins queue the same way, once their code has
  named a group. The row lock stays the authority, across relay processes and against
  the deletion. The pool's size (10) and a 10 s limit on waiting
  for a connection are now explicit.
- Adding the missing foreign keys was weighed and rejected: SQLite cannot add one to an
  existing table without rebuilding it, which is the destructive migration this project
  does not ship (ADR-0011).

**2. The first-pairing mint checked emptiness and inserted in two separate steps, and
nothing retired the links it left behind.** Both halves break the same promise — §5's
"the account page cannot mint into a populated group", which is what makes an account
takeover recoverable. The race: a device joining between the check and the insert
leaves a link minted *for an empty group* that is in fact a link into a populated one.
The gap that needs no race at all: two mints on an empty group (two boots of an unpaired
relay, or two looks at an account page) produce two valid links, the first device
consumes one, and the other stays a live credential nobody revoked.

- **One transaction holding the group row**, so the check and the insert cannot be
  straddled by a join, which takes the same row first.
- **No unclaimed first link survives the first join [revised 2026-10-01].** The join
  that makes a group non-empty retires every other unconsumed code the group holds, in
  its own transaction and under the hold the mints take: a mint either lands first and
  is retired there, or lands after and finds a device. Retired by pulling each code's
  expiry back to its creation time (or to now, if that is earlier), which no real code
  has, so the row says what happened without a schema change and whoever tries it later
  is told "this setup link stopped working when the first device joined this group"
  rather than "unknown link". Until somebody pairs, several first links can be live at
  once, and that is safe: each one is a way to become the group's FIRST device, which is
  what it was minted to be. The first version did this at the mint instead, deleting the
  group's earlier links every time a new one was minted. That closed the hole at a
  price: each restart of an unpaired self-hosted relay killed the link the previous boot
  had printed, a second look at an account page killed the link already on screen, and
  the delete was one half of the deadlock above.
- **A device's own mint refuses a caller removed mid-request**, under the hold the
  removal takes, so a device cannot walk away with a link into the group it was just
  removed from, and a last device's in-flight mint cannot land in a group it has emptied.
- The provisioning route's mint answers 404 when the group was deleted under it, where it
  used to read that as "already has a device".

**3. Pairing codes were unbounded in both directions.** `POST /v1/pairing` wrote a row
per call with nothing counting them, and nothing anywhere deleted a code once it was
used or expired. One authenticated device could therefore grow a relay's database
without end, past every cap, because the caps govern the message queue and this is not
one.

- **`PAIRING_CODES_MAX_LIVE` (default 20, `0` switches it off)** bounds the codes a group
  is *holding* — unconsumed and unexpired — inside the WHERE of the insert that would
  exceed it, under the same hold on the group row, so racing mints produce one row rather
  than several. Both halves are load-bearing: with the statement alone, mints arriving
  together each count the same pre-insert total and overshoot (`caps.test.ts` pins this
  by holding the row itself and queueing six mints behind it). Refused with
  `limit_reached` (409) saying how long to wait. **On by default**, unlike the per-group
  caps, because it bounds a table rather than a tier: a link is minted to hand to a
  device in front of you and it expires in ten minutes, so nothing legitimate comes near
  it. It is relay-wide and deliberately not a per-group override — no column, no
  provisioning field, nothing for a control plane to set. Parsed as a whole number of 0
  or more, and anything else stops the relay at boot: Postgres refused a fraction there
  on every mint, so `2.5` made every pairing link a 500.
- **The sweeper drops a code once it is past expiry by the tombstone grace.** Dated by
  `expires_at` rather than by consumption, so the register route can still answer "this
  link was already used" rather than "unknown link" for as long as any other tombstone
  survives.

**Also on this surface: `/admin/provisioning/…/usage` was silent about group-key
storage.** It reported queued messages, stored bytes and endpoints, and said nothing
about `group_keys` — a table that grows with traffic, is held for the whole history
window, and was governed by no cap. A tenant filling a relay's disk through it looked
healthy in the one number an operator would have gone looking for. Usage now carries
`groupKeys: { copies, bytes }` as its own figure rather than folded into `queue.bytes`,
because it is bounded by different things (see [0028]/[0030]'s amendment below).

- Tested with deterministic Postgres concurrency tests (`server/test/tenancy-races.test.ts`,
  helpers in `server/test/locks.ts`): each one holds the group row from the test, starts
  the operations one at a time, and confirms each one is WAITING behind that hold, by
  asking Postgres who blocks whom, before starting the next. A path that stopped taking
  the row therefore fails the wait instead of passing on a fast machine; the first
  version slept a fixed 250 ms instead, which decided nothing. Each test was run against
  a relay with its own fix undone and observed to fail. The branches a vanished group
  reaches run on both dialects (`server/test/group-gone.test.ts`).


---

## 0030 — Per-group caps are one refusal with a named limit, counted by the database

**Status:** Accepted · 2026-08-20
**Relates to:** `HOSTED_PLAN.md` §4.3 (per-group caps and their contract), §4.4 (shared-store quotas), §10.1 (the measured bar: *exactly* enforced at 10× overload), §3 (the relay knows no accounts) and the **H2 gate**, which this is the second half of; ADR-0029 (the first half, and the precedent for weighing a new `ApiErrorCode` against four hand-maintained client copy tables), ADR-0012 (the in-process rate limiter, whose "per-instance on purpose" note this amends), ADR-0009 (the wire contract and what "additive" costs), ADR-0008 (what "Sent" means, and why "Sent 2 of 3" is already honest), ADR-0011 (one dialect-agnostic migration for SQLite and Postgres), ADR-0024 (the pairing link is the only credential), ADR-0028 (`history_blob` — originally ruled *outside* the byte cap here, and **inside** it since this ADR's 2026-08-20 amendment); `shared/src/types.ts`, `server/src/caps.ts`, `server/src/quota.ts`, `server/src/ratelimit.ts`, `server/src/routes/messages.ts`, `server/src/routes/endpoints.ts`, `server/src/db/`.

### Context
Three gaps, and they only look like one problem from a distance.

**The relay could not refuse anything for being too much.** A group may hold any number of endpoints, queue any number of messages of any size, and send as fast as it can open sockets. On a household relay that is right: the person absorbing the cost is the person making it. On a relay somebody else runs it is not a policy at all, it is an assumption that everyone is the operator.

**The contract had no way to SAY a cap.** `ApiErrorCode` had no cap refusal and `SendResponse.rejected[]` had no cap reason (`shared/src/types.ts`), so even a correctly enforced cap could only be reported as something it was not. `HOSTED_PLAN` §4.3 is explicit that the contract, not the counting, is the actual work.

**The counters were in one process's memory, on purpose.** ADR-0012 recorded the register rate limiter as a `Map`, per-instance to match the single-instance WebSocket hub, and that reasoning was sound for a *hub*: split it and you lose latency, never correctness. It was never sound for a *limit*. Two relay processes over one database each hand out the full `RATE_LIMIT_MAX`, the effective limit is silently double what the operator configured, and nothing anywhere reports it. §10.1 asks that every cap stay exact under a further 10× overload; a limiter that is wrong by a factor of the instance count is not approximate under pressure, it is wrong at rest.

### Decision

**1. Four caps, generic, off by default, with per-group overrides on the group row.** `CAP_ENDPOINTS`, `CAP_QUEUED_MESSAGES`, `CAP_QUEUED_BYTES`, `CAP_SENDS_PER_WINDOW` (+ `CAP_SEND_WINDOW_SECONDS`) are relay-wide defaults, every one `0` = unlimited, so a relay that sets none of them runs **the same SQL it ran before this ADR** — the guarded paths are not merely inert, they are not entered. Four additive nullable columns (`groups.cap_*`) hold per-group overrides, written by `setGroupCapOverrides` / read by `getGroupCapOverrides` in `server/src/caps.ts`: plain functions, not routes, because the §4.2 provisioning API is what will expose them and its authentication and audit trail are not this chunk's decision to make. **NULL and 0 are different answers and stay different** — NULL is "nobody set one here, follow the relay", 0 is "somebody set unlimited here". Collapsing them would make every deliberate exemption evaporate the next time an operator raised a relay-wide default, silently.

**2. ONE reason literal plus a named detail, not four literals — and this is the deliberate half of §4.3's "named so ADR-0008 clients can say *which* limit was hit".** `SendResponse.rejected[]` and its `/v1/group-keys` twin gain `reason: 'limit_reached'` and an optional `limit?: GroupLimit` (`'endpoints' | 'queued_messages' | 'queued_bytes' | 'sends_per_window'`). The alternative — a distinct reason literal per cap — was rejected on evidence rather than taste. Every client carries a **hand-maintained copy table** for these reasons (`extension/src/lib/strings.ts`, Android's `SendFeedback.kt`, iOS's `SendFeedback.swift`), exactly the cost ADR-0029 weighed when it declined to mint a new error code; and the TypeScript ones switch on the union **exhaustively**, so a widened union does not degrade gracefully there, it fails to compile (measured: adding one literal produced `TS2366` in two functions). Four literals is that cost four times over for one concept, and a fifth cap later would cost it again. One literal plus a field costs it once, forever: a client that ignores `limit` still says something true, and a client that cannot match an unknown literal says nothing at all. The reason set is now the **named** type `SendRejectionReason`, shared by both responses instead of copied into each — the twins drifting apart is precisely what breaks a client that maps both through one function.

**3. `ApiErrorCode` gains `limit_reached`, at 409, for the register path only.** The endpoint cap is the one cap that refuses a whole request rather than an item, and it does so on `POST /v1/endpoints/register`. 409 for the same reason `group_exists` is 409: the call is well formed and would have succeeded one device ago, so it conflicts with existing state. **Not 429**, and that was the tempting wrong answer: every client reads a 429 as "not now, hold the tab and retry" (`extension/src/lib/health.ts` maps it to `relay-busy`; Android and iOS to `RelayBusy`), so a permanently full group would be retried forever instead of reported. No detail field was added to `ApiError`: only one cap can ever answer here, so the code already names it and the message carries the actionable half, which register-path clients surface verbatim (ADR-0029).

**4. Every cap is decided inside the WHERE clause of the statement that would exceed it. Never in JavaScript.** Endpoint count and both queue caps are guarded single-statement inserts — `INSERT INTO … SELECT ?,?,… WHERE (SELECT count(*) …) < ?` and, for bytes, `AND (SELECT coalesce(sum(octet_length(envelope)),0) …) + ? <= ?`. Zero rows affected *is* the refusal. A check-then-insert was rejected outright: it is wrong at every level of load, not just under it.
   - **Atomicity per dialect, stated because the two are not the same argument.** SQLite needs nothing more: better-sqlite3 is synchronous, and Kysely serves it one connection behind a mutex, so no second writer exists to interleave. **Postgres needs more, and this is the part that is easy to get wrong**: under READ COMMITTED every statement takes its own snapshot, so two concurrent senders both see the pre-insert count and both write, overshooting by one per racer. The fix is a `SELECT id FROM groups WHERE id = ? FOR UPDATE` inside the same transaction: the loser blocks, and the guarded insert it then runs takes a **fresh** snapshot that already contains the winner's row. The lock is per group (two groups never wait for each other) and is taken **only when a cap is in force**, so an uncapped relay is not serialised for machinery it did not ask for. `server/test/caps.test.ts` proves this is load-bearing rather than decorative: with the lock removed, the Postgres run overshoots and the suite fails.
   - **Sends-per-window needs no lock at all**, because its statement is already exact on both dialects: `INSERT … ON CONFLICT (…) DO UPDATE SET hits = hits + 1 WHERE hits < ?`. Postgres re-reads the live row under `ON CONFLICT DO UPDATE` rather than the statement snapshot, which is the one place READ COMMITTED gives exactness for free.

**5. The semantics `HOSTED_PLAN` pinned, implemented exactly, with the two places they needed a ruling.** Byte caps measure the **stored envelope** (`octet_length(envelope)`), not a client's claim and not the plaintext the relay cannot read; only live rows count (unacked, unexpired, envelope present), so a group at its cap drains itself as its devices read their tabs. **An idempotent replay of an already-accepted item counts nothing at all** — not a slot, not a byte, not a unit of the window — because it already occupies exactly what it occupied the first time, and counting it twice would let a client retrying a timed-out request talk itself out of its own quota. `ON CONFLICT (id) DO NOTHING` remains the dedupe point underneath; a zero-row guarded insert is disambiguated by one re-read, so "deduped" is never mistaken for "capped". **Batches keep per-item accept/reject semantics**, so a cap may split one, which every client already reports honestly ("Sent 2 of 3", ADR-0008). The two rulings: `history_blob` is **outside** the byte cap, because it is governed by `HISTORY_RETENTION_DAYS` and survives ack on purpose (ADR-0028), and folding it in would make the delivery-queue cap drift with a retention setting that has nothing to do with delivery — **this half is AMENDED 2026-08-20 (see the amendment below): it left stored bytes unbounded, and the cap now counts retained blobs too**; and the send window is spent **before** the queue guard runs, so an item a queue cap then refuses has still cost a unit — the alternative is inserting a row and compensating with a delete, and windows are short enough (60 s by default) that the group gets it back almost immediately.

**6. The counters move to a shared store, and ADR-0012's note is amended rather than overturned.** One table, `quota_counters (scope, key, window_start, window_end, hits)`, primary key on the first three, with the atomic upsert-increment above. `register_ip` holds the rate limiter's per-IP buckets; `group_sends` holds the sends-per-window cap. Windows are **aligned** to a multiple of their length rather than started by the first hit, which is what lets two processes compute the same row from the same wall clock instead of each getting its own phase. `window_end` is stored rather than derived so the sweeper can drop finished windows without knowing what window length produced them, which matters the first time an operator changes `RATE_LIMIT_WINDOW_SECONDS` between boots. Expired windows are dropped by the existing TTL sweeper (`sweep.ts`) — the relay's one housekeeping clock — as a third, unrelated job that shares no retention rule with messages. **ADR-0012's "per-instance ON PURPOSE" still stands for the WebSocket hub and is now wrong for the limiter**, so `ratelimit.ts`'s header says so instead of repeating it. Everything the operator sees is unchanged: same `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_SECONDS`, same key (client IP, respecting `TRUST_PROXY`), same `rate_limited` (429) with `Retry-After`, same fail-safe direction when a proxy collapses clients into one bucket. What is new is that the store can be unreachable, and then register fails **closed** with a 500 — which costs nothing, because register cannot complete without the database either way.

**7. Register became one transaction, which is a caps consequence worth naming on its own.** The endpoint cap can only be known after the pairing link identifies the group, and the link is consumed on the way there. Refusing afterwards would burn a **single-use credential** — the only credential in the product (ADR-0024) — and charge the user a link per attempt at a group they cannot prune. So the whole join now commits or rolls back together: a capped join leaves the link unused and still good once somebody makes room. It also closes an older hole nobody had written down, where a crash between "consume" and "insert the endpoint" burned the link with nothing to show for it. The group-added WebSocket announcement moved **after** the commit, because a rollback must not tell a group about a device that does not exist.

**Not done here, deliberately:**
- **No client copy for `limit_reached`.** All four clients fold an unrecognised refusal into their generic "something went wrong inside your relay" line. Real copy is a cross-client change (extension, Android, iOS, console together) and belongs with the surface that will actually produce these refusals.
- **No suspension.** "Caps to zero as a kill switch" is `HOSTED_PLAN` §4.2's, along with the provisioning API that would set them; ADR-0029's open question about whether `provisioned` should refuse a `/v1/pairing` mint for a suspended tenancy therefore stays open. The endpoint cap is enforced at register rather than at mint, so a link already in somebody's hands stays honest until it is used.
- **No per-account limits**, because the relay knows no accounts (`HOSTED_PLAN` §3, ADR-0029). Every cap here is a number on a group row that somebody set.
- **No cap counters on `/admin/status`.** Per-group usage is an aggregate the provisioning API owns (§4.2), and the endpoint-level view stays operator-local.
- **`/v1/group-keys` never emits `limit_reached`** *(superseded 2026-10-01: the amendment below gives it a structural bound of 64 copies per device, refused with `limit_reached`)*. Its union carries the literal because the two reason sets are one named type; the caps govern the message queue, and refusing a group-history key to a group that is merely full would break key distribution (ADR-0028) for no benefit.

### Consequences / follow-ups
- **Nothing changes for a self-hosted relay.** Every cap defaults to unlimited, no cap column is written at group creation, and with no cap in force neither the transaction nor the lock nor the guarded SQL is reached.
- **`shared/src/types.ts` grew a sanctioned additive lock** under ADR-0009: `ApiErrorCode` gains `limit_reached`; `SendRejectionReason` is a new **named** type carrying the existing three literals plus `limit_reached`; `GroupLimit` is new; both `SendResponse.rejected[]` and `GroupKeyResponse.rejected[]` gain the optional `limit`. The literal set changed by exactly one member. One stale comment was corrected in passing: `rate_limited` was still annotated "reserved; not emitted in v1", which stopped being true when ADR-0012 shipped the limiter that emits it.
- **The compatibility cost is real and asymmetric, so it is stated rather than summarised.** Android and iOS already fall back to a generic line for an unknown reason or code, and the console reads neither, so all three degrade quietly. The extension did **not**: `rejectionLine` and `relayErrorLine` were exhaustive switches with no default, so a widened union broke its typecheck, and at run time an unrecognised reason had always fallen out of the switch and returned `undefined` straight into the banner. Both switches gained the unknown-reason fallback the other clients already had. That is a latent bug fixed, not new copy — but it is a change outside `server/` and `shared/`, and a reviewer should see it as one.
- **A windowed cap reads as permanent to every shipped client.** `limit_reached` arrives as a per-item rejection, which clients treat as final and stop holding the tab for. That is right for the endpoint and queue caps and **wrong for `sends_per_window`**, which clears itself in under a minute. Whoever writes the client copy has to map that one `limit` value into the hold-and-retry class, and that is the strongest single reason the copy work is a named follow-up rather than an optional polish.
- **A capped group serialises its own writes on Postgres.** That is the price of exactness and it is charged per group, only while a cap is on. It has not been measured at the §10.1 load model; doing so is part of H2's load evidence, not of this change.
- **SQLite remains single-process.** The shared store makes the *limits* honest across instances; it does nothing about two relay processes over one SQLite file, which would contend at the file lock. Postgres is the multi-instance story, as `DEPLOY.md` already says.
- **`quota_counters` is the first table that grows with request volume rather than with devices.** Bounded by the sweeper, and the sweeper is now load-bearing for something other than privacy. A relay running with `SWEEP_INTERVAL_SECONDS=0` and a rate limit on will accumulate one row per IP per window forever; that combination is not refused at boot, and probably should be looked at.
- **The migration suite covers both dialects for the new columns and the new table**, including that the cap columns arrive **nullable** — if the ALTER ever landed as `NOT NULL DEFAULT 0`, every pre-existing group would become permanently exempt from a cap its operator later set, and only a test would notice.
- **A trap worth writing down, found the hard way.** A query on `ctx.db` inside a Kysely transaction **deadlocks on SQLite** (one connection, behind a mutex), and handing the same probe a transaction instead **breaks on Postgres**, because `legacyGroupDefaults` picks its dialect-specific catalogue query off the object it is given and a transaction is not the instance `createDatabase` registered. Anything moving more of a route inside a transaction has to check both halves; only running the suite on both dialects catches it.

### Amendment — 2026-08-20 · the byte cap bounds STORED bytes, `history_blob` included

Decision 5 read `HOSTED_PLAN` §4.3's "byte caps measure the stored envelope" as putting `history_blob` **outside** the sum, and gave a reason that still sounds right: the blob is governed by `HISTORY_RETENTION_DAYS` and survives ack on purpose (ADR-0028), so folding it in makes a delivery-queue cap drift with a retention setting that has nothing to do with delivery.

The consequence was worse than the drift, and it is the kind that only shows up when somebody counts. **A blob survives ack and nothing else measured it**, so a capped group could send, ack, send, ack — forever — and the relay would store an unbounded pile of blobs for it while every cap kept reporting healthy. The queued-messages cap saw an empty queue, the byte cap saw zero envelope bytes, and `/admin/provisioning/…/usage` agreed with both. The one number an operator would have gone looking for was the one that could not see the storage.

- **The guard now counts what the group has the relay HOLDING**: `octet_length(envelope)` over the live queued rows, **plus** `octet_length(history_blob)` over the group's blob-carrying rows still inside the history window. The inserted item is charged for both of its own halves. Still one statement, still inside the WHERE of the insert it would refuse, still exact on both dialects — decision 4 is untouched, and this is the same guard with a wider sum.
- **The window is the retention window, not "whatever the sweeper has not reached yet"**, so bytes stop counting against a group at the moment the relay stops owing them back, rather than at whatever later moment a sweep happens to run. With `HISTORY_RETENTION_DAYS=0` nothing matches and blobs count for nothing, which is consistent: that relay serves no history and drops the blobs on the ordinary tombstone schedule.
- **`tenancy.groupUsage` mirrors the definition by IMPORTING it**, not by matching it. Both readers now take their predicates from `caps.ts` (`liveQueuedMessages`, `storedHistoryBlobs`), because two hand-copied WHERE clauses is exactly how "the number an operator acts on" and "the number that refused their customer" stop being the same number. `usage.queue.bytes` is therefore wider than `usage.queue.messages` — a group can hold stored bytes with an empty queue, and now says so.
- **Nothing changes for a relay with no byte cap set**, which is every self-hosted one: the sum is not computed, because the guard is not entered.
- ADR-0028's `history_blob` is otherwise unchanged — same lifetime, same sweeper, same "the relay holds no key that can open it". What changed is only that its size is now counted somewhere.

### Amendment — 2026-09-05, revised 2026-10-01 · the group lock is no longer a caps-only cost, and key distribution is bounded

Two changes, both from the review recorded in [0031]'s 2026-09-05 amendment, and both
revised after the follow-up review of 2026-10-01 (`SECURITY_REVIEW.md`).

**The group-row lock is taken on every group-scoped write, capped or not.** Decision 4's
note that "the default relay (all caps off) runs the same unserialised inserts it always
has" was true and was the hole: an unserialised insert is exactly what let an in-flight
send strand ciphertext in a tenancy that had just been deleted. The lock's job is now
two jobs — cap accounting, and ordering against `deleteGroupCascade` — and only the first
of them was ever optional. The caps still decide which INSERT runs, so an uncapped relay
runs the plain statement it always ran; what it now also pays is one indexed read and a
transaction. It turned out to need one more piece [revised 2026-10-01]: a request
waiting for the row held a pooled Postgres connection while it waited, so one tenant
could fill the pool every tenant shares. Writes now queue per group in process before
they take a connection ([0031]'s amendment).

**`POST /v1/group-keys` was bounded by nothing at all, and now has four bounds.** It
stores a row per item, holds it for the whole history window, and decision 5's ruling
kept it outside the queue caps. That ruling stands and is still right — a device refused
its history key because somebody's inbox is full stays unable to read history it is
entitled to, and unlike a queue that does not clear itself — but "outside the queue caps"
had quietly become "outside everything". A tenant, **including a suspended one**, since
key distribution deliberately stays open under suspension [0031], could fill a relay's
disk while every cap reported healthy.

- **Size, per item (4096 bytes).** A group key is a fixed-size thing: 32 random bytes,
  their fingerprint and a timestamp, sealed. No user content ever enters one, so it
  cannot grow, and an oversized one is malformed rather than throttled — refused with
  the request's other shape errors (`invalid_request`), because no retry of that item
  could ever succeed. And every stored id is at most 128 characters [revised
  2026-10-01], on `messages` as well: an id was the one part of a row nothing measured,
  so it rode past this bound and past every byte cap, and on Postgres a long one failed
  the primary-key index with a 500.
- **Count, per target: at most 64 copies for one device [revised 2026-10-01].** Always
  on. The first version leaned on the send window for the count, and the send window is
  off by default and optional per group, so with it off a group (a suspended one
  included) could still store copies without end: measured at 1,000 copies and 4 MB
  against a 10 KB byte cap, with usage still reporting the whole allowance free. What
  legitimately lands here is one copy per key generation per device, so 64 is many
  times any real need. Enforced inside the insert, like every cap here, and refused per
  item with `limit_reached` and no `limit` name, because it is a structural bound and
  not one of the group's caps. It clears as old copies leave at the history cutoff.
- **Rate, per group, when the group has a send window: each newly stored copy spends one
  unit of it.** That is the cap that measures how hard a group may push at the relay,
  and it is the one refusal that clears itself within `CAP_SEND_WINDOW_SECONDS`. A
  replay of an already-stored id spends nothing and takes no slot under the count
  bound, the same rule sends follow.
- **Age: the sweeper**, unchanged — these were already dropped at the history cutoff.

**This makes `limit_reached` reachable on `/v1/group-keys`, which `shared/src/types.ts`
said it was not.** The comment is corrected there. It costs no client change and no new
literal: the window refusal names `sends_per_window`, an existing value with existing
copy, and the count refusal names nothing, which every client already tolerates. The
three clients that upload keys (the extension, Android and iOS; the console never does)
remember only the ids the relay *accepted*, so a refused copy is re-offered on the next
wake rather than marked done.


---

## 0029 — Group creation is a three-way policy, and a foreign endpoint is indistinguishable from none

**Status:** Accepted · 2026-08-20
**Relates to:** `HOSTED_PLAN.md` §4.1 (provisioned groups), §4.6 (the endpoint-existence oracle), §2.2 (`plan`/`has_email`) and the **H2 gate**, which this is the first half of; ADR-0022 (one relay, one group — its default is unchanged), ADR-0023 (the relay owns its group), ADR-0009 (the wire contract, and what "additive" costs), ADR-0021 (the retirement pattern this follows), ADR-0016 / `HOSTED_PLAN` §2.3 (mechanism open, policy closed); `server/src/config.ts`, `server/src/routes/endpoints.ts`, `server/src/routes/messages.ts`, `server/src/routes/group-keys.ts`, `server/src/db/index.ts`, `shared/src/types.ts`.

### Context
Three things in the relay were shaped by an assumption that stopped being true the moment a relay might host somebody else's devices: that whoever runs it is also the only person on it.

**`ALLOW_MULTIPLE_GROUPS` does two jobs at once.** It lets several groups coexist *and* it leaves the no-code CREATE path on `POST /v1/endpoints/register` open to anyone, because ADR-0022's guard only bites in single-group mode. On a household relay running two deliberately isolated groups that is exactly right. On a relay other people use it means anyone who finds the address mints a tenancy — past signup, past billing, past caps, past whatever maps a group to an account. There was no setting that said "several groups, but not on demand", and that is the setting a hosted relay needs.

**The send route answered a question it should not have been able to answer.** It looked targets up across every group and then said `unknown_target` for an id it could not find and `not_in_group` for one it found somewhere else. To a sender on a single-person relay that distinction is a helpful diagnosis. On a shared relay it answers "is this guessed id real in someone else's group?", which is an endpoint-existence oracle. `POST /v1/group-keys` carried the identical ladder, so the oracle was readable twice and fixing one route alone would have left it fully intact. Ids are random, so the practical leak is small; the fix is smaller, and the H2 gate asks for **indistinguishable responses, not merely refusal**.

**`groups.plan` and `groups.has_email` are account-shaped debris.** Written once at create (`'free'`, `0`), never read anywhere, and directly at odds with the thing the relay is supposed to be able to say plainly: it knows no plan. The group→plan mapping belongs in the closed control plane, and per-group state on the relay is caps as explicit values and nothing else.

### Decision

**1. `GROUP_CREATION=single|open|provisioned` replaces the boolean.**
- `single` (**default, and ADR-0022 unchanged**): the relay makes its own group at boot (ADR-0023) and refuses every later public create with `group_exists` (409), message unchanged.
- `open`: today's multi-group behaviour, exactly. **`ALLOW_MULTIPLE_GROUPS=1` keeps mapping to it**, so every existing deployment and docker-compose out there keeps the behaviour it has.
- `provisioned`: several groups may exist, and the public create path **always** refuses — including while the relay holds no group at all, which is precisely what makes it a policy rather than the single-group relay's one-shot. Groups come into being out of band; joining is untouched and still device-to-device with a pairing link.
- **`GROUP_CREATION` wins when both variables are set**, so a relay already running `ALLOW_MULTIPLE_GROUPS=1` tightens to `provisioned` by adding one line rather than by remembering to delete another. A pair that **contradicts** on multiplicity (`ALLOW_MULTIPLE_GROUPS=1` with `single`, or `=0` with `open`/`provisioned`) is a **boot error naming the fix**, not a guess: either answer is somebody's data model, and quietly picking one is how a relay ends up multi-tenant while its operator believes it is not. An unknown value is a boot error too — a typo must not fall through to a default.
- `allowMultipleGroups` survives as a **derived** value, because "may several groups exist here" and "may this caller make one" are now different questions and the `multiple_groups` warning only cares about the first. `/admin/status` reports the policy **additively** and keeps the old field.
- `acceptsNewGroups` (ADR-0022's hint) reads **false** under `provisioned`, so clients offer "join" rather than a button guaranteed to be refused, and boot mints **no** first-run pairing link there — a link belongs to one group, and choosing which is provisioning's job, not boot's.

**2. The provisioned refusal is `forbidden` (403), and the alternatives were weighed rather than defaulted to.** `group_exists` (409) is the wrong copy and would be an outright lie on an empty relay: 409 asserts a conflict with existing state, and the shipped string on four clients says "your relay already hosts a group of devices". A **new** `ApiErrorCode` is legitimate under ADR-0009's additive-lock process and was the tempting answer — but every client carries a **hand-maintained** copy table for these codes (`extension/src/lib/strings.ts` and `health.ts`, Android's `SendFeedback.kt`, iOS's `SendFeedback.swift`), so a new code ships a refusal three of the four clients cannot explain until they are each updated and re-released. `forbidden` already means exactly this ("allowed for some callers, never for this one"), already has copy everywhere, and carries the actionable half in `error.message`, which the register path surfaces verbatim. The message names the way in (ask whoever runs the relay for a pairing link) because the caller cannot fix this themselves.

**3. An endpoint outside the caller's group answers exactly like one that never existed.** Both routes scope the target lookup to the caller's group, so a foreign id falls out as `unknown_target` — same reason, same shape, same bytes. The stale-key check deliberately stays *after* the lookup: running it against a foreign endpoint's key would rebuild the same oracle one step further along. `not_in_group` **stays in the wire unions in `shared/src/types.ts`** and is simply never emitted: removing a literal from a locked contract is not additive (ADR-0009), and an older relay still sends it, so every client keeps its copy. This matches what the ack, rename and delete routes already did — a resource the caller cannot see is a resource that does not exist.

**4. `groups.plan` and `groups.has_email` retire the ADR-0021 way, with one addition that ADR-0021 did not need.** The code stops writing them, fresh databases stop creating them, existing databases keep the harmless unused columns, and **no one-time migration ships** (house rule). The addition: `recovery_verifier` was nullable, so dropping the write was free; **`plan` is `NOT NULL` with no default**, so "stop writing it" on its own would have broken group creation on the owner's live relay and on every restored backup — silently, and only at the moment somebody tried to make a group. `legacyGroupDefaults()` probes the actual table once per create and supplies the old values only where the old columns are. Relaxing the constraint in place was rejected: SQLite cannot drop a `NOT NULL` without rebuilding the table, which is the destructive migration this project does not ship.

**Not done here, deliberately:** the provisioning API itself (`HOSTED_PLAN` §4.2) — `provisioned` currently means "groups are made by whoever can reach the database", which is honest and useful on its own and is what the API will later automate. Also not done: per-group caps (§4.3), shared-store quotas (§4.4), and the hosted security profile (§4.5). H2 is **not** closed by this; items 1 and 6 are.

### Consequences / follow-ups
- **Nothing changes for a self-hosted relay.** The default is `single`, unset means `single`, and `ALLOW_MULTIPLE_GROUPS=1` still means what it meant. No existing deployment needs to be touched.
- **`provisioned` passes the §2.3 test on its own merits**, which is why it lives in this repo: a self-hoster running a family relay may want the same lock, and nothing about the commercial policy behind it leaks in.
- **The 403 is a backstop, not the common path.** Clients read `acceptsNewGroups` before showing onboarding, so under `provisioned` they never offer "create" in the first place — the same relationship `group_exists` has to ADR-0023.
- **`not_in_group` becomes dead wire surface that must stay alive.** It is the second entry (after ADR-0010's `historyOf`) kept purely for compatibility. Anything reading this file later should not tidy it away.
- **`legacyGroupDefaults` is permanent, and that is the price of the house rule.** A one-time `ALTER TABLE` on the owner's own relays remains optional hygiene; if it is ever run everywhere, the probe can go, and the migration suite's legacy fixture is what proves whether it still earns its place.
- **The migration suite now covers group *creation* against a legacy database in both dialects**, including a test that the same insert *without* the compat fails — so the mechanism cannot quietly become decorative.
- **Test helpers gained `groupCreation`; `allowMultipleGroups: true` still works** and maps to `open`, so the suites that opted into multi-group before the policy existed did not all have to change to say the same thing.
- **Every future cross-tenant answer has to be checked for this shape**, not just refused. The H2 gate is indistinguishability, and the two routes fixed here looked correct for three chunks precisely because refusing felt like enough.
- ~~Open, and belonging with the provisioning API: whether `provisioned` should also refuse the `/v1/pairing` mint for a group whose tenancy has been suspended.~~ **Closed by [0031]:** yes, and at the mint rather than only at the join. It turned out not to be a caps question at all — suspension became its own group-row state rather than "caps to zero".

---

## 0028 — Group history: one blob per send, sealed to a group key the relay never holds

**Status:** Accepted · 2026-08-05 (owner decision)
**Relates to:** **Supersedes the content mechanism of ADR-0010** (per-console history copies); ADR-0003 (self-host == hosted), ADR-0005 (relay stores ciphertext only), ADR-0008 ("Sent" means the relay accepted), ADR-0009 (E2E primitive), ADR-0016 (the relay is a blind pipe), ADR-0024 (the pairing link is the only credential); `PLANS.md` P-7; README's "never sees a URL".

### Context
P-7 shipped a **received-tabs list per device**, and owner review found two holes it cannot close.

**A tab that never arrives is unrecoverable.** `extension/src/background/send.ts` drops the queued item the moment the relay accepts it, and ADR-0008 already established that "Sent" only ever meant "the relay took it". So the sending device forgets the tab at exactly the point where nobody yet knows whether it landed; the target never records it because it never received it; the relay holds ciphertext until TTL that no UI can read. Close the source tab and it is gone. A misconfigured or buggy target makes this the *normal* case, not an edge one.

**A per-device list makes you guess the device.** Finding a tab means knowing where you sent it and having that device to hand. The only group-wide view was a paired console — optional, and sender-sealed, so it can say what was sent but never whether it arrived.

The straight fix is a single group-wide history readable from anywhere. The obvious route — let the relay store URLs — was considered and **rejected**: it falsifies README's front-page "never sees a URL", removes the premise ADR-0016's licensing argument rests on ("a blind pipe... imports no crypto"), turns the relay database and its backups into a browsing-history store, and lands hardest exactly where the business is, on the Phase 3 multi-tenant relay serving people who did not set it up.

The actual mistake was narrower: history was being sealed to **exactly one device's key**, then worked around. Seal it once to a key the **group** holds and the problem dissolves without touching what the relay can see.

### Decision
1. **A group history key.** 32 random bytes, held by every paired endpoint, never by the relay. The relay's role is unchanged: it stores an opaque blob and validates only its shape.
2. **One history blob per send.** The source seals one extra blob under the group key with `crypto_secretbox` (XSalsa20-Poly1305) — the symmetric half of the `crypto_box` all four clients already implement, so no new primitive enters the codebase. It carries the same `SendPayload`, the target endpoint id, and the message ids it corresponds to. One blob per send, **not** one per endpoint: the N-copies design was rejected as unnecessary once the key is shared.
3. **The relay retains history blobs deliberately**, for a configurable window (`HISTORY_RETENTION_DAYS`, default 30), and **not** deleted on ack — unlike message payloads, which keep today's delete-on-ack behaviour untouched. `GET /v1/messages?history=1` returns the caller's whole group, newest first, each row carrying the blob plus the delivery state the relay already knows (delivered / acked / never-arrived). Content is opaque to the relay; status comes from metadata it has held all along. `HISTORY_RETENTION_DAYS=0` stops it serving history while still *accepting* blobs, so a relay setting can never make an existing client start failing.
   - **The blob rides the message row it describes** (`messages.history_blob`), rather than the separate table this ADR first proposed. One row, one lifetime, no join to dangle, and the additive-nullable-column upgrade path is the one already proven twice on the owner's live relay. The sweeper gains a second clock instead: a row carrying a blob survives until **both** windows have passed — expiry + grace (replay protection, bounded by the TTL) and creation + history retention (the product promise). `envelope` is still purged on the original schedule, because the two are different things with different lifetimes sealed to different keys.
4. **The key travels sealed to an endpoint's published key, never in the pairing link.** An existing member seals the current group key to a new endpoint's `e2ePubkey` (already published in the endpoint list) and posts it to **`/v1/group-keys`, its own route**. **The pairing link is deliberately unchanged.**
   - **Corrected during implementation: this is NOT an ordinary message**, as this ADR first said. An ordinary message is a *tab* to every client already shipped. Android's `SendPayload.url` is non-null, so one carrying a key instead of a URL fails to parse, is skipped **without an ack**, and retries on every drain until it expires; iOS would show the user "Unsupported link blocked" each time. A dedicated route is invisible to a client that does not know to poll it, which is exactly the forward compatibility this needs. Copies are not consumed on read (a device that fetches and then dies before persisting must be able to fetch again); they age out on the history window and are deleted when their endpoint is removed. Putting the key in the fragment was the first design and was rejected: it lengthens the QR, and it turns a photographed link from a single-use join credential into a long-lived read key. The cost of this choice is that a freshly paired device has no history until some other device next wakes — seconds for a client holding the stream, one poll otherwise. Receiving tabs is unaffected and works immediately.
5. **One mechanism for join, backfill and rotation.** The same seal-to-pubkey delivery introduces the key to a new device, backfills a group that predates this ADR, and distributes a rotated key.
6. **A device holds a SET of keys, not one**, which is what makes the rest work. Rotation keeps old history readable; a group upgrading from before this ADR can survive two devices minting a key at the same instant, because both survive and every device converges on the same *current* one; and a device that has been off for a month can read the whole window. Convergence is total and deterministic — newest `createdAt` wins, `keyId` breaks the tie — so devices agree without talking to each other. Minting the *first* key is a lowest-endpoint-id election, so an upgrading group does not fragment its first day of history across N keys; the race is survivable, just pointless.
7. **Removal rotates the key; earlier history stays readable.** Removing an endpoint mints a new group key, sealed to each remaining endpoint. History written before the rotation stays under the old key, which remaining devices still hold, so **no history is destroyed by removing a device**. The removed device keeps the old key but loses its device token, so it can fetch nothing further. Re-sealing existing history under the new key was considered and rejected as machinery out of proportion to a group of one person's own devices (owner decision).
8. **Every client shows one merged history** — sent and received in one timeline, newest first, with delivery state on sent rows and "Send again" on a tab that never arrived, which is possible because the blob carries the payload, so *any* device can re-send it, not only the source.
   - **Corrected during implementation: the local received record is KEPT and merged with the relay's list, not replaced by it.** Purely relay-fed history regresses P-7's promise on three configurations that really occur — a relay predating this ADR, `HISTORY_RETENTION_DAYS=0`, and a relay that is simply down. In all three, tabs still arrive and still have to be recoverable. Merge is by message id, relay content wins. It also means the *target* of a tab can always read it even with no group key, because it decrypted the tab itself on the way in.
   - **A console never mints and never distributes a key.** It is a pure reader excluded from every chooser, and the lowest-id election would otherwise hand key authority to a browser tab someone opened once.
9. **Direction is carried by mail imagery, not a bare arrow.** A paper plane for what this device sent, a tray for what it received, a neutral exchange glyph when neither end is this device. Owner review rejected a plain up/down arrow: it does not say what it means, and a lone arrow in a row's left gutter reads as a control for reordering the list. Where a preposition has nothing to attach to — a transfer between two *other* devices — the row names both ends as `Source → Target` instead, so an arrow only ever appears between two device names. Rejected alternatives, with reasons, so they are not revisited blindly: chat-style left/right alignment (position alone is missable, wastes width on a phone, implies a conversation, and the third-party case has no side to sit on); a written `Sent`/`Received` badge (accessible and unmistakable, but repeats the preposition and costs a line per row); giving/receiving hands (illegible at 15 px, gesture meanings vary by region, and a hand reads as *more* tappable than a paper plane, not less).

### Consequences / follow-ups
- **The relay now holds ciphertext by design**, where before it deleted payloads on ack. More ciphertext at rest, for longer, in one more place to back up. Categorically different from plaintext, but a genuine weakening of today's posture and it belongs in `SECURITY.md` stated plainly, not buried.
- **README's "never sees a URL" and ADR-0016's blind-pipe premise both remain true**, which is the whole point of choosing this over relay-visible URLs.
- **ADR-0010's per-console copies become redundant for content.** The console reads group history like every other endpoint. `kind: 'console'` and its exclusion from choosers are unaffected; the `historyOf` field stays for wire compatibility with older senders.
- **P-7's shipped work is absorbed, not discarded.** `InboxItem`, the batch grouping, the "2 of 3 tabs" honesty line and the three screens all carry over; they gain a sent side, a delivery state, and the name "History".
- **Losing the key on every device makes history unreadable.** Not backed up by backing up the relay, deliberately. Acceptable: losing every device means re-pairing anyway.
- A leaked pairing link still grants only a single-use join. The key alone cannot read history without a valid device token to fetch blobs with.
- **Timestamps must be one shape across clients, because the ring orders keys by string comparison.** Porting the keyring to Kotlin surfaced this: `Instant.toString()` drops a zero millisecond fraction, and `"…00Z"` sorts *after* `"…00.000Z"`, so a key minted on a whole second on Android would have outranked an identical browser one and the group would have silently disagreed about which key was current. All four clients now emit millisecond-precision ISO. Anything that ever writes a `createdAt` must keep doing so.
- **A cross-client vector pins the seal** (`ios/TabsendKit/Tests/TabsendKitTests/Resources/group-history-vector.json`, copied into `android/app/src/test/resources/`). Four independent implementations of `crypto_secretbox` — libsodium in the browser and console, hand-assembled on both phones — is exactly the shape where every suite passes and a tab sealed on the phone is unreadable in the browser. A round-trip test only proves a client agrees with itself; the vector fixes the bytes.
- **iOS cannot rotate**, because it has no remove-a-device surface to trigger one. It reads and converges on rotations minted elsewhere. If a remove-device screen is ever added there, the rotation path has to come with it.
- Open: the retention window (30 days proposed) and whether it should be relay-configurable per group; storage is a few hundred bytes per send, so this is a policy question, not a capacity one.
- Open: **nothing has been seen running except iOS.** The loop is proven against a live relay from `TabsendKit`, and the extension's page survives the e2e rig, but no history screen on any client has been looked at by a human, and the two-device key handshake has never run in a browser. That is the gate before this is called done.

### Amendment — 2026-10-13 · what the group-history review found, and what changed

The first review of this ADR on its own terms (`SECURITY_REVIEW.md`, "Review of group
history (2026-10-13)") found that the code did not do several things this ADR says.

- **Decision 7 was never built.** No client rotated the key when a device was removed; the
  only key ever minted was the first. So a removed device, or a relay that had once obtained
  the key, read new history indefinitely, and P-10's "remove it" cut nothing off (GH1).
  **Now: rotation is triggered by a departure, not by the remove button.** The new-device
  watch (P-10) records a debt whenever an id leaves the accepted device list: `rotateOwedAt`,
  and `rotateFrom`, the `createdAt` of the key that was current at that moment. The next key
  sync on any device that can mint (extension, Android, iOS) mints a new key unless its ring
  already holds one newer than `rotateFrom` (another device got there first), settles the debt
  either way, and hands the current key only to devices the watch has accepted by id and key.
  The comparison is with a key, never with a clock: compared with the departure's time, a key
  planted up to a day ahead (which the date rule allows) looked like a rotation already made,
  and a device about to be removed could keep the group on a key it holds (found by the
  verification pass). This covers a removal made from any client, the console included, and
  a device a relay showed once and then hid; a known device whose key changed owes a rotation
  too. Two devices racing may each mint one; decision 6 already makes that harmless. **Not
  covered:** a relay that answers a removal and keeps listing the device, or withholds key
  copies selectively (`PLANS.md` P-14 items 8 and 9).
  **iOS now rotates too**, which retires the "iOS cannot rotate" consequence above: it got a
  remove action with P-10, and the departure trigger needs no screen.
- **Decision 6 now fixes the shape of `createdAt`.** The ring compares it as text, and a copy
  dated `"Wed, 31 Dec 9999 …"` or `"9999-12-31T23:59:59.999Z"` stayed current past every
  rotation (GH4). A received record must be exactly `YYYY-MM-DDTHH:mm:ss.sssZ`, no more than a
  day ahead of the receiving device's clock, and carry a 32-byte key whose fingerprint is its
  `keyId` (`shared/src/keyrecord.ts`, vectors in `shared/vectors/group-key-records.json`).
- **A list without this device is never used** for key handoff or sender trust, and a known
  id whose key changed is announced as a new device (GH2, GH3; `PLANS.md` P-10). The first
  list a device sees is looked at once by the user instead of taken silently, and a device that
  is shown and then hidden stays on screen until dismissed (GH6, GH7; `PLANS.md` P-14 items 1
  and 2, closed later that day). Neither changes who is handed the key: it is still not held
  back for a new device.
- **The first-key election leaves consoles out** (decision 8 says a console never mints; it
  could still win the election and leave the group with no key) (GH11).
- **`HISTORY_RETENTION_DAYS=0` now means "not stored", not only "not served"**, and a blob
  past its window is dropped on time even while its row stays for replay protection (GH8).
- **Still contradicted, and left open: decision 2 says the blob carries "the target endpoint
  id, and the message ids it corresponds to".** It carries the payload and the two labels
  only, and nothing binds it to its row, so a relay can move a blob onto another row of the
  same group (GH15). Low impact, because the relay already controls delivery state; recorded in
  `PLANS.md` P-14.

### Amendment — 2026-10-13 (later) · a removal is recorded where it is made, and a rotation names who it is for

The verification pass found that the departure-triggered rotation above could still be
defeated by a relay that lies on purpose (`SECURITY_REVIEW.md` X13, X14). Both are closed.

- **A removal made on a device is recorded on that device at once.** "Remove it" is only a
  request to the relay, and a relay that answers it and keeps listing the device triggered no
  departure and so no rotation. The watch now records the removal when the relay accepts it
  (`removed`), owes the rotation against the key current then, and leaves that id out of key
  handoff and out of the senders it trusts, whatever the list says. A device carrying a removed
  device's *key* under a new id is held back from key handoff until the user answers its notice,
  not shut out for good: the extension keeps its device key when it re-pairs, so an honest
  re-paired browser comes back under a new id with the same key. (A narrow exception to the
  2026-10-08 ruling that the history key is not held back for a new device; it applies only on
  the device that did the removal.)
- **Decision 7's key record may carry `departed`.** The record a rotation seals gains an optional
  list of at most 32 distinct ids: the devices that had left when it was minted (the minter's
  debt, `rotateFor` in the watch). A device that owes a rotation stands down only for a key that
  is newer than the key current when the device left and names every id it owes; a key that
  merely arrived later does not count. A receiver drops the sender's own id from the list it
  reads, since a device cannot vouch for its own departure, and refuses the record if the list is
  malformed. The first key of a group names nobody. This is a sealed-format change on four
  clients, so it has cross-client vectors (`shared/vectors/group-key-records.json` and
  `new-devices.json`). A key is never sealed to an id its own `departed` list names, and the
  extension now replaces the key even while the relay is failing the key routes, as the phones
  already did. **Not covered:** a key dated up to a day ahead, minted by a device before
  it is removed and handed over late by a device the relay never told of the removal; a tighter
  future bound was weighed and not adopted (`PLANS.md` P-14 item 9).

### Amendment — 2026-10-30 · a device hands on every key, not only the current one

Decision 6 says a device that has been away "can read the whole window", and the 2026-10-08
ruling accepts that a new device reads the retained history from before it joined. The code
did not do it: every client handed on **only the current key**, on the stated grounds that "a
device that arrived after it was replaced has no history under it to read". That is false
whenever a rotation happened inside the history window, and the commonest case makes it so:
replacing a phone removes the old one, which rotates the key, so the new phone was handed
only the key minted for it and every earlier row showed locked (owner report, 2026-10-30).

**Now:** the extension, Android and iOS hand each member every key in the ring, newest first,
capped at 16 (`MAX_HANDED_KEYS`, well inside the relay's 64-copies-per-device bound; an older
key's blobs have left the window anyway). A device named in **any** key's `departed` list is
handed none of them: it already holds the keys from before it left. Nothing on the wire
changes (a copy already carried one key record), so no receiver needs an update, and the
first wake after upgrading hands the older keys to every member once. Each copy still spends
one unit of `CAP_SENDS_PER_WINDOW` where a relay sets it; a refused copy is retried later.

---

## 0027 — Firefox store disclosure treats encrypted relay traffic as transmission

**Status:** Accepted · 2026-08-10
**Relates to:** AMO publication; `extension/public/manifest.firefox.json`;
`docs/AMO_SOURCE.md`.

### Context

New AMO submissions must declare whether an extension transmits personal data. Mozilla's
definition covers data handled outside the extension or local browser, even when the data
is end-to-end encrypted and the transfer is initiated by the user. Tabsend's core operation
sends the selected tab URL and may include its visible title and favicon.

Firefox provides a built-in consent experience for manifest-declared collection beginning
with desktop version 140 and Android version 142. Supporting older Firefox versions while
transmitting declared categories would require Tabsend to build and retain a separate custom
consent flow.

### Decision

- Declare `browsingActivity` and `websiteContent` as required categories. Do not claim
  `none`: encryption protects content from the relay but does not mean no transmission
  occurred.
- Raise Firefox's strict minimum version from 128 to 142 and use Firefox's built-in consent
  prompt instead of adding a second in-extension consent system solely for older releases.
- Continue describing the actual privacy boundary precisely: the relay sees routing metadata
  and ciphertext, while paired endpoints can decrypt the user-selected tab payload.

### Consequences / follow-ups

- Firefox 128–141, including its older ESR line, cannot install this new AMO build.
- Users get a platform-native, reviewable disclosure before installation.
- Any future payload expansion must be checked against the declared AMO categories before
  release.

---

## 0026 — Post-v0.6 security boundaries are explicit and fail closed

**Status:** Accepted · 2026-08-10
**Relates to:** `docs/SECURITY_REVIEW.md`; hosted-relay prerequisite; iOS physical qualification.

### Context

The v0.6 reconciliation identified three boundaries that automated interoperability tests
did not settle: client-controlled Web Push egress, unbounded WebSocket lifecycle, and iOS
backup/migration behavior for credentials and decrypted history. All are acceptable risks in
a trusted single-user lab; none is an acceptable implicit default for a hosted relay or
external iOS beta.

### Decision

- Push endpoints are HTTPS-only. Hosted-safe default egress rejects local/reserved literals
  and DNS answers at the connection-time resolver, does not follow redirects, and times out.
  A self-hoster may explicitly allow private endpoints for a private UnifiedPush distributor.
  Hosted deployment still adds a network-layer private/metadata deny policy.
- WebSockets have a 16 KiB frame cap, 10-second hello deadline, 90-second idle timeout,
  bounded pending-frame queue, 1,000 per-process connection cap, and five sockets per endpoint.
  Every value is configurable and invalid non-positive limits fail at boot.
- iOS endpoint credentials use `AfterFirstUnlockThisDeviceOnly`. Restoring a backup to another
  phone requires re-pairing and cannot clone a live endpoint. Received-tab history moves out
  of App Group preferences into an after-first-unlock protected file excluded from backup.

### Consequences / follow-ups

- These are post-v0.6 changes; the `v0.6.0` tag remains immutable.
- Physical devices must prove Keychain/App Group entitlements, backup restore, reinstall,
  lock-state access, and the v0.6 inbox migration before external iOS distribution.
- Application egress checks do not replace a hosted network firewall, nor do resource limits
  replace tenant quotas and distributed abuse controls.
- Relay-controlled endpoint-key introduction remains a separate protocol-design gate, recorded
  in `HOSTED_SECURITY_PLAN.md`.

---

## 0025 — Pairing links advertise client-appropriate routes

**Status:** Accepted · 2026-07-31
**Relates to:** ADR-0019 (self-signed TLS), ADR-0020 (mutable relay route), ADR-0024 (complete pairing links); `server/src/pairing-links.ts`, `shared/src/types.ts`, client pairing parsers.

### Context
A self-signed LAN relay deliberately has two doors: pinned HTTPS for native apps and
cleartext HTTP for browser extensions. The relay nevertheless put only
`PUBLIC_RELAY_URL`—the native HTTPS door—into every link and QR. That made phone pairing
work while copied links failed in extensions, and made the operator manually rewrite a
one-time security credential. Opening a pairing link as a web page also returned a JSON
404 (or, on self-signed HTTPS without an installed app, the browser's unavoidable
certificate warning).

### Decision
**Copyable links default to the browser route; QR codes default to the native route; both
carry the alternate route in the URL fragment.**

- `PUBLIC_BROWSER_RELAY_URL` is derived from `PUBLIC_RELAY_URL` plus `HTTP_PORT` in the
  self-signed dual-listener setup, so custom ports work without client assumptions. It can
  be overridden for an unusual proxy layout.
- `POST /v1/pairing` keeps `link` as the native/QR presentation for compatibility with
  older clients and adds `browserLink` for copying. Updated UIs make `browserLink` the
  user-visible default. On a hosted/domain relay they are the same compact HTTPS link, so
  hosted UX is unchanged.
- Browser clients select `browser=` and native clients select `native=` when a user pastes
  the other presentation. For older relays, the presence of a certificate pin plus the
  documented default port pair permits the conservative `8787` HTTPS ↔ `8786` HTTP repair.
- `GET /pair` is a no-store, no-analytics explanation page with a local copy action and a
  project download/help link. The secret remains in the fragment and never reaches the
  server. A self-signed HTTPS privacy warning happens before HTTP and cannot be replaced by
  this page; making the copied/default link use HTTP avoids it for browser onboarding.

### Consequences / follow-ups
- A pairing URL chooses the new endpoint's initial route, not its permanent identity.
  Clients can already verify the same relay and change LAN ↔ Tailscale routes without
  re-pairing (ADR-0020), but store only one active route and do not fail over automatically.
- Pairing surfaces explain the split only when it exists. A hosted user sees the existing
  single-link experience.
- Store-specific download links are deferred until listings exist; the landing page uses
  the stable project Releases page in the meantime.
- Publicly exposing the cleartext browser listener remains deliberately blocked by default.
  `HTTP_ALLOW_PUBLIC` is an explicit emergency override, not a roaming feature.

---

## 0024 — A complete pairing link is the only user-facing pairing credential

**Status:** Accepted · 2026-07-30
**Relates to:** ADR-0019 (self-signed TLS pinning), ADR-0022 (one relay, one group), ADR-0023 (relay-created first link); `shared/src/types.ts`, `server/src/routes/pairing.ts`, `extension/src/lib/pairing.ts`, `android/…/logic/Pairing.kt`.

### Context
Tabsend exposed the one-time secret in three interchangeable-looking forms: a short code, a QR, and a link. They were not actually interchangeable. A short code says nothing about which relay to contact, so browser onboarding had to ask for a relay URL first. More importantly, a self-signed relay's pairing link carries its SPKI fingerprint in `#fp=`; Android needs that out-of-band trust anchor before it can make the first HTTPS request.

The Android scanner demonstrated the failure directly: it parsed a valid QR, copied only the short `c=` secret into the form, and discarded both the link and its certificate fingerprint. The later join reparsed that detached secret and could no longer trust the relay. A QR that visibly contained the right link therefore failed as if it were an untrusted code.

### Decision
**The complete HTTP(S) pairing link is the sole user-facing pairing credential.**

- The relay returns complete links plus `expiresAt`; it never publishes the detached secret as a separate response field. ADR-0025 later split copy and QR presentations while preserving one credential.
- Browser extension, console, and Android onboarding accept only a complete link. Users do not enter a relay URL separately and never see or type the internal short secret.
- Pairing surfaces show a QR and a copyable read-only link carrying the same code. ADR-0025 permits their outer relay routes to differ for a dual-listener self-hosted relay. There is no separate code display or copy action.
- Android preserves the exact scanned link until join parsing, including `#c=` and optional `&fp=`. A regression test locks that handoff.
- Protocol v3 marks the breaking response and onboarding contract. Current clients reject v1/v2 relays before attempting to pair.
- The short random value and `pairing_codes` table remain internal implementation details. The authenticated register request may still carry that extracted value over the wire; it is no longer a standalone credential a person handles.

### Consequences / follow-ups
- New-device onboarding is one step: scan or paste one link. The link selects the relay as well as authorising and, where needed, trusting it.
- A detached legacy code is deliberately rejected, even when syntactically valid. Silently accepting it would reintroduce the missing-relay and missing-pin states.
- The first-run relay log remains the source for the first device; after that, any paired device can create the next short-lived link.
- Links contain a bearer secret in the URL fragment. They should be treated as passwords until consumed or expired, but fragments are not sent in HTTP requests or normal access logs.

---

## 0023 — The relay owns its group, and hands out the first pairing code

**Status:** Accepted · 2026-07-29
**Relates to:** ADR-0022 (one relay, one group — this makes it structural), ADR-0021 (no recovery credential), ADR-0003 (account-less device group), P-3 (self-signed pin in pairing payloads); `server/src/bootstrap.ts`, `server/src/server.ts`, `server/test/bootstrap.test.ts`.

### Context
ADR-0022 made a relay host one group, but left the group's *creation* to whichever client registered first. Two problems followed from that, and the owner named both:

1. **Setting up a relay and then "creating a group" is two steps for one thing** — and the second step has no settings and no decisions in it. Nothing is being chosen, so nothing should be asked.
2. **A phone cannot perform it.** The iOS and Android apps only ever join with a pairing code; neither has a create path (iOS won't even proceed without a parseable code). So a fresh relay could not be adopted by a phone at all. If you self-host on a mini PC and reach for your phone first, you are stuck: nothing can create the group, and nothing exists to invite you into one. Requiring a browser extension as the mandatory first client is a constraint nobody chose.

### Decision
**The relay creates its own group at boot, and prints a pairing link while that group is empty.**
- `ensureBootstrapGroup` runs in `start()` right beside `ensureRelayId` — the first-boot work the relay already does. Idempotent; a relay that already has a group (which is every existing relay) is untouched.
- `mintFirstRunPairing` mints a code **only while the group has zero endpoints** — the single moment the normal rule ("codes come from a device already in the group") has nobody to apply to. The instant a first device joins, this stops for good and pairing is device-to-device again. The link carries the SPKI pin exactly as a normal pairing payload does (P-3): a first device needs the trust anchor as much as a later one.
- The code gets a **longer life than a normal pairing code** — 24h by default (`BOOTSTRAP_PAIRING_TTL_MINUTES`) against 10 minutes. That 10-minute window is sized for handing a code between two devices in your hands; this one is read out of a boot log by someone who may finish setting up hours later, and a silently-expired code is a bad first experience on a relay that has nothing in it yet. Restarting prints a fresh one.
- Single-group relays only. A relay running `ALLOW_MULTIPLE_GROUPS` is deliberately multi-tenant, where every group belongs to somebody who asked for it, so an owner-less group minted at boot would just be an orphan for the first arrival to land in by accident.

### Consequences / follow-ups
- **Every client now does the same single thing: join.** Phone, browser, console. The create-or-join fork is gone from the experience even though the code path remains.
- **ADR-0022's mechanism is kept, not removed, and is now load-bearing in a second way.** `acceptsNewGroups` reads false from the very first boot, so first-run hides "create" immediately rather than after someone takes it; `group_exists` becomes the backstop rather than the common case. Both were nearly deleted as redundant — they are what lets multi-group stay a supported mode instead of a special case.
- **Multi-group is untouched and still opt-in**, which keeps the door open for offering multiple groups per relay as a deliberate feature (e.g. a household where each person wants their own). That question is open; nothing here forecloses it.
- **`group_exists` copy now names both sources of a code** — a paired device, or the relay's startup log — because a first-time operator has no paired device to be sent to. Same fix in the extension's first-run copy.
- **Test helpers now mirror boot.** `startTestServer` runs the same two steps, and `register()` mints a code when none is supplied, since "give me an endpoint" now means "join the relay's group". This surfaced 41 tests that had been quietly relying on register-creates-a-group; they now exercise what a real relay does.
- **Not addressed:** what hosted does instead of a log line (presumably hands the link to the customer at signup), and whether the bootstrap window should be closable manually. Both belong with the multi-tenancy design.

---

## 0022 — One relay, one group (multi-group is opt-in)

**Status:** Accepted · 2026-07-29
**Relates to:** ADR-0003 (account-less device group), ADR-0021 (removing the recovery credential raised the question), ADR-0020 (`relayId` — relay identity, which this makes user-visible in practice); `server/src/config.ts`, `server/src/routes/endpoints.ts`, `server/src/routes/config.ts`, `extension/src/pages/firstrun.ts`.

### Context
A relay could host any number of groups: `POST /v1/endpoints/register` **without** a pairing code created a new one, every time, unconditionally. That generality is real for a hosted multi-tenant relay, but on a self-hosted relay — the design centre (ADR-0003: self-host == hosted) — there is exactly one group, and the extra concept only creates a failure:

**A browser that picks "create a group" instead of "join" lands in a second, invisible group on the same relay.** Both browsers then report themselves correctly paired, neither can see the other, and nothing anywhere says why. There is no error, because nothing went wrong by the old rules. It is a state the user cannot diagnose from any surface, and the only fix — unpair and re-onboard — is one they have no reason to try, since both ends look healthy.

The group was also never a nameable thing (`groups` has no `name` column) — reinforcing that it is plumbing, not a concept the user should have to hold.

### Decision
**Default a relay to a single group; make multi-group an explicit deployment choice.**
- New `ALLOW_MULTIPLE_GROUPS` (default **false**). With it off, the create path on `register` first checks whether a group already exists and, if so, refuses with a new `group_exists` code — **409 Conflict**, not 400: the request is well-formed and would have been valid against an empty relay; it conflicts with relay state. The message names the way forward ("use a pairing code from a device that is already paired"), because this is otherwise a dead end.
- `GET /v1/config` gains **`acceptsNewGroups`**, so a client can shape onboarding *before* the user chooses rather than letting them fill in two names and then meet a refusal. The extension's first-run hides the "Start a new group" fieldset and explains why. Absent on older relays ⇒ read as true (previous behaviour). It is a **hint, never the enforcement** — the register route decides regardless, so a stale or skipped probe is harmless.
- Joining is completely untouched: a pairing code from a paired device works exactly as before. Only the *second create* is refused.
- **Not done: making relay and group literally the same object.** No schema change, no dropped `group_id`. Groups remain the E2E trust boundary and multi-tenancy stays possible for hosted Pro; this is a policy default, which is the part that fixes the failure. Collapsing the data model would buy nothing further and would foreclose the hosted path.

### Consequences / follow-ups
- **The silent-second-group failure is now unreachable** on a default relay: it surfaces as an error at the moment of the mistake, on the screen where the mistake is made.
- **A group still needs no name**, and none was added. On a single-group relay the relay's address *is* the identity — which is what `relayId` (ADR-0020) already tracks.
- **`acceptsNewGroups` is a deliberate, bounded disclosure.** An unauthenticated caller learns "this relay is in use" — never how many groups, who is in them, or any id. A relay already reveals that it is a relay, and the enforcement does not depend on the hint.
- **Tests now match production.** `startTestServer` defaults to single-group like a real relay; the two suites that genuinely need two groups (cross-group isolation, rate-limit counting) opt in via `allowMultipleGroups`, which makes their multi-tenancy assumption explicit rather than incidental.
- Existing relays hosting more than one group are **not** broken: the check only refuses *new* creates. Such an operator sets `ALLOW_MULTIPLE_GROUPS=1`.
- Console and Android need no change — both always register with a pairing code and could never create a group.

---

## 0021 — No recovery credential: pairing from a live device is the only way in

**Status:** Accepted · 2026-07-29
**Amends:** ADR-0003 (which mandated a recovery key) and ADR-0007's recovery-kit nudge; PRD §11 / INTERACTION_FLOWS "Recovery key".
**Relates to:** ADR-0005 (E2E — why a restored group is empty), ADR-0013/0020 (relay switch and address change, the flows people actually confuse with recovery); `shared/src/types.ts` §8, `server/src/routes/endpoints.ts`, `extension/src/lib/storage.ts`.

### Context
ADR-0003 specified a 12-word recovery phrase as "the only way back if every device is lost", and Chunk 6b built it: BIP39 minting, a SHA-256 verifier column on `groups`, an unauthenticated `POST /v1/endpoints/recover` route, a first-run save/skip nudge, and an entry field in the console. Reviewing the shipped feature against the product it actually serves, the justification does not survive:

1. **The triggering scenario is self-defeating.** Recovery is only *needed* when no paired device remains, because any surviving endpoint can already mint a pairing code (`POST /v1/pairing` accepts any device token — there is no designated primary). But when no device remains, the group holds nothing worth restoring: its endpoint rows are dead, and its message history is sealed to keypairs that no longer exist (ADR-0005), so a recovered endpoint gets a fresh key and reads none of it. Recovery therefore restored an *empty group under its old id* — materially indistinguishable from creating a new one.
2. **The relay is the durable thing, and it is the owner's.** Tabsend is self-hosted by design (ADR-0003: self-host == hosted). If the relay is up, a new group is one first-run away; if the relay is gone, its database is gone and no client-side phrase brings the groups back. The scenario where a phrase is the deciding factor does not exist for a self-hoster. Access to a *hosted* relay is protected by the operator's real credentials, which is a different problem with a different answer.
3. **It was a permanent, silent liability.** The phrase is a bearer credential with no device approval: anyone holding it joins the group forever. It was persisted **in cleartext** in `ext.storage.local`, indefinitely, including after the user clicked "I saved it".
4. **The cost was ongoing, not sunk.** The route, the wordlist, and the schema column were written, but the roadmap still owed a re-nudge flow and a regenerate/re-download flow, and every onboarding change had to carry the save/skip step.

The scope here is deliberately narrow: this is about a *credential*, not about durability. Nothing else changes about backups (`docs/DEPLOY.md` still says back up the relay database).

### Decision
**Remove the recovery phrase entirely, and add nothing in its place.** Getting a device into a group is one path with no alternatives: an already-paired device mints a pairing code.

- Deleted: `server/src/recovery.ts`, the bundled BIP39 wordlist, `POST /v1/endpoints/recover`, `RecoveryKit`/`RecoverRequest`/`RecoverResponse` and `RegisterResponse.recovery`, the extension's first-run reveal + "I saved it" + `markRecoverySaved` RPC, the console's recover block and controller path, and Android's `RecoveryKit`.
- `groups.recovery_verifier` is **no longer created or written, and dropped by hand** — same reasoning as the extension key above: a subtractive step in `migrate()` was written, then removed, because a migration that runs forever to undo a state that can never recur is debris. Fresh databases never create the column. The owner's relay was cleaned up once with:

  ```sql
  ALTER TABLE groups DROP COLUMN IF EXISTS recovery_verifier;
  ```

  A database restored from an older backup will still have it. That is harmless — the column is nullable and nothing references it — and `server/test/migration.test.ts` keeps it in the legacy fixture precisely to prove current inserts work against such a database.
- **A relay-side escape hatch was considered and rejected.** An admin command to mint a pairing code out-of-band would be a real capability, but it answers the same non-problem: if the relay is reachable enough to run an admin command, it is reachable enough to create a new group from any browser.
- The removal is asserted, not merely performed: `server/test/hardening.test.ts` requires `/v1/endpoints/recover` to 404, so re-introducing a back door is a visible, failing decision.

### Consequences / follow-ups
- **Losing every paired device at once means the group is gone**, and that is now the documented, intended behaviour rather than a mitigated risk. The remedy is to create a fresh group against the same relay and re-pair — minutes of work for a handful of browsers.
- **Existing installs are cleaned up by hand, and the cleanup ships nothing.** An install predating this ADR still holds the phrase in `ext.storage.local` under `recovery`, in cleartext. A migration hook was written and then **deliberately removed**: a one-time cleanup does not belong in the permanent codebase, where it would outlive its purpose by years and read as live logic to every future reader. Every affected browser is one the owner controls, so the fix is a line pasted into each extension's service-worker console, once:

  ```js
  chrome.storage.local.remove('recovery')
  ```

  **This trade-off is only available because Tabsend has no third-party installs yet.** If a build carrying the phrase ever reaches users the owner cannot reach, a shipped migration becomes the only honest option — the key would otherwise sit there forever.
- The unauthenticated rate limiter now guards exactly one route (`register`); its config, comments, and `RATE_LIMIT_*` docs were corrected to say so.
- Email stays optional and is now for Pro billing only — recovery was its other stated purpose (ADR-0003, PRD §9).
- **Follow-up, now decided:** whether a group is a useful concept distinct from a relay at all. Answered by **ADR-0022** — one relay, one group by default, multi-group opt-in.

---

## 0020 — The relay address is a route; the relay's identity is not its URL

**Status:** Accepted · 2026-07-28
**Relates to:** ADR-0013 (relay switch = re-register — still true for *actually different* relays), ADR-0019 (pinned cert is per-relay), `docs/PLANS.md` P-4; `server/src/db` (`meta` table), `server/src/routes/config.ts`, `extension/src/background/identity.ts`, `android/…/ui/MainActivity.kt`.

### Context
Per ADR-0013 the relay URL lives inside the registration next to relay-issued credentials, so *any* address change — a DHCP lease, LAN→tunnel, a domain move of the same instance — cost a full re-pair of every device. ADR-0013 was right that overwriting the URL alone silently breaks everything **when the target is a different relay**; it never distinguished the far more common case where the target is the *same relay at a new address*, where the credentials remain perfectly valid. That distinction was previously undecidable: nothing identified a relay instance other than its URL.

### Decision
**Give the relay a stable identity separate from its address, and let clients move the address in place once they have verified that identity.**
- The relay mints a random `relayId` (UUID) on first boot into a new additive `meta` key/value table, never regenerates it, and returns it from `GET /v1/config`. It is not a secret and not a credential — it exists solely to answer "same relay?".
- Clients capture `relayId` at registration time and store it in the registration blob.
- Both clients gain a **"change relay address"** action (extension options → Connection; Android paired screen) that verifies before committing: (1) `GET /v1/config` at the new address must answer; (2) if both sides have a `relayId` they must match — mismatch is refused as "a different relay"; (3) an authenticated `GET /v1/endpoints` with the existing token must succeed — the proof that the credentials are honoured there. Only then is the stored `relayUrl` overwritten (nothing else), and the wake channels re-pointed. Against a pre-relayId relay the change still works on token-proof alone, reported as unverified rather than blocked.
- The pinned certificate (ADR-0019), when present, is kept across the change — same relay, same key.

### Consequences / follow-ups
- ADR-0013 stands for genuine relay switches: different `relayId` (or a token the target rejects) still means re-register, and the destructive reset flow remains the path for that.
- Security bound is honest, not absolute: `relayId` is unauthenticated data, so a hostile relay could echo a stolen one — but it cannot validate the device token (step 3) without the real relay's token-hash database, and a relay only ever holds ciphertext, so the residual blast radius is deny-service/observe-metadata (unchanged from P-4's analysis). On Android with a pinned cert, TLS itself authenticates the relay and closes even that.
- **Deferred, deliberately:** multiple stored routes with automatic failover (LAN first, tunnel second), and group portability *between* relays (touches recovery, ADR-0003). `relayId` is the enabling primitive for both; neither is designed here.
- The pairing payload still carries exactly one URL; a QR does not enumerate routes.
- **Amended 2026-07-29 (dogfood): both clients merged into one flow, not one button pair each.** The extension's rewrite (see ADR-0013's 2026-07-29 amendment) replaced its two-button "change address / connect to a different relay" choice with a single field that classifies the address and offers exactly one matching action. Android was carrying the same underlying detection (step 2/3 above, unchanged) but still the old two-button shape (`changeRelayButton` "Change relay address" + a separate Unpair whose confirm dialog explained when to use which). It now mirrors the merged flow: one "Move to another relay…" dialog (`MainActivity.promptMoveRelay`) with a Check step that classifies via `logic/RelayMove.kt` (unit-tested, the pure counterpart of `identity.ts`'s `probeRelay`) and relabels its own button to the one action that fits — "Switch to this address" (re-verifies, then `Store.updateRelay`, now backfilling `relayId` on commit like the extension) or "Start fresh here" (confirmed; re-registers, pre-filling the Join screen with the address just checked rather than the one left behind). Unpair's confirm dialog dropped the paragraph about relay-switching, since that's no longer its job; it kept the pre-fill of the previous address, since re-adding the same phone on the same relay is still a reason to unpair. The console was checked and has no equivalent feature to bring in line — it has never had one, per ADR-0013's original text ("the console... already has unpair → re-pair").
- **Amended 2026-10-30 (owner): iOS gets the same flow, and the different-relay copy is plainer.** iOS had no way to move relays at all. It now has the same "Move to another relay…" row on the paired screen, opening a sheet (`RelayMoveView.swift`) with one field, a Check, and one matching action, classified by `TabsendKit/RelayMove.swift` (the Swift twin of `RelayMove.kt`, with tests). On all three clients the different-relay line now reads "This is a different relay. It doesn't know your devices, so each one will need to pair again." and its button "Switch to this relay" (was "Set up here" in the extension, "Start fresh here" on Android). iOS leaves the old group through the normal unpair, then shows the pairing screen.

---

## 0019 — Phones trust a self-hosted relay by pinned key, not by CA

**Status:** Accepted · 2026-07-28
**Relates to:** ADR-0015 (Android delivery), ADR-0013/0020 (relay identity), `docs/PLANS.md` P-3, `docs/DEPLOY.md`; `server/src/tls.ts`, `shared/src/types.ts` (`PairingPayload.certFingerprint`, `PAIRING_LINK`), `android/…/net/Tls.kt`.

### Context
A self-hosted relay was unreachable from a phone without a domain and CA certificate: `localhost` on the handset means the handset, the relay binds loopback, and Android refuses cleartext to a LAN IP. The owner installs APKs from CI artifacts and uses no adb, so the documented USB workaround was advice he cannot follow. Android's actual rule is "encrypted + server identity confirmed" — a public CA is only the default way to satisfy the second half, and the pairing code is already an out-of-band trusted channel minted by the relay and carried by the user.

### Decision
**Opt-in `TLS_SELF_SIGNED=1`: the relay serves its own long-lived certificate, the pairing payload carries the key fingerprint, and Android pins it — trust-on-first-use, like an SSH host key.**
- On first boot in this mode the relay generates a 10-year self-signed RSA cert into `./.data/tls/` (SANs: localhost, every non-internal IPv4, plus `TLS_EXTRA_SANS`) and serves HTTPS itself (WS shares the server). Reused verbatim on every later boot. With `PUBLIC_RELAY_URL` unset, it defaults to `https://<LAN-IP>:<port>` so the QR carries a reachable address.
- The fingerprint is `base64url(SHA-256(SPKI DER))` — a pin on the *public key*, which leaves room for a rotating leaf over a stable key later. It travels as additive `PairingPayload.certFingerprint` and in the link fragment (`/pair#c=CODE&fp=…`), out of access logs, same as the code.
- Android parses `fp`, uses it for the pre-registration config check, stores it with the registration, and from then on every HTTP call and the WebSocket accept **exactly that key and no other** — an accept-all hostname verifier paired with the pin, because identity comes from the key, not from a SAN that goes stale with the DHCP lease. No pin ⇒ platform trust untouched.
- Clients that predate `fp` mis-parse such links; accepted, since without the pin they could not complete the handshake anyway.

### Consequences / follow-ups
- **Rotation = re-pair, by design.** Destroying `./.data/tls/` invalidates every phone's pin; the directory is documented as backed-up alongside the database. A re-trust flow (new cert signed by the pinned key) is the designed-for escape hatch if this ever bites — the SPKI pin was chosen so it can be added without a wire change.
- **Extensions cannot pin** (no say over certificate validation): a browser on the relay's machine uses `http://localhost` (secure context); a browser elsewhere keeps the domain+Caddy ladder. Extension and console parse `fp` tolerantly so links round-trip.
- Web Push still needs a CA origin, so this mode is poll/WS delivery for browsers — irrelevant to Android, which is push-less by choice (ADR-0015).
- `selfsigned` joins the server's dependencies; generation happens in boot code, `loadConfig()` stays pure.
- iOS inherits nothing from this: Safari/web surfaces cannot pin (PLANS P-5's constraint stands).

---

## 0018 — A rejected token says WHY: removal is proved, not inferred

**Status:** Accepted · 2026-07-27
**Relates to:** ADR-0003 (identity/auth; deviceToken is the only stored credential), ADR-0013 (relay switch wipes relay-scoped state), ADR-0005 (relay holds ciphertext only); `server/src/context.ts`, `server/src/db/schema.ts` (`removed_endpoints`), `shared/src/types.ts` §10b, `extension/src/background/identity.ts`.

### Context
A 401 meant two different things and the client had to guess. It guessed the worst: any rejection on an authenticated call ran `handleRemoval()`, wiping the device token, cached endpoints, send prefs, recovery kit **and the outbound queue**. That is correct when another device deleted this endpoint. It is data loss when the relay was restarted against an empty database or restored from a backup — the `endpoints` row is absent in both cases, so a healthy relay coming back up silently un-paired every device and destroyed queued sends. Dogfooding 2026-07-26 surfaced the same family of bug three times in one session: the client blaming a relay that was answering perfectly.

### Decision
**The relay records deliberate removals, so `endpoint_removed` (proof) is distinguishable from `unauthorized` (an unknown token). Clients act destructively only on proof.**
- `DELETE /v1/endpoints/:id` writes a tombstone to the new `removed_endpoints` table (keyed by `device_token_hash`, with `endpoint_id`/`group_id`/`removed_at`) **before** deleting the row. A removal without its tombstone is exactly the ambiguity this exists to remove.
- `authenticateToken` consults the tombstones on a miss: a match throws the new `endpoint_removed` code (401), anything else stays `unauthorized` (401).
- `isDefinitiveRemoval()` in `shared` is the single place that decides which codes are destructive. Clients import it rather than testing status codes.
- The extension's `handleAuthRejection(definitive)` unpairs on proof; otherwise it keeps registration and queue intact, sets an `authWarning`, and the next successful authenticated call clears it.
- Endpoints removed before this table existed leave no tombstone and read as unknown. That is the safe direction: the cost is a pairing that lingers rather than one destroyed by mistake.

### Consequences / follow-ups
- Migration is additive (`createTable … ifNotExists`), so an existing relay upgrades on boot with nothing to run by hand.
- Tombstones are never swept. They are tiny, and expiring one would silently restore the ambiguity — revisit only with a deliberate retention decision.
- Android has no auto-unpair path at all and so was never exposed to this; it is now the more conservative of the two clients by accident. If Android ever gains one, it must go through `isDefinitiveRemoval()`.
- A relay whose database is genuinely lost now leaves every client warning-but-paired forever. Acceptable — the alternative is the bug this ADR removes — but the warning needs a UI surface (follow-up).

---

## 0017 — Version the wire protocol; report skew as skew, never as an outage

**Status:** Accepted · 2026-07-27
**Relates to:** ADR-0009 (contract locks), ADR-0013 (relay URL is part of identity), ADR-0015 (Android delivery); `shared/src/types.ts` §10c, `server/src/routes/config.ts`, `android/…/logic/Protocol.kt`, `extension/src/background/identity.ts`.

### Context
There was no version negotiation anywhere. Clients registered blind, so any incompatibility surfaced downstream as a transport failure — "couldn't reach the relay" — pointing the user at a server that had answered every request correctly. Compounding it, no build could identify itself: the Android `versionCode` was pinned at 1 and `versionName` at `0.1.0` for every APK ever produced, so a stale install and a current one were indistinguishable. Dogfooding 2026-07-26 could not separate "old app" from "relay down" from "tunnel dead", and builds arrive by downloading a CI artifact with no cable attached, so nothing outside the app could answer the question either.

### Decision
**`GET /v1/config` carries the protocol handshake; clients check it before registering and name the stale side. Builds identify themselves on screen.**
- Three additive fields: `protocol` (what the relay speaks), `minClientProtocol` (hard floor — "cannot work"), `recommendedClientProtocol` (soft floor — "should update"). All absent ⇒ 1, so relays predating the handshake keep working.
- `checkProtocol()` in `shared` returns a discriminated result naming which side is stale. "Update the app" and "update the relay" are different actions by different people, so one generic message is never adequate.
- **The band between recommended and min is the forgiving zone**: below `recommended` a client warns and keeps working; only below `minClientProtocol` does it refuse. A version check that stops a working setup is worse than the skew it guards against.
- `minClientProtocol` moves almost never — every bump strands devices that were fine a moment earlier. Nudging goes through `recommended`.
- Skew never borrows an outage's words. `ProtocolMismatchError` survives `humanRegisterError` precisely so a reachable-but-incompatible relay is never described as unreachable.
- Android `versionCode` derives from the CI run number and `versionName` from run + commit; the app displays it in both paired and unpaired states.

### Consequences / follow-ups
- `CLIENT_PROTOCOL` is 2. The first-run bootstrap pairing flow is a compatibility boundary: it requires a relay that creates the initial group and code at boot, so v2 clients reject v1 relays before attempting to register. Additive fields still do not need a bump.
- The extension does not yet surface the `outdated` advisory (Android does) — small follow-up.
- Console, extension, and Android handshake before pairing. The helper is not a pairing client.
- Unknown *fields* are already tolerated in both directions. Unknown enum *values* were resolved 2026-07-28 (was `docs/PLANS.md` P-6): the descriptive enums degrade to their catch-alls (`browser` → `other`, `platform` → `unknown`) in `server/src/validate.ts` instead of 400-ing, while `kind` stays strict because it changes routing behaviour.

---

## 0016 — Relay is source-available (FSL-1.1-ALv2); everything else stays Apache-2.0

**Status:** Accepted · 2026-07-27
**Relates to:** **Supersedes ADR-0007 (License)** and the licensing stance in PRD §8; PRD §9 (monetization); ADR-0005 (relay stores ciphertext only), ADR-0003 (self-host == hosted). Full reasoning, rejected options, and the AI-copyright caveat: **`docs/LICENSING.md`**.

### Context
ADR-0007 put everything under Apache-2.0 on the reasoning that "the moat is hosted convenience, not source" and that rehosting was a low threat for a niche solo project. Two things break that. First, the party actually worth worrying about is not a scrappy rehoster but an incumbent — a browser vendor that ships send-tab-to-device natively or stands up a hosted relay, and ends the revenue line. Second, permissive-upstream/copyleft-fork is a one-way valve: a fork can absorb everything upstream does while upstream can take nothing back (Apache OpenOffice → LibreOffice). Neither is survivable for a solo project. AGPL — the reflex answer — is the wrong tool: an organisation with lawyers publishes its diff and competes anyway, while the AGPL's friction lands entirely on self-hosters' employers and would-be contributors. It filters out exactly the people who were never the threat.

### Decision
**`server/` (the relay) → FSL-1.1-ALv2 (Functional Source License 1.1, converting to Apache-2.0 two years after each release). Everything else — `shared/`, `extension/`, `android/`, `console/`, `helper/`, `e2e/`, `docs/` — stays Apache-2.0. The multi-tenant commercial control plane (billing, provisioning, tenancy, admin, abuse tooling) stays an unpublished separate codebase.**
1. **The relay is the only defensible piece.** Verified: it stores an opaque `envelope` blob plus routing columns (`server/src/db/schema.ts`), validates only the envelope's shape (`validate.ts` `reqEnvelope`), imports no crypto, and its only private key is the VAPID push-signing key. A blind pipe is cheap to copy and valuable to run at scale — which is precisely why it is the piece a competitor would take.
2. **`shared/` must stay permissive.** It exports live runtime code (`PAIRING_LINK`, `checkProtocol`, `bearerAuth`, the TTL constants) and its `exports` map points at `./src`, so it is compiled into both the FSL relay and the Apache clients. FSL there would leak the restriction into every "open source" client.
3. **Clients stay Apache-2.0** for three independent reasons: GPL/AGPL is incompatible with App Store terms (VLC was pulled in 2011), which would block the roadmapped iOS app outright; shipped client code is undefendable anyway (a zip of JS, a decompilable APK, against a public wire contract); and portable clients that work against *any* compliant relay are what make ADR-0003's self-host==hosted promise credible.
4. **Never call the relay "open source."** The Open Source Definition forbids restricting fields of endeavour, so "open source but you may not compete with me" is definitionally impossible, not merely un-approved. The relay is **source-available**; the other six packages are open source and may be called that. Accepted cost: OSI-gated distribution channels, some community goodwill, and SPDX tooling that will not recognise `FSL-1.1-ALv2`.
5. **The open/closed line is drawn once and never moves inward.** Open = everything a self-hoster needs. Closed = what is useless to someone serving four of their own devices (billing, tenancy, quotas, operator admin, abuse tooling). Nothing open today becomes closed later. AOSP earned "open in name only" not by starting split but by a decade of Google relocating functionality into closed Play Services.

### Consequences / follow-ups
- **The moat is not the licence.** Tabsend's defensible position is being neutral ground *between* browser and OS ecosystems — a vendor can only credibly serve its own browser. FSL buys a two-year head start to build that; it is not itself the strategy. If a licensing manoeuvre ever conflicts with a cross-ecosystem integration, the integration wins.
- Repo work: add `server/LICENSE.md` (FSL text, licensor + per-release change date); `server/package.json` → `"license": "SEE LICENSE IN LICENSE.md"` (not an SPDX id; the package is `private` so risk is nil); root `LICENSE` unchanged and scoped in the README to "everything except `server/`"; README licence section replaced (draft in `docs/LICENSING.md` Appendix A); PRD §8/§9 annotated in place, not deleted.
- `server/`'s `web-push` dependency is MPL-2.0 (file-level weak copyleft, already verified under 0007's no-GPL rule). MPL §3.3 permits a larger work under different terms provided MPL files stay MPL, so FSL is fine — spot-check, not an audit.
- **Copyright caveat, recorded honestly:** this codebase is substantially AI-generated, and the copyright status of AI-generated code is unsettled and jurisdiction-dependent (US: human authorship required; UK: computer-generated works protected; EU/DE: human creativity required). The implication runs the *wrong* way from intuition — if copyright does not subsist, **no** licence attaches, Apache-2.0 included, so weak copyright makes the position worse, not moot. Mitigations: keep the human-authorship record visible (this file is the primary asset), register the "Tabsend" trademark (the one instrument that survives weak copyright), and get real legal advice before the first paying customer, incorporation, or outside contribution. `docs/LICENSING.md` §8. **Not legal advice.**

---

## 0015 — Android pairs push-less (no distributor app); WS fast path + polling deliver

**Status:** Accepted · 2026-07-22
**Relates to:** ADR-0006 (transport; no Firebase in the main build), ADR-0001 (WS fast path is latency-only), PRD §6.1 (queue+poll correctness); Chunk 5c known-limitation #5 ("pairing requires a distributor"); `shared/src/types.ts` §2, `server/src/validate.ts`, `android/app`.

### Context
Chunk 5c made `RegisterRequest.pushSubscription` a hard gate on the phone: joining required a UnifiedPush endpoint in hand, which required a distributor app (ntfy) installed first. Dogfooding hit exactly that wall ("Couldn't get a push endpoint…"), and the owner ruled the dependency out: **a second app is too much setup for pairing to ever require it.** Meanwhile the architecture never actually needed push for correctness — the extension registers a placeholder subscription and polls, the relay's WS `/v1/stream` fast path already delivers `message` events instantly to any connected client, and PRD §6.1's rule is explicit: correctness never depends on a push arriving. Bundling a distributor is not a thing (Android apps can't ship other apps), and FCM would reverse ADR-0006 and burden every self-hosted relay with Firebase credentials.

### Decision
**Drop UnifiedPush from the Android app entirely. The phone registers with `pushSubscription: {transport:"none"}` — a new wire variant meaning "never wake me" — and is reached by (1) the WS fast path while the app is alive, (2) an ~5-minute AlarmManager poll chain in the background, (3) the 15-minute WorkManager periodic as backstop, and (4) drain on open/boot.**
- `{transport:"none"}` is additive to the `PushSubscription` union; the relay validator accepts it and `wake()` no-ops on it (it can never accrue push_failures). No DB migration (the column stays non-null JSON).
- The Android app connects to WS `/v1/stream` (OkHttp, hello → ping per §11) while any of its screens is visible; a `message` event just triggers the ONE idempotent drain loop — stream bytes are never trusted (PRD §6.1).
- **Instant delivery** is enabled by default: a `specialUse` foreground service keeps the socket up in the background, at the Android-mandated cost of a small permanent notification + some battery. A person may turn it off, and an existing explicit opt-out stays off through the change. specialUse (not dataSync) so Android 15's dataSync time caps can't cut the connection; boot-time FGS start failures degrade silently to the poll chain.
- Background cadence: `setAndAllowWhileIdle` one-shot alarms chained every ~5 min (no permissions needed). Deep Doze throttles ALL apps to ~9–15 min ticks — that's the platform floor without a push provider, accepted.
- UnifiedPush connector, receiver, and ntfy UI copy are deleted, not kept dormant — if instant-push-without-a-running-app is ever wanted for stock Android, FCM (revisiting ADR-0006) is the honest path, not a resurrected distributor dependency.

### Consequences / follow-ups
- Pairing is now zero-prerequisite on the phone: relay URL + code, done.
- A backgrounded phone delivers immediately by default. Someone who turns the service off sees links after minutes instead; opening the app is always instant.
- The extension's chunk-4 placeholder webpush subscription could switch to `{transport:"none"}` and retire that documented debt (small follow-up).
- Chunk 5c's known-limitations #1 (FCM flavor) and #4 (multi-distributor picker) are obsolete; #5 is resolved.
- **Amended 2026-10-01 by [ADR-0034]: the mandated notification is no longer the price of
  instant delivery, but this ADR is not withdrawn.** The owner raised the notification as the
  live friction; ADR-0032's forwarder had meanwhile removed the "every self-hoster needs the
  push provider's credentials" half of this ADR's reason for refusing FCM, leaving only
  ADR-0006's objection to Play Services in the build. Android can now be rung through Google
  via that same forwarder, with no wire change and no relay change, in ONE apk that decides at
  runtime — so a phone without Play Services runs it unchanged and still gets everything
  described here. **Everything in this ADR remains live for that phone**, and for anyone who
  chooses "no Google": push-less pairing (`{transport:"none"}` is still what pairing
  registers), the WS fast path, the alarm chain, and `StreamService` with its notification.
  What changed is that the notification is now a fallback rather than the only option. The
  owner also asked whether a silent Android could be a paid feature; it is not, and P-11
  records why. Full analysis: `docs/PLANS.md` P-11.

---

## 0014 — Drop the native helper from the v1 path (relay handles same-machine too)

**Status:** Accepted · 2026-07-21
**Relates to:** the removed native-helper implementation; ADR-0013 (relay is re-registered, not migrated); `docs/PLANS.md` P-1/P-2.

### Context
Chunk 6a built the native helper as a same-machine, no-cloud delivery path — a launchd-managed broker + native-messaging host letting two browsers on one Mac exchange tabs with no network hop (PRD §6.4: "no cloud round-trip at all"). But PRD §6.4's own P0 flow already required "the cloud console... to establish identity" for *every* endpoint, helper or not — pairing has no non-relay path. Dogfooding surfaced the consequence: a same-machine user must (1) run a relay (env vars, VAPID keys, a kept-alive process) just to pair, and only after that (2) separately install the helper — currently a raw dev-grade shell script, no signed installer, manual Chrome-family extension-ID lookup per browser, a re-run required for every new Chrome-family browser added later. There is no case where the helper is *less* total setup than just using the relay that's already running for delivery too — it adds a second thing to install without removing the first.

The helper's actual value — avoiding a cloud round-trip — is real only when the relay is a remote/hosted server the user doesn't run (PRD §9's future managed-cloud Pro tier). Against a **self-hosted local relay** — the only path v1 ships — there's no meaningful cloud hop to avoid: the relay already runs on the same machine, and its WebSocket fast path delivers same-machine sends at effectively the same perceived speed as native messaging. The premise is moot for the case v1 actually serves.

### Decision
**Deprioritize the native helper out of the v1 path. Same-machine delivery uses the relay like any other pair of endpoints — no separate no-cloud path for v1.**
- Onboarding/install guidance no longer mentions or recommends the helper. Two browsers on one machine just both pair to the same running relay.
- The implementation, installer, test package, native-messaging permission, and UI were removed on 2026-07-31. A future local-delivery proposal must start from a new design and ADR rather than reviving this code.

### Consequences / follow-ups
- `docs/PLANS.md` P-1 and P-2 (helper onboarding-friction proposals) are superseded by this decision — the fix for "the helper increases friction" is "don't use the helper for v1," not "fix its onboarding."
- The endpoint contract no longer admits `native_helper`; same-machine sends use the relay like every other endpoint pair.

---

## 0013 — Change the relay after onboarding (re-register, don't migrate)

**Status:** Accepted · 2026-07-21
**Relates to:** ADR-0009 §3 (relay URL is client base-URL config, carried in pairing), DOGFOOD pass-2 #2 (relay URL is an onboarding-time choice); `extension/src/background/identity.ts`, `extension/options.html`.

### Context
The relay URL was set once, during first-run onboarding, and never editable afterward in the extension — no relay control on the options page. A user who set up against a local dev relay (`localhost:8787`, "local only") could not move to a real networked relay without reinstalling. The obvious "make the relay URL an editable setting" is wrong: the relay URL is not a setting. It lives inside the `Registration` alongside `deviceToken`/`endpointId`/`groupId`, all issued **by that specific relay**; on another relay those credentials are meaningless, so overwriting only the URL silently breaks every API call.

### Decision
1. **Switching relays is a re-registration, not a migration.** A group cannot be carried across relays from the client alone (the new relay knows nothing of the old group/keys). So the extension's options page gains a **Connection** section with a "Connect to a different relay…" button that hands off to the *existing* onboarding page — reusing the whole tested create/join/device/recovery flow — rather than building a second registration path or a fake in-place edit.
2. **`resetRegistration` wipes only relay-scoped local state.** New `resetRegistration()` best-effort-DELETEs this endpoint on the old relay (ignored if unreachable), stashes the old URL under a new `lastRelayUrl` key (so onboarding pre-fills it — a localhost → LAN-IP edit is one keystroke), then clears `registration`, `recovery`, `prefs`, `endpointsCache`, `pushSubscription`+`pushVapidKey`, `outbound`, `pendingUndo`. The device X25519 keypair (`identity`) and `ClientSettings` are **kept** — the keypair is not relay-scoped and is reused across registrations. The RPC then tears the wake channels down (close the offscreen doc on Chrome; drop the event-page WS on Firefox via `applyConfig(null)`, which now actually disconnects).
3. **Apps already had the equivalent.** Android supports it via **Unpair → rejoin** (a phone only ever joins); polished so the old relay URL pre-fills after unpair and the dialog names relay-switching as a use. The console gets its relay from the pairing link / serving origin and already has unpair → re-pair. No wire/server change.

### Consequences / follow-ups
- Switching relays is destructive to the *local* group membership by design; the UI confirms ("disconnects this browser from your current devices on `<relay>`") before resetting.
- A phone can't create a group, so moving a whole setup to a new relay means creating the group there from a browser first, then rejoining from the phone.
- If a hosted service later ships, the same Connection section is where its relay/account choice would surface (DOGFOOD pass-2 #2: "advanced settings" for the hosted path).
- **Amended 2026-07-29 (dogfood): the user never classifies the move; the extension does.** Presenting "Change address…" and "Connect to a different relay…" as a *choice* was the mistake. It asked the owner to decide which case he was in — from a paragraph of explanation — and then failed his localhost → mini-PC attempt with an error, even though `relayId` plus an authenticated probe answers that question definitively before anything is committed. The Connection panel is now one field ("Where is your relay now?") and one `probeRelay` call, which touches no storage and returns `same` / `different` / `unreachable` / `error`; the UI states the finding and offers only the matching action — switch (devices stay paired) or start fresh (confirmed, every device re-pairs). ~150 words of standing explanation went with it. The two commit paths are unchanged underneath: `changeRelayUrl` re-verifies before swapping the URL, `switchToRelay` is `resetRegistration` plus the destination.
- **Amended 2026-07-29 (dogfood): relay pre-fill, split in two.** Decision 2's blanket pre-fill of `lastRelayUrl` is withdrawn — the relay you just chose to leave is the one address that is *not* a sensible default, and on a fresh install the old `http://localhost:8787` default handed every user a loopback address as a recommendation (the Android app had already dropped its equivalent pre-fill; the extension had not). Two carried values now, weighted differently: `pendingRelayUrl` (typed in settings, on the way to it) IS pre-filled, and `lastRelayUrl` is offered as a "use it again" click via `StateView.previousRelayUrl`. With neither, first run's relay field starts **empty**.

## 0012 — Harden & package build decisions (Chunk 6b)

**Status:** Accepted · 2026-07-19 (build decisions, within the Chunk-6b mandate)
**Relates to:** ADR-0003 (recovery), 0005/0009 (E2E), 0006 (push), 0007 (license); `shared/src/types.ts`. Full detail: `docs/reports/chunk-6b.md`.

### Context
Paying the accumulated debts (recovery wordlist + flow, Android crypto, bundle size, server hardening) and packaging the product surfaced choices worth recording.

### Decision
1. **Real BIP39 wordlist, no versioning needed.** The 96-word placeholder is replaced by the canonical 2048-word BIP39 English list (public domain / CC0, SHA-256 `2f5eed53…`, loaded at boot with a 2048-word integrity check). Verification is `SHA-256(phrase)` on the literal, normalised (lowercase/space-collapsed) phrase — it never re-derives words from the list — so swapping the list **cannot** invalidate the owner's already-minted phrase. No `wordlistVersion` field is recorded because nothing downstream consumes one; if a future flow validates typed words against the list, that flow would pin a version.
2. **Recovery re-join route (sanctioned additive lock).** `POST /v1/endpoints/recover` with `RecoverRequest`/`RecoverResponse` (`types.ts` §10). Unauthenticated (all devices may be lost), verifies the phrase against the stored verifier, and enrolls a fresh endpoint into the group — the join path authorised by the phrase instead of a pairing code. A wrong phrase returns `unauthorized` (401), a uniform "credential rejected" with no group-existence oracle. Recovery restores **membership, not old ciphertext** (the new key can't read history sealed to lost devices — inherent to E2E). Wired into the console's onboarding.
3. **Server hardening, single-instance-honest.** (a) Rate limiting on the auth-free write routes (register, recover) via an in-process fixed-window limiter keyed by client IP → the contract's `rate_limited` (429) + `Retry-After`; per-instance to match the single-instance WS hub, fails safe. (b) A configurable request body cap (`MAX_BODY_BYTES`, default 1 MiB → 413). (c) Dead-subscription pruning: N consecutive 404/410 push failures (`PUSH_DEAD_THRESHOLD`, default 3) marks a subscription dead and skips its wakes; the client's heartbeat rotation (chunk-4 self-heal) resets the counter. New `endpoints.push_failures` column via the same additive, dialect-agnostic in-place migration.
4. **Android crypto: Bouncy Castle, not the hand-roll.** The XSalsa20 keystream now runs on BC's vetted `XSalsa20Engine`; the `crypto_box_beforenm` HSalsa20 (BC exposes no standalone HSalsa20) uses BC's public `Salsa20Engine.salsaCore`, undoing its feed-forward add. All hand-rolled Salsa20 round arithmetic is deleted. The committed libsodium interop vector stays green (the proof).
5. **Version from one place.** The root `package.json` `version` is stamped into the emitted extension manifest at build time; the store-package scripts read the same value. `web-ext` is pinned as a devDependency.

### Consequences / follow-ups
- `types.ts` gains `RecoverRequest` + `RecoverResponse` (§10) — the only wire additions this chunk; both additive.
- **Bundle size (debt #6) remains, documented.** Already non-sumo; the libsodium ESM entry is broken upstream (hence the CJS alias); dynamic-import code-splitting cuts `background.js` 752 kB → 26 kB but **breaks crypto in the MV3 service worker under the `pnpm e2e` gate** (A/B: static 7/7, dynamic 0/7 — SW `generateKeyPair` never resolves). Kept static import; revisit if upstream ships a working ESM build or MV3 SW dynamic-import support proves reliable in the gate's Chromium.
- Two `web-ext lint` items (QR `innerHTML`, gecko `data_collection_permissions`) are pre-AMO-submission fixes, documented in `docs/AMO_SOURCE.md`.

---

## 0011 — Reliability core build decisions (Chunk 4)

**Status:** Accepted · 2026-07-17 (build decisions, within the Chunk-4 mandate)
**Relates to:** PRD §6.1/§6.6; ADR-0004/0006/0008/0009/0010; `shared/src/types.ts`. Full detail: `docs/reports/chunk-4.md`.

### Context
Building the reliability core surfaced several policy choices the design docs left to the builder. Recording them so Chunk 5's parallel agents and the self-host story inherit a settled contract.

### Decision
1. **Dual dialect, one migration.** SQLite stays the dev/test default; Postgres is opt-in via a `postgres://` DATABASE_URL. Both run the SAME dialect-agnostic migration + queries (TEXT ISO-8601 timestamps, INTEGER booleans, `ON CONFLICT DO NOTHING`). The chunk-2 integration suite runs on both, env-switched (`TABSEND_TEST_PG=1`); CI runs the matrix.
2. **TTL sweep mirrors the ack model.** An expired-but-unacked message has its envelope **nulled** immediately (privacy — no ciphertext past TTL), retaining the routing row as a tombstone (an idempotent replay can't resurrect it). Tombstones are hard-deleted once past a grace window (default = one TTL ⇒ retention ≈ 2× TTL). Delivery of expired messages was already impossible via the lazy `expires_at > now` read filter; the sweeper closes the retention gap.
3. **Stale endpoints: server never auto-deletes.** ADR-0004's "pruned by last-seen" is resolved conservatively: an endpoint offline > 30d is **marked** stale in the client's list rendering (derived from `lastSeenAt`, no new wire field), but removal stays a user action (`DELETE /v1/endpoints/:id`). Avoids the relay silently dropping a vacationing endpoint.
4. **Config discovery route (sanctioned additive lock).** `GET /v1/config → ServerConfigResponse { vapidPublicKey }` (unauthenticated) lets a client fetch the `applicationServerKey` before subscribing. Added to `types.ts` §10c.
5. **Offscreen-document WebSocket.** The MV3 SW can't hold a socket across idle-termination, so an offscreen document holds the `/v1/stream` WS. Chrome offers no dedicated "network connection" offscreen reason; `BLOBS` is used with an honest justification (documented approximation). The socket is latency-only — poll + push are the correctness path. **Empirical constraint:** offscreen documents get almost no `chrome.*` APIs — `chrome.storage` is unavailable (verified) — so the doc receives its relay/token config from the SW over runtime messaging (`need-config` pull at startup + push on registration change), never from storage.
6. **One deliver path.** Poll, push tickle, and WS `message` all funnel through a single serialized, seen-set-idempotent deliver loop, so redundant wake paths can never double-open a tab.
7. **VAPID key rotation is detected client-side.** A push subscription is bound to the `applicationServerKey` it was created with; if the relay's key changes (self-hoster regenerates keys), every push 403s while the subscription looks healthy — silent wake loss. The extension therefore stores the key it subscribed against, compares it to `GET /v1/config` on each SW boot, verifies the browser-level subscription via `PushSubscription.options.applicationServerKey`, and unsubscribes/resubscribes on mismatch, then rotates the new subscription to the relay via heartbeat.

### Consequences / follow-ups
- `types.ts` gains `ServerConfigResponse` (§10c) — the only wire addition this chunk.
- Chunk 5 (Firefox) has no Push API: it relies on the WS + alarms wake path (spike §3b); the offscreen pattern is Chrome-specific.
- Local Postgres via a project-local `pg_ctl` cluster (`scripts/pg.sh`), not `brew services`.

---

## 0010 — Console endpoints & E2E history copies

**Status:** Accepted · 2026-07-16 (owner decision at build kickoff)
**Relates to:** ADR-0003, 0004, 0005, 0009; PRD §5 (console P0), §6.6; `shared/src/types.ts`.

### Context
PRD P0 gives the console a "recent-link history," and an 0005 consequence claimed a *paired* console "decrypts locally." Build review caught the contradiction: `crypto_box` seals each payload to exactly one target's key, so no console — paired or not — can ever decrypt traffic between two *other* endpoints. Options considered: (a) metadata-only history (source → target + timestamp, no URLs), (b) sender seals an extra copy to the console, (c) drop console history from v1. Owner picked **(b)**.

### Decision
1. **The console is a real endpoint.** `EndpointKind` gains `'console'`. A console pairs like any device (QR / short code), holds its own keypair and device token — and is **excluded from every target list and chooser**; it is never a user-visible send destination.
2. **History = ordinary messages, sealed per console.** On every send, the source seals one extra envelope per (console endpoint × real target) carrying the same `SendPayload` plus `historyOf: { targetEndpointId }` *inside the ciphertext*. On the wire these are normal `SendItem`s targeted at the console; the relay learns nothing new — it already sees the real item's routing row.
3. **Console consumption.** The console pulls/acks copies like any endpoint, renders them as history entries (never opens tabs), and persists them client-side (IndexedDB). Server behavior is unchanged: payload deleted on ack or TTL.
4. **Sender-side ack visibility (companion fix, same review).** So the chooser's ⏳ pending row can drain, the WS stream gains an `acked` event to the source, and `GET /v1/messages?outbox=1` returns the calling endpoint's still-unacked sends (routing projection, no envelopes).

### Consequences / follow-ups
- Zero cost when no console is paired (no copies minted). A console offline past the TTL has history gaps; a freshly paired console starts with empty history — both accepted.
- Multi-target sends mint one copy per console per real target (simple; matches per-target sealing).
- Clients filter `kind === 'console'` out of chooser/context-menu target lists; no server-side rule (console-targeted items *are* the history mechanism).
- `types.ts` updated: `EndpointKind` + `'console'`; `SendPayload.historyOf?`; `ServerStreamEvent` + `acked`; `OutboxMessagesResponse`.
- Supersedes the 0005 consequence line "Paired-device console decrypts locally" — a console decrypts only what is sealed *to it* (its history copies and any direct sends).

---

## 0009 — Contract locks (send-prefs, routes, pairing input, E2E primitive)

**Status:** Accepted · 2026-07-16
**Relates to:** `shared/src/types.ts`; ADR-0008; Decisions 0002, 0003, 0004, 0005; PRD §6.5.

### Context
Drafting the `shared/` contracts (follow-on to 0008) surfaced four items `types.ts` §10 left open. Locking them so the protocol/server can be built.

### Decision
1. **Send preferences are client-local.** `primaryTargetId`, `primaryPinned`, and the recent-targets MRU live in extension/app local storage, not the relay. They're per-source and only that endpoint reads them; a reinstalled profile is a new endpoint anyway (0004), so server persistence buys nothing; and keeping them local avoids retaining send-pattern metadata the delete-on-ack model otherwise drops. Console can't show/edit a source's default target (acceptable). Promotable to an optional server mirror later without a wire change.
2. **REST routes are `/v1/endpoints/*`.** Aligns the API with the model and the core differentiator (0004: the unit is a browser endpoint, not a device). User-facing labels still read "device." PRD §6.5 updated. The per-endpoint token keeps the name `device_token` (colloquial; not worth the churn).
3. **Pairing carries the relay URL in the QR and a copy-paste link; the bare short code is a hosted-default convenience.** QR and pairing link both encode `{relayUrl, code}` (covers self-host and no-camera desktop→desktop). A 6–8 char short code assumes the hosted relay; a self-hoster entering a code sets a one-time relay field first. `PairingPayload` stays `{relayUrl, code}`; the code rides in the link *fragment* so it never hits a server log. Relay URL is client base-URL config, not a message-body field.
4. **E2E primitive = libsodium `crypto_box` (authenticated), X25519 + XSalsa20-Poly1305.** Chosen over `sealed_box` because sender authentication is ~free (every endpoint already has a keypair and shares pubkeys in-group, 0005) and it stops a compromised/malicious relay from *injecting* links, not just reading them. Chosen over WebCrypto P-256+AES-GCM because that still needs a crypto lib on Android and uses older curves with more hand-assembly. Envelope carries `alg`, `nonce`, `senderKeyId`, `targetKeyId`, `ciphertext`. Sender is non-anonymous within the group — a feature. No forward secrecy (one-shot links, 0005); the `alg` tag allows future rotation (e.g., HPKE).

### Consequences / follow-ups
- `types.ts` updated: `EncryptedEnvelope` gains `nonce` + `senderKeyId`; `SourcePrefs` marked device-local and its server `/prefs` routes removed; `PAIRING_LINK` helper added; routes/naming note resolved.
- PRD §6.5 routes renamed `/v1/devices/*` → `/v1/endpoints/*`.
- The server performs **no** crypto — it forwards ciphertext; sealing/opening is client-only (libsodium-wrappers in the browser, lazysodium/libsodium on Android).
- Remaining open: **0006 (transport)** — the Stage 0 spike. All UX/contract items are now locked.

### Note — 2026-10-15 · what the launch-surface review found against decision 4

Two statements here no longer hold (`SECURITY_REVIEW.md` L10, `PLANS.md` P-16 item 10).
**Sender authentication does not stop every injection.** `crypto_box` derives one key per pair
of devices, so a box A sealed to B also opens at A with B named as sender, and the sealed
payload names neither target nor message id. A compromised relay cannot inject a new link, but
it can hand a device its own sent tab back "from" the device it went to, and replay any tab to
its recipient under new ids. The fix on record is to seal the target's key id and the message
id inside the payload. **Android does not use lazysodium**: since ADR-0012 it composes
BouncyCastle's X25519, XSalsa20 and Poly1305 with its own HSalsa20; iOS writes Salsa20 and
Poly1305 itself. Both matched libsodium in every case of the review's differential test.

---

## 0008 — Interaction/UX flow set

**Status:** Accepted · 2026-07-16
**Relates to:** PRD §5A, §6.1, §6.4; Decisions 0001–0005. Full spec: `INTERACTION_FLOWS.md`.

### Context
0001–0005 fixed the *architecture* of the send (five surfaces, one shared target-list model, per-source primary, account-less pairing, E2E). This entry fixes the *interaction behavior* on top of it — the send gesture per surface, the chooser states, and the pairing/onboarding flow — so `shared/` contracts can be locked. One genuine conflict had to be resolved: PRD §5A wants a one-click quick-send from the toolbar icon; 0001 wants the icon to open the chooser. A browser action with `default_popup` set can't do both.

### Decision
- **Toolbar click = a setting; Chooser is the default.** Chooser mode (`action.setPopup('chooser.html')`) opens the rich chooser on click — 0001 verbatim. Quick-send mode (`action.setPopup('')` → `action.onClicked`) sends to primary and moves the target list to the icon's right-click menu — PRD §5A's "the icon is the fast path." Runtime toggle, no reinstall. Reconciles §5A and 0001 by making both real, one default and one opt-in.
- **Mis-send safety = toast-only, no undo.** Every send confirms with a toast that names the target (so a wrong target is visible); recovery is to resend correctly and close the wrong tab. No cancel window, no retraction message to build.
- **Queued/offline visibility = honest toast + conditional pending row.** Toast text reflects target presence ("…— opens when it wakes"); pending items surface **only inside the chooser and only when non-empty**. Rejected: fully-invisible identical toast (risks the silent-surprise failure the product exists to beat) and a standing queued dashboard (violates invisible-utility). The toast copy and the pending row remain independent switches (settings, §7 of the spec).
- **Adaptive rule made concrete:** `n=0` → every surface routes to onboarding; `n=1` → every surface sends direct (no one-row chooser); `n≥2` → chooser/menu. Self excluded (0002).
- **Chooser states specced:** zero-target empty state (the on-ramp to pairing), single-target one-row chooser (auto-send on open until it was dropped 2026-07-21 — see the amendment on 0001), multi-target chooser, offline targets shown-and-selectable (presence non-gating, 0001), in-flight/error, and P1 multi-select.
- **Two queues guarantee delivery:** a source-side outbound queue (source offline) plus the server-side durable queue (target offline, PRD §6.1). Neither can silently drop.
- **Pairing/onboarding:** first-run creates the group + captures device label (0004) + nudges the recovery key (0003/0007), then lands on the zero-target empty state; adding an endpoint uses QR (phone) / 6–8-char short code (desktop→desktop), minted by an already-paired device (console canonical, extension convenient); pubkeys exchanged on join (0005); primary is learned on first send (0002).

### Consequences / follow-ups
- Feeds the `shared/` contracts pass: `primaryTargetId`/`primaryPinned` per-endpoint; client-local settings (`toolbarClickMode`, `showSuccessToast`, `showPendingRow`, `contextMenusVisible`, hotkeys); `pairing_codes` code length + TTL. See `INTERACTION_FLOWS.md` §10.
- Confirmation degrades to an action-badge ✓ on restricted pages where content scripts can't inject a toast (`chrome://`, Web Store, PDF) — an honest, documented limit.
- Hotkey opens a popup **window** on Chrome (`action.openPopup()` unreliable, 0001) but the real action popup on Firefox (`browserAction.openPopup()` works) — per-browser nuance, not a blocker.
- Queued-visibility confirmed by owner 2026-07-16 (option A + a slice of C): honest toast + conditional pending row.

### Amendment — 2026-07-29 · feedback must be able to say "no"

Dogfooding the self-hosted relay (a mini PC on the LAN) exposed the gap this ADR's feedback model left: **the toast had no failure state, and quick-send fired it before the send.** Firefox → Arc stopped delivering entirely and every surface still read as success. The amendment narrows what the UI may claim, without changing the delivery guarantees:

- **"Sent" now means the relay accepted it.** A tab held in the source-side outbound queue reports as `Waiting to send` (amber), not `Sent` (green). `SendResult` gains a classified `failure`; its absence is the licence to say "Sent".
- **`No connection` splits into browser-offline vs. relay-unreachable**, and the relay case names the address — the one thing a self-hoster can act on. `navigator.onLine` is used only to *demote* a relay diagnosis, never to skip a send.
- **Quick-send reports the real outcome.** The undo-window banner says `Sending`, and the dispatched send's actual result replaces it on the originating tab. Previously that result was discarded.
- **Relay reachability is persisted** (fed by ordinary traffic, no extra probe) so the chooser and options page can explain a standing outage, with a 30 s grace so a container restart isn't announced.
- **Every send path reports once**, from `sendToTarget` — context-menu sends had no feedback at all before.
- **No wire code reaches a user.** `ApiError.message` is contractually allowed to change and is written for a log; only `error.code` travels into the client, which owns the wording. An unrecognised code folds to the generic one rather than leaking.
- **The held queue is nameable.** Title + URL are stored device-locally beside each envelope so the chooser can list which tabs are stuck, not just count them. No wire or server impact — the relay still sees only ciphertext — and the entry dies with the item.

Unchanged: toast-only mis-send safety, the 4 s undo window, presence non-gating, the two-queue delivery model, and the restricted-page badge fallback. Spec: `INTERACTION_FLOWS.md` §4a–4b.

**Ported to iOS and Android · 2026-07-29.** All three clients now agree about what "Sent" means. The rules above are unchanged; three things are mobile-specific:

- **Local notifications are the surface, not toasts.** `ShareActivity` toasts then `finish()`es and `ShareViewController` is torn down on completion, so mobile has no equivalent of the toolbar badge and a delayed outcome had nowhere to land at all. One notification id per send (derived from the message id) so two sends in flight never overwrite each other's verdict, while a single send's own optimistic state is still replaced by its real one. Android gets two channels — `send_status` (IMPORTANCE_LOW, auto-dismissed after 2 s) and `send_problems` (IMPORTANCE_HIGH, lingers) — which is a genuine improvement on this ADR's single `showSuccessToast` boolean: the OS settings UI lets the user mute confirmations while keeping failures, per-tone, with no preference screen of ours. Failures are never gated behind an app setting. Where notifications are denied, the in-app waiting list is the only surface, so it is not optional and says so.
- **iOS does not notify on plain success.** There is no `setTimeoutAfter` on iOS: a success notification sits in Notification Center until swiped, which is litter for something the user watched succeed as the sheet dismissed. So iOS notifies only pending, error, and queue-recovery. This inverts the default above and is defensible ONLY because failures now always notify — silence became unambiguously good, which was not true before this amendment. Owner decision, taken as provisional pending a dogfood check; one flag (`SendNotifications.notifiesPlainSuccess`) restores parity.
- **The queue is written before the POST, not after the failure.** A share extension dies the moment it completes its request, and `ShareActivity` is a task the OS reaps freely, so a POST in flight can vanish — and a tab that was never queued and never accepted was simply lost, with the queue noticing nothing on the next open. Both platforms now enqueue the sealed item first and drop it once the relay gives a definite answer. Safe to replay because the relay inserts on the client-generated id with ON CONFLICT DO NOTHING, so this needs no iOS background `URLSession` (the fix `ROADMAP.md` originally proposed) and closes the same hole on Android, which that fix would not have.

**A held tab reports either way.** An item leaves the queue only on a definite answer, and both outcomes are told: the queue draining announces itself (as in the extension), and a tab the relay finally REFUSES on a later retry now announces that too, on the problems channel, naming the tab and why. Without the second the original bug simply grew a longer fuse — the user was promised "waiting to send", walked away, and the tab died on a 401 in silence. Correspondingly, a 429 or any 5xx is classified as "not now" rather than as a refusal (`SendFailure.RelayBusy`), because the HTML 502 a reverse proxy returns for a restarting relay carries no error envelope, is therefore indistinguishable from `internal`, and treating it as final discarded the tab — in a queue flush, every queued tab in one pass. The consequence that left open — nothing ever ENDED a wait, so a permanently-5xxing envelope was retried forever and an outage grew the queue without bound — was closed on 2026-08-18 by an age cap at the relay's own message TTL, a 200-item size cap that evicts the oldest, and a local cancel on the waiting list, all three announced rather than silent (`INTERACTION_FLOWS.md` §4f). The recoverable/final split above is unchanged by that: a 429 or a 5xx still keeps the tab, and the age cap is what eventually ends it. **Back-ported to the extension · 2026-08-16** (`INTERACTION_FLOWS.md` §4e), where the same non-2xx-is-final rule was still live and its queue drain was the one place that could lose every held tab at once.

Two mobile caveats on the relay-health verdict: it is read from `registeredRelayUrl` rather than the full registration, because on iOS the latter reads the device token out of the Keychain and doing that on every API call made the verdict silently never record; and on iOS the verdict lives in the App Group store, so an outage first noticed by the share extension (a separate process, and usually the first thing to send) is the same verdict the app explains later.

### Amendment — 2026-08-05 · presence has a third value, and it is "unknown"

The same honesty rule, applied to the dots rather than the toasts. Dogfooding found the extension popup drawing a confident green dot next to a banner saying the relay had not answered in two hours: presence was rendered straight off the cached endpoint list, and nothing aged that verdict out, so an outage froze it at whatever had been true when the relay was last reachable. Every client had the same bug, because every client paints its device list from cache precisely when the relay is unreachable.

- **A presence verdict expires.** The relay calls an endpoint online for `PRESENCE_ONLINE_THRESHOLD_SECONDS` after its last heartbeat, so a client's snapshot of that verdict cannot outlive the same window. The extension and Android record when the cached list was fetched and compare against that horizon; iOS's share sheet, which always attempts a live list and has no cached-first paint, uses the simpler fact of whether that fetch succeeded; the console uses its own connection state.
- **Unknown is drawn as a different KIND of answer**, not a third status: a dotted ring (`◌` on mobile) against the solid offline ring. No row moves, resizes, or reorders when presence expires — the outage must not rearrange the list under a click that is already on its way.
- **"Last seen" survives; "online" does not.** The first is a statement about the past and stays true as a snapshot ages, so an unknown row keeps it and is often more informative for having it. Screen readers get "status unknown" rather than a colour we cannot vouch for.
- **Unchanged: presence is still non-gating (0001).** Every row stays selectable during an outage, because a send made now is legitimately queued and will fly when the relay returns. This amendment narrows only what the UI may CLAIM, never what the user may do.

---

## 0007 — License

**Status:** ~~Accepted~~ **SUPERSEDED by [ADR-0016](#0016--relay-is-source-available-fsl-11-alv2-everything-else-stays-apache-20)** · 2026-07-09, superseded 2026-07-27
**Relates to:** PRD §8 (build-vs-borrow), §9 (monetization)

> **Read 0016 first.** The blanket Apache-2.0 stance below no longer holds: the relay
> (`server/`) is now source-available under FSL-1.1-ALv2. Everything else in this ADR —
> the no-GPL dependency rule, the patent-grant reasoning, the Apache-2.0 choice for the
> clients and `shared/` — still stands.

### Context
Open/self-host core + hosted Pro tier. The core must be open and contributor-friendly without giving away the Pro business, and clear of GPL entanglements (we learn from but don't fork floccus, GPLv3).

### Decision
**Apache-2.0 for the open core; Pro/hosted code kept in a separate, unpublished package.**
- Open core (extensions, protocol, self-host relay) under Apache-2.0 — permissive + explicit patent grant.
- Pro-only bits (managed-relay ops, billing) stay closed simply by not being published — no copyleft needed to protect them.
- No GPL-derived dependencies.

### Consequences / follow-ups
- Rejected AGPL-3.0 + CLA: low rehost-competitor threat for a niche solo project, it deters users/contributors, and it would complicate our own closed Pro tier. Revisit only if closed-competitor rehosting becomes a real concern.
- The moat is hosted convenience, not source.
- Add `LICENSE` (Apache-2.0) at repo root; keep the Pro package in a private repo/workspace.

---

## 0006 — Transport

**Status:** Accepted · 2026-07-16 (Spike A confirmed; was Provisional 2026-07-09)
**Relates to:** PRD §6.1–6.2, §11; Decision 0005; full spike report: `docs/spikes/transport.md`

### Context
Must wake possibly-suspended endpoints (MV3 service worker, backgrounded Android app), deliver reliably, queue-backed, self-hostable, minimizing Google dependency.

### Decision
**Implement the standard VAPID Web Push protocol directly; don't build the product on ntfy-as-an-app.**
- Desktop extensions: VAPID Web Push is the native wake mechanism for a suspended MV3 service worker; the relay speaks Web Push.
- Android: support **UnifiedPush** (self-hostable, no Google, WebPush-based → reuses relay logic), with **FCM as a fallback** for stock-Android users.
- Self-hosters point Android at their own UnifiedPush distributor; relay unchanged.

### Consequences / follow-ups
- Chrome Web Push endpoints inherently route through Google's push service (unavoidable), but no FCM SDK/credentials are needed and payloads are ciphertext (0005) → the push layer relays only an encrypted blob.
- **Partially reversed 2026-10-01 by [ADR-0034], and exactly this much:** the Android app now
  contains the Firebase messaging SDK, so "no FCM SDK" no longer holds for Android. The
  *credentials* half still does — no relay, hosted or self-hosted, holds a Firebase credential;
  the wake-up forwarder (ADR-0032) holds it, and the push it sends is a content-free marker. The
  decision above picked UnifiedPush with FCM as a fallback; ADR-0015 deleted the former and this
  is the latter arriving, five ADRs later, through a forwarder that did not exist when either was
  written.
- Offscreen-document WebSocket remains the foreground fast path (PRD §6.1); push+queue is the correctness path.
- ~~Stage 0 spike validates latency + Android UnifiedPush integration effort before this flips to Accepted.~~ Done — see below.

### Spike result (2026-07-16, Spike A — `docs/spikes/transport.md`)
- **Chrome, real branded Chrome 150, real FCM:** foreground/warm tab-open **~108 ms median** (n=8, max 261 ms) vs. the <1 s bar; cold-wake (SW confirmed terminated) **~225 ms median** (n=6, max 305 ms) vs. the <5 s bar; deep-cold (SW dead + 3 min channel idle) ~432 ms. Bars beaten 9–22×. `userVisibleOnly: false` subscribe works promptless in extensions.
- **Firefox: no Push API for WebExtensions at all** (verified empirically — no `PushManager`, no `navigator.serviceWorker` on the background page, no `browser.push`). Fallback ships as pre-specified: event page + WS (1–2 ms delivery while live) + `alarms(1 min)` reconnect; Firefox suspends the page after ~30–40 s *regardless of WS/timer activity* (even with `persistent: true` in our runs), so the running-but-idle worst case is ~60 s to drain — a Firefox platform ceiling no transport can fix; correctness still queue-backed. Also wake on user-activity events (tabs/windows/toolbar) so delivery lands the moment the user touches Firefox.
- **Android/UnifiedPush: zero relay changes** — UnifiedPush 3.0 endpoints are standard Web Push (VAPID), so the same sender reuses; app-side connector lib + optional embedded-FCM-distributor fallback is days of work. ntfy (Apache-2.0, license confirmed) as canonical distributor.
- **ntfy-as-transport fallback rejected:** it cannot fix the one weak spot (Firefox — its own browser delivery *is* Web Push) and adds a dependency where VAPID-direct already excels.
- Build-relevant traps (Chrome ≥137 blocks `--load-extension` → use CDP `Extensions.loadUnpacked`; subscribe needs an *active* SW + retry; persistent test profile or GCM rate-limits) are recorded in the spike report §6.

---

## 0005 — End-to-end encryption

**Status:** Accepted · 2026-07-09
**Relates to:** Decision 0003 (per-endpoint keypairs); PRD §6.6

### Context
The device-group model (0003) already gives every endpoint a keypair, so E2E encryption of link payloads is nearly free. The usual objection to E2E — losing server-side previews/history — is avoidable because the sender already holds the tab's title/favicon.

### Decision
**E2E on by default, always — no plaintext mode.**
- Sender encrypts the URL to the target endpoint's public key; relay stores/forwards **ciphertext only**.
- Sender embeds title/favicon **inside** the encrypted payload, so previews and history still work (client-provided, not server-fetched).
- Multi-target send encrypts per target key.

### Consequences / follow-ups
- No server-side features that read link contents (server search, server previews) — out of scope anyway; search can be client-side.
- A non-paired web console (e.g., magic-link on a borrowed machine) can't decrypt link contents — it sees targets/timestamps, not URLs. Paired-device console decrypts locally. Accepted (more private).
- Key distribution: endpoint public keys are published to the group via the relay at pairing; sender fetches target pubkeys, trust rooted in the pairing step (QR/code).
- Keep crypto simple — per-message public-key encryption; no forward secrecy needed for one-shot link payloads. Handle endpoint re-pair → new key.

---

## 0004 — Endpoint granularity

**Status:** Accepted · 2026-07-09
**Relates to:** PRD §5A (labels), §6.3 (data model); retires the P2 "browser-profile targeting"

### Context
Browser extensions run per-profile — each Chrome/Firefox profile has an isolated extension instance and storage and cannot see other profiles. Browsers also don't reliably expose profile identity or the OS hostname to extensions (privacy).

### Decision
**An endpoint is an opaque per-profile install**, identified by a generated ID + a user-editable label.
- Per-profile is the natural (and only available) unit; two profiles of the same browser register as two endpoints.
- No modeling of "profiles" as a special concept; no profile/hostname auto-detection.
- Default label = `{browser} · {device}`; the device is captured once at pairing, pre-filled with a best-effort guess from the user agent (e.g., "Chrome on macOS"), user-renamable (e.g., "MacBook").
- Retires the PRD's P2 "browser-profile targeting" — it's the natural consequence, not a feature.

### Consequences / follow-ups
- Onboarding must capture/confirm the device label at pairing (small friction; honest + private).
- Endpoint IDs are stable per install; reinstalling a profile's extension creates a new endpoint (old one goes stale → pruned by presence/last-seen).
- The chooser may show duplicate browser names on one device; user labels disambiguate.

---

## 0003 — Identity / auth model

**Status:** Accepted · 2026-07-09
**Relates to:** PRD §6.5–6.6 (auth, security), §9 (monetization); Decision 0001 (pairing)

### Context
Tabsend relays a user's own endpoints. Auth must (1) group endpoints, (2) enroll new endpoints without putting account credentials in an extension, (3) give self-host and hosted parity, and (4) still support a paid cloud tier (which needs an identity for billing). It's a privacy-first "invisible" utility, so minimizing central accounts/PII is on-brand.

### Decision
**Hybrid: account-less device group at the core, email optional.**
- **Device group** — the first endpoint creates a group secured by a keypair; other endpoints join by QR / short pairing code (Syncthing/Signal-style device linking). This is the identity for everyone; no email or password required to use Tabsend.
- **Self-host = hosted** — identical model both ways; nothing central to breach on the free/self-host path.
- **Email is optional, feature-gated** — attach one only for (a) cloud **Pro** billing or (b) cross-device account **recovery**. Never required for core use.
- **Console auth** — an already-paired device authorizes the web console (or the recovery key); on hosted-Pro the attached email can magic-link in.
- **Recovery** — a downloadable recovery key/phrase generated at group creation; **opt-in but nudged** (offered prominently at setup, skippable).
- Extensions/apps hold a per-endpoint device token/key from pairing — never account credentials.

### Consequences / follow-ups
- Per-endpoint keypairs fall out of this model → **E2E encryption is nearly free** (feeds the E2E-default decision).
- Losing all devices with no saved recovery key = losing the group (accepted trade-off; mitigated by the nudge).
- Billing attaches to the group via the optional email; keep PII minimal.
- Pairing UX (QR + short code) is a first-class onboarding surface and must be dead simple.
- No email-sending infra required for the free/self-host path.

---

## 0002 — Default / primary-target model

**Status:** Accepted · 2026-07-09
**Relates to:** Decision 0001; PRD §5A, §6.3 (data model)

### Context
The chooser ordering, the single-target adaptive send (0001), and the optional "send to primary" hotkey all need a favored destination. Send behavior is directional and source-specific — what you usually send *from* Chrome-Work differs from what you send *from* your phone.

### Decision
A single **per-source `primaryTargetId`** on each endpoint:
- **Per-source**, not global — each source endpoint (browser/device) has its own primary destination.
- **Learned with override** — defaults to most-recently-used (MRU) for that source; the user can **pin** it to stop it moving.
- **One concept, three jobs** — the same value drives (a) chooser ordering (pinned/primary first, then recent, then the rest), (b) the single-target auto-send, and (c) the optional "send to primary" blind-fire hotkey. "What's on top of the chooser" always equals "what the hotkey fires to."
- Self is excluded from a source's target list.

### Consequences / follow-ups
- Data model: `primaryTargetId` (nullable) + `primaryPinned` (bool) per endpoint; per-source MRU tracked (server-side, or a small local recents list — decide at build time).
- Drift caveat: unpinned MRU means the blind-fire hotkey's destination moves with recent sends; mitigation is to pin. Blind-fire is opt-in only (the main hotkey opens the chooser — 0001, option b).
- First run: no primary yet → chooser lists all targets (alphabetical) until the first send establishes MRU.

---

## 0001 — Entry-point surfaces & chooser architecture

**Status:** Accepted · 2026-07-09
**Relates to:** PRD §5A (design principles, integration surfaces)

### Context
Tabsend is an "invisible utility." The send action must live in the browser's native surfaces and feel native, while still letting the user pick from all their targets (Model B). Native context menus are browser-rendered and limited (Chrome: text-only; Firefox: text + optional per-item icon; no custom styling, no live status). `chrome.action.openPopup()` — which would let a hotkey/menu summon the styled popup — is historically restricted/unreliable in Chrome, so we cannot depend on programmatically opening the toolbar popup.

### Decision
Five entry surfaces, all fed by **one shared target-list model**:

1. **Toolbar icon popup** — the rich, fully-styled chooser (HTML we control): all targets, default first, online dots, device glyphs, search when the list is long. Opens on icon click (reliable via `default_popup`). This is the Model B chooser.
2. **Page context menu** — `Send tab to ▸ [targets]`; sends the current tab's URL directly on selection.
3. **Link context menu** — `Send link to ▸ [targets]`; sends the right-clicked link's URL.
4. **Firefox tab-strip context menu** — `Send tab to ▸ [targets]` (Firefox only; Chrome has no `tab` context).
5. **Keyboard shortcut** — opens the chooser as a **small popup window** (option b), which works everywhere and honors "always choose." An optional *second* shortcut for "send to primary" (fast, no chooser) may be added later.

**Adaptive rule:** if exactly one target is registered, every surface sends directly — no chooser.

> **Amended 2026-07-21 (dogfood), toolbar surface only.** The adaptive rule no longer applies to the toolbar-triggered chooser popup or its hotkey: those open a one-row chooser and wait for an explicit click even at `n=1`. Auto-sending on open made the "Open the chooser" setting indistinguishable from Quick-send, closed the popup before pairing could be reached, and fired off a bare icon click. The rule stands unchanged for the context menus (a single flat `Send tab to X` is already an explicit click) and for Quick-send mode's blind-fire. See DOGFOOD.md 2026-07-21, INTERACTION_FLOWS §2.7/§3.3, `extension/src/pages/chooser.ts`.

**Division of labor (resolves the styling limitation):** rich, custom-styled UI only in surfaces we fully control (toolbar popup + hotkey popup window). Native context menus stay plain and browser-styled — which is *desirable*, they should look native. Firefox may add a small per-item icon as progressive enhancement; Chrome stays text-only.

**Presence is non-gating:** because delivery is queue-backed (reliability core, PRD §6.1), sending to an offline target queues and delivers on wake. So native menus need not convey online/offline; the rich chooser shows status for reassurance only, never as a blocker.

### Consequences / follow-ups
- **Requires a "default / primary target" concept** — for default-first ordering, the single-target adaptive send, and the optional "send to primary" hotkey. → next decision (0002).
- A shared menu/list builder rebuilds context-menu items when the device list or presence changes (`contextMenus.update/create/remove`).
- Settings: a toggle to hide the context-menu entries (stay out of the way).
- Mobile surfaces (OS share sheet + per-endpoint Sharing Shortcuts) are separate and out of scope for this decision.
- Do **not** design any flow that depends on `chrome.action.openPopup()`.

---

## Decision queue

*All architecture/UX open questions from PRD §11 are resolved (0001–0009). The interaction/UX flow set is locked (0008) and the `shared/` contract questions are locked (0009); full spec in `INTERACTION_FLOWS.md`, contracts in `shared/src/types.ts`.*

**Still open:** *none — 0006 (transport) flipped to Accepted 2026-07-16 after Spike A (`docs/spikes/transport.md`). All ADRs 0001–0010 are Accepted.*

**Next up (build):** Stage 1 server MVP (§1.1).
