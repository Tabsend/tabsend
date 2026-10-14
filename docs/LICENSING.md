# Tabsend — Licensing strategy

**Status:** Accepted · 2026-07-27 (ADR-0016; supersedes ADR-0007 and the licensing stance in PRD §8)
**Scope:** why the relay is source-available and everything else is open source, what was rejected, and the rules that keep the promise honest.

> **This is not legal advice.** It is a product decision written by the project's owner, who is
> not a lawyer. Every claim about a licence, a court, or a copyright office here is a layman's
> reading. Get real advice before money changes hands — see §8.

---

## 1. The split

| Path | Licence | Why |
|---|---|---|
| `server/` (the relay) | **FSL-1.1-ALv2** — Functional Source License 1.1, converting to **Apache-2.0 two years after each release** | The only component someone could resell as a competing hosted service. |
| `shared/` (the wire contract) | **Apache-2.0** | Compiled into *both* the FSL relay and the Apache clients. It has to be the permissive one — see §1.2. |
| `extension/`, `android/`, `console/`, `e2e/`, `docs/` | **Apache-2.0** | Client code is undefendable and needs to stay App-Store-compatible — see §5. |
| Commercial control plane (billing, provisioning, tenancy, admin, abuse tooling) | **Unpublished**, separate codebase | Not in this repo, not licensed to anyone, not needed by a self-hoster — see §7. |

**In one sentence:** run the relay for yourself, your family, or your employer — permitted, always,
no exceptions. Sell Tabsend-as-a-service to third parties — not permitted, for two years per release.

### 1.1 Why the relay is the one that gets restricted

Verified in the code, because the whole strategy leans on it:

- `server/src/db/schema.ts` — the `messages` table holds `envelope` (a nullable JSON blob) plus
  routing columns (`group_id`, `source_endpoint_id`, `target_endpoint_id`, timestamps). There is no
  URL column, no title column, no favicon column.
- `server/src/validate.ts` `reqEnvelope()` — the relay validates the envelope's *shape*
  (`alg`, `senderKeyId`, `targetKeyId`, `nonce`, `ciphertext`) and treats the ciphertext as an
  opaque string. It never parses it.
- `server/src/routes/messages.ts` — stores `JSON.stringify(item.envelope)`, hands it back on poll,
  nulls it on ack.
- The relay imports no crypto library at all. The only private key it holds is the VAPID key used to
  *sign push requests* — nothing to do with message content. `server/src/push.ts` sends an empty
  wake tickle; the payload carries no user data.
- libsodium lives only in `extension/` and `console/`; Android has its own Bouncy-Castle-backed
  `CryptoBox` pinned to libsodium by a committed interop vector (ADR-0012 §4).

So the relay is a **dumb, blind pipe** — and that is exactly what makes it commercially interesting
to someone else. Being blind means it is trivially operable at scale by a party that never has to
earn a user's trust about content, because it never sees content. It is the piece that is cheapest
to copy and most valuable to run.

To be precise about what the relay *does* see (this matters for honest privacy claims, not for
licensing): group and endpoint identifiers, message sizes and timing, push subscription endpoints,
and client IP addresses. It cannot read user content. It is not blind to metadata. *(Qualified
2026-10-01, `HOSTED_PLAN.md` §9.11: it also keeps the device list, so a **compromised** relay
could add a device of its own to a group, and that device could read the group's links from
then on, plus its retained history. Any privacy claim built on this list must say so and must never
say the operator "cannot" read links.)*

### 1.2 Why `shared/` cannot be FSL

`shared/` is not a documentation package. It exports live runtime code — `DEFAULT_CLIENT_SETTINGS`,
`PAIRING_LINK()`, `bearerAuth()`, `checkProtocol()`, `API_VERSION`, and the TTL/threshold constants —
and its `exports` map points straight at `./src`, so every consumer's bundler compiles the source
into its own build. `server/`, `extension/`, `console/` and `e2e/` all depend on
`@tabsend/shared: workspace:*`; Android hand-mirrors the same shapes in `wire/Wire.kt`.

If `shared/` were FSL, the FSL restriction would ride into every Apache-licensed client that bundles
it, and the "clients are open source" claim would be false. Permissive is not a preference here, it
is a structural requirement.

---

## 2. Rejected: fully permissive (the status quo, ADR-0007)

ADR-0007 put everything under Apache-2.0 on the reasoning that "the moat is hosted convenience, not
source" and that the rehost threat was low for a niche solo project. Two things changed that
assessment.

**The threat isn't a scrappy rehoster, it's an incumbent.** The concrete worry is a browser vendor.
Tabsend's whole surface is a browser extension plus a small relay; a vendor that decided
send-tab-to-device should be a first-class feature could ship it natively, or stand up a hosted
relay, and end the revenue line in a quarter. Permissive licensing hands them a working
implementation and a tested wire protocol as a starting point. That isn't paranoia about theft — it
is just what permissive licensing is *for*, and it cuts both ways.

**The Apache OpenOffice failure mode.** Permissive upstream, copyleft fork: the fork can absorb
every improvement upstream makes, and upstream is legally barred from taking anything back. That
is a one-way valve. OpenOffice went to Apache-2.0; LibreOffice went MPL/LGPL; LibreOffice could
merge OpenOffice's work and OpenOffice could not merge LibreOffice's. Development flowed one
direction until upstream had nothing left. For a solo project with no institutional backing, that
asymmetry is not survivable.

---

## 3. Rejected: AGPL-3.0

AGPL is the reflex answer to "someone will host my software." It is the wrong tool for the party
actually feared.

**AGPL does not deter an institution.** A large organisation with a legal department will read the
AGPL, comply with it, publish its modifications, and compete anyway. Publishing a diff costs it
nothing. The obligation AGPL imposes — release your changes — is precisely the obligation a
well-resourced competitor can satisfy without breaking stride.

**AGPL does deter everyone Tabsend wants.** It deters the self-hoster's employer, whose legal team
has a blanket no-AGPL policy. It deters casual contributors. And, as ADR-0007 already noted, it
complicates a closed commercial tier — the very thing it is being adopted to protect.

So AGPL gets the worst of both: maximum friction for friendly users, near-zero friction for the
hostile case. It filters out the people who would never have hurt the project and waves through
the one that could.

---

## 4. Chosen: FSL-1.1-ALv2

The **Functional Source License** takes the opposite aim. It does not restrict *how* you may modify
or redistribute; it restricts *one purpose*: making Tabsend available to third parties as a
competing commercial product or service. Everything else — internal use at any scale, commercial
internal use, modification, redistribution, forks, non-commercial research and education — is
permitted from day one. Two years after a given release ships, that release becomes plain Apache-2.0
with no restrictions at all.

**Why this is the right shape of restriction:**

1. **It binds the party that actually reads licences.** A browser vendor's counsel will not sign off
   on shipping a service built from a codebase whose licence forbids exactly that. A licence's real
   deterrent power is proportional to how much the target has to lose from non-compliance, and
   institutions have everything to lose. This is the inverse of the AGPL calculus in §3 — and it is
   the whole point.
2. **The conversion keeps the promise honest.** FSL is not "closed with a source viewer." Every
   release is on a clock. In two years it is Apache-2.0, unconditionally, and the licensor cannot
   take that back. A user's worst case is a two-year wait, not a permanent lock.
3. **It costs the legitimate user nothing.** Read the restriction against Tabsend's actual users and
   it is inert. Someone running a relay for four of their own devices, or for a company's 200
   laptops, is never in scope.

### 4.1 The cost, stated plainly: this is not open source

**FSL is source-available, not open source.** It is not OSI-approved, and it never will be. The Open
Source Definition forbids restricting fields of endeavour (OSD §6) and discrimination against
persons or groups (§5). "Open source, except you may not compete with me" is not a licence the OSI
declined to approve — it is definitionally impossible under the definition. The words are not
available for this.

The project therefore does not use them for the relay, anywhere, ever. Not in the README, not in
store listings, not in a blog post. `server/` is **source-available**. `extension/`, `android/`,
`console/`, `shared/` and `e2e/` are **open source (Apache-2.0)** and may be called that.

What is actually lost by accepting this:

- Distribution channels that require an OSI licence — some Linux distributions' main repositories,
  some corporate procurement checklists, some "we only use FOSS" policies.
- Goodwill from the part of the community that treats source-available licensing as a betrayal.
  That reaction is real and it is not unreasonable; a fair number of projects have used
  "open core" as cover for progressive enclosure (§7).
- Automated tooling that keys off SPDX identifiers may flag or fail on `FSL-1.1-ALv2`, because it
  is not on the SPDX licence list. Expect friction in dependency scanners and package registries.

The trade accepted: **losing the label for one of seven packages, in exchange for the restriction
existing at all.** The alternative was not "open source and protected" — no such licence exists.
It was "open source and unprotected," which is §2.

---

## 5. Why the clients stay Apache-2.0

Three independent reasons, any one of which would be sufficient.

1. **Copyleft on clients would block iOS outright.** The GPL/AGPL family is incompatible with the
   Apple App Store's terms — the App Store imposes device and usage restrictions that GPL §6/§10
   forbid the distributor from adding. This is not theoretical: VLC's iOS app was pulled from the
   App Store in 2011 after a GPL complaint, and only returned once VideoLAN relicensed. iOS is on
   Tabsend's roadmap (PRD §13, Phase 3). A copyleft client licence would kill it before it started.
2. **Shipped client code is undefendable anyway.** A browser extension is JavaScript in a zip file.
   An Android APK is decompilable. Anything distributed to users can be read, and the *interesting*
   part — a chooser UI and a `crypto_box` call against a documented wire protocol — is a weekend of
   work to reimplement from `shared/src/types.ts` alone, which is public and permissive. Restricting
   the client buys nothing real and costs contributions.
3. **Portable clients are what make self-hosting credible.** The promise is "the relay you run is
   the whole backend" (README; ADR-0003's *self-host == hosted*). That promise is only believable if
   the clients genuinely work against *any* compliant relay, including one the project never sees.
   Apache-2.0 clients plus a permissive wire contract mean a third party can build a relay from
   scratch and every Tabsend client will talk to it. That is the strongest available proof that
   self-hosting is not a marketing line.

---

## 6. Where the moat actually is (and it is not the code)

Licensing buys time. It is not the strategy, and treating it as one is how projects end up with a
restrictive licence *and* no business.

Tabsend's defensible position is **being the neutral ground between ecosystems**. A browser vendor
can build send-tab-to-device, and does — but it can only credibly serve its own browser and its own
platform. It has no incentive to make Chrome-Work → Firefox-Personal → Android work as one flat set
of endpoints, and structural reasons not to. Neither does an OS vendor. The whole category is
built to keep users inside a ring fence; the value Tabsend creates is specifically in not having one.

That position cannot be copied by the party feared, because copying it would mean abandoning the
reason they'd build it. It also cannot be licensed away. **Neutrality is the moat; the FSL is the
two-year head start that lets it be built.**

The practical implication: if the project ever has to choose between a licensing manoeuvre and a
cross-ecosystem integration, the integration wins.

---

## 7. The open/closed line — and the rule that it never moves

**Open** — everything a self-hoster needs to run Tabsend for themselves:
the wire protocol, all clients, the relay (queue, push, WebSocket, storage, pairing),
the deploy guide, the schema, the tests.

**Closed** — the multi-tenant commercial control plane, in a separate unpublished codebase:
billing and subscriptions, tenant provisioning and isolation, plan/quota enforcement, operator
admin tooling, abuse detection and response.

The test for which side something falls on: **is it useless to someone serving four of their own
devices?** Billing is useless to them. Tenant isolation is useless to them — they are one tenant.
Abuse tooling is useless to them — they know every user personally. Message delivery is not useless
to them, so it stays open, forever.

### 7.1 The rule

**The line is drawn once, here, and never moves inward.** Nothing that is open today becomes closed
later. Nothing a self-hoster relies on gets relocated into the commercial plane. New functionality
is classified by the §7 test at the time it is built — never by whether closing it would help
revenue.

This rule exists because the failure mode has a well-known name. Android is nominally open source,
and AOSP is a real, complete, licensed codebase. Its "open in name only" reputation was not earned
at the start — it was earned over a decade of Google progressively relocating functionality
(location, messaging, search, the app store, push, safety-net attestation, increasingly the core
APIs apps assume) out of AOSP and into closed Play Services, until the open part stopped being
sufficient to build a competitive phone. No single move was the betrayal. The direction of travel
was.

A self-hoster's real question is not "is it open today" — it is "will it still be enough in three
years." The only answer that has any weight is a rule stated in advance and honoured visibly. This
document is that statement; violating it should be treated as a breaking change to the product's
promise, not a business decision.

---

## 8. Honest caveat: AI-generated code and whether any of this is enforceable

This codebase is substantially AI-generated — co-authored with Claude, as the README says and the
per-chunk reports in `docs/reports/` document in detail. That is relevant to licensing, and the
project should not pretend otherwise.

**The copyright status of AI-generated code is genuinely unsettled, and it differs by jurisdiction:**

- **United States:** the Copyright Office requires human authorship. Purely machine-generated output
  is not registrable; what *is* protectable is the human contribution — selection, arrangement,
  substantial modification, creative structuring. How much is enough is not settled, and prompts
  alone have been held insufficient.
- **United Kingdom:** the CDPA explicitly protects "computer-generated works" with no human author,
  attributing authorship to the person who made the arrangements necessary for their creation. A
  Tabsend-shaped project is on much firmer ground here.
- **EU / Germany:** protection requires the author's own intellectual creation — a human creative
  act. Output generated without meaningful human creative input is likely unprotected.

**The strategic implication, which points the opposite way from intuition:** weak copyright does not
make this document moot, it makes the position *worse*. Licences are enforced through copyright. If
copyright does not subsist in the code, then **no** licence attaches to it — not the FSL, and not
Apache-2.0 either. There would be nothing to restrict a competing service with, and equally nothing
behind the patent grant and attribution terms the open packages rely on. A world where the FSL is
unenforceable is not a world where the code is safely permissive; it is a world where the code is
simply unowned by anyone, available to everyone, on any terms they like.

So the exposure runs in one direction: more human authorship is strictly better for every part of
this strategy.

**Mitigations, in rough order of cost:**

1. **Maintain a visible record of human authorship and architectural decision-making.** This is
   already the project's practice and is its single strongest asset here: `docs/DECISIONS.md` is a
   16-entry log of owner-level architectural rulings; `docs/PRD.md`, `INTERACTION_FLOWS.md` and
   `BUILD_SEQUENCE.md` are human-directed specifications; the per-chunk reports record which
   decisions were the owner's. ADR-0015 (the Android push ruling), ADR-0014 (dropping the helper)
   and ADR-0010 (console history model) are explicit records of a human making the call. Keep doing
   this, deliberately, and keep it in the repository.
2. **Register the trademark.** "Tabsend" as a word mark is protectable regardless of how the code
   was written, does not expire in two years, and is the one instrument that actually stops a
   competitor from launching a confusingly-similar hosted service under the project's own name. In
   the weak-copyright scenario it is the *only* remaining instrument. It is also the cheapest item
   on this list.
3. **Get real legal advice before money is involved.** Specifically before: taking the first paying
   customer, incorporating, or accepting an outside contribution of any size. A one-hour
   consultation with a software-licensing lawyer in the relevant jurisdiction, timed before revenue
   rather than after a dispute, is the correct spend.
   **Owner ruling 2026-10-01 (`HOSTED_PLAN.md` §9.12): not for the hosted launch.** No lawyer and
   no accountant consults at hobby scale; the trademark filing (item 2) stays. The contribution
   trigger is a separate question and is untouched by that ruling (see `CLA.md`).
4. **Add a contributor agreement if outside contributions ever start.** Not needed for a
   single-author project. Needed the moment someone else's code lands in `server/`, because
   relicensing an FSL codebase later requires the right to do so.

**Again: this document is not legal advice, and none of the above is a legal opinion.**

---

## 9. What this means for the repository

Most of the mechanical work already landed in the working tree while this document was being
written. Recorded here so the state is legible.

**Already applied:**

1. **`server/LICENSE`** — the FSL-1.1-ALv2 text, licensor named, per-release conversion stated.
2. **`server/LICENSE-NOTE.md`** — a plain-English, explicitly non-binding summary of what the
   relay's licence permits. Good; keep it subordinate to `LICENSE` (it already says so).
3. **`server/package.json`** — `"license": "FSL-1.1-ALv2"`.
4. **Root `LICENSE`** — still Apache-2.0; copyright line corrected to the named owner.
5. **`NOTICE`** — per-directory licence map (Apache-2.0 everywhere except `server/`).
6. **`README.md`** — licence section rewritten to state the split. Three gaps remain; see
   Appendix A.
7. **`shared/`, `extension/`, `android/`, `console/`, `e2e/`** — unchanged, Apache-2.0.

**Still outstanding:**

8. **README gaps** — the section does not say *source-available*, does not explain why the relay
   cannot be called open source, does not point at this document, and does not set the
   self-hosting support expectation. Patch in Appendix A.
9. **`"license": "FSL-1.1-ALv2"` is not an SPDX identifier**, so strict tooling may warn or fail.
   npm's compatible spelling is `"SEE LICENSE IN LICENSE"`. Risk is near zero in practice — the
   package is `"private": true` and never published — so this is a judgement call, not a defect.
10. **Annotate in place, don't delete** (the ADR-0014 convention): PRD §8's "keep the open core
    permissive (MIT/Apache-2.0)" line and §9's licensing note now describe a superseded stance and
    should carry a pointer to ADR-0016. ADR-0007 itself should carry a "superseded by 0016" marker
    so a reader landing on it directly is not misled.
11. **Dependency check for the relay.** `server/` depends on `web-push` (MPL-2.0 — file-level weak
    copyleft, already verified at build time under ADR-0007's no-GPL rule), plus Fastify, Kysely,
    `better-sqlite3` and `pg`. MPL-2.0 §3.3 permits distributing a larger work under different terms
    as long as the MPL-covered files themselves stay MPL, so the FSL relay is fine — but this is a
    spot-check, not an audit, and belongs in the §8.3 legal conversation.

---

## Appendix A — Proposed README licence section

**Not applied — proposed.** `README.md`'s `## License` section was rewritten in the working tree
while this document was being written, and that rewrite already covers the split, the self-hosting
permission, the single prohibition, and the two-year conversion. Three things it does **not** do:

- it never says **source-available**, or explains why the relay cannot be called open source
  (§4.1 — the one thing this project must not get wrong in public);
- it doesn't link this document or ADR-0016;
- it doesn't set the **support expectation** for self-hosting, and it still cites ADR-0007, which
  ADR-0016 supersedes.

The block below replaces `README.md` lines 86–99 (`## License` through the co-authoring line) and
folds those three in. Changes from what is currently there are the heading, the source-available
paragraph, the closing support paragraph, and the ADR reference.

```markdown
## Licensing & self-hosting

**Clients and protocol — [Apache-2.0](LICENSE), open source.** The browser extensions, the
Android app, the web console, and `shared/` (the wire contracts). Permissive,
with an explicit patent grant, and **no GPL dependencies**.

**The relay ([`server/`](server/LICENSE)) — `FSL-1.1-ALv2`, source-available.** The Functional
Source License, Version 1.1, ALv2 Future License permits everything except one thing:

- ✅ **Self-hosting is fully permitted** — for yourself, your family, or your organisation, at any
  scale, including commercially. Read the source, modify it, redistribute it, run it forever.
- ❌ **The only prohibition:** offering Tabsend to third parties as a competing commercial product
  or service.
- ⏳ **Every relay version converts to Apache-2.0 two years after it is released** —
  automatically and irrevocably. Nothing stays restricted.

**Source-available is not open source, and we don't call it that.** The Open Source Definition
forbids restricting what you may use software *for*, so "open source, but you may not compete
with me" is not a licence that exists — the words aren't available for the relay, whatever else
the FSL allows. [`server/LICENSE-NOTE.md`](server/LICENSE-NOTE.md) is a plain-English summary of
the terms; **[`docs/LICENSING.md`](docs/LICENSING.md)** (ADR-0016) has the full reasoning,
including what was rejected and why.

**Self-hosting is supported by documentation, not by the maintainer.**
**[`docs/DEPLOY.md`](docs/DEPLOY.md)** is a complete guide — HTTPS, SQLite or Postgres,
systemd/Docker, backups, known limitations — and it is deliberately thorough because there is no
support channel behind it. Tabsend is a one-person project; running your own relay is your own
operation.

Co-authored with Claude (see per-chunk reports in `docs/reports/`).
```

*Alternative placement:* the support-expectation paragraph could instead go under the existing
`### Self-hosting` subsection (README line 69), leaving the licence section purely about licences.
Either works; it must appear somewhere, and it must not be softened.

---

## Appendix B — Quick answers

**Can I run the relay for my company's 500 employees?** Yes. Internal use is permitted at any scale,
commercial or not.

**Can I run a relay for my friends?** Yes.

**Can I charge my consulting clients for setting up their own Tabsend relay?** Yes — professional
services around the software are permitted. What is not permitted is running the service *for* them
as your product.

**Can I fork the relay and publish my fork?** Yes. The fork carries the same FSL terms, and converts
to Apache-2.0 on the same two-year clock.

**Can I launch a paid "TabsendCloud"?** No — not for two years after the release you build on, at
which point that release is Apache-2.0 and you can. (The name would be a separate trademark
question.)

**Can I build a different client?** Yes, with no restriction at all — the wire contract and every
client are Apache-2.0.
