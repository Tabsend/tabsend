import type { Config } from './config'
import { isPostgresUrl } from './db'
import { isLoopbackAddress } from './netguard'

/**
 * The hosted deployment posture, checked at boot [0033] (HOSTED_PLAN §4.5 and §7,
 * HOSTED_SECURITY_PLAN's control-plane gates, `docs/HOSTED_PROFILE.md`).
 *
 * WHAT THIS IS. `TABSEND_PROFILE=hosted` is a claim: "this relay is the multi-tenant
 * one strangers pay for." Everything below is a setting that claim implies, checked
 * once, before the relay opens a socket or touches a database. Unset means no claim,
 * nothing checked, and byte-for-byte the relay every self-hoster already runs.
 *
 * WHAT THIS IS NOT. It configures nothing. The half of §4.5 that matters most is the
 * NETWORK-layer egress deny for private and metadata ranges, and no process inside the
 * relay can install it, and none can honestly verify it either: a relay that could
 * prove its own egress was blocked would have to make the very calls the rule forbids.
 * Same for separate system users, per-service database users, and secrets in a managed
 * store. Those are `docs/HOSTED_PROFILE.md`'s checklist, verified from outside by an
 * operator. This module covers exactly the part a config bag can answer for.
 *
 * WHY REFUSING TO BOOT. Every other misconfiguration warning in this relay is a warning
 * because a self-hoster's relay half-working beats their relay not working. A paid
 * multi-tenant relay inverts that: silently degrading is taking money for nothing
 * (HOSTED_PLAN §8), and the operator who set `TABSEND_PROFILE=hosted` asked to be told.
 * A refusal at boot is also the one moment the fix is cheap, before anybody has paired.
 *
 * EVERY RULE HERE PASSED ONE TEST: would it ever be wrong for a LEGITIMATE hosted
 * deployment? The ones that failed it are listed at the bottom of this file, with why,
 * so a later reader does not add them back.
 */

/** One posture rule this relay does not meet, named by the variable that fixes it. */
export interface ProfileViolation {
  /** The environment variable an operator has to change. */
  setting: string
  /** What is wrong and what to do about it, in one actionable sentence. */
  problem: string
}

/**
 * Every hosted-posture rule this config breaks, in the order an operator meets them.
 *
 * Pure and total: it returns ALL violations rather than throwing on the first, because
 * a relay that reports one problem per boot costs its operator one restart per problem,
 * and the whole point of checking at boot is that the fix should be cheap.
 */
export function hostedProfileViolations(config: Config): ProfileViolation[] {
  const violations: ProfileViolation[] = []

  // Named verbatim by HOSTED_SECURITY_PLAN ("forbidden in hosted configuration") and by
  // §4.5. Web Push endpoints arrive in an UNAUTHENTICATED register body from a stranger
  // (`push-egress.ts`), so this switch hands anyone who can reach the relay a lever that
  // makes it dial loopback, the LAN, or the cloud metadata service. It exists for the
  // one self-hosted case that genuinely needs it, a private UnifiedPush distributor on
  // your own network, and that case cannot exist on a relay serving other people.
  if (config.pushAllowPrivateEndpoints) {
    violations.push({
      setting: 'PUSH_ALLOW_PRIVATE_ENDPOINTS',
      problem:
        'is on, and it lets a stranger who registers a device point this relay at loopback, the LAN, or a cloud metadata address. Remove it, or set it to 0. It exists for a self-hosted relay reaching its own UnifiedPush distributor, never for a relay other people use.',
    })
  }

  // HOSTED_PLAN §4.1: "Hosted runs `provisioned`." `open` is the setting that lets
  // anyone who finds the address mint a tenancy past signup, billing, caps and the
  // account mapping; `single` cannot host tenants at all. Neither is a hosted relay.
  if (config.groupCreation !== 'provisioned') {
    violations.push({
      setting: 'GROUP_CREATION',
      problem: `is "${config.groupCreation}" and a hosted relay needs "provisioned". On "open" anyone who finds this address can start their own group here, past signup and billing; on "single" the relay holds one group and cannot host tenants at all. Set GROUP_CREATION=provisioned.`,
    })
  }

  // The other half of `provisioned`: with no credential the provisioning routes are not
  // registered AT ALL [0031], so nothing can create a group, and the public create path
  // always refuses. That combination is a relay on which no tenancy can ever come into
  // being. It boots, it answers, it sells nothing. Presence only here; the credential's
  // length and emptiness are already boot errors in `loadConfig`.
  if (!config.provisioningToken && !config.provisioningTokenFile) {
    violations.push({
      setting: 'PROVISIONING_TOKEN_FILE',
      problem:
        'is not set, and neither is PROVISIONING_TOKEN, so the provisioning API is not registered and nothing can create a group on a GROUP_CREATION=provisioned relay. Generate a credential with: openssl rand -base64 32. Write it to a file your secret store mounts, then point PROVISIONING_TOKEN_FILE at that file.',
    })
  }

  // HOSTED_PLAN §7 puts the relay and the control plane on one machine with "its own
  // Postgres database and database user with no grants on the other's", and §8's backup
  // and restore drills are pg_dump ones. SQLite cannot express that boundary: it is a
  // file, and file permissions are the only grant it has. The per-group caps also take a
  // row lock on Postgres to stay exact under concurrency [0030], and the multi-instance
  // story is Postgres-only (DEPLOY.md).
  if (!isPostgresUrl(config.databaseUrl)) {
    violations.push({
      setting: 'DATABASE_URL',
      problem:
        'is not a postgres:// URL. A hosted relay needs Postgres: the relay and the control plane each get their own database and their own database user with no grants on the other, which a SQLite file cannot express, and the backup and restore drills are pg_dump ones. Set DATABASE_URL=postgres://tabsend@127.0.0.1:5432/tabsend_relay',
    })
  }

  // ADR-0019 is the SELF-HOST path: a phone trusts a relay with no domain by pinning
  // its key, because there is no CA to ask. A hosted relay has a real domain and a real
  // certificate (HOSTED_PLAN §5, DEPLOY.md's Caddy deployment), and turning this on
  // there would put a pin in every pairing link for a certificate the browsers cannot
  // use at all. Note this also settles HTTP_PORT and HTTP_ALLOW_PUBLIC: the cleartext
  // companion listener only exists alongside self-signed TLS (`loadConfig`), so with
  // this off it cannot be configured, and a rule of its own could never fire.
  if (config.tlsSelfSigned) {
    violations.push({
      setting: 'TLS_SELF_SIGNED',
      problem:
        'is on. That is the no-domain self-host path (ADR-0019), where phones pin the relay key because there is no certificate authority to ask, and browsers cannot use it at all. A hosted relay has a real domain and a real certificate in front of it. Remove it, or set it to 0.',
    })
  }

  // DEPLOY.md's domain topology, which is the hosted one: Caddy terminates TLS and
  // proxies to the relay (docker-compose.domain.yml sets TRUST_PROXY=1 for exactly this
  // reason). Without it every request looks like it came from the proxy, so the per-IP
  // register rate limit becomes ONE bucket shared by every client on the internet and
  // the first abuser spends it for everybody. Silent, and only visible as "pairing
  // stopped working for everyone at once".
  if (!config.trustProxy) {
    violations.push({
      setting: 'TRUST_PROXY',
      problem:
        'is off, and a hosted relay sits behind a TLS-terminating proxy. Without it every request appears to come from the proxy, so the per-IP register limit becomes one bucket shared by the whole internet and one abuser spends it for every customer. Set TRUST_PROXY=1.',
    })
  }

  // POST /v1/endpoints/register is the one write route that needs no device token
  // (ADR-0012), so it is the one route a stranger can drive without pairing first. On a
  // relay you run for yourself, 0 is a defensible choice. On one strangers reach it is
  // an open door, and HOSTED_SECURITY_PLAN requires the quota rather than suggesting it.
  if (config.rateLimit.max <= 0) {
    violations.push({
      setting: 'RATE_LIMIT_MAX',
      problem:
        'is 0, which switches off the only limit on the one write route that needs no device token (register). Set RATE_LIMIT_MAX=30 with RATE_LIMIT_WINDOW_SECONDS=600, or higher numbers if your signup rate needs them.',
    })
  }

  // The sweeper is the relay's one housekeeping clock: it purges expired ciphertext,
  // drops tombstones, and since [0030] ages out the quota counter rows. Off, a hosted
  // relay keeps strangers' encrypted tabs past the TTL it promised them, and grows one
  // quota row per client IP per window forever. [0030] named that second combination as
  // something that "probably should be looked at" and left it unrefused; on a relay
  // claiming the hosted posture it is refused.
  if (config.sweepIntervalMs <= 0) {
    violations.push({
      setting: 'SWEEP_INTERVAL_SECONDS',
      problem:
        'is 0, which stops the sweeper. A hosted relay would then hold expired ciphertext past the retention it promised, and accumulate one rate-limit counter row per client address per window with nothing to remove them. Set SWEEP_INTERVAL_SECONDS=60.',
    })
  }

  // Each phone's wake token is a bearer credential — one header, no binding to this
  // relay, no expiry (forwarder PROTOCOL.md §4, §6): whoever holds it can ring that
  // phone through the forwarder, from anywhere. The relay sends the target phone's
  // token on every wake, so over plain http those tokens cross the wire in the clear
  // on every ring, and a hosted relay's traffic leaves its host. ADR-0032 deliberately
  // does not put the push-egress guard on this URL, because it is operator config and
  // a self-hoster ringing their own forwarder over http on their own LAN is a
  // supported setup; hosted is the deployment where that reasoning does not hold.
  //
  // LOOPBACK IS THE EXCEPTION, and a real one: a forwarder running as another process
  // on the same host, reached at http://127.0.0.1:PORT, never puts the token on a
  // network at all. That is the one legitimate hosted http case, so it is the one this
  // allows. Presence is still not asserted (see the list at the bottom) — a hosted
  // relay that wakes no phones sets nothing here and this rule never fires.
  if (config.wakeForwarderUrl !== undefined && !wakeForwarderIsConfidential(config)) {
    violations.push({
      setting: 'WAKE_FORWARDER_URL',
      problem: `is "${config.wakeForwarderUrl}", which is plain http to another host. The relay sends each phone's wake token in a header on every ring, and anyone who holds one can ring that phone, so this puts those tokens on the wire in the clear. Use https, or run the forwarder on this same host and point at http://127.0.0.1:8788, its default port.`,
    })
  }

  // PUBLIC_RELAY_URL is what pairing links carry, so on a hosted relay it is the
  // customer-facing address (HOSTED_PLAN §5: app.tabsend.org, where the console is
  // served at the root and pairing links already point). Left at the default it
  // advertises http://localhost:PORT, which every device it is handed to will fail to
  // reach. Checked for https as well as for being set: the relay is behind a proxy, so
  // its own listener is plain HTTP and only this value carries the public scheme.
  if (!config.publicRelayUrlExplicit || !config.publicRelayUrl.startsWith('https://')) {
    violations.push({
      setting: 'PUBLIC_RELAY_URL',
      problem: `is "${config.publicRelayUrl}", and pairing links carry it to every device that joins. A hosted relay advertises its own public https origin. Set PUBLIC_RELAY_URL=https://app.tabsend.org, or whichever hostname your customers reach.`,
    })
  }

  return violations
}

/**
 * Does the wake-forwarder call keep its bearer token off the wire?
 *
 * True for https, whatever the host, and for http only to loopback — where there is no
 * wire. Parsed rather than string-matched because `loadConfig` has already reduced this
 * to an origin and a path, and the hostname is the only part that decides.
 */
function wakeForwarderIsConfidential(config: Config): boolean {
  const raw = config.wakeForwarderUrl
  if (raw === undefined) return true
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    // Unparseable never reaches here — `loadConfig` refuses it at boot — but a rule
    // that decides a posture must not answer "fine" because it could not look.
    return false
  }
  if (url.protocol === 'https:') return true
  return isLoopbackHostname(url.hostname)
}

/**
 * Is this hostname the machine itself? `localhost`, an IPv4 loopback address, or `::1`.
 *
 * A HOSTNAME, not a socket peer, which is why `netguard.isLoopbackAddress` is not
 * enough on its own: a URL may carry `localhost` or a bracketed `[::1]`, neither of
 * which is an address. Anything that resolves elsewhere — including a name an operator
 * has pointed at 127.0.0.1 in `/etc/hosts` — reads as remote, because a rule about a
 * credential on a wire must not depend on a resolver this process cannot see.
 */
function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase()
  if (host === 'localhost') return true
  // `new URL` keeps IPv6 hosts in brackets; strip them before asking netguard.
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
  return isLoopbackAddress(bare)
}

/**
 * Enforce whatever posture the config claims. Called once at boot, before the database
 * is opened and long before a socket exists.
 *
 * No profile means no check and no output, so this is a no-op for every relay that does
 * not opt in. `hosted` either passes silently or throws with every violation listed at
 * once, each naming the variable and the fix.
 */
export function assertProfile(config: Config): void {
  if (config.profile !== 'hosted') return
  const violations = hostedProfileViolations(config)
  if (violations.length === 0) return

  const lines = violations.map((v, i) => `  ${i + 1}. ${v.setting} ${v.problem}`)
  throw new Error(
    [
      'TABSEND_PROFILE=hosted claims this relay runs the hosted deployment posture. Its configuration does not. Refusing to start.',
      '',
      ...lines,
      '',
      'The full posture, including the parts no process can check for itself (network egress deny, separate system users, secrets in a managed store), is docs/HOSTED_PROFILE.md in the Tabsend repo. Unset TABSEND_PROFILE to run this as an ordinary self-hosted relay instead.',
    ].join('\n'),
  )
}

/*
 * WEIGHED AND DELIBERATELY NOT ASSERTED. Each of these is something a hosted relay
 * plausibly wants, and each fails the "would this ever be wrong for a legitimate hosted
 * deployment?" test, which is the bar for a rule that REFUSES to boot.
 *
 * - Per-group caps (CAP_*). Tempting, since §4.3 exists for hosted. But caps are a
 *   PER-GROUP number the provisioning API sets at tenancy creation [0030], and a
 *   deployment that gives every group explicit caps and leaves the relay-wide defaults
 *   at unlimited is correct. Asserting the defaults would refuse it.
 * - WAKE_FORWARDER_URL's PRESENCE. A hosted relay that wakes no phones is a hosted
 *   relay, and unset means drain-on-open, which is a complete supported delivery mode
 *   [0032]. Its SCHEME is asserted where it is set, and that is a different question:
 *   the rule above is not "you must have a forwarder", it is "if you ring one, do not
 *   put the wake token on the wire in the clear".
 * - HOST. 0.0.0.0 is right inside a container where only the proxy is published, and
 *   127.0.0.1 is right on a bare-metal host. Both are legitimate hosted deployments.
 * - VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY. Generated into the database on first boot is
 *   the recommended shape, hosted included; an explicit pair is the exception.
 * - MESSAGE_TTL_DAYS, HISTORY_RETENTION_DAYS, CAP_* windows. Product policy, not
 *   posture. A relay is not insecure for keeping tabs for three days or thirty.
 * - Anything about the network firewall, the system users, the database grants, or where
 *   the secrets came from. The relay cannot see any of it, and a check that passes
 *   because it could not look is worse than no check: it would read as an assurance.
 */
