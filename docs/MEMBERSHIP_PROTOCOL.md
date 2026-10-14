# Tabsend — Signed endpoint membership (H1 design)

**Status:** **PARKED 2026-10-01 by owner ruling (`HOSTED_PLAN.md` §9.11) — off the hosted
launch path. Kept, not deleted.** The owner ruled that a tiny hobby product does not need
this, and that it is the biggest single job between today and a beta. Its risk is
accepted in `HOSTED_PLAN.md` §12 and answered instead by a "new device joined" notice
(`PLANS.md` P-10) and honest claims. Nothing below is reviewed or scheduled. Two parts are
now out of date and are left as written: §7.1's hosted `minClientProtocol = 4` floor is
withdrawn, and §7.3's "hosted has no migration problem at all" stops being true the day
the first hosted group exists, because hosted groups will then take the same opt-in
migration as self-hosted ones. *Original status:* **DRAFT — awaiting design review.
Nothing here is implemented, and nothing here may be implemented until the review
passes.** This document exists to *be* the
review artefact named by `SECURITY_REVIEW.md` next-review-point 1 ("Review the signed
membership wire protocol and adversarial vectors before implementation") and by the H1
gate in `HOSTED_PLAN.md` §10 ("Design review *before* implementation"). The wire shapes,
route names, and constant values below are proposals; they become locks only once the
review accepts them, at which point the load-bearing parts graduate into ADRs per house
rules.

**Drafted:** 2026-08-19

**Relates to:** [`HOSTED_SECURITY_PLAN.md`](HOSTED_SECURITY_PLAN.md) (the seven-step
sketch this document turns into a protocol, and the bootstrap exception at its lines
42–49), [`HOSTED_PLAN.md`](HOSTED_PLAN.md) §4.7 (the named genesis-sequencing
deliverable), §5 (the bootstrap window), §10/§10.1 (the H1 gate),
[`SECURITY_REVIEW.md`](SECURITY_REVIEW.md) (the open "relay-provided endpoint key
directory" finding this closes), ADR-0005 (E2E), ADR-0009 (contract locks, the
`crypto_box` primitive, the fragment rule), ADR-0017 (protocol versioning, the forgiving
band, `minClientProtocol`), ADR-0019 (pinned self-signed TLS, fingerprint in the pairing
fragment), ADR-0021 (no recovery credential), ADR-0022/0023 (one relay one group; the
relay-minted first link), ADR-0024/0025 (the pairing link is the only credential),
ADR-0028 (group history sealed to a group key); `shared/src/types.ts`,
`server/src/routes/endpoints.ts`, `server/src/bootstrap.ts`,
`server/src/routes/group-keys.ts`, `server/src/routes/config.ts`.

---

## 1. Goals and non-goals

### The required outcome, restated

From `HOSTED_SECURITY_PLAN.md`: **a compromised or malicious relay must not be able to
add an apparently trusted endpoint and receive links intended for the user's real
devices.**

That is one sentence and it is the whole design. Everything below either serves it or is
scaffolding for testing it.

Today the relay is the authority. `GET /v1/endpoints` returns rows the relay controls;
`EncryptedEnvelope.senderKeyId` is checked against those rows. ADR-0009 described
`crypto_box` as stopping a malicious relay from *injecting* links, and that is true only
relative to the directory — a relay that adds a row holding its own key satisfies every
check a client currently makes. `SECURITY_REVIEW.md` carries this as an open, accepted
limitation for self-hosting. It is not acceptable when the project runs the relay.

### Goals

1. **Device-rooted trust.** Membership changes are signed by devices. The relay stores
   and distributes the log and can mint nothing.
2. **No manual fingerprint comparison in the normal path.** The security plan is explicit
   that user-compared fingerprints are an internal-experiment stopgap, not the commercial
   design.
3. **Implementable on all four clients with primitives each already has**, with no new
   third-party dependency and no hand-rolled signature code (step 1 of the sketch).
4. **Rollback, equivocation, rotation, and revocation are protocol behaviours**, not
   documentation.
5. **The self-hosted experience does not get worse.** A self-hoster who never upgrades
   their relay keeps a working setup, honestly labelled.
6. **One set of wire test vectors, run byte-for-byte in every client**, mirroring the
   `interop-vector.json` / `group-history-vector.json` precedent.

### Non-goals

- **Account recovery. ADR-0021 stands, unamended.** Losing every device loses the group.
  Membership adds nothing here, and a root key held anywhere but on a device would be a
  recovery credential wearing a different hat.
- **Multi-group accounts, teams, sharing between accounts.** `HOSTED_PLAN.md` §13.
- **Forward secrecy**, unchanged from ADR-0005: these are one-shot links.
- **Confidentiality of the membership log.** It is public keys, opaque ids, and
  timestamps. The relay already holds all of it.
- **Replacing the ADR-0019 TLS pin.** Different layer, different job, both stay.
- **Delegation, roles, or any authority gradient.** Every member has identical powers.
- **Rewriting history.** No compaction, no pruning, no re-signing.
- **Availability guarantees.** A relay that refuses to serve the log is broken, not
  malicious-and-undetected. §8 says so plainly.

---

## 2. What each client can actually do today

The design must be buildable four times over. Verified in the worktree rather than
assumed:

| Client | Crypto today | Ed25519 sign/verify available? |
|---|---|---|
| Extension | `libsodium-wrappers` ^0.7.15 (lockfile 0.7.16), `extension/src/lib/crypto.ts`; `crypto_box_easy`, `crypto_secretbox_easy`, WebCrypto `crypto.subtle.digest('SHA-256', …)` for key ids | **Yes.** The standard (non-sumo) build exports `crypto_sign_keypair`, `crypto_sign_seed_keypair`, `crypto_sign_detached`, `crypto_sign_verify_detached`. Confirmed by running them against the installed 0.7.16: 32-byte public key, 64-byte secret key, 64-byte signature, verify true. |
| Console | Same library, same version, its own copy at `console/src/lib/crypto.ts` | **Yes**, identically. |
| Android | BouncyCastle `bcprov-jdk18on:1.78.1` (`android/app/build.gradle.kts`), used for `X25519Agreement` and `Poly1305` in `android/app/src/main/java/io/tabsend/app/crypto/CryptoBox.kt`, with Salsa20 hand-written beside it; `java.security.MessageDigest` and `java.util.Base64` in `Base64x.kt` | **Yes.** The resolved jar contains `org/bouncycastle/crypto/signers/Ed25519Signer.class`, `params/Ed25519PrivateKeyParameters.class`, `params/Ed25519PublicKeyParameters.class`, `generators/Ed25519KeyPairGenerator.class`. `minSdk = 26` rules out the platform's own Ed25519 (API 33+), which is exactly why BouncyCastle is already there. |
| iOS | CryptoKit; `Curve25519.KeyAgreement` in `ios/TabsendKit/Sources/TabsendKit/Crypto/CryptoBox.swift`, `SHA256` in `Base64X.swift` and `TlsPinning.swift`, Salsa20/Poly1305 hand-written beside them. Package platforms: iOS 16, macOS 13 | **Yes.** `Curve25519.Signing.PrivateKey` / `.PublicKey`, `signature(for:)` / `isValidSignature(_:for:)`, available since iOS 13 — the sibling of the `Curve25519.KeyAgreement` type the file already imports. |

**The least common denominator is therefore Ed25519 with a real implementation on every
stack, and it is the only new primitive this design introduces.** That matters more than
it sounds: `SECURITY_REVIEW.md` lists "native cryptographic composition" as an open
finding precisely because Salsa20 and Poly1305 are hand-assembled twice, and
`HOSTED_PLAN.md` §12 names composition bugs as the residual risk of declining the paid
audit. Signature verification lands as a library call on every client, so the H1 release
adds no fourth and fifth hand-written primitive. Any design that needed one should be
rejected on that ground alone.

Two supporting primitives, also present everywhere with no new dependency:

- **SHA-256** — WebCrypto `crypto.subtle.digest` (extension/console), `MessageDigest`
  (Android), `CryptoKit.SHA256` (iOS). Already used for `keyIdFor`.
- **HMAC-SHA-256** — WebCrypto `crypto.subtle.sign('HMAC', …)`, `javax.crypto.Mac`
  (`HmacSHA256`), `CryptoKit.HMAC<SHA256>`. Needed once, for §5's invite binding.
  Deliberately not BLAKE2b: libsodium and BouncyCastle have it, CryptoKit does not.

**Key storage** reuses each client's existing home for its X25519 secret, with no new
policy: `ext.storage.local` (extension, `extension/src/lib/storage.ts`), the console's
own persistence (`console/src/lib/persist.ts`), private-mode `SharedPreferences`
(Android, `store/Store.kt`), and the Keychain at
`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` (iOS, `AppGroupStore.swift`, per
ADR-0026). The signing secret is exactly as sensitive as the encryption secret already
there, so it gets the same treatment and no separate ceremony.

**Keys are never shared between roles.** libsodium exposes
`crypto_sign_ed25519_pk_to_curve25519`, and it is tempting to carry one keypair. Rejected:
cross-protocol key reuse is on the review checklist in `HOSTED_SECURITY_PLAN.md`'s own
words ("cross-protocol/key confusion"), the conversion has no counterpart in CryptoKit's
public API, and the two keys have genuinely different lifetimes (an endpoint may rotate
its encryption key without touching its identity). Two keys, two purposes, no derivation
between them.

---

## 3. Data structures

### 3.1 The membership entry

One entry per membership change. Fields correspond to step 3 of the sketch.

```ts
export type MembershipEntryType = 'genesis' | 'add' | 'rotate' | 'revoke';

export interface MembershipEntry {
  /** Encoding version of the SIGNED BYTES. Bump only for an incompatible encoding. */
  v: 1;
  type: MembershipEntryType;
  groupId: GroupId;
  /** Position in the chain. Genesis is 0; every later entry is exactly prev + 1. */
  seq: number;
  /** base64url-nopad SHA-256 of the previous entry. "" at genesis. */
  prevHash: string;

  /** The endpoint this entry is ABOUT (added, rotated, revoked, or the genesis one). */
  subjectEndpointId: EndpointId;
  /**
   * Stable, label-independent identity for the subject. Minted by the JOINING
   * device, not the relay: 32 random bytes, base64url-nopad.
   */
  subjectIdentity: string;
  /** Standard base64 X25519 public key. "" on a revoke. */
  subjectE2ePubkey: string;
  /** Standard base64 Ed25519 public key. "" on a revoke. */
  subjectSignPubkey: string;

  /** Millisecond-precision ISO-8601 UTC. See §3.4. */
  createdAt: IsoTimestamp;

  /** Who signed. Equals subjectEndpointId at genesis and on a rotate. */
  signerEndpointId: EndpointId;
  /** The signer's Ed25519 public key, standard base64, as it appears in state(seq-1). */
  signerSignPubkey: string;
  /** base64 Ed25519 detached signature over the §3.3 bytes. 64 raw bytes. */
  sig: string;
}
```

**`label` is deliberately absent, and this is load-bearing rather than tidy.** The relay
*rewrites* labels: `distinctLabel()` in `server/src/routes/endpoints.ts` runs
`uniqueLabel` on both register and `PATCH /v1/endpoints/:id`, so a device that registers
as "Chrome" into a group that already has one is stored as "Chrome 2". A signature over a
label would therefore be invalid the moment it was created, on the current relay, for
entirely benign reasons. The sketch's phrase "label-independent identity" is not a
preference; it is the only shape that survives contact with the code. Labels stay a
relay-held display convenience, and §8 states the residual honestly.

`subjectIdentity` is what survives a rename and a re-pair of the *display* name while the
keys stay put. It is minted client-side so the relay cannot correlate or reuse it, and it
is bound into the signature so an endpoint id cannot be silently re-pointed at a
different identity.

### 3.2 The root and the head

**There is no group root keypair.** The sketch says "the first endpoint creates a
self-signed group root certificate", which reads two ways, and the separate-keypair
reading has to be rejected:

- Its secret would have to live somewhere. On the first device, it makes that device
  irreplaceable, which contradicts ADR-0021's "any surviving member can add another".
- Anywhere else, it is a recovery credential — the exact thing ADR-0021 removed and gave
  reasons for.
- If it must co-sign every change, the first device becomes a single point of failure for
  the whole group's future.

So the root is **the genesis entry itself, self-signed by the first endpoint's signing
key**, and the group's trust anchor is a hash:

```
rootId = base64url_nopad( SHA-256( canonical_bytes(genesis) || raw_sig(genesis) ) )
```

That is the value later pairing links carry (§5). It is 43 characters, it is not a
secret, and it commits to the first endpoint's two public keys, its identity, and the
group id.

The **membership head** is what every client persists and compares against:

```ts
export interface MembershipHead {
  groupId: GroupId;
  rootId: string;          // genesis entry hash — never changes for a group
  seq: number;             // highest verified sequence
  entryHash: string;       // hash of the entry at `seq`
  /** Derived, cached: the verified membership at `seq`. */
  members: VerifiedMember[];
}

export interface VerifiedMember {
  endpointId: EndpointId;
  identity: string;
  e2ePubkey: string;
  signPubkey: string;
  /** Sequence at which this member's CURRENT keys were established. */
  since: number;
}
```

The head is stored beside the device token, in the same place and with the same
protection. Losing it means re-pairing; that is already the ADR-0021 answer to losing
local state.

### 3.3 Canonical encoding — length-prefixed concatenation

**Decision: the signed bytes are a fixed-order, length-prefixed concatenation of typed
fields. Not canonical JSON.**

The repo is JSON on the wire and it would be natural to sign the JSON. It is also how
this goes wrong. Canonical JSON (JCS, RFC 8785) requires agreement on number formatting,
`\uXXXX` escaping, surrogate-pair handling, key sort order over UTF-16 code units, and
lone-surrogate behaviour — implemented four times, in four languages, by one person, with
`JSON.stringify` and `kotlinx.serialization` and `JSONEncoder` each having their own
opinions about several of them. A single divergence produces a signature that verifies on
three clients and fails on the fourth, intermittently, on inputs containing a
non-ASCII label — and this codebase's own test fixtures already contain
`"Example — a tab in flight ✈️"`, which is exactly the input class that finds such bugs.

Canonical CBOR was considered and rejected for the plainer reason that no client has a
CBOR library, and adding one to four stacks to avoid adding zero is a poor trade.

Length-prefixed concatenation needs no parser, no library, and no agreement about
anything except byte order. Every client already holds these values as typed fields; it
concatenates them. An implementation can be read and checked by eye.

**The exact bytes.** Define:

```
lp(s)  = uint32be( byteLength( utf8(s) ) ) || utf8(s)
u8(n)  = one byte
u32(n) = uint32 big-endian, four bytes
```

`lp("")` is four zero bytes. There is no separator anywhere: the length prefixes make the
encoding unambiguous, which is the entire reason for choosing it.

The signing input is:

```
DOMAIN            = the 20 ASCII bytes "tabsend/membership/1" then 0x00 — 21 bytes total

signing_input =
    DOMAIN
 || u8(v)                        // 1
 || u8(typeByte)                 // genesis=1, add=2, rotate=3, revoke=4
 || lp(groupId)
 || u32(seq)
 || lp(prevHash)                 // "" at genesis
 || lp(subjectEndpointId)
 || lp(subjectIdentity)
 || lp(subjectE2ePubkey)         // "" on revoke
 || lp(subjectSignPubkey)        // "" on revoke
 || lp(createdAt)
 || lp(signerEndpointId)
 || lp(signerSignPubkey)
```

Notes that are part of the spec, not commentary:

- **The domain string is a hard prefix over a NUL byte.** It exists so an Ed25519
  signature made in this protocol can never be replayed as a signature in another one,
  and so a future encoding change cannot be confused with this one. The trailing `0x00`
  removes any chance of a longer domain string being a prefix of a shorter one plus
  payload. Any future signed object in Tabsend takes its own domain
  (`tabsend/<purpose>/<n>`), never this one.
- **`typeByte` values are assigned once and never reused.** A retired type number stays
  retired.
- **`prevHash` and the public keys enter as *strings*, exactly as they appear on the
  wire.** This repo already fingerprints the base64 *string* rather than the decoded
  bytes — `keyIdFor()` in `server/src/ids.ts` is
  `base64url(sha256(utf8(e2ePubkey)))`, and both existing vectors pin that convention.
  Following it means no client has to decode base64 to sign or verify, which removes the
  whole class of "which base64 alphabet, was it padded" bug. It also means the encodings
  must be *stable*: a client MUST NOT re-encode a key it received. Sign the bytes you
  were given.
- **`seq` is `u32`**, not a string and not a JSON number. Four bytes, big-endian, no
  formatting question.
- **`createdAt` is millisecond-precision ISO-8601 UTC**, i.e. `2026-08-19T12:34:56.000Z`.
  ADR-0028's consequences list records this exact trap: Kotlin's `Instant.toString()`
  drops a zero millisecond fraction, `"…00Z"` sorts after `"…00.000Z"`, and the group
  silently disagreed about which key was current. Here it would be worse — a signature
  mismatch rather than an ordering one. The same rule applies and is tested by the same
  kind of vector.

**Entry hash**, used for `prevHash`, `rootId`, and equivocation detection:

```
entryHash = base64url_nopad( SHA-256( signing_input || raw 64 signature bytes ) )
```

The signature is inside the hash. Ed25519 as specified in RFC 8032 is deterministic, so
in practice two valid signatures over one input do not arise — but the chain should not
depend on that, and covering the signature costs nothing.

**Signature:** Ed25519, detached, over `signing_input` with no pre-hashing (pure Ed25519,
not Ed25519ph). `crypto_sign_detached` / `crypto_sign_verify_detached`,
`Ed25519Signer`, `Curve25519.Signing`. Carried as standard base64 (64 raw bytes → 88
characters), matching how every other key and blob in this codebase travels.

### 3.4 Where the values come from

| Value | Minted by | When |
|---|---|---|
| `subjectIdentity` | the joining device | before its first register call |
| Ed25519 keypair | the joining device | before its first register call, beside its X25519 keypair |
| `subjectEndpointId` | the relay | at register, as today (`newId()`) |
| `groupId` | the relay | at group creation, as today |
| `seq`, `prevHash` | the signing device | from its own verified head |
| `createdAt` | the signing device | at signing |

The relay mints ids; it mints no keys and no entries. An id it controls is harmless
because the signature binds the id to keys it does not control.

---

## 4. The state machine

### 4.1 Verification

`verify(entries, storedHead) → VerifiedState | Rejection`. Run over the whole chain from
`seq 0` every time the log is fetched, or incrementally from a verified head. The rules,
in the order they are checked:

**Chain-shape rules (every entry):**

1. `v` is a version this client understands; otherwise the chain stops at the previous
   entry and the client reports "this group uses a newer membership format" — an ADR-0017
   skew message, not an error.
2. `seq` of the first entry is 0 and its `type` is `genesis`; every later `seq` is exactly
   `prev.seq + 1`. No gaps, no reordering, no duplicates.
3. `prevHash` equals the computed `entryHash` of the previous entry. `""` at genesis.
4. `groupId` is identical across the chain and equal to the group the client is registered
   in.
5. `createdAt` is a valid millisecond ISO-8601 UTC string. It is **not** required to be
   monotonic — clocks on a phone and a laptop disagree, and rejecting a chain over that
   would turn a clock skew into an unrecoverable group. Timestamps are display and audit
   material; `seq` is the ordering.
6. The signature verifies over §3.3's bytes under `signerSignPubkey`.
7. `signerSignPubkey` equals the signing key that `state(seq - 1)` holds for
   `signerEndpointId`. **This is the rule that makes a removed key powerless**: after a
   revoke, the endpoint is not in the state, so no key is on record for it, so nothing it
   signs can satisfy this check. It also means a rotated-away key cannot sign anything
   dated after its own rotation.

**Per-type rules:**

| Type | Signer must be | Subject must be | Additional |
|---|---|---|---|
| `genesis` | the subject itself (self-signed); `signerSignPubkey == subjectSignPubkey` | absent (the state is empty) | `seq == 0`, `prevHash == ""`. Exactly one genesis per chain. |
| `add` | a member of `state(seq-1)` | **not** a member, and its `endpointId` and `identity` must never have appeared anywhere earlier in the chain | no resurrection: a revoked device rejoins as a *new* endpoint, which ADR-0004 already says a re-paired install is |
| `rotate` | the subject itself | a member of `state(seq-1)` | at least one of the two keys must actually change; `identity` must not change |
| `revoke` | any member of `state(seq-1)`, **including the subject** (self-unpair) | a member of `state(seq-1)` | the resulting membership must be non-empty |

The "at least one surviving member" rule in the revoke row is ADR-0021 expressed as a
protocol constraint. A group cannot sign itself out of existence; the last device leaving
is a relay/account teardown (`HOSTED_PLAN.md` §5's deletion cascade), not a log entry.

### 4.2 Head persistence, rollback, equivocation

A client persists `MembershipHead` and applies three rules on every fetch:

- **Extension only.** A served chain is accepted only if it *extends* the stored head:
  every entry up to `storedHead.seq` hashes identically, and the entry at
  `storedHead.seq` has `entryHash == storedHead.entryHash`.
- **Rollback → reject, keep the stored head.** A chain that ends below `storedHead.seq`,
  or that omits entries the client has already verified, is a relay fault. The client
  keeps operating on its stored head and surfaces "the relay is serving an older
  membership list than this device has already verified". It does **not** downgrade, and
  it does not resolve by taking the longer or the newer chain — length and recency are
  both relay-controlled.
- **Equivocation → freeze and stop sending.** A different `entryHash` at a sequence the
  client has already verified means the relay served two different histories. This cannot
  be a benign race: entries are append-only and `(groupId, seq)` is unique. The client:
  1. freezes membership at the last consistent head,
  2. **stops sending entirely**, and says why in those words — "this relay gave two
     different answers about which devices are in your group",
  3. keeps *receiving*, but only from endpoints in the frozen state (a received link is a
     smaller harm than a sent one, and refusing them adds a way for a relay to censor),
  4. does not auto-heal, does not retry into a resolved state, and does not offer a
     one-tap "trust it anyway". Clearing it is a deliberate, explicit act by a person, and
     it is the same act as re-pairing.

Sending is what leaks. Freezing sends is the correct blast radius.

### 4.3 What a rename is

**Nothing.** A label change writes no entry, does not move the head, and does not affect
verification. `PATCH /v1/endpoints/:id` is unchanged, still lets any endpoint in the group
rename any other, and still lets the relay's `uniqueLabel` rewrite the result. The
rename-without-key-change vector (§9) exists to prove exactly this: same log, same head,
same members, different display strings.

---

## 5. Genesis and the pairing links

This is the deliverable `HOSTED_PLAN.md` §4.7 names, and it is where the naive reading
contradicts itself, so it is spelled out step by step.

### 5.1 The correction the sketch does not make

Step 5 of the sketch says pairing links bind the invitation to the current root and
inviter key, and that the joining device verifies that binding. That is necessary and it
is not sufficient, because of a fact in the code: **`pairing_codes.code` is stored in the
relay's database in plaintext** (`server/src/routes/pairing.ts`, `server/src/db/schema.ts`).
The pairing code is a secret from the world; it is not a secret from the relay.

Follow the consequence. The inviter mints a link and hands it over. The joiner registers
with its two public keys and the code. The inviter now has to sign an `add` entry naming
the joiner's keys — and the only place it can learn those keys is *from the relay*. A
hostile relay substitutes its own keys for the joiner's, the inviter signs them, and the
relay now owns a fully, correctly signed member. Every rule in §4 passes. The signed
membership chain has certified the attack.

So the link needs one more thing: **a secret the relay never sees**.

### 5.2 The invite binding key

The inviting device generates 32 random bytes locally, keeps them, and puts them in the
link fragment as `k=`. It never sends them to the relay. `POST /v1/pairing` is unchanged
server-side; `k` is a purely client-side addition to the fragment, which ADR-0009 and
ADR-0024 already establish as the place a credential rides so it stays out of request
paths and access logs.

The joining device, before registering, computes:

```
DOMAIN_INVITE = the 16 ASCII bytes "tabsend/invite/1" then 0x00 — 17 bytes total

inviteBinding = base64url_nopad( HMAC-SHA-256(
    key     = the 32 raw bytes of k,
    message = DOMAIN_INVITE
           || lp(subjectE2ePubkey)
           || lp(subjectSignPubkey)
           || lp(subjectIdentity)
           || lp(pairingCode)
) )
```

and sends it in `RegisterRequest`. The relay stores it opaquely and shows it to the
inviter with the pending endpoint. The inviter recomputes it from the `k` it kept and the
keys the relay reports. If they match, the relay did not substitute anything, because it
does not have `k`. If they do not match, **the inviter refuses to sign and says so**: the
join fails visibly, which is the correct outcome of a relay caught tampering.

Including `pairingCode` in the message stops a binding being lifted from one invite to
another. Including `subjectIdentity` stops the keys being re-pointed at a different
identity.

**Only the inviter can honestly sign the add**, because only the inviter holds `k`. That
is a real product consequence and it is stated in §5.5.

### 5.3 The three link forms

| Form | Who mints it | Fragment carries | What it binds |
|---|---|---|---|
| **Bootstrap** (self-hosted boot log, ADR-0023; hosted signup page, `HOSTED_PLAN.md` §5) | the relay, only while the group has zero endpoints | `c=` code, `fp=` cert pin when self-signed, `browser=` / `native=` routes | relay and group only. **No `r=`, no `i=`, no `k=`** — there is no root yet and no inviter to protect |
| **Join** (any later pairing) | an already-paired device | `c=`, `k=`, `r=` root id, `i=` inviter signing-key fingerprint, plus `fp=` / `browser=` / `native=` as today | relay, group, **the current group root, and the inviting device's key** |
| **Re-mint** (`HOSTED_PLAN.md` §5's account page; ADR-0023's restart-prints-a-fresh-one) | the relay | as bootstrap | identical to bootstrap, and **permitted only while the group is still empty** |

`i=` is `base64url_nopad(SHA-256(utf8(signPubkeyB64)))` — the same fingerprint rule as
`keyIdFor` and as ADR-0028's `groupKeyId`. One rule for every fingerprint in the project.

As additive `PairingPayload` fields:

```ts
export interface PairingPayload {
  relayUrl: string;
  code: PairingCodeValue;
  browserRelayUrl?: string;
  nativeRelayUrl?: string;
  certFingerprint?: string;
  /** ADDITIVE. 32 random bytes, base64url-nopad. Client-minted; the relay never sees it. */
  inviteKey?: string;
  /** ADDITIVE. The group's genesis entry hash. Absent on a bootstrap link. */
  rootId?: string;
  /** ADDITIVE. Fingerprint of the inviter's Ed25519 key. Absent on a bootstrap link. */
  inviterKeyId?: string;
}
```

`PAIRING_LINK()` appends `&k=`, `&r=`, `&i=` when present. Older clients tolerate unknown
fragment parameters (ADR-0017's unknown-fields rule; ADR-0019 established the precedent
with `fp=`), so a v3 client mis-reads nothing — it simply ignores three parameters and
pairs as it does today, into a relay that is willing to let it.

**On QR density:** three additional fragment parameters add roughly 130 characters. The
existing self-signed link already carries a 43-character `fp=`. This is expected to stay
inside a comfortable QR version, but it is a measurement, not an opinion, and §10 lists
it as an open question rather than asserting it.

### 5.4 Genesis, precisely

1. A relay boots (or a hosted group is provisioned). `ensureBootstrapGroup` creates an
   empty group; `mintFirstRunPairing` mints a **bootstrap link** because the group has
   zero endpoints. No root exists. The link cannot bind one.
2. That link authenticates *the relay and the group to the first device*, exactly as it
   does today — including the ADR-0019 certificate pin, which is the only trust anchor
   present at this moment and which membership does not replace.
3. The first device registers. Before that it minted its X25519 keypair (as today), its
   **Ed25519 keypair**, and its `subjectIdentity`. It sends `signPubkey` and `identity` in
   `RegisterRequest`; no `inviteBinding`, because there is no inviter.
4. The relay creates the endpoint and returns the device token, as today.
5. **The first device immediately mints the root**: it builds the genesis entry (`seq 0`,
   `prevHash ""`, `type genesis`, subject and signer both itself), self-signs it, and
   `POST`s it to the membership log. It stores `rootId` as its head. **This is the whole
   of "who mints the root and when."** No relay involvement beyond storage.
6. Every later join uses a **join link** carrying `r=` and `i=` and `k=`, and the sequence
   in §5.5.

If step 5 fails (offline, crash), the group has an endpoint and no genesis. The device
retries on next launch; until it succeeds it is a group of one with an unverified
membership, which is a state it can always leave by retrying. It must never be resolved by
letting a *second* device mint the genesis, because a second device cannot know the first
one's keys are honest. The relay refuses a genesis when the group already has more than
one endpoint, for the same reason it refuses a bootstrap link into a non-empty group.

### 5.5 Join, precisely

Given a join link carrying `c`, `k`, `r`, `i`:

1. **Before registering**, the joiner fetches the log with the code as its authorizer:
   `GET /v1/membership?code=<c>`. This read is unauthenticated-but-invited, and it exists
   so the joiner can check the root *before it hands over its public keys*. The log is not
   secret; gating it on a live pairing code costs nothing and keeps casual enumeration out.
2. The joiner verifies the chain per §4.1, then checks:
   - the genesis entry hash equals `r`; and
   - some member at the head has `SHA-256(utf8(signPubkey))` equal to `i`.

   Either check failing means the relay is serving a group that is not the one the link
   describes. **Abort before registering.** Nothing has been sent.
3. The joiner mints its keys and identity, computes `inviteBinding` under `k`, and calls
   `POST /v1/endpoints/register` with `pairingCode`, `e2ePubkey`, `signPubkey`, `identity`,
   `inviteBinding`, and `clientProtocol`.
4. The relay creates the endpoint row and returns a device token. **The endpoint is
   pending**: it is in the relay's directory but not in any client's verified state, so no
   client will send to it and it will send to nobody.
5. The **inviter** — the device that minted the link and holds `k` — sees the pending
   endpoint (WS `endpoint_added` already fires; §6 adds the fields it needs), recomputes
   the binding, and on a match signs an `add` entry at `head.seq + 1` and appends it.
6. Every client, including the joiner, fetches the extended log, verifies it, and moves its
   head. The joiner confirms the entry that adds it carries its own two public keys and
   identity **verbatim**, byte for byte, and only then treats the directory as trusted and
   begins sending.
7. ADR-0028's group history key is delivered as it is today, over `/v1/group-keys` — but a
   client seals it only to an endpoint in its **verified** membership. That is the second
   place membership does real work: without it, a fabricated endpoint receives the group
   key and can read the whole history window.

**The inviter must be running to complete a join.** If the browser that minted the link is
closed, the new device sits pending until it reopens. This is a genuine UX regression
against today's fire-and-forget pairing and it is the price of the guarantee: the only
device that can honestly attest to the joiner's keys is the one that shared a secret with
it. The right mitigation is copy, not protocol — "waiting for Chrome · Work to confirm this
device", named, with the reason. §10 asks the review whether this is acceptable.

### 5.6 How this scopes the §5 bootstrap window

`HOSTED_PLAN.md` §5 already states it: whoever consumes the first link becomes the root.
This design does not close that window; it defines its edges precisely, and the edges are
what make the window small.

- The window opens when the group is created and **closes permanently at the first
  join**, because `mintFirstRunPairing` refuses once an endpoint exists and the relay
  refuses a second genesis.
- An attacker who wins the race gets an **empty group** — no history, no keys, no links —
  and the real owner gets a **visible, unambiguous failure**: their own bootstrap link is
  already consumed, and if they force their way in as a second device they will find a
  genesis they did not mint and an `i=` fingerprint that is not theirs. Recovery is to
  delete the group and start again, which at that point costs nothing.
- Hosted narrows it further with the notification email at first join (§5 of the plan).
- The window is **not** a membership problem and cannot be solved by membership: it is the
  ordinary trust-on-first-use boundary that ADR-0019's certificate pin already lives on.
  Saying so is more useful than pretending otherwise.

One consequence to carry into H2: **`mintFirstRunPairing` currently returns `null`
whenever `ALLOW_MULTIPLE_GROUPS` is set** (`server/src/bootstrap.ts`), and the hosted relay
runs multi-group. Hosted has no bootstrap link today. `HOSTED_PLAN.md` §4.2's provisioning
API is where it comes from, and **the "only while the group is empty" rule must be carried
across with it** — it is not an ADR-0023 detail, it is half of this section's argument.

*Annotated 2026-08-20: both halves have since landed. The setting is now
`GROUP_CREATION` (ADR-0029; `ALLOW_MULTIPLE_GROUPS=1` is a still-working alias for
`open`), and `bootstrap.ts` gates on `groupCreation !== 'single'`, so the behaviour
described is unchanged under either name. The provisioning API (ADR-0031) mints the first
link per group and does carry the empty-group rule with it. This paragraph stays as the
requirement it was; the design review should check the shipped rule against it rather than
assume it.*

---

## 6. Relay surface

Additive throughout. Nothing existing changes shape.

### 6.1 Storage

```ts
export interface MembershipEntriesTable {
  group_id: string
  seq: number
  /** Computed entry hash, base64url-nopad. */
  entry_hash: string
  prev_hash: string
  entry_type: string
  subject_endpoint_id: string
  signer_endpoint_id: string
  /** The entry as received, verbatim JSON. NEVER re-serialised. */
  entry: string
  created_at: string
}
// PRIMARY KEY (group_id, seq)
```

`entry` is stored and returned **byte-for-byte as received**. A relay that re-serialises
JSON will eventually reorder a key or normalise a character and break every signature in
the group. This is a one-line rule with a large blast radius, so it belongs in the schema
comment as well as here.

The `(group_id, seq)` primary key means an *honest* relay cannot fork a chain by accident —
a bug cannot produce two entries at one sequence. It does not constrain a *hostile* relay,
which owns the database; equivocation is a live serving behaviour, and §4.2 is what detects
it. Both statements are true and neither substitutes for the other.

Retention: entries are never swept and never expire. A group's log is a few hundred bytes
per device event, which is nothing next to the message rows the sweeper already manages.
They are deleted only with the group, as part of `HOSTED_PLAN.md` §5's idempotent teardown
cascade — which that section already lists ("membership log").

### 6.2 Routes

```
GET  /v1/membership?since=<seq>&limit=<n>     auth: device token
GET  /v1/membership?code=<pairingCode>        auth: a live, unconsumed pairing code
POST /v1/membership                            auth: device token
```

`GET` returns entries ascending from `since` (default 0), capped at `limit` (default 200,
max 1000), plus the relay's view of the tail:

```ts
export interface MembershipLogResponse {
  entries: MembershipEntry[];
  /** The relay's tail. A HINT for paging, never trusted as truth. */
  head: { seq: number; entryHash: string };
  /** True when more entries exist above the last one returned. */
  more: boolean;
}
```

`head` is explicitly a paging aid. A client pages until `more` is false and then trusts
only what it verified. A relay that advertises a head it does not serve is withholding, and
§8 classifies that.

`POST` takes one entry and applies **shape checks only**:

- well-formed per the field list, sizes bounded,
- `groupId` matches the caller's group,
- `seq == storedTail.seq + 1` and `prevHash == storedTail.entryHash`, or the log is empty
  and the entry is a `genesis` with `seq 0` in a group with exactly one endpoint,
- the row does not already exist.

On a sequence conflict it answers a new `ApiErrorCode`, **`membership_conflict` (409)** —
an additive lock under the ADR-0009 process, and the right code for the same reason
ADR-0022 chose 409 for `group_exists`: the request is well-formed and would have been valid
a moment earlier. A client that gets it re-fetches, re-verifies, rebuilds its entry at the
new sequence, and retries. Two devices adding two different endpoints at once is an
ordinary race with an ordinary resolution.

The relay does **not** verify signatures. It holds no keys, ADR-0016's blind-pipe premise
says it imports no crypto, and a relay that validated signatures would be trusted to have
done so — which is the mistake this whole design removes. Shape checks are for keeping an
honest relay's storage consistent, nothing more.

WS gains one additive event:

```ts
| { type: 'membership_appended'; seq: number; entryHash: string }
```

Latency only, like every other stream event (ADR-0001, PRD §6.1). A missed event costs a
poll.

### 6.3 What the relay may and may not do

| May | May not (and is caught) |
|---|---|
| Store entries; serve them in order; page them | Mint an entry (no signing key exists anywhere it can reach) |
| Refuse a malformed or mis-sequenced append | Modify an entry (breaks the signature) |
| Refuse to serve at all (outage, suspension) | Reorder or renumber (breaks `prevHash`) |
| Delete a whole group on teardown | Omit an entry below an advertised head (breaks `prevHash`) |
| Rewrite `label` via `uniqueLabel`, as today | Serve different bytes at one `seq` to two callers (equivocation, §4.2) |
| Report a pending endpoint's keys and binding | Roll a client back (§4.2) |

The last "may" is where the relay can still lie, and §5.2 is the answer: it can report
whatever keys it likes for a pending endpoint, and the inviter's binding check catches it.

### 6.4 ADR-0023's boot link and re-minting

Both survive, with one rule added and one clarified.

- **Added:** a bootstrap or re-mint link carries no `r=`/`i=`/`k=`, and a joining client
  treats their absence as "this must be an empty group". If it fetches the log and finds a
  genesis, the link is lying about being a first link, and it refuses. That is the check
  that stops a hostile relay from handing a *later* device a bootstrap-shaped link in order
  to skip the root binding — a downgrade attack the sketch does not name.
- **Clarified:** "only while empty" is now doing security work, not just tidiness, and it
  must be preserved verbatim in `HOSTED_PLAN.md` §4.2's generalized provisioning version.
  ADR-0023's own follow-up list ("what hosted does instead of a log line", "whether the
  bootstrap window should be closable manually") is answered by §5.6: hosted shows it at
  signup, and it closes itself at the first join.

---

## 7. Protocol versioning and migration

### 7.1 The numbers

**The membership release is `CLIENT_PROTOCOL = 4`.** It changes the onboarding contract
(join links carry new required parameters; a joiner verifies a root before registering),
which is precisely what ADR-0017 says a bump is for.

**`MIN_RELAY_PROTOCOL` stays at 3**, and this is the argued part.

A v4 client against a v3 relay finds no membership routes. It could refuse — but ADR-0017
is emphatic that a version check which stops a working setup is worse than the skew, and
raising the relay floor would break every self-hoster who updates a browser extension
before their server. So a v4 client with **no stored head** for a group may operate
unverified against an older relay, and says so on screen.

The obvious objection is a downgrade attack: a hostile relay advertises `protocol: 3` and
the client drops its guarantee. The answer is that **the mode is decided by what the client
has stored, not by what the relay says**:

> Once a client holds a membership head for a group, it requires membership for that group
> **forever**. A relay that subsequently stops serving the log is a fault, not a mode
> change. There is no path from verified back to unverified except an explicit re-pair by a
> person.

This is the same trust-on-first-use shape ADR-0019 already uses for the certificate pin,
and it means the relay's advertised protocol number is a routing hint rather than a
security control — which is all ADR-0017 ever claimed it was.

**The hosted relay pins `minClientProtocol = 4`**, per `HOSTED_PLAN.md` §4.7. Nothing older
can register there, so nobody ever pairs into a hosted group under relay-authoritative
trust. ADR-0017's "moves almost never" caution is about stranding an existing fleet; a
brand-new hosted relay has no fleet.

### 7.2 Two implementation items the review should flag as gaps, not details

1. **There is no knob.** `server/src/routes/config.ts` hard-wires
   `minClientProtocol: MIN_RELAY_PROTOCOL`. Hosted needs a `MIN_CLIENT_PROTOCOL` env
   override, defaulting to the shared constant so self-hosted behaviour is unchanged.
2. **The floor is advertised but never enforced, and cannot be.** `checkProtocol()` is
   client-side, and `RegisterRequest` carries no protocol field at all — the relay does not
   know what version is talking to it. `HOSTED_PLAN.md` §4.7 says a pre-membership client
   "cannot register or operate there at all"; today nothing implements that sentence.
   It needs an additive `RegisterRequest.clientProtocol?: number` and a register-route
   refusal when it is absent or below the floor. Absent must fail closed on a relay with a
   raised floor (an old client omits it) and must be tolerated on a default relay.

Neither is a membership design question, which is exactly why both are easy to lose. They
belong in H1's implementation scope.

### 7.3 Migration for existing self-hosted fleets

**Decision: an existing group does not acquire a root retroactively. It opts in, and the
opt-in costs one re-pair per device.**

The tempting migration is: the first upgraded device mints a genesis and, in the same
breath, signs `add` entries for every endpoint currently in `GET /v1/endpoints`. It is a
few hours of work and nobody has to re-pair.

It is also the attack, laundered. The list that migration blesses is **the relay's list**.
If the relay had already inserted a fabricated endpoint, the migration signs it into the
chain and stamps it permanently trusted — and the group ends up strictly worse off than
before, because now there is a signature saying the fabrication is genuine. A migration
whose input is the untrusted thing cannot produce a trusted output.

The variant where the operator confirms each endpoint's key fingerprint on screen before
the migration signs it was considered and rejected too. It is the pairwise manual
verification `HOSTED_SECURITY_PLAN.md` explicitly declines as the commercial design, it
scales worst on the largest groups, and comparing 43-character strings on eight browsers is
a ceremony people click through.

So:

- A group with no genesis stays **unverified**, works exactly as it does today, and says so
  plainly in each client (one line, not a warning banner — this is the status quo, not a
  regression).
- The owner opts in from one device: "start signed membership". That device mints a genesis
  naming **only itself**, and every other device re-pairs through the new signed join.
- Hosted has no migration problem at all: every hosted group is born after H1, with a
  genesis from its first device.

The honest summary is that the cost is real and it is bounded — a handful of browsers, once
— and it is the only version where the root actually roots in a device rather than in the
relay.

---

## 8. Threat analysis

Each row names the rule that kills the attack, so the review can check the rules rather
than the prose.

| Attack | What the relay does | Killed by |
|---|---|---|
| **Relay-fabricated endpoint** | inserts a row in `endpoints` with its own X25519 and Ed25519 keys | §4.1 rule 7 + the `add` row: the row is not in any signed chain, so it never enters `state`. Clients target only verified members. The relay cannot sign an `add` — no member's signing key exists anywhere it can reach. |
| **Fabricated endpoint via a forged add** | writes an `add` entry naming its own keys | Signature check (rule 6) against a signing key it does not hold. |
| **Key substitution at join** | reports its own keys as the joiner's, so the honest inviter signs them | §5.2 invite binding: the HMAC is keyed by `k`, which travelled only in the link fragment and never reached the relay. Mismatch ⇒ the inviter refuses to sign and the join fails visibly. |
| **Rollback** | serves a chain that ends before a client's stored head, e.g. one that predates a revoke | §4.2 extension-only rule: the stored head is kept, the short chain is rejected, the relay fault is surfaced. A revoked device does not come back by the relay forgetting it. |
| **Equivocation / forked history** | serves chain A to your laptop and chain B to your phone | §4.2: a differing `entryHash` at an already-verified `seq` freezes membership and **stops sending**, with no auto-heal and no one-tap override. |
| **Forked / concurrent join** | two devices legitimately append at `seq n` at once | Not an attack: `(group_id, seq)` uniqueness rejects the second with `membership_conflict` (409); that client re-fetches, re-verifies, rebuilds at `n+1`, retries. Both devices end up added, in some order. |
| **Corrupted or truncated signature** | flips a byte, in storage or in transit | Signature check (rule 6). The chain stops at the previous entry; the client keeps its last good head and reports a fault rather than silently accepting a shorter history. |
| **Replay of an old head** | re-serves a previously valid prefix as if it were current | Same as rollback. `seq` and `entryHash` are both pinned locally, and neither length nor recency is used to pick between chains. |
| **Resurrection of a revoked device** | replays the original `add` after a `revoke` | `seq`/`prevHash` place it at a fixed position; re-appending it at a new sequence fails the `add` rule (the endpoint id and identity already appear in the chain). A returning device joins as a new endpoint, per ADR-0004. |
| **Downgrade to a bootstrap link** | hands a later device a link with no `r=`/`i=`/`k=` | §6.4: absent binding means "empty group"; the client fetches the log, finds a genesis, and refuses. |
| **Protocol downgrade** | advertises `protocol: 3` to a v4 client | §7.1: a client holding a head requires membership forever, regardless of what the relay claims. |
| **Group-key theft via a fabricated endpoint** | fabricates an endpoint to be handed the ADR-0028 history key | §5.5 step 7: clients seal group keys only to **verified** members. |

### What this design does **not** defend against, stated plainly

- **Withholding.** A relay that serves no log, or stalls at a stale head, denies service.
  Clients can detect that they are not making progress; they cannot compel an answer. This
  is availability, not integrity, and it is the correct boundary — `HOSTED_PLAN.md` §3
  already documents the relay as a single point of availability failure.
- **The bootstrap window.** §5.6. Whoever consumes the first link becomes the root.
  Narrowed, made visible, not eliminated.
- **A compromised device.** Its keys are its keys. The group is only as trustworthy as its
  members, which is what "device-rooted" means.
- **A stolen signing key rotating itself.** `rotate` is self-signed, so an attacker holding
  a device's signing key can rotate to a key of its own and lock the real device out. The
  real device's recourse is another member's `revoke`. Where there is no other member, the
  attacker has the group — but that requires compromising the only device, which already
  loses everything on it. Requiring a co-signature above N members was considered and left
  as an open question (§10.8) rather than assumed.
- **Labels.** The relay picks display strings and can rewrite them (`uniqueLabel`) or lie
  about them. It cannot change which keys are in the group, so the worst case is a user
  sending to a real device they did not mean to. Mitigation is UI: the pending-join
  confirmation names the inviter, and a device's identity is its keys.
- **Metadata.** Unchanged. The relay still sees who sends to whom and when
  (`LICENSING.md` §1.1), and the log adds "when devices joined and left" to that list. The
  privacy policy must say so.
- **Traffic analysis, timing, side channels in the native implementations.** Out of scope
  here; on `HOSTED_SECURITY_PLAN.md`'s review checklist, and covered by
  `HOSTED_PLAN.md` §9.6's adversarial-model-review substitute.

---

## 9. Wire test-vector catalog

`HOSTED_SECURITY_PLAN.md` lines 51–53 name ten cases and require the same vectors to run in
every client. This section is specified concretely enough that the implementation phase can
generate them mechanically.

### 9.1 Shape, mirroring the existing precedent

The two existing vectors set the pattern, and it is worth stating what the pattern *is*
before extending it:

- **Canonical home:** `ios/TabsendKit/Tests/TabsendKitTests/Resources/`, declared in
  `ios/TabsendKit/Package.swift` under `resources: [.copy(...)]`.
- **The extension reads that file in place**, by relative path, rather than copying it —
  `extension/src/lib/groupvector.test.ts` resolves
  `../../../ios/TabsendKit/Tests/TabsendKitTests/Resources/group-history-vector.json` with
  a comment explaining that the two can then never drift apart unnoticed.
- **Android keeps a byte-identical copy** at `android/app/src/test/resources/`, because
  Gradle cannot reach outside its module. Both existing files are currently identical
  across the two homes; a CI check that they stay so is cheap and missing.
- **Generation is a deterministic Node script** — `android/tools/gen-interop-vector.mjs` —
  which resolves `libsodium-wrappers` from the pnpm store by explicit path, derives
  keypairs from **fixed seeds** (`Buffer.alloc(32, 0x11)`), uses a **fixed nonce**, and
  writes `JSON.stringify(vector, null, 2)` plus a trailing newline with a leading
  `_comment` field explaining what the file pins.

Membership vectors follow all of it, with one deliberate difference: **one file with a
`cases[]` array**, not ten files. The ten cases share a group id and a key set, and a
harness that loads one file and loops is what makes "run the same vectors in every client"
a small amount of work in four languages rather than forty test functions.

- **Generator:** `shared/tools/gen-membership-vector.mjs`. In `shared/` rather than
  `android/tools/` because it serves four clients; the existing script's location is an
  accident of which client needed it first.
- **Output:** `ios/TabsendKit/Tests/TabsendKitTests/Resources/membership-vector.json`,
  copied to `android/app/src/test/resources/`, read in place by the extension test.
- **Console gap, flagged:** the console has its own `console/src/lib/crypto.ts` and
  `console/src/lib/keyring.ts` but **no vector test at all today** — `interop-vector.json`
  and `group-history-vector.json` are exercised by the extension, Android, and iOS only.
  "Run the same vectors in every client" is four clients, so the console gets a
  membership-vector test, and the review should decide whether the two existing vectors get
  one at the same time (§10.6).

### 9.2 File schema

```jsonc
{
  "_comment": "Cross-client vectors for the signed membership chain. …",
  "alg": "ed25519",
  "encoding": "tabsend/membership/1",

  // Fixed, seeded keypairs. Ed25519 from crypto_sign_seed_keypair(seed),
  // X25519 from crypto_box_seed_keypair(seed), seeds are constant bytes.
  "keys": {
    "A": { "seedHex": "11…11", "signPublicKey": "…", "signPrivateKey": "…",
           "e2ePublicKey": "…", "e2ePrivateKey": "…",
           "signKeyId": "…", "identity": "…" },
    "B": { … }, "C": { … },
    "RELAY": { … }   // the adversary's keypair, used by the fabrication cases
  },

  "groupId": "…",

  // Debug aid, and the single most useful field in the file: the exact bytes of one
  // entry's signing input, so an implementation can fix its ENCODER before it ever
  // has to debug a failing signature.
  "encodingProbe": {
    "entry": { … },
    "signingInputHex": "746162…",
    "signingInputLength": 214,
    "entryHash": "…"
  },

  "cases": [
    {
      "name": "genesis",
      "description": "…",
      // Entries served by the (possibly hostile) relay, in the order served.
      "log": [ { …MembershipEntry… } ],
      // What the client had already verified. null = a fresh client.
      "storedHead": null,
      "expect": {
        "verdict": "accept",              // accept | reject | freeze
        "head": { "seq": 0, "entryHash": "…" },
        "rootId": "…",
        "members": [ { "endpointId": "…", "signKeyId": "…", "since": 0 } ],
        "reason": null,                   // machine-readable code when not "accept"
        "sendingAllowed": true
      }
    }
  ]
}
```

`verdict` has three values, matching §4.2: `accept` (move the head), `reject` (keep the
stored head, report a fault, keep sending to the frozen-but-valid state), `freeze`
(equivocation — keep the head, **stop sending**). `sendingAllowed` is stated separately and
redundantly on purpose: it is the outcome the product actually cares about, and a client
that gets the verdict right and the consequence wrong has failed the test.

### 9.3 The ten cases

| # | Case | Input | Expected verdict, every client |
|---|---|---|---|
| 1 | **genesis** | A's self-signed `seq 0` only; no stored head | `accept`; head `(0, H0)`; `rootId == H0`; members `[A]`; sending allowed |
| 2 | **join** | `[genesis(A), add(B) signed by A]`; stored head `(0, H0)` | `accept`; head `(1, H1)`; members `[A, B]`; B's entry carries B's exact `e2ePubkey`, `signPubkey`, `identity` strings |
| 3 | **concurrent / forked join** | two entries both claiming `seq 1` (`add(B)` and `add(C)`, both validly signed by A), served in one response | `reject`, reason `duplicate_seq`. Not equivocation — one response cannot be two histories. The client re-fetches. A companion sub-case serves them as two *separate* responses and expects `freeze`. |
| 4 | **rename without key change** | log identical to case 2; the accompanying directory fixture gives A and B different `label` values from the previous case | `accept`; head, `rootId` and `members` **byte-identical to case 2**. Proves labels are outside the signed bytes and outside the state. |
| 5 | **rotation** | `[genesis(A), add(B), rotate(B→B') signed by B's old key]` | `accept`; head `(2, H2)`; members `[A, B']` with B' keeping B's `identity` and `endpointId` and gaining a new `since`. A sub-case signs the rotation with A's key instead: `reject`, reason `rotate_not_self_signed`. |
| 6 | **revoke** | `[genesis(A), add(B), revoke(B) signed by A]` | `accept`; members `[A]`. Sub-case a: a later entry signed by B's now-removed key ⇒ `reject`, reason `signer_not_member`. Sub-case b: `revoke(A)` signed by A when A is the only member ⇒ `reject`, reason `would_empty_group`. |
| 7 | **rollback** | log `[genesis, add(B)]` served to a client whose stored head is `(2, H2)` after a `revoke(B)` | `reject`, reason `rollback`; head stays `(2, H2)`; B is **not** restored; sending still allowed to the frozen state |
| 8 | **equivocation** | stored head `(1, H1)`; relay serves a chain whose `seq 1` hashes to `H1'` | `freeze`, reason `equivocation`; head stays `(1, H1)`; **`sendingAllowed: false`** |
| 9 | **corrupted signature** | case 2's log with one byte of `add(B).sig` flipped | `reject`, reason `bad_signature`; head stays `(0, H0)`; A still a member, B not |
| 10 | **relay-fabricated endpoint** | three sub-cases: (a) an `endpoints` directory row for RELAY with no log entry at all; (b) an `add(RELAY)` entry signed by RELAY's own key; (c) an `add(RELAY)` at `seq 1` with a `prevHash` that does not match the genesis | (a) `accept` the log, and RELAY is **absent from `members`** and not a valid target; (b) `reject`, reason `signer_not_member`; (c) `reject`, reason `prev_hash_mismatch`. In all three, **`sendingAllowed` to RELAY is false**. |

An eleventh, non-adversarial case earns its place: **`encodingProbe`** as a standalone
assertion. Every client asserts that its encoder produces `signingInputHex` byte-for-byte
before any signature is checked. Both existing vectors work this way in spirit — Android
and iOS must reproduce a libsodium ciphertext byte-for-byte, because authentication fails
on any divergence — and the probe makes the failure *legible* instead of surfacing as an
unexplained bad signature.

The invite binding (§5.2) needs its own small fixture in the same file: fixed `k`, fixed
code, fixed keys, expected `inviteBinding`. Four HMAC implementations is four chances to
disagree about the message construction, and it is the one value that stands between an
honest inviter and a substituted key.

---

## 10. Open questions for the design review

Listed because they are genuinely open, not to be waved through.

1. **The inviter must be online to complete a join** (§5.5). Acceptable, with clear copy?
   The alternative — letting any member sign — requires distributing `k` to the whole
   group, which weakens the binding to "any member's device is honest" rather than "the
   device that shared a secret with the joiner is honest". Probably still worth having on
   the table, since in this product every member is the same person.
2. **iOS cannot revoke.** ADR-0028's consequences record that iOS "has no remove-a-device
   surface" and therefore cannot rotate the group key. Revocation needs a signer with a UI.
   Does iOS gain a remove-device screen in H1, or is "a group whose only device is an
   iPhone cannot revoke anything" an accepted limitation? The same question decides whether
   ADR-0028's rotate-on-removal path gets built there.
3. **Coupling `revoke` to the ADR-0028 group-key rotation.** ADR-0028 §7 says removing an
   endpoint rotates the history key. Should a `revoke` entry *require* an accompanying
   rotation before the revoking client resumes sending, or is it advisory? Mandatory is
   safer and gives the revoking device more to do while offline peers are unreachable.
4. **Migration cost** (§7.3). One re-pair per device for every existing self-hosted group,
   including the owner's dogfood fleet. Accepted, or does self-hosted get the
   confirm-each-fingerprint variant as an explicit, documented exception?
5. **QR density with `k=`, `r=`, `i=`** (§5.3). Roughly 130 more characters in the
   fragment. Needs a measurement against the Android and iOS scanners at realistic
   distances, not an assurance. If it hurts, the fallback is shortening `r=` to a truncated
   root fingerprint, which weakens it in a way that needs its own argument.
6. **Does the console need a signing key at all?** It is a pure reader, excluded from every
   chooser (ADR-0010, ADR-0028 §8), and it never sends. Giving it one costs nothing and
   keeps the state machine uniform; not giving it one means one fewer key to store in a
   browser tab someone opened once. Related: the console has no cross-client vector test
   today (§9.1) — does it get one for all three vectors, or only for membership?
7. **Log length and paging.** 200 entries per page is a guess. Is there any realistic group
   where the chain grows enough to matter, and should there be a hard cap that refuses
   appends beyond it?
8. **Self-signed rotation** (§8). A stolen signing key can rotate itself and lock out the
   real device. Accept as a residual, or require a co-signature from another member once
   the group has more than one? Co-signature reintroduces the "inviter must be online"
   problem on every rotation.
9. **Is `membership_conflict` the right code**, or should a sequence collision reuse
   `invalid_request`? A distinct code lets clients retry automatically; a new
   `ApiErrorCode` value is an additive lock that every client must learn to ignore
   gracefully (ADR-0017's unknown-enum rule covers it, but it is worth saying out loud).
10. **`RegisterRequest.clientProtocol`** (§7.2). New additive field plus a register-route
    refusal, or does hosted enforce its floor some other way? Without it, `HOSTED_PLAN.md`
    §4.7's central promise has nothing behind it.
11. **Does `GET /v1/membership?code=` leak usefully?** It tells the holder of a live pairing
    code how many devices are in the group and when they joined. That holder is being
    invited into the group, so the answer is probably no — but it is the one new
    unauthenticated read, and it deserves an explicit ruling rather than an assumption.

---

## 11. Where the existing docs and this design disagree

Recorded here rather than only in review notes, per the house rule that findings land in
tracked docs.

- **"Self-signed group root certificate"** (`HOSTED_SECURITY_PLAN.md` step 2) reads as a
  separate root keypair. A separate root key has no safe home and would contradict
  ADR-0021. Resolved in §3.2: the root is the genesis *entry*, self-signed by the first
  endpoint, and `rootId` is its hash.
- **"verifies that binding before sending a token"** (step 5) — the joining device never
  sends a token; the relay issues one to it. Restated in §5.5 as: verify the root **before
  registering**, using the pairing-code-authorized read, and verify the entry that adds you
  before sending anything.
- **The sketch is silent on the pairing code being relay-visible.** `pairing_codes.code` is
  stored plaintext, so the code alone cannot bind a joiner's keys to an inviter. §5.2's
  invite key is a required addition, and it is the single most load-bearing correction in
  this document.
- **ADR-0023's `mintFirstRunPairing` returns `null` under `ALLOW_MULTIPLE_GROUPS`**, and
  hosted runs multi-group. Hosted has no bootstrap link in the current code; §4.2's
  provisioning API must supply it and must carry the "only while empty" rule with it.
  *(Annotated 2026-08-20: the setting is `GROUP_CREATION` since ADR-0029, with
  `ALLOW_MULTIPLE_GROUPS` a working alias and the gate now `groupCreation !== 'single'`;
  ADR-0031's provisioning API supplies the per-group first link and does carry the rule.
  §5's paragraph on this is annotated the same way.)*
- **ADR-0009 says `crypto_box` "stops a compromised/malicious relay from injecting links".**
  True only relative to the endpoint directory, which the relay owns. The claim becomes
  complete only with membership, and the ADR is worth annotating to say so.
- **`minClientProtocol` is advertised and never enforced**, and `RegisterRequest` carries no
  protocol at all (§7.2). `HOSTED_PLAN.md` §4.7's "cannot register or operate there at all"
  is currently unimplementable as written.
- **The relay rewrites labels** (`uniqueLabel` on register and PATCH). This is why labels
  must be outside the signed bytes (§3.1) — it is a constraint the sketch's
  "label-independent identity" phrase implies without naming the mechanism.
- **ADR-0028's "iOS cannot rotate"** becomes a membership problem as well as a history-key
  one, per open question 2.
