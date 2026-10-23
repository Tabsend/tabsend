# Self-hosting the Tabsend relay

The relay is the only server component. It's a small Fastify app that stores and forwards
**end-to-end-encrypted ciphertext** (it never sees your URLs), wakes devices via Web Push,
and offers a WebSocket fast path. This guide covers running it on a VPS — bare-metal Node
or Docker — with HTTPS, a database, and backups.

> Self-host == hosted (ADR-0003): there is no separate "cloud" code path. What you run here
> is the whole thing.

## Contents
- [Requirements](#requirements)
- [Quick start (bare Node)](#quick-start-bare-node)
- [Configuration](#configuration)
  - [Provisioning API (hosted)](#provisioning-api-hosted)
  - [Deployment profile (`TABSEND_PROFILE`)](#deployment-profile-tabsend_profile)
  - [Waking phones (`WAKE_FORWARDER_URL`)](#waking-phones-wake_forwarder_url)
- [Database: SQLite vs Postgres](#database-sqlite-vs-postgres)
- [HTTPS is mandatory (Caddy example)](#https-is-mandatory-caddy-example)
- [No domain? Self-signed TLS for phones on your LAN](#no-domain-self-signed-tls-for-phones-on-your-lan)
  - [LAN, Tailscale, and domain reachability](#lan-tailscale-and-domain-reachability)
- [Running as a service (systemd)](#running-as-a-service-systemd)
  - [Browsers can't pin, so add a cleartext listener](#browsers-cant-pin-so-add-a-cleartext-listener-for-them)
- [Docker & docker-compose](#docker--docker-compose)
  - [A domain you control (recommended)](#a-domain-you-control-recommended)
  - [A spare machine with no domain](#a-spare-machine-with-no-domain)
    - [Check the address in the log](#check-the-address-in-the-log)
    - [Open the firewall](#open-the-firewall)
  - [Bring your own proxy](#bring-your-own-proxy)
- [Backups](#backups)
- [Known limitation: single-instance WS fan-out](#known-limitation-single-instance-ws-fan-out)
- [Serving the web console](#serving-the-web-console)

## Requirements

- **Node ≥ 26** and **pnpm 11.13.1** (`npm install --global pnpm@11.13.1`; Node 26 no
  longer bundles corepack), OR **Docker**.
- A domain with **HTTPS** (Web Push requires it — see below).
- A database: nothing to install for **SQLite** (a file), or a **Postgres 14+** server.

## Quick start (bare Node)

```bash
git clone <your-fork> tabsend && cd tabsend
npm install --global pnpm@11.13.1   # the version package.json pins
pnpm install --frozen-lockfile

cp server/.env.example server/.env
# edit server/.env: set PUBLIC_RELAY_URL to your https origin and VAPID_SUBJECT

# Run it (reads server/.env if you export it):
cd server && set -a && source .env && set +a && cd ..
pnpm --filter @tabsend/server start        # listens on $HOST:$PORT (default 127.0.0.1:8787)
```

The relay **auto-migrates on boot** — the schema is created/upgraded idempotently, so
there is no separate migration command and upgrades are safe to redeploy over an existing
database (columns are added additively; existing rows keep working).

On its first boot the relay generates its Web Push (VAPID) keypair atomically and stores
it in the same SQLite/Postgres database as the relay identity. Later boots and image
rebuilds reuse it, so there is no post-install key command and browser subscriptions stay
valid. Backing up the database backs up this identity too.

## Configuration

All configuration is environment variables — see **[`server/.env.example`](../server/.env.example)**
for the annotated list. The ones that matter most:

Every limit below that counts something (`RATE_LIMIT_MAX`, `CAP_*`,
`PAIRING_CODES_MAX_LIVE`) must be a whole number of 0 or more, and the two pairing-link
lifetimes must be above zero. Anything else stops the relay at startup with a message
naming the setting, rather than failing requests later.

| Var | Default | Notes |
|---|---|---|
| `HOST` / `PORT` | `127.0.0.1` / `8787` | Bind loopback and front it with a proxy; use `0.0.0.0` in a container. |
| `HTTP_PORT` | — | With `TLS_SELF_SIGNED`, serve an **additional cleartext** listener here for browser extensions (which cannot pin). Trusted LAN only. |
| `HTTP_ALLOW_PUBLIC` | `0` | Let that cleartext port serve clients outside private ranges. Leave off unless the guard is refusing machines you trust (see below). |
| `PUBLIC_RELAY_URL` | `http://localhost:$PORT` | **Your public https origin.** Embedded in pairing links/QRs — must be externally reachable. |
| `PUBLIC_BROWSER_RELAY_URL` | derived | Browser-safe route advertised in copied links. With self-signed TLS + `HTTP_PORT`, defaults to `http://<PUBLIC_RELAY_URL host>:<HTTP_PORT>`; otherwise it is the same as `PUBLIC_RELAY_URL`. |
| `TRUST_PROXY` | `0` | Set `1` behind a reverse proxy so rate limits key on the real client IP (via `X-Forwarded-For`). |
| `DATABASE_URL` | `sqlite:./.data/tabsend.db` | SQLite path or `postgres://…`. |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | auto-generated | Optional complete override for an existing/externally managed Web Push identity. Set both or neither. |
| `VAPID_SUBJECT` | `mailto:dev@tabsend.local` | Web Push operator contact (`mailto:` or `https:`). Changing it does not rotate the stored keypair. |
| `MESSAGE_TTL_DAYS` | `7` | Queued messages expire after this; expired ciphertext is purged and never delivered. |
| `HISTORY_RETENTION_DAYS` | `30` | How far back the group history screens reach (ADR-0028). The relay keeps one encrypted blob per send for this long, sealed to a group key it does not hold, plus the delivery state it already knew. This is the one thing it retains on purpose rather than deleting on acknowledgement, so it is also what grows the database and its backups: a few hundred bytes per send. `0` switches history off — the relay still accepts blobs, so no client starts failing, it just serves nothing and drops them on the normal schedule. |
| `MAX_BODY_BYTES` | `1048576` | Request body cap (abuse guard). |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_SECONDS` | `30` / `600` | Per-IP limit on the auth-free route (register). `0` disables. Refused calls get `rate_limited` (429) and a `Retry-After`. The counts are kept in the relay database rather than in memory (ADR-0030), so two relay processes sharing one database share one budget instead of getting one each. |
| `CAP_ENDPOINTS` | `0` (unlimited) | Devices allowed in one group. A join past it is refused with a message naming the number, and the pairing link is left unused so it still works once a device is removed. |
| `CAP_QUEUED_MESSAGES` / `CAP_QUEUED_BYTES` | `0` / `0` (unlimited) | Tabs a group may have waiting for delivery at once, and how much the relay stores of them. Only tabs still waiting count toward the first, so reading one on the target device frees its slot. The size limit also counts the group's history copies (`HISTORY_RETENTION_DAYS`), because those outlive delivery and would otherwise be stored without any limit at all; that space comes back when a copy passes out of the history window. Refusals are per tab, so sending five when there is room for three sends three and reports it. |
| `CAP_SENDS_PER_WINDOW` / `CAP_SEND_WINDOW_SECONDS` | `0` / `60` | Tabs one group may send per window, across all its devices. Each new copy of the group's history key a device hands to another counts as one too. Clears itself when the window rolls over, so it bounds bursts rather than totals. History key copies are bounded without it as well: at most 64 for any one device, and at most 4096 bytes each. |
| `PAIRING_CODES_MAX_LIVE` | `20` | Pairing links one group may have waiting at once (minted, not yet used, not yet expired). Unlike the caps above this is on by default, because it bounds a table rather than a plan: a link is made to hand to a device in front of you and it expires in ten minutes, so nothing normal comes near 20. Past it, minting is refused with a message saying how long to wait. `0` disables; anything other than a whole number of 0 or more stops the relay at startup. Used and expired links are deleted by the sweeper once they are past expiry by `SWEEP_GRACE_SECONDS`. |
| `PUSH_DEAD_THRESHOLD` | `3` | Consecutive 404/410s before a push subscription is treated as dead. |
| `PUSH_ALLOW_PRIVATE_ENDPOINTS` | `0` | Permit private/local Web Push destinations. Only for a trusted self-hosted UnifiedPush distributor; never enable on a hosted relay. |
| `STREAM_MAX_FRAME_BYTES` | `16384` | Maximum WebSocket frame. Stream frames are only hello/ping JSON. |
| `STREAM_HELLO_TIMEOUT_SECONDS` / `STREAM_IDLE_TIMEOUT_SECONDS` | `10` / `90` | Authentication deadline and authenticated idle timeout. |
| `STREAM_MAX_CONNECTIONS` / `STREAM_MAX_CONNECTIONS_PER_ENDPOINT` / `STREAM_MAX_CONNECTIONS_PER_GROUP` | `1000` / `5` / `100` | Per-process, per-endpoint and per-group live WebSocket caps. The per-group one stops a single group on a shared relay from taking every connection the process allows. A device turned away falls back to polling. |
| `BOOTSTRAP_PAIRING_TTL_MINUTES` | `1440` (24h) | How long the first-run pairing link printed at startup stays valid. Much longer than a normal device-created link (10 min) because it is read out of a boot log, possibly hours after the relay started. Only ever printed while the relay has no devices; restart to get a fresh one. Every link printed this way keeps working until the first device pairs, and then all the others stop working, so none of them can let a second device in later. |
| `GROUP_CREATION` | `single` | Who may create a group here (ADR-0029). `single` is the normal self-hosted relay: it creates its one group at startup and every device joins that with a complete pairing link, so a second create is refused. `open` lets several groups coexist and lets anyone reaching the relay start one without a link. `provisioned` also allows several groups but refuses every create over the API, even while the relay is empty — groups are set up by the operator and devices only ever join with a link. Use `provisioned` for any relay other people use: on `open`, a stranger who finds the address can start their own group on your machine. |
| `ALLOW_MULTIPLE_GROUPS` | `false` | The older name for the same setting. `1` still means `GROUP_CREATION=open` and keeps working unchanged. Set both only if they agree; a contradictory pair stops the relay at startup with an explanation instead of a guess. New deployments should use `GROUP_CREATION`. |
| `PROVISIONING_TOKEN` / `PROVISIONING_TOKEN_FILE` | — (off) | Credential for the provisioning API (ADR-0031). **Unset means those routes do not exist** — see below. Set exactly one of the two. |
| `WAKE_FORWARDER_URL` | — (off) | Address of the wake-up service that lets this relay wake a phone (ADR-0032, ADR-0034). Unset is what every relay does today: no wake; an iPhone collects its tabs the next time it is opened, and an Android phone keeps its own connection. See below. |
| `TABSEND_PROFILE` | — (off) | Set to `hosted` on a multi-tenant relay other people pay for, and the relay checks that posture at startup and refuses to start if it does not hold (ADR-0033). Unset means nothing is checked and nothing changes. See below. |

Push endpoints are untrusted input. By default the relay accepts only HTTPS URLs,
rejects obviously local destinations at registration, and uses a public-only DNS
resolver in the actual TLS connection so a DNS change cannot redirect the request to
loopback, LAN, link-local, or cloud-metadata addresses. The Web Push library does not
follow redirects. A commercial hosted deployment must additionally deny private and
metadata egress at the network boundary; application checks are defense in depth, not
the sole control. The nftables and ufw recipes for that, with a command that proves the
deny is working, are in
[`HOSTED_PROFILE.md`](HOSTED_PROFILE.md#2-egress-deny-at-the-network-layer).

### Provisioning API (hosted)

**If you run a relay for yourself, skip this.** It is off unless you switch it on, and
off means the routes are not there at all — `/admin/provisioning/…` answers the same
plain 404 as any URL the relay does not serve. Nothing about your relay changes.

It exists for the other shape: a relay running `GROUP_CREATION=provisioned`, where
groups are set up out of band and something needs to do the setting up. Six operations,
all on one group:

| Call | What it does |
|---|---|
| `POST /admin/provisioning/groups` | Creates a group. Answers its id. |
| `POST /admin/provisioning/groups/<id>/pairing` | Mints that group's **first** pairing link. Refused once any device has joined, and refused while the group is suspended. It lasts `BOOTSTRAP_PAIRING_TTL_MINUTES`; a JSON body `{"lifetimeMinutes": n}` (1 to 43200, which is 30 days) sets a longer or shorter life for this one link, for a store reviewer whose review takes days. It still works only once, for the group's first device. |
| `GET` / `PATCH /admin/provisioning/groups/<id>/caps` | Reads and sets the per-group limits (ADR-0030). Omitting a limit leaves it alone; `null` clears it back to the relay-wide default; `0` means unlimited for this group. |
| `GET /admin/provisioning/groups/<id>/usage` | Counts and sizes only: devices, tabs waiting, bytes waiting, how long the oldest has waited, how many history key copies it holds and their size, the limits and the headroom left, whether it is suspended. Never device names or a device list — that view stays on `/admin/status`, on this machine. |
| `POST /admin/provisioning/groups/<id>/suspend` and `/resume` | Stops the group **accepting** work: no sends, no joins, no new pairing links, and each refusal says why. Everything else keeps working — devices stay paired, tabs already waiting still arrive, and nothing is deleted. |
| `DELETE /admin/provisioning/groups/<id>` | Deletes the group and everything it owns: devices and their tokens, queued tabs, history blobs, group keys, pairing links, tombstones, counters. Safe to run again; deleting a group that is already gone succeeds. |

**Two conditions, both required.** The call must come from this machine, dialled
directly at the relay rather than forwarded by a reverse proxy, **and** carry the
credential as `Authorization: Bearer <credential>`. Being on the machine is not enough
by itself: that says where a caller is, not who it is, and it cannot tell your own
software apart from anything else running there — including the relay being tricked
into fetching a URL. If either condition fails the answer is an ordinary 404 and a
warning in the relay log saying which one it was, so nothing scanning the relay can
learn the routes are here.

Generate a credential:

```bash
openssl rand -base64 32
```

Then give it to the relay **one** of two ways, never both. Either put the value it
printed in `server/.env` as `PROVISIONING_TOKEN`, or write it to a file readable only by
the user the relay runs as and set `PROVISIONING_TOKEN_FILE` to that file's path — the
shape a secret manager usually hands you, and the one to prefer, since an environment
variable is visible to anything that can read the process. A trailing newline in the
file is fine.

A credential shorter than 16 characters, or set-but-empty, stops the relay at startup
rather than leaving you with an API you believe is protected and is not. When it is
working, the relay says so once in its startup log.

Under Docker the same locality rule applies as for `/admin/status`: with bridge
networking a call from the host arrives from the docker gateway, not from loopback, so
the caller has to be inside the container's network namespace.

Every call writes one line to the relay log — which operation, which group, the outcome,
and your own `Idempotency-Key` or `X-Request-Id` if you send one, so you can line the
relay's line up with your own record. Pairing links and credentials are never written
there. That log is a **mirror**, not the record: keep your own authoritative one, off
this machine, because anything that compromises the relay can rewrite the relay's copy.

### Deployment profile (`TABSEND_PROFILE`)

**If you run a relay for yourself, skip this too.** Unset is the default and means nothing
is checked, nothing is warned about, and the relay behaves exactly as it always has.

It is for the other shape again: a relay other people pay to use. Setting
`TABSEND_PROFILE=hosted` does not switch anything on. It is a **claim about the deployment**,
and the relay checks the claim at startup and **refuses to start** if the settings do not
match — no private push endpoints, `GROUP_CREATION=provisioned` with a provisioning
credential, Postgres, no self-signed TLS, `TRUST_PROXY=1`, a rate limit, a running sweeper,
and an explicit https `PUBLIC_RELAY_URL`. Everything wrong is listed at once, each with the
variable to change and what to change it to, so one restart clears the lot.

Refusing rather than warning is deliberate (ADR-0033). Every other misconfiguration here is a
warning, because a self-hosted relay half-working beats it not working at all. A relay people
pay for inverts that: quietly running in a weaker posture than its operator believes is worse
than not running.

What it cannot check is the larger half — the network firewall denying private and
cloud-metadata egress, the separate system users, the per-service database grants, and where
the secrets came from. No process inside the relay can see any of that, and a check that
passed because it could not look would read as an assurance.
**[`HOSTED_PROFILE.md`](HOSTED_PROFILE.md)** is that checklist, with a verification command
for every line.

### Waking phones (`WAKE_FORWARDER_URL`)

**If nobody sends tabs to a phone, skip this.** It is off unless you switch it on, and
off is what every relay does today: no wake; an iPhone collects its tabs the next time
somebody opens the app, and an Android phone keeps its own connection open, behind the
permanent notification Android requires for that. Browsers are not affected either way.

**It changes Android phones too, not only iPhones.** An Android build with Google push
(ADR-0034; none ships yet) checks for this setting. When it is on, the phone signs up
with the wake-up service, closes its own connection and drops the permanent
notification, unless its user chose "Don't use Google". The phone signs up with the
forwarder built into the app, so this setting has to point at that same forwarder: if it
points at another one, that phone is never rung. It gets its tabs when it checks in,
every few minutes, or when it is opened. Once a second tab has arrived that no wake
announced, it goes back to its own connection (on Android 12 and later, from the next
time Tabsend is opened) and says on screen that wake-ups stopped arriving (`PLANS.md`
P-9).

iOS freezes an app the moment it goes to the background, so the only way to wake one is
Apple's push service — and Apple takes instructions only from a key it issues to a paid
developer account. That key cannot be handed to self-hosters: it is not per-user, and
anyone holding it could notify every Tabsend user. Android can stay connected, but only
behind a permanent notification, and Google's push service, the way around that, likewise
takes instructions only from the app maker's credential. So your relay cannot ring a phone
by itself, however well you configure it. It asks a small separate service to ring it,
and the phone then fetches from **your** relay, which is where your tabs were all along.

**What that service learns, stated plainly, because running any doorbell means somebody
can hear it ring:**

> The forwarder learns that a device received something, and when. Never what.

Not the tab, not the URL, not the title, not who sent it, not your name or email. There
is no account there to attach any of it to, and no field in the request for it to travel
in: the call carries a token meaning "ring that phone" and nothing else, and the push
Apple or Google delivers is empty. It does see the network address of the relay that
rings it, as any web service sees its callers, and a phone's address when the phone signs
up; it holds those in memory for its rate limits, at most two minutes after the last call
(twenty for sign-ups), and never writes them to its log or its database. Apple or Google
sees each ring as well, never what it is for. The
[forwarder's own README](../forwarder/README.md) is the field-by-field version.

**Two ways to have one, and today only one of them exists.** The project does not run a
forwarder yet: nothing is deployed, no address is baked into either phone app, and there
is none to point at. So for now the only way to have one is to **run your own**, which
needs an Apple developer account for iPhones, and for Android your own Firebase project
and your own build of the app — that is why the forwarder's source is published, and
`forwarder/README.md` has the setup. If the project ever runs a public instance it will
be the same service called the same way, and its address will be published here; a hosted
Tabsend relay gets no private key and no shortcut path either way.

Set `WAKE_FORWARDER_URL` to the base address of the forwarder you are running — its
origin, no path and no query string; the relay adds the route itself. Three things about
this setting are worth knowing before you use it:

- **It is yours, not your devices'.** The relay only ever calls the address written
  here. A phone hands it a wake token and never a URL, so nothing that registers with
  your relay can point its outbound calls anywhere.
- **A wake never affects a send, and never slows one down.** If the service is slow,
  refuses the call, or is simply gone, the tab is still accepted and still queued, and
  the phone gets it on open. Nothing is lost and nobody sees an error. The relay rings
  the doorbell and moves on without waiting for an answer, so a forwarder that has
  stopped responding costs your sends nothing at all.
- **A relay without this setting refuses to register a phone on the wake path**, with
  a message saying so, rather than accepting it and never ringing. Both phone apps check
  `GET /v1/config` first and stay on their fallback instead (an iPhone collects its tabs
  on open, an Android phone keeps its own connection), so in practice this refusal is a
  diagnostic rather than something a user meets.
- **Point it at a forwarder and nothing else.** A wake forwarder answers `202` and
  nothing else answers `202`, so the relay treats every other status as a failed ring,
  including a friendly `200` or `204`. That is on purpose: an address that turns out to
  be a health page or an unrelated service would otherwise look like a working doorbell
  in the log while no phone ever rang.
- **Use `https` unless the forwarder is on this machine.** The relay sends the phone's
  wake token in an `Authorization` header on every ring, so plain `http` to another host
  puts that credential on the wire in the clear. `http://127.0.0.1:8788` (the forwarder's
  default port) is fine, because there is no wire. A relay running `TABSEND_PROFILE=hosted`
  refuses to start otherwise.
- **A redirect counts as a failed ring.** The relay does not follow one, because a `202`
  from wherever it leads would read as a wake that never happened.
- **Each phone is rung once per send**, however many tabs the send carries, and not at all
  while its app is open and connected: the open connection already delivered the tab, and
  the forwarder allows a phone only a few rings a minute. The forwarder also limits each
  calling relay (`CALLER_RATE_LIMIT_MAX`, 120 a minute by default); a relay serving many
  phones, Android phones included, should be given a higher limit there.

## Database: SQLite vs Postgres

Both dialects run the **same migrations and queries** (ISO-8601 text timestamps, integer
booleans) — pick by `DATABASE_URL`.

- **SQLite** (`sqlite:/path/to/tabsend.db` or a bare path): zero-dependency, perfect for a
  single small relay. The file (plus its `-wal`/`-shm` siblings) is the entire state.
- **Postgres** (`postgres://user:pass@host:5432/db`): use for larger installs or if you
  already run Postgres. Create the database once; the relay migrates the schema itself.

Switching dialects is a data migration (no built-in export/import) — decide up front.

## HTTPS is mandatory (Caddy example)

**Web Push only works over HTTPS.** Browsers refuse to create a push subscription on an
insecure origin, so a plain-http relay can pair and poll but never push-wake. Terminate TLS
with a reverse proxy and point `PUBLIC_RELAY_URL` at the https origin.

[Caddy](https://caddyserver.com) gets you automatic Let's Encrypt certificates:

```caddy
# /etc/caddy/Caddyfile
relay.example.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:8787
}
```

Caddy proxies both the REST API and the `/v1/stream` WebSocket (it upgrades transparently).
Then set `PUBLIC_RELAY_URL=https://relay.example.com` and `TRUST_PROXY=1` in the relay's
environment. (An nginx equivalent needs `proxy_set_header Upgrade`/`Connection` for the WS.)

## No domain? Self-signed TLS for phones on your LAN

If the relay only needs to serve **your own devices on your own network**, you don't need a
domain or a CA certificate. Set:

```bash
TLS_SELF_SIGNED=1
```

On first boot the relay generates a long-lived self-signed certificate (kept in
`./.data/tls/`, reused forever after) and serves HTTPS directly — no proxy. The
certificate's key fingerprint is embedded in every pairing QR/link, and the Android app
**pins** it: the phone accepts that one certificate and only that one, the same
trust-on-first-use model as an SSH fingerprint. No CA involved, and stricter than normal
HTTPS in exchange.

To make the relay reachable from the phone, also bind beyond loopback (`HOST=0.0.0.0`) and
open those ports in the host firewall — nothing does that for you. When `PUBLIC_RELAY_URL`
is unset in this mode, the relay defaults it to `https://<your-LAN-IP>:<port>` so the pairing
QR carries an address the phone can reach. Extra names/IPs for the certificate go in
`TLS_EXTRA_SANS` (comma-separated) — name every address you might serve on, since the
certificate is minted once and adding a SAN later invalidates every device's pin.

Machines usually have several addresses (Docker bridges, VMs, mesh VPNs), so the relay ranks
them — real NIC on an RFC1918 network first, mesh VPN next, `docker0`/`virbr0`-style bridges
last — and **logs which it chose and what it passed over**. Check that line before pairing,
and set `PUBLIC_RELAY_URL` yourself if the guess is wrong.

### Browsers can't pin, so add a cleartext listener for them

Pinning is an Android-app capability. A **browser extension cannot pin a certificate** —
it has no access to the TLS handshake — so it cannot talk to a self-signed relay at all,
and there is no interstitial to click through because the requests come from a service
worker with no UI. That would leave the phone working and the browser locked out.

`HTTP_PORT` fixes it by giving the same relay a second, plain-HTTP listener:

```bash
TLS_SELF_SIGNED=1
PORT=8787        # https — the phone, pinned
HTTP_PORT=8786   # http  — the browser extension
```

Copied pairing links now use `http://<LAN-IP>:8786`; pairing QR codes use the pinned HTTPS
address for phones. Each form carries the other route as a client-readable hint, so pasting
the QR link into an extension or the copied browser link into a phone app is corrected
automatically. Older links using the documented `8787`/`8786` defaults are corrected by the
clients as a compatibility fallback. Custom ports are advertised by the relay rather than
guessed; set `PUBLIC_BROWSER_RELAY_URL` only if automatic same-host derivation is wrong.

It is **one relay**, not two: both listeners share the database and the
live-socket registry, so a tab sent from the browser wakes the
phone's socket instantly rather than waiting for a poll. Rate limits and per-group
limits are shared through the database itself (ADR-0030), so they hold whichever door
a request arrives at. The copy/QR distinction disappears
on a domain deployment because the same CA-trusted HTTPS URL works everywhere.

**What the cleartext port costs you.** Device tokens travel it unencrypted, so anyone on
the network can read one and impersonate that browser to the relay. They cannot read your
tabs — contents are end-to-end encrypted and the relay never holds plaintext — but the
stolen browser credential can act as that endpoint: send, list device metadata, mint a new
pairing link, rename/remove group endpoints, and read ciphertext addressed to the stolen
endpoint. Prefer the domain deployment below if the browser needs to reach the relay from
outside the house.

**It refuses public clients by default.** Nothing about a listener confines it to a LAN —
it binds every interface exactly like the https one, and would serve the open internet if a
router forwarded it. The realistic accident is forwarding a *range* of ports so the phone
can reach the https port, and dragging this one along without noticing. Leaked tokens
cannot be un-leaked, so the cleartext listener rejects any client whose address is not
private (`403 forbidden`), covering both REST and the WebSocket upgrade:

- **allowed** — `127.x`, `10.x`, `192.168.x`, `172.16–31.x`, `169.254.x`, `100.64–127.x`
  (the range mesh VPNs such as Tailscale hand out), and IPv6 loopback, link-local
  (`fe80::/10`) and unique-local (`fc00::/7`).
- **refused** — everything else, including an IPv4-mapped public address.

The check reads the **socket's** peer address, never `X-Forwarded-For` — that header is
written by the client, so a guard trusting it could be walked through by anyone claiming to
be `192.168.1.5`.

This is a seatbelt, **not encryption**: someone already on your LAN can still read a token
off the wire. And it can misfire in one case — networks that give every device a globally
routable address (common with IPv6) will look "public" to it, so a laptop beside the relay
could be refused. Pairing against a literal `192.168.x.x` URL keeps the connection on IPv4
and avoids that. `HTTP_ALLOW_PUBLIC=1` disables the guard if you need it gone; the startup
log then says so in plain terms.

### LAN, Tailscale, and domain reachability

Tabsend endpoints do not connect directly to one another. Each one independently connects
outbound to the same relay using the route stored when it paired. That means a browser using
the LAN route and a phone using the Tailscale route can still exchange tabs: the relay id,
database, and group are the same even though the addresses differ.

The pairing route is **not permanent**, but each client has one active route at a time:

- A device paired through `192.168.x.x` needs access to that LAN until its relay address is
  changed. It will not automatically discover or fail over to Tailscale.
- A device paired through `100.x.x.x` needs Tailscale running until its relay address is
  changed. The cleartext listener's private-client guard accepts Tailscale's `100.64/10`
  range; Tailscale itself encrypts that network path.
- In the extension's Connection settings or the phone's **Move to another relay…** flow,
  enter the other address. The client verifies the stable `relayId` and its existing token,
  then changes only the saved route. Devices stay paired and queued messages stay intact.
- A domain with CA-trusted HTTPS is the only one-route setup that works cleanly for browsers
  and phones both on and away from the home network. Tailscale is the practical no-domain
  alternative, but every device using a Tailscale route must be connected to the tailnet.

Automatic LAN-first/Tailscale-second failover is not implemented. Supporting that safely
requires clients to store and verify multiple routes, decide precedence, and avoid silently
falling onto an attacker-controlled relay. The stable relay id is already the foundation for
that future work.

### Other limits of self-signed mode

- **Deleting the TLS directory mints a new certificate**, which invalidates the pin on
  every paired phone — those phones must re-pair. Back it up with the database.
- **Web Push should be unaffected**, contrary to what this guide previously said. The
  extension subscribes through the browser's own push service and the relay only needs
  outbound HTTPS to reach that service, so the relay's own certificate does not enter
  into it. This reasoning has not been confirmed against a live browser — treat it as
  expected-but-untested, and note the Android app does not use Web Push (ADR-0015; its
  optional Google push goes through the wake-up forwarder instead, ADR-0034).

## Running as a service (systemd)

For a bare-Node deployment, a unit that sources the env file and runs the relay:

```ini
# /etc/systemd/system/tabsend-relay.service
[Unit]
Description=Tabsend relay
After=network.target
# If using local Postgres: After=network.target postgresql.service

[Service]
Type=simple
User=tabsend
Group=tabsend
WorkingDirectory=/opt/tabsend
EnvironmentFile=/opt/tabsend/server/.env
# The globally installed pnpm; adjust the path to your Node install if needed.
ExecStart=/usr/bin/pnpm --filter @tabsend/server start
Restart=on-failure
RestartSec=3
# Hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/tabsend/server/.data
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo useradd --system --home-dir /opt/tabsend --shell /usr/sbin/nologin tabsend
sudo chown -R tabsend:tabsend /opt/tabsend
sudo systemctl daemon-reload
sudo systemctl enable --now tabsend-relay
journalctl -u tabsend-relay -f
```

(`ReadWritePaths` is only needed for the SQLite data dir; drop it for Postgres.)

## Docker & docker-compose

A multi-stage, **non-root** [`Dockerfile`](../Dockerfile) builds the relay. There are two
compose files, for the two deployments:

| File | For | Shape |
| --- | --- | --- |
| [`docker-compose.lan.yml`](../docker-compose.lan.yml) | A spare machine, no domain | One container, SQLite, self-signed HTTPS + a cleartext port for browsers |
| [`docker-compose.domain.yml`](../docker-compose.domain.yml) | A domain you control — **recommended** | Relay + Postgres + Caddy, real Let's Encrypt certificates via DNS challenge |
| [`docker-compose.yml`](../docker-compose.yml) | Bring-your-own proxy | Relay + Postgres bound to loopback; you supply the TLS front end |

**Which to pick.** If you own a domain — a subdomain of one you already have is fine —
use `docker-compose.domain.yml`. It is the only shape where every browser on every machine
trusts the relay with nothing installed anywhere, and it is the same arrangement a hosted
service would use. Use `docker-compose.lan.yml` when you have no domain and accept that
browsers reach the relay in cleartext on a network you trust.

### A domain you control (recommended)

```bash
git clone <your-fork> tabsend && cd tabsend
cp server/.env.example .env
# add to .env: RELAY_DOMAIN, ACME_EMAIL, CF_API_TOKEN, POSTGRES_PASSWORD
docker compose -f docker-compose.domain.yml up -d --build --wait
```

Point `relay.example.com` at the machine — a LAN address for LAN-only use, a public
address to reach it while away. Caddy obtains the certificate through your **DNS
provider's API** rather than an inbound connection, which is what lets this work with no
ports open and even when the record points at a private IP. That does mean stock Caddy
isn't enough: [`Dockerfile.caddy`](../Dockerfile.caddy) builds it with the Cloudflare DNS
plugin, and using another provider means swapping that plugin and the matching credential
in [`Caddyfile.domain`](../Caddyfile.domain).

Nothing is installed on the phone or the laptop under this deployment — they see ordinary
HTTPS. No pin, no cleartext port, and Web Push works.

### A spare machine with no domain

```bash
git clone <your-fork> tabsend && cd tabsend
docker compose -f docker-compose.lan.yml up -d --build --wait
docker compose -f docker-compose.lan.yml logs -f    # prints the pairing URL + pin
```

Note the `--wait`. Plain `up -d` returns once the container has been *created*, not once
the relay is answering, so anything that immediately probes the relay — a curl, a health
script, the next line of your deploy — can hit a connection refused on a deployment that
is in fact fine. `--wait` holds until the container's healthcheck passes (a few seconds),
and it exits non-zero if the relay never becomes healthy, which is the behaviour you want
in a script. `--wait-timeout 120` puts a ceiling on it.

The container uses `network_mode: host`, so the relay reads the machine's real LAN
interfaces and derives both the certificate SANs and `PUBLIC_RELAY_URL`
(`https://<LAN-IP>:8787`) from them. Under Docker's default bridge network it would see
only an internal `172.x` address and hand phones an unroutable pairing URL — which is why
this file is **Linux-only** (host networking does not work the same way on Docker Desktop
for macOS/Windows; there, set `PUBLIC_RELAY_URL` and `TLS_EXTRA_SANS` to the LAN IP by hand
and publish `8787:8787` instead).

Two things still need your attention on a real machine: **which address it advertises**, and
**the host firewall**. Both are covered below.

#### Check the address in the log

Host networking means the relay sees *every* interface, including the ones Docker itself
created — `docker0`, plus a `br-<hash>` for every compose project on the box. Those carry
perfectly routable-looking `172.x` addresses that nothing off the machine can reach. The
relay ranks the candidates (a real NIC on an RFC1918 network wins; mesh-VPN addresses like
Tailscale's `100.64/10` come next; Docker and libvirt bridges rank last) and logs the choice
plus everything it passed over:

```
This host has several LAN addresses; pairing links will advertise the one ranked best.
  chosen: "192.168.1.20 (enp3s0)"  passedOver: ["100.x.x.x (tailscale0)", "172.17.0.1 (docker0)"]
```

Read that line before pairing anything. If the chosen address is wrong — several real NICs,
or a VLAN the phone can't see — set `PUBLIC_RELAY_URL` explicitly and restart:

```bash
echo 'PUBLIC_RELAY_URL=https://192.168.1.20:8787' >> .env && docker compose -f docker-compose.lan.yml up -d --wait
```

Compose reads `.env` from the project directory. This does **not** touch the certificate, so
nothing needs re-pairing.

If the machine later moves to an address the certificate was never minted with, boot warns
that clients are being sent somewhere the cert does not cover — they would fail the
handshake. The fix is `TLS_EXTRA_SANS` **plus** a new certificate, and a new certificate
means every paired device must re-pair. Cheaper to name every address you might use in
`TLS_EXTRA_SANS` on day one.

#### `docker compose ps` shows no ports — that is correct here

Under `network_mode: host` the container has no port mappings to report, so the PORTS
column comes up empty even while the relay is serving on 8787 and 8786. Do not read that
as a failure to start; check the health column, or ask the relay directly:

```bash
curl -fsS http://127.0.0.1:8786/v1/config
```

#### Open the firewall

Host networking publishes no ports, so **Docker does not open the firewall for you** — a
distro with one enabled (Fedora, RHEL, and Ubuntu with `ufw` on) leaves the relay healthy,
reachable from the machine itself, and invisible to every other device. It looks exactly
like a broken relay.

```bash
sudo firewall-cmd --permanent --add-port=8787/tcp --add-port=8786/tcp && sudo firewall-cmd --reload
```

```bash
sudo ufw allow 8787/tcp && sudo ufw allow 8786/tcp
```

Drop the `8786` half if you commented `HTTP_PORT` out. If the machine is on a mesh VPN, check
whether its interface sits in a separate firewall zone that needs the same ports.

#### Pair

Use the **phone/QR** link from the log for the app (it carries the pin) and the default
copied link for a **browser extension** (`http://<LAN-IP>:8786`) — see
[Browsers can't pin](#browsers-cant-pin-so-add-a-cleartext-listener-for-them) for why the
browser needs it and what it costs. Comment `HTTP_PORT` out of the compose file to disable
it. Because that port is cleartext, the browser side of this deployment is LAN-only; the
phone can use pinned HTTPS over a forwarded port, but only when the advertised address is
actually reachable from outside. See [LAN, Tailscale, and domain reachability](#lan-tailscale-and-domain-reachability).

The SQLite database (including the stable VAPID keypair) and TLS keypair share the
`relay-data` volume. Back them up together — losing the database loses pairings and
invalidates browser push subscriptions; losing the TLS keypair breaks the pin on every
paired phone.

### Bring your own proxy

```bash
# Build just the relay image:
docker build -t tabsend-relay .
docker run -d --name tabsend-relay -p 127.0.0.1:8787:8787 \
  -v tabsend-data:/data \
  -e PUBLIC_RELAY_URL=https://relay.example.com -e TRUST_PROXY=1 \
  -e VAPID_SUBJECT=mailto:you@example.com \
  tabsend-relay

# Or the full stack (relay + Postgres):
cp server/.env.example .env      # fill in POSTGRES_PASSWORD + PUBLIC_RELAY_URL
docker compose up -d --build
```

The image defaults to SQLite at `/data/tabsend.db` and TLS material at `/data/tls` (mount a
volume at `/data`); `docker-compose.yml` overrides `DATABASE_URL` to the Postgres service. A
`HEALTHCHECK` polls `/v1/config`, over https when `TLS_SELF_SIGNED` is on. Still front this
deployment with Caddy for TLS — compose binds the relay to `127.0.0.1` for that reason.

> **Build note (verification performed):** Docker was not available in the environment that
> authored this, so the image was **not** built in CI here. The `CMD` runtime path *was*
> verified locally — the relay boots and serves `GET /v1/config` via
> `server/node_modules/.bin/tsx server/src/server.ts` (exactly what the container runs),
> including in `TLS_SELF_SIGNED` mode: HTTPS on the LAN address, correct SANs, the
> healthcheck command exiting 0, and the same SPKI fingerprint across restarts.
> The base image must satisfy `engines.node >= 26`; the build stage installs `python3/make/g++`
> in case `better-sqlite3` has no prebuilt for the Node ABI. If you build it, watch that
> first native-compile step.

## Backups

State to back up is the **database**. It contains ciphertext/routing state, pairings, relay
identity, and the VAPID private key used only to authenticate Web Push wakes. It never
contains decrypted URLs or device end-to-end encryption private keys:

- **SQLite:** back up the DB file **and** its `-wal`/`-shm` siblings together, or take a
  consistent snapshot with `sqlite3 tabsend.db ".backup '/backup/tabsend-$(date +%F).db'"`
  (safe while the relay runs). Restoring is a file copy while the relay is stopped.
- **Postgres:** `pg_dump` on a schedule, e.g.
  `pg_dump "$DATABASE_URL" | gzip > /backup/tabsend-$(date +%F).sql.gz`; restore with
  `psql`. With compose, run it inside the `db` service.

**Losing the database means losing the groups.** There is no recovery phrase or escape
hatch to restore one (ADR-0021), and no client holds a copy — the relay's database is the
only record of who is in which group. Devices are not bricked: they re-pair into a fresh
group in minutes. But queued messages and history are gone, so keep backups.

### Starting over after losing every device

If every paired device is gone, the old group cannot mint a new pairing link. Merely restarting
the relay does not help: the occupied group is still in its database. Use this recoverable reset:

1. Stop the relay and make a final backup of the database and TLS directory or Docker data
   volume. Do not destroy the old state; it may still be useful if a device is recovered.
2. Configure the relay to use a **new, empty database**. For SQLite, use a new file path. For
   Postgres, use a new empty database. For the LAN Compose deployment, attach a new named data
   volume while retaining the old volume as the backup.
3. Start the relay. It creates a fresh default group and prints a new first-run pairing link.
4. Pair the replacement devices and confirm send/receive before deciding whether to retire the
   preserved old state.

This resets group membership, queued ciphertext, message history, relay identity and stored
VAPID identity. Reusing the existing TLS directory keeps native certificate pins stable where
the deployment separates TLS material from the database; replacing an entire combined Docker
volume also creates a new TLS identity, so every native client must trust the new pairing link.

## Known limitation: single-instance WS fan-out

**The relay is single-instance for the WebSocket fast path.** Live `message`/`presence`/
`acked` events are fanned out from an **in-process** hub (`server/src/hub.ts`), so running two
relay processes behind a load balancer would mean a socket connected to instance A never
receives events originating on instance B.

This is a **latency-only** concern, not a correctness one: the durable queue + Web Push +
the client's 30-second poll deliver every message regardless of the socket (ADR-0001). A
second instance would still deliver everything — just without the sub-second live path for
cross-instance events. For horizontal scale the hub would move to Postgres `LISTEN/NOTIFY`
or Redis pub/sub; until then, **run one relay instance** (vertical scale is plenty for a
personal/small-group relay). Postgres as the database is fine and encouraged — the
single-instance limit is about the *WebSocket hub*, not the store.

## Serving the web console

The console (`console/`) is an optional static SPA that pairs in as a `kind:'console'`
endpoint. Build it (`pnpm --filter @tabsend/console build` → `console/dist`) and serve it
**same-origin** with the relay behind your proxy (`/` → the static files, `/v1` → the relay)
so its API calls stay same-origin (the relay has no CORS). See `docs/reports/chunk-5b.md`.
