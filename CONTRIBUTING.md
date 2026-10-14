# Contributing to Tabsend

Thanks for looking. Tabsend is a small project with one author, and this file exists so you
know what you're walking into before you spend time on a patch.

Two things worth reading before anything else:

- **[The CLA](#the-cla-and-why-there-is-one)** — Tabsend asks contributors to sign a
  Contributor Licence Agreement. The reason is commercial, and it's spelled out plainly below.
- **[What "supported" means](#what-support-actually-means)** — self-hosting is supported by
  documentation, not by the maintainer.

Security problems do **not** go here. See [`SECURITY.md`](SECURITY.md).

---

## Before you write code

Tabsend is deliberately narrow: it moves one browser tab to one other device, and most of the
architecture is already locked in [`docs/DECISIONS.md`](docs/DECISIONS.md) (ADRs). A patch that
cuts across a decision recorded there will probably be rejected on the design, not the code —
so it's worth checking the ADR log first, and worth opening an issue before building anything
substantial.

Small, obviously-good things (a typo, a broken doc link, a failing edge case with a test) need
no discussion. Just send them.

---

## How Tabsend is licensed

Tabsend uses a **split licence**:

| Part of the repo | Licence | Licence file |
|---|---|---|
| `server/` — the relay | **FSL-1.1-ALv2** (Functional Source License 1.1, Apache-2.0 future licence) | [`server/LICENSE`](server/LICENSE) |
| `shared/`, `extension/`, `android/`, `console/`, `e2e/`, `docs/`, repo root | **Apache-2.0** | [`LICENSE`](LICENSE) |

[`NOTICE`](NOTICE) carries the authoritative per-directory mapping.

**What FSL means for you, in plain terms.** Run the relay for yourself, your family, your
company, your school, your club — that's all explicitly allowed, and always will be. Fork it,
modify it, ship your changes, run it on your own hardware. The single thing FSL prohibits is
offering Tabsend to other people as a commercial service that competes with Tabsend itself.
Every version of the relay converts to plain Apache-2.0 two years after its release, so the
restriction is temporary by construction, not permanent.
[`server/LICENSE-NOTE.md`](server/LICENSE-NOTE.md) is the plain-English summary; the canonical
FSL text and FAQ live at <https://fsl.software>.

The reason for the split: there is a separate multi-tenant hosted service built on this work,
in an unpublished codebase that is not in this repo. The FSL protects that one narrow
commercial case. It doesn't touch self-hosting, which is the use case Tabsend was actually
built for and which stays free forever.

Two consequences worth knowing before you contribute:

- **`shared/` is deliberately Apache-2.0 and must stay that way.** It compiles into both the
  FSL relay and the Apache clients, so restricting it would leak the restriction into every
  client. Don't propose changing it.
- **The relay is "source-available", not "open source".** The Open Source Definition forbids
  restricting fields of endeavour, so the relay cannot honestly be called open source. The
  other packages can. Please keep that distinction in any docs you write.

The full reasoning — what was rejected and why, including AGPL — is in
[`docs/LICENSING.md`](docs/LICENSING.md) and ADR-0016 in
[`docs/DECISIONS.md`](docs/DECISIONS.md).

---

## The CLA, and why there is one

To contribute, you need to agree to [`CLA.md`](CLA.md). It is short — one page — and you can
read the whole thing in about two minutes.

Here is the honest reason, without the usual boilerplate about "protecting the project."

**Reason one: the hosted service.** There is a commercial hosted version of Tabsend. If you
contribute code to this repo under Apache-2.0 alone and nothing else, that code is licensed to
*everyone* on Apache terms — including the maintainer — and in practice that works fine. But
the moment the licensing needs to change in any way the original licence doesn't already
allow, every past contributor has to be tracked down and asked. On a project with one author
today and possibly twenty contributors later, that becomes impossible in a hurry. The CLA
gives the owner a licence broad enough to relicense contributions into the hosted product and
to adjust licensing later without a hunt for signatures.

**Reason two: the fork asymmetry.** Without a CLA, this project has no way back from a
copyleft fork. Someone can take Tabsend's permissively-licensed code, fork it under a strong
copyleft licence, accept improvements into that fork, and Tabsend can never merge any of it
back — the licences point one way only. That is not a hypothetical: it is essentially what
happened to Apache OpenOffice after LibreOffice forked. The fork absorbed the upstream work
and kept going; the upstream project was legally barred from taking the improvements back and
withered. A CLA doesn't prevent forks — nothing does, and nothing should — but it keeps the
door open in both directions rather than just one.

**What the CLA does not do.** It doesn't take your copyright away; you keep it. It doesn't
stop you using your own contribution anywhere else, including in a competing product. It
doesn't let the owner make already-published Apache-2.0 releases un-free retroactively — that
isn't possible, and no CLA changes it. It is a licence *grant*, not an assignment.

If that trade isn't one you want to make, that's a completely reasonable position, and no hard
feelings. Filing issues, writing docs corrections that aren't copyrightable expression, and
reporting bugs all need no CLA at all.

### How to sign

**Put one line in your pull request description or as a PR comment:**

```
I have read the Tabsend CLA (CLA.md) and I agree to it for this and all my future
contributions to this project.
```

That's it. No account to create, no bot, no form.

**Why this route and not the alternatives.** Three mechanisms are common in small open-source
projects, and each trades off differently:

- **A statement in the PR** (what Tabsend uses). Zero infrastructure. The record lives in the
  GitHub PR timeline, timestamped and tied to your account, and it covers your future PRs too
  so you only ever do it once. The weakness: the record lives on GitHub rather than in the git
  history, so it wouldn't automatically travel if the project moved hosts. For a project of
  this size that's an acceptable risk, and it's the lowest possible friction for you.
- **A CLA bot** (cla-assistant.io and similar). Best paper trail, blocks merges until signed.
  It's also a third-party service holding contributor identity data, and it's more machinery
  than a project with occasional pull requests needs. Overkill here.
- **A `Signed-off-by:` line** (`git commit -s`). Travels in the git history forever, survives
  a host migration. But that line conventionally means the **Developer Certificate of Origin**,
  which is a *different thing* — the DCO certifies that you wrote the code and have the right
  to submit it, and grants no relicensing rights at all. Tabsend needs the relicensing grant,
  so a bare DCO sign-off would not be enough, and repurposing the line risks people signing
  something other than what they think they signed.

If you'd rather have the agreement recorded in the git history as well as the PR, add
`Signed-off-by: Your Name <your@email>` to your commits **in addition to** the PR statement,
and note in the PR that your sign-off is meant as CLA agreement. That's welcome but not
required.

> **Not legal advice.** `CLA.md` and this section are a non-binding draft written by a product
> person, not a lawyer. Before Tabsend accepts contributions at any real volume, a lawyer
> should review the CLA text — `docs/LICENSING.md` §8 already flags an outside contribution as
> one of the triggers for getting real advice. If you're contributing on behalf of an employer,
> check with them first — in most jurisdictions your employer, not you, owns code you write on
> their time or equipment.
>
> One related caveat, recorded openly rather than buried: **most of this codebase is
> AI-generated** (co-authored with Claude — see `docs/reports/`), and the copyright status of
> AI-generated code is unsettled and varies by country. That is a question about the *existing*
> code, not about your contribution — what you write by hand is yours to license, and that is
> what the CLA covers. `docs/LICENSING.md` §8 works through it honestly.

---

## What support actually means

Tabsend is maintained by one person, alongside a job. Being straight about this up front is
better than disappointing you later.

**Self-hosting is supported by documentation, not by the maintainer.**
[`docs/DEPLOY.md`](docs/DEPLOY.md) is the support — TLS with Caddy, SQLite vs Postgres,
systemd, Docker, backups, the known single-instance limitation. It is written to be followed
end to end without asking anyone anything, and keeping it good enough to do that is a real
priority.

What that means in practice:

- **If the docs are wrong, incomplete, or led you astray — that's a bug.** File it. Doc fixes
  are among the most useful contributions this project can get, and they get attention.
- **If Tabsend's own code is broken — that's a bug.** File it, with steps to reproduce.
- **If your VPS, reverse proxy, DNS, firewall, Postgres install, or ISP is the problem —
  that's yours.** The maintainer genuinely cannot debug your infrastructure, and pretending
  otherwise would just mean issues sitting unanswered for months.

There is no SLA on anything. Issues and pull requests get looked at when there's time, which
is usually within a couple of weeks and sometimes not. A pull request that sits is not being
ignored on purpose. Feel free to bump it.

None of this is meant as "go away." Self-hosters are the users Tabsend is built for. It's just
the honest shape of a one-person project, said out loud instead of discovered the hard way.

---

## Development

### Requirements

- **Node ≥ 26** and **pnpm 11.13.1** — `npm install --global pnpm@11.13.1`, matching the
  `packageManager` pin in the root `package.json`. Node 26 dropped corepack, so
  `corepack enable` is no longer an option
- For the Android app only: **JDK 17** and the Android SDK (platform 34) — see
  [`android/README.md`](android/README.md) for a command-line-only setup, no Android Studio
  needed

```bash
pnpm install --frozen-lockfile
```

### The gates

These are exactly what CI runs (`.github/workflows/ci.yml`), so run them before you open a PR:

```bash
pnpm lint         # biome check .  — formatting AND lint rules, in one pass
pnpm typecheck    # pnpm -r run typecheck  — tsc --noEmit in every package
pnpm test         # vitest run  — shared, server, extension, console
```

Two things `pnpm test` deliberately does not cover:

```bash
pnpm e2e          # real browser end-to-end (bundled Chromium) — slow, kept out of `pnpm test`
pnpm e2e:push     # real branded Chrome + real FCM push — needs a local Chrome install
```

and the Android app, whose tests are Gradle's:

```bash
cd android && ./gradlew test          # JVM unit tests, no emulator — includes the crypto interop vector
cd android && ./gradlew assembleDebug # → app/build/outputs/apk/debug/app-debug.apk
```

CI additionally runs the server suite a second time against **Postgres 17**, because the relay
supports both SQLite and Postgres and the dialect matrix has caught real bugs. If you touch
anything in `server/src/db/`, run it locally too:

```bash
TABSEND_TEST_PG=1 TABSEND_TEST_PG_URL=postgres://postgres:postgres@localhost:5432/tabsend_test \
  pnpm --filter @tabsend/server test
```

### Formatting and lint: Biome

Tabsend uses **[Biome](https://biomejs.dev)** (pinned to 2.5.4) as both formatter and linter.
`pnpm lint` checks; `pnpm format` fixes. Don't add Prettier or ESLint.

The house settings, from `biome.json`:

- 2-space indent, 100-column lines
- **single quotes**, **semicolons only where needed** (`asNeeded`)
- imports auto-organised
- `noExplicitAny` and `noNonNullAssertion` are relaxed inside `*.test.ts` and `test/`

**One deliberate exception you need to know about: `shared/src` is excluded from Biome.**
It's in the ignore list on purpose. `shared/src/types.ts` is the authoritative wire contract
that server, extension, Android and console all agree on, and it is hand-formatted — banner
section headers, semicolons, aligned trailing comments. Biome's style would rewrite all of it
and destroy the readability that makes it usable as a spec. `shared/src` is still typechecked
by `tsc` like everything else; only the formatter leaves it alone. **Match the existing style
in that file by hand; don't run a formatter over it.** (The reasoning is recorded in
`docs/reports/chunk-0.md`.)

`android/` and `spikes/` are also outside Biome's scope — Kotlin has its own conventions.

### Comments

The codebase leans on comments more than most, and this is intentional. The convention:

- **Every non-trivial module opens with a block comment saying what it is and what invariant
  it holds** — not what the code does line by line, but why it exists and what would break if
  someone changed it carelessly. See `server/src/ratelimit.ts` or
  `extension/src/lib/crypto.ts` for the shape.
- **Comments explain *why*, and cite the decision.** Cross-references to `ADR-0005`,
  `PRD §6.1`, `types.ts §9`, or a chunk report are normal and encouraged — they let the next
  reader find the reasoning instead of guessing at it.
- **Inline comments are for the non-obvious.** A comment restating what the code already says
  is noise; a comment explaining why the durable row must be written *before* the delivery
  attempt is the whole point.
- **Doc comments (`/** … */`) on exported functions and types**, in the JSDoc/KDoc style
  already used throughout.
- **Trade-offs and known limits get written down where they live**, honestly, including the
  ugly ones. There are several comments in this codebase that amount to "this is a documented
  limitation, here's why we accepted it." That's the standard — please keep it.

If your change makes an existing comment wrong, fix the comment in the same commit.

### Commits and pull requests

- Descriptive commit subjects in the imperative mood ("Reject sends whose targetKeyId is
  stale"), a body when the *why* isn't obvious from the diff.
- One logical change per PR. A refactor bundled with a behaviour change is much harder to
  review and much harder to revert.
- Add a test if the change is testable. The relay, `shared/`, and the pure logic modules in
  every client are all straightforward to unit test.
- If your change alters anything in `shared/src/types.ts`, say so explicitly in the PR
  description — that file is a contract five packages depend on, and additive changes are
  much easier to accept than breaking ones.
- If your change contradicts or supersedes an ADR in `docs/DECISIONS.md`, say that too. A new
  ADR may be the actual deliverable.

---

## Reporting bugs

Open a GitHub issue with what you expected, what happened, and how to reproduce it. Include
which endpoint kinds were involved (Chrome extension, Firefox, Android, console), whether the
relay is local or remote, and anything from the relay logs.

**Security issues do not go in public issues** — see [`SECURITY.md`](SECURITY.md).
