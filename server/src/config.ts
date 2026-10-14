import { readFileSync } from 'node:fs'
import { DEFAULT_MESSAGE_TTL_DAYS, PAIRING_CODE_TTL_MINUTES } from '@tabsend/shared'

/**
 * Runtime configuration, resolved from env vars with sane dev defaults.
 * Everything here is process/deployment scoped; wire shapes live in @tabsend/shared.
 */
export interface Config {
  host: string
  port: number
  /** Raw DATABASE_URL. SQLite (`sqlite:`/`file:`/bare path/`:memory:`) is the
   *  dev/test default; a `postgres://` URL selects the Postgres dialect (Chunk 4a). */
  databaseUrl: string
  /** Base URL embedded in PairingPayload.relayUrl so a joining device finds this relay. */
  publicRelayUrl: string
  /** True when PUBLIC_RELAY_URL was set explicitly. When false AND tlsSelfSigned is on,
   *  boot (server.ts) replaces the localhost default with a LAN-reachable https URL —
   *  loadConfig stays pure, so the network-interface lookup lives in boot code. */
  publicRelayUrlExplicit: boolean
  /** Browser-safe advertised route. Usually identical to publicRelayUrl; in the
   *  self-signed dual-listener setup it points at the cleartext companion port. */
  publicBrowserRelayUrl: string
  /** True when PUBLIC_BROWSER_RELAY_URL was supplied instead of derived. */
  publicBrowserRelayUrlExplicit: boolean
  /** Serve HTTPS with a locally generated, long-lived self-signed cert (P-3). The
   *  pairing payload then carries the cert's SPKI fingerprint for clients to pin.
   *  Default off: plain HTTP behind a reverse proxy stays the recommended deploy. */
  tlsSelfSigned: boolean
  /** Directory holding the generated key.pem/cert.pem pair (tlsSelfSigned only). */
  tlsDir: string
  /** Extra SANs (hostnames/IPs) baked into the generated cert (tlsSelfSigned only). */
  tlsExtraSans: string[]
  /** Port for an ADDITIONAL plain-HTTP listener alongside the https one (tlsSelfSigned
   *  only; undefined = off). Exists for browser extensions, which cannot pin a
   *  certificate the way the Android app does and so cannot use a self-signed relay at
   *  all. Cleartext, so it is for a LAN you trust and never for the open internet:
   *  device tokens ride the wire in the clear. A relay on a real domain does not need
   *  this — see docs/DEPLOY.md. */
  httpPort?: number
  /** Let the cleartext listener serve clients OUTSIDE private network ranges. Default
   *  false: it refuses them, so a router that forwards the port by accident cannot
   *  expose device tokens to the internet. Turn on only if your own network gives
   *  devices globally routable addresses (common with IPv6) and the guard is refusing
   *  machines you trust — it does not make the port encrypted either way. */
  httpAllowPublic: boolean
  /** Message time-to-live in ms; a row's expiresAt = createdAt + this. */
  messageTtlMs: number
  /** Pairing-code lifetime in ms. */
  pairingCodeTtlMs: number
  /**
   * How many LIVE pairing codes one group may hold at once — unconsumed and
   * unexpired. `PAIRING_CODES_MAX_LIVE`, default 20; `0` switches it off.
   *
   * ON by default, unlike the per-group caps, because it is a structural bound and
   * not a product tier [0031 amended]. `POST /v1/pairing` writes a row per call, the
   * rows outlived their own expiry with nothing to remove them, and no limit anywhere
   * counted them — so one authenticated device could grow a relay's database without
   * end and without ever touching a cap. Nothing legitimate comes near 20: a link is
   * minted to hand to a device in front of you, and it expires in ten minutes. The
   * sweeper (sweep.ts) is the other half — this bounds what is live, that removes
   * what is dead.
   */
  pairingCodesMaxLive: number
  /** TTL-sweeper cadence in ms; <= 0 disables the background sweeper. */
  sweepIntervalMs: number
  /** How long past expiry a tombstone row is kept before hard-deletion (ms). */
  sweepGraceMs: number
  /**
   * How long a group's shared history stays readable, in ms [0028].
   *
   * Its own knob rather than reusing the tombstone window, because the two answer
   * different questions: the tombstone window exists so an idempotent replay
   * cannot resurrect a payload, and is therefore bounded by the TTL. This one is
   * a product decision about how far back "where did that tab go" should reach.
   * A row is kept until BOTH windows have passed, so raising this never shortens
   * tombstone protection.
   */
  historyRetentionMs: number
  /** VAPID keys for Web Push. Production boot provisions these when env omits them;
   *  absent is still supported by the pure app factory for poll-only tests/embedding. */
  vapid?: VapidConfig
  /** Max JSON request body in bytes (Fastify bodyLimit). Caps abuse; default 1 MiB. */
  bodyLimitBytes: number
  /** Maximum WebSocket frame accepted by the latency-only stream. */
  streamMaxFrameBytes: number
  /** Time allowed for a new WebSocket to authenticate with its hello frame. */
  streamHelloTimeoutMs: number
  /** Close an authenticated WebSocket that stops sending application pings. */
  streamIdleTimeoutMs: number
  /** Maximum upgraded WebSockets held by one relay process. */
  streamMaxConnections: number
  /** Maximum simultaneous WebSockets belonging to one endpoint. */
  streamMaxConnectionsPerEndpoint: number
  /**
   * Maximum simultaneous WebSockets belonging to one GROUP [0031 amended 2026-10-01].
   * The process-wide cap above is shared by every tenant on a hosted relay, so without
   * this one group could hold all of it and push everybody else onto polling. Default
   * 100, far above any household (devices times their per-endpoint allowance).
   */
  streamMaxConnectionsPerGroup: number
  /** Trust `X-Forwarded-For` (set true when behind a reverse proxy so rate limits key
   *  on the real client IP, not the proxy's). Default false. */
  trustProxy: boolean
  /** Rate limit for the UNauthenticated write route (register). */
  rateLimit: RateLimitConfig
  /** Relay-wide per-group cap defaults [0030]; a group row may override each one. */
  caps: GroupCapDefaults
  /** Consecutive 404/410 push failures before a subscription is treated as dead
   *  (wakes skipped until the client rotates a fresh one via heartbeat). Default 3. */
  pushDeadThreshold: number
  /** Permit Web Push to private/local destinations. Off by default because a
   *  client-controlled endpoint is otherwise an SSRF path. Self-hosters with a
   *  private UnifiedPush distributor may opt in deliberately. */
  pushAllowPrivateEndpoints: boolean
  /**
   * Base URL of the wake-up forwarder this relay rings for phones [0032, 0034]
   * (HOSTED_PLAN §6). `WAKE_FORWARDER_URL`, e.g. `https://wake.tabsend.io`.
   *
   * UNSET MEANS TODAY'S BEHAVIOUR, EXACTLY: no wake, drain on open, and the
   * `forwarder` push transport is refused at registration rather than accepted and
   * never rung. Every relay that exists before this option is that relay.
   *
   * OPERATOR CONFIG, NOT USER INPUT — and that distinction is the whole reason
   * `push-egress.ts` does not guard it. That guard exists because a Web Push endpoint
   * arrives in a register body from an unauthenticated stranger, so pointing it at
   * 169.254.169.254 has to be impossible. This URL is set by whoever runs the relay,
   * in the same env file as `DATABASE_URL`; anyone able to change it can already run
   * arbitrary code as the relay. Guarding it would only stop a self-hoster from
   * running their own forwarder on their own LAN, which is a supported setup.
   */
  wakeForwarderUrl?: string
  /**
   * Who may CREATE a group on this relay (`GROUP_CREATION`) [0029]. Default `single`.
   *
   * Replaces the boolean `ALLOW_MULTIPLE_GROUPS`, which conflated two questions:
   * "may several groups coexist here" and "may anyone mint one". They are the same
   * answer for a household relay and different answers for a multi-tenant one.
   */
  groupCreation: GroupCreation
  /**
   * How long the FIRST-RUN pairing link printed at boot stays valid (ADR-0023).
   * Much longer than `pairingCodeTtlMs` on purpose — that one is sized for handing a
   * link between two devices in your hands; this one is read out of a boot log,
   * possibly hours later. Default 24h.
   */
  bootstrapPairingTtlMs: number
  /**
   * Bearer credential for the provisioning API [0031] (HOSTED_PLAN §4.2).
   *
   * UNSET MEANS THE ROUTES ARE NOT REGISTERED AT ALL — not registered-and-refusing.
   * A self-hosted relay that never sets this is byte-for-byte the relay it was before
   * the API existed, and `/admin/provisioning/...` there is a 404 because there is
   * genuinely nothing there.
   *
   * Set from `PROVISIONING_TOKEN`, or read at boot from `PROVISIONING_TOKEN_FILE`
   * (server.ts) — the shape a managed secret store hands you. Exactly one of the two,
   * because two answers to "what is the credential" is a question nobody should have
   * to resolve at runtime.
   */
  provisioningToken?: string
  /** Path the token is read from at boot, when that form was chosen. See above. */
  provisioningTokenFile?: string
  /**
   * The deployment posture this relay claims to be running (`TABSEND_PROFILE`) [0033]
   * (HOSTED_PLAN §4.5, `docs/HOSTED_PROFILE.md`).
   *
   * UNSET IS THE DEFAULT AND MEANS TODAY'S BEHAVIOUR, EXACTLY: nothing is asserted,
   * nothing is warned about, and every self-hosted relay that exists is that relay.
   *
   * `hosted` is a claim the relay is asked to check rather than a switch that changes
   * how it behaves. Setting it turns on `assertProfile` (`profile.ts`), which REFUSES
   * to boot unless the posture HOSTED_SECURITY_PLAN's control-plane gates require is
   * actually configured. It configures nothing itself: the network-layer egress deny, the
   * separate system users and the managed secret store are deployment work that no
   * process inside the relay can perform or verify, and `docs/HOSTED_PROFILE.md` is
   * the checklist for them.
   */
  profile?: RelayProfile
}

/**
 * Deployment postures a relay may claim [0033].
 *
 * One value today, and a union rather than a boolean because the next one will be a
 * posture too (a `staging` that warns instead of refusing has been suggested), and a
 * boolean would have to be replaced rather than extended.
 */
export type RelayProfile = 'hosted'

const RELAY_PROFILE_VALUES: readonly RelayProfile[] = ['hosted']

/**
 * Group-creation policy [0029] (HOSTED_PLAN §4.1).
 *
 * - `single` — the default and the whole of ADR-0022: the relay owns one group,
 *   made at boot (ADR-0023), and the public create path is refused once it exists.
 * - `open` — many groups, and anyone may create one without a pairing code. What
 *   `ALLOW_MULTIPLE_GROUPS=1` has always meant, and still maps to.
 * - `provisioned` — many groups, but the public create path ALWAYS refuses, even on
 *   an empty relay. Groups come into being out of band (an operator, or a control
 *   plane calling a provisioning API), so nobody can mint a tenancy on a relay they
 *   do not run. A household relay may want the same lock.
 */
export type GroupCreation = 'single' | 'open' | 'provisioned'

const GROUP_CREATION_VALUES: readonly GroupCreation[] = ['single', 'open', 'provisioned']

/**
 * May a client still CREATE a group on this relay, given whether it holds any yet?
 *
 * The onboarding HINT, and only the hint: `GET /v1/config` publishes it so a client can
 * offer the button that will work instead of one guaranteed to be refused, and
 * `/admin/status` reports the same fact to an operator. Enforcement is the register
 * route's, which has to distinguish the two refusals this collapses into one `false`
 * (403 `forbidden` on `provisioned`, 409 `group_exists` on a `single` relay that
 * already has one). ONE function so those two readers cannot drift apart: they were
 * two copies of the same ladder, and a third policy would have had to be added twice.
 *
 * Exhaustive on purpose — a policy added to {@link GroupCreation} without an answer
 * here is a compile error rather than a silent `false`.
 */
export function acceptsNewGroups(policy: GroupCreation, hasAnyGroup: boolean): boolean {
  switch (policy) {
    case 'open':
      return true
    case 'single':
      return !hasAnyGroup
    case 'provisioned':
      return false
    default: {
      const unreachable: never = policy
      throw new Error(`Unhandled group-creation policy: ${String(unreachable)}`)
    }
  }
}

export interface RateLimitConfig {
  /** Max requests per window per key. <= 0 disables rate limiting entirely. */
  max: number
  /** Window length in ms. 0 disables rate limiting too: a window of no length cannot
   *  count anything, and the alternative is a boundary arithmetic nobody can define
   *  (quota.ts). Normalised to exactly 0 by {@link loadConfig}, so "off" has one
   *  spelling here whatever the operator typed. */
  windowMs: number
}

/**
 * Relay-wide defaults for the four per-group caps [0030] (HOSTED_PLAN §4.3).
 *
 * Every one defaults to 0, which means UNLIMITED — so an existing relay upgrading to
 * this version behaves exactly as it did, down to the SQL it runs: with no cap in
 * force the send and register paths take the same unguarded inserts they always took.
 * A group row may override any of these individually (`groups.cap_*`), which is what
 * the §4.2 provisioning API will set through `setGroupCapOverrides`.
 *
 * `0 = unlimited` rather than a sentinel like -1, matching `RATE_LIMIT_MAX`: one
 * spelling for "switch this off" across the whole config.
 */
export interface GroupCapDefaults {
  /** Endpoints a group may hold. Refused at register, before the join is recorded. */
  endpoints: number
  /** Undelivered messages held for a group. Refused per item, at send. */
  queuedMessages: number
  /** Stored bytes held for a group: queued envelopes plus the history blobs still
   *  inside HISTORY_RETENTION_DAYS (caps.ts). Refused per item, at send. */
  queuedBytes: number
  /** Accepted sends per window, group-wide. Refused per item, at send. */
  sendsPerWindow: number
  /** Length of that send window in ms. Only read when `sendsPerWindow` is on. */
  sendWindowMs: number
}

export interface VapidConfig {
  publicKey: string
  privateKey: string
  /** `mailto:` or `https:` contact, required by the Web Push spec. */
  subject: string
}

/** Derive the browser door to the same relay without assuming the default ports. */
export function deriveBrowserRelayUrl(publicRelayUrl: string, httpPort?: number): string {
  if (httpPort === undefined) return publicRelayUrl
  let parsed: URL
  try {
    parsed = new URL(publicRelayUrl)
  } catch {
    throw new Error(`PUBLIC_RELAY_URL must be a valid absolute URL, got: ${publicRelayUrl}`)
  }
  parsed.protocol = 'http:'
  parsed.port = String(httpPort)
  return parsed.toString().replace(/\/$/, '')
}

const DAY_MS = 24 * 60 * 60 * 1000
const MINUTE_MS = 60 * 1000
const MAX_HISTORY_RETENTION_DAYS = 3650

function num(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback
  const n = Number(value)
  if (!Number.isFinite(n)) throw new Error(`Expected a number, got: ${value}`)
  return n
}

function positiveNum(value: string | undefined, fallback: number, name: string): number {
  const n = num(value, fallback)
  if (n <= 0) throw new Error(`${name} must be greater than zero, got: ${n}`)
  return n
}

/**
 * A count: a whole number of 0 or more, where 0 switches the limit off. Refused at boot
 * otherwise, because a limit reaches SQL as a parameter compared against `count(*)` or a
 * counter, and Postgres rejects a fraction or a number past its integer range there on
 * every request rather than once: `2.5` made every pairing mint, every join or every
 * send a 500, depending on which limit it was. A negative used to read as "off" without
 * saying so, which is a typo nobody would ever be told about.
 */
function wholeNum(value: string | undefined, fallback: number, name: string): number {
  const n = num(value, fallback)
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new Error(
      `${name} must be a whole number of 0 or more (0 switches it off), got: ${value}`,
    )
  }
  return n
}

/**
 * Resolve `GROUP_CREATION` against the older `ALLOW_MULTIPLE_GROUPS` boolean [0029].
 *
 * Precedence: `GROUP_CREATION` wins whenever it is set, so a relay already running
 * `ALLOW_MULTIPLE_GROUPS=1` tightens to `provisioned` by adding one variable rather
 * than by remembering to delete the old one. `ALLOW_MULTIPLE_GROUPS=1` alone still
 * means `open`, unchanged, which is what keeps every existing docker-compose out
 * there working.
 *
 * A pair that contradicts each other about MULTIPLICITY is a boot error rather than
 * a guess: either answer would be somebody's data model, and silently picking one is
 * how a relay ends up multi-tenant when its operator believed it was not.
 */
function readGroupCreation(env: NodeJS.ProcessEnv): GroupCreation {
  const raw = env.GROUP_CREATION?.trim().toLowerCase()
  const legacyRaw = env.ALLOW_MULTIPLE_GROUPS
  const legacySet = legacyRaw !== undefined && legacyRaw.trim() !== ''
  const legacyOn = legacyRaw === '1' || legacyRaw === 'true'

  if (raw === undefined || raw === '') return legacyOn ? 'open' : 'single'
  if (!GROUP_CREATION_VALUES.includes(raw as GroupCreation)) {
    throw new Error(
      `GROUP_CREATION must be one of ${GROUP_CREATION_VALUES.join(', ')}, got: ${env.GROUP_CREATION}`,
    )
  }
  const policy = raw as GroupCreation

  if (legacySet && legacyOn && policy === 'single') {
    throw new Error(
      'ALLOW_MULTIPLE_GROUPS=1 asks for several groups and GROUP_CREATION=single asks for exactly one. Set only GROUP_CREATION: use "open" for the old multi-group behaviour, or "provisioned" to keep several groups while refusing public creates.',
    )
  }
  if (legacySet && !legacyOn && policy !== 'single') {
    throw new Error(
      `ALLOW_MULTIPLE_GROUPS=${legacyRaw} asks for one group and GROUP_CREATION=${policy} asks for several. Set only GROUP_CREATION, and remove ALLOW_MULTIPLE_GROUPS.`,
    )
  }
  return policy
}

/**
 * Shortest credential the provisioning API will accept [0031].
 *
 * A guessable token on a route that creates and destroys tenancies is worse than no
 * route at all, because it looks like a control. 16 characters is not a security
 * argument on its own; it is a floor that catches `PROVISIONING_TOKEN=changeme`
 * at boot, where it is cheap, instead of never.
 */
const PROVISIONING_TOKEN_MIN_LENGTH = 16

/**
 * Validate a provisioning credential, whatever it arrived in. Returns the token with
 * surrounding whitespace removed.
 *
 * Trimmed on both forms, and that is deliberate rather than sloppy: writing a secret
 * to a file leaves a trailing newline almost every time (`openssl rand … > token`), and
 * whitespace at either end of a bearer token could not survive an HTTP header anyway,
 * so keeping it would only produce a credential that can never match.
 */
export function validateProvisioningToken(raw: string, source: string): string {
  const token = raw.trim()
  if (token === '') {
    throw new Error(
      `${source} is set but empty. Unset it entirely to run without the provisioning API, or give it a real credential. Generate one with: openssl rand -base64 32`,
    )
  }
  if (token.length < PROVISIONING_TOKEN_MIN_LENGTH) {
    throw new Error(
      `${source} must be at least ${PROVISIONING_TOKEN_MIN_LENGTH} characters. It guards a route that creates and deletes groups. Generate one with: openssl rand -base64 32`,
    )
  }
  return token
}

/**
 * Read the provisioning credential out of `PROVISIONING_TOKEN_FILE` at boot.
 *
 * Not done in {@link loadConfig}, which stays an env-only pure function — the same
 * split that keeps TLS material and the VAPID keypair in boot code (server.ts). The
 * VALIDATION is in loadConfig either way, so a misconfiguration is a boot error rather
 * than a route that quietly never registers.
 */
export function readProvisioningTokenFile(path: string): string {
  let contents: string
  try {
    contents = readFileSync(path, 'utf8')
  } catch (err) {
    throw new Error(
      `PROVISIONING_TOKEN_FILE points at ${path}, which cannot be read: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  return validateProvisioningToken(contents, `PROVISIONING_TOKEN_FILE (${path})`)
}

/**
 * Validate and normalise `WAKE_FORWARDER_URL` [0032].
 *
 * A boot error rather than a shrug, for the same reason a half-set VAPID pair is one:
 * an operator who typed this wrong meant to be able to wake phones, and the quiet
 * failure would be phones that pair happily and then never ring. Only the origin and
 * path are kept — the route (`/v1/wake`) is the forwarder's protocol, not the
 * operator's to spell, so a trailing slash here cannot produce a double one there.
 */
function readWakeForwarderUrl(raw: string): string {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error(
      `WAKE_FORWARDER_URL must be an absolute URL like https://wake.example.com, got: ${raw}`,
    )
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(
      `WAKE_FORWARDER_URL must be http or https, got: ${parsed.protocol.replace(':', '')}`,
    )
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    // A wake token rides a header and never a URL (forwarder PROTOCOL §6, ADR-0009 §3).
    // A query string here is either a mistake or somebody trying to attach a secret to
    // every wake, and both are worth refusing at boot.
    throw new Error(
      `WAKE_FORWARDER_URL must be a plain base URL with no query string or fragment, got: ${raw}`,
    )
  }
  return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '')
}

/**
 * Read `TABSEND_PROFILE` [0033]. Unset (and empty) is undefined, which asserts nothing.
 *
 * An unrecognised value is a boot error rather than a shrug, for the same reason
 * `GROUP_CREATION` typos are [0029]: somebody who wrote `TABSEND_PROFILE=hostd` meant
 * to have the hosted posture checked, and falling through to "no profile" would give
 * them a relay that boots happily and checks nothing. The failure this refuses to
 * allow quietly is an operator who believes a gate is armed and is wrong.
 */
function readProfile(env: NodeJS.ProcessEnv): RelayProfile | undefined {
  const raw = env.TABSEND_PROFILE?.trim().toLowerCase()
  if (raw === undefined || raw === '') return undefined
  if (!RELAY_PROFILE_VALUES.includes(raw as RelayProfile)) {
    throw new Error(
      `TABSEND_PROFILE must be one of ${RELAY_PROFILE_VALUES.join(', ')}, got: ${env.TABSEND_PROFILE}. Leave it unset for a relay you run yourself; nothing is checked and nothing changes.`,
    )
  }
  return raw as RelayProfile
}

/** Build a Config from an env bag (defaults to process.env). Pure — no side effects. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = num(env.PORT, 8787)
  const host = env.HOST ?? '127.0.0.1'
  const databaseUrl = env.DATABASE_URL ?? 'sqlite:./.data/tabsend.db'
  const publicRelayUrlExplicit = env.PUBLIC_RELAY_URL !== undefined && env.PUBLIC_RELAY_URL !== ''
  const publicRelayUrl = publicRelayUrlExplicit
    ? (env.PUBLIC_RELAY_URL as string)
    : `http://localhost:${port}`

  const tlsSelfSigned = env.TLS_SELF_SIGNED === '1' || env.TLS_SELF_SIGNED === 'true'
  // Default: a tls/ dir next to the SQLite data dir.
  const tlsDir = env.TLS_DIR ?? './.data/tls'
  const tlsExtraSans = (env.TLS_EXTRA_SANS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)

  // Only meaningful alongside https — without tlsSelfSigned the main listener is
  // already plain HTTP, so a second cleartext port would just be a duplicate.
  const httpPortRaw = env.HTTP_PORT
  const httpPort =
    tlsSelfSigned && httpPortRaw !== undefined && httpPortRaw.trim() !== ''
      ? num(httpPortRaw, 0)
      : undefined
  if (httpPort !== undefined && httpPort === port) {
    throw new Error(`HTTP_PORT (${httpPort}) must differ from PORT — they cannot share a socket.`)
  }
  const httpAllowPublic = env.HTTP_ALLOW_PUBLIC === '1' || env.HTTP_ALLOW_PUBLIC === 'true'
  const publicBrowserRelayUrlExplicit =
    env.PUBLIC_BROWSER_RELAY_URL !== undefined && env.PUBLIC_BROWSER_RELAY_URL.trim() !== ''
  const publicBrowserRelayUrl = publicBrowserRelayUrlExplicit
    ? (env.PUBLIC_BROWSER_RELAY_URL as string)
    : deriveBrowserRelayUrl(publicRelayUrl, httpPort)

  // TTL override: MESSAGE_TTL_SECONDS wins (handy for short-lived expiry testing),
  // else MESSAGE_TTL_DAYS, else the contract default.
  const messageTtlMs =
    env.MESSAGE_TTL_SECONDS !== undefined
      ? num(env.MESSAGE_TTL_SECONDS, 0) * 1000
      : num(env.MESSAGE_TTL_DAYS, DEFAULT_MESSAGE_TTL_DAYS) * DAY_MS

  // Above zero, like the bootstrap lifetime below: a link that expires as it is made
  // can never be used, and a join reads a code whose expiry equals its creation time as
  // one the group's first join retired (routes/endpoints.ts), so 0 would also tell
  // everybody the wrong reason.
  const pairingCodeTtlMs =
    positiveNum(
      env.PAIRING_CODE_TTL_MINUTES,
      PAIRING_CODE_TTL_MINUTES,
      'PAIRING_CODE_TTL_MINUTES',
    ) * MINUTE_MS
  // See the field's doc comment for why this one is on by default where the per-group
  // caps are not: it bounds a table, not a tier.
  const pairingCodesMaxLive = wholeNum(env.PAIRING_CODES_MAX_LIVE, 20, 'PAIRING_CODES_MAX_LIVE')

  // Sweeper: runs every SWEEP_INTERVAL_SECONDS (default 60s). A tombstone is
  // hard-deleted SWEEP_GRACE_SECONDS past expiry (default = one TTL, so total
  // server retention ≈ 2× TTL).
  const sweepIntervalMs = num(env.SWEEP_INTERVAL_SECONDS, 60) * 1000
  const sweepGraceMs =
    env.SWEEP_GRACE_SECONDS !== undefined ? num(env.SWEEP_GRACE_SECONDS, 0) * 1000 : messageTtlMs

  // Group history [0028]: 30 days by default. Storage is a few hundred bytes per
  // send, so this is a policy choice about how far back the history screens
  // reach, not a capacity one. HISTORY_RETENTION_DAYS=0 turns group history off
  // at the relay: blobs are still accepted (an older client must not start
  // failing) but not stored and nothing is served. A whole number of days up to
  // ten years: a negative used to read as "off" without saying so, and a value
  // past about 10^8 days made every send a 500 (review 2026-10-13).
  const historyRetentionDays = wholeNum(env.HISTORY_RETENTION_DAYS, 30, 'HISTORY_RETENTION_DAYS')
  if (historyRetentionDays > MAX_HISTORY_RETENTION_DAYS) {
    throw new Error(
      `HISTORY_RETENTION_DAYS must be at most ${MAX_HISTORY_RETENTION_DAYS}, got: ${historyRetentionDays}`,
    )
  }
  const historyRetentionMs = historyRetentionDays * DAY_MS

  const hasVapidPublicKey = Boolean(env.VAPID_PUBLIC_KEY?.trim())
  const hasVapidPrivateKey = Boolean(env.VAPID_PRIVATE_KEY?.trim())
  if (hasVapidPublicKey !== hasVapidPrivateKey) {
    throw new Error(
      'VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY must either both be set or both be omitted. Refusing to ignore a partial explicit keypair.',
    )
  }
  let vapid: VapidConfig | undefined
  if (hasVapidPublicKey && hasVapidPrivateKey) {
    vapid = {
      publicKey: env.VAPID_PUBLIC_KEY as string,
      privateKey: env.VAPID_PRIVATE_KEY as string,
      subject: env.VAPID_SUBJECT ?? 'mailto:dev@tabsend.local',
    }
  }

  const bodyLimitBytes = num(env.MAX_BODY_BYTES, 1024 * 1024) // 1 MiB
  const streamMaxFrameBytes = positiveNum(
    env.STREAM_MAX_FRAME_BYTES,
    16 * 1024,
    'STREAM_MAX_FRAME_BYTES',
  )
  const streamHelloTimeoutMs =
    positiveNum(env.STREAM_HELLO_TIMEOUT_SECONDS, 10, 'STREAM_HELLO_TIMEOUT_SECONDS') * 1000
  const streamIdleTimeoutMs =
    positiveNum(env.STREAM_IDLE_TIMEOUT_SECONDS, 90, 'STREAM_IDLE_TIMEOUT_SECONDS') * 1000
  const streamMaxConnections = positiveNum(
    env.STREAM_MAX_CONNECTIONS,
    1_000,
    'STREAM_MAX_CONNECTIONS',
  )
  const streamMaxConnectionsPerEndpoint = positiveNum(
    env.STREAM_MAX_CONNECTIONS_PER_ENDPOINT,
    5,
    'STREAM_MAX_CONNECTIONS_PER_ENDPOINT',
  )
  const streamMaxConnectionsPerGroup = positiveNum(
    env.STREAM_MAX_CONNECTIONS_PER_GROUP,
    100,
    'STREAM_MAX_CONNECTIONS_PER_GROUP',
  )
  const trustProxy = env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true'
  // RATE_LIMIT_WINDOW_SECONDS=0 (or negative) means the limiter is OFF, not a window of
  // zero length: `0 = switch this off` is the spelling every cap already uses, and it is
  // what RATE_LIMIT_MAX=0 has always done. Normalised to exactly 0 here so the value that
  // reaches quota.ts has one shape — before this, it reached windowBounds, produced NaN
  // boundaries and failed EVERY register with a 500 (the limiter fails closed).
  const rateLimitWindowMs = num(env.RATE_LIMIT_WINDOW_SECONDS, 600) * 1000
  const rateLimit: RateLimitConfig = {
    max: wholeNum(env.RATE_LIMIT_MAX, 30, 'RATE_LIMIT_MAX'),
    windowMs: rateLimitWindowMs > 0 ? rateLimitWindowMs : 0,
  }
  // Per-group caps [0030]. All off by default: a relay that sets none of these runs
  // exactly as it did before they existed (HOSTED_PLAN §4.3). The window only matters
  // when CAP_SENDS_PER_WINDOW is on, but it is read unconditionally so a bad value is
  // a boot error rather than a surprise the first time somebody turns the cap on.
  const caps: GroupCapDefaults = {
    // Whole numbers, like every count here (`wholeNum`): each one reaches SQL compared
    // against a `count(*)` or a counter, where Postgres refuses `2.5` on every request.
    endpoints: wholeNum(env.CAP_ENDPOINTS, 0, 'CAP_ENDPOINTS'),
    queuedMessages: wholeNum(env.CAP_QUEUED_MESSAGES, 0, 'CAP_QUEUED_MESSAGES'),
    queuedBytes: wholeNum(env.CAP_QUEUED_BYTES, 0, 'CAP_QUEUED_BYTES'),
    sendsPerWindow: wholeNum(env.CAP_SENDS_PER_WINDOW, 0, 'CAP_SENDS_PER_WINDOW'),
    sendWindowMs: positiveNum(env.CAP_SEND_WINDOW_SECONDS, 60, 'CAP_SEND_WINDOW_SECONDS') * 1000,
  }
  const pushDeadThreshold = num(env.PUSH_DEAD_THRESHOLD, 3)
  const pushAllowPrivateEndpoints =
    env.PUSH_ALLOW_PRIVATE_ENDPOINTS === '1' || env.PUSH_ALLOW_PRIVATE_ENDPOINTS === 'true'
  // The phone doorbell [0032, 0034]. Absent is the default and means the relay behaves exactly
  // as it did before the forwarder existed — see the field's doc comment.
  const wakeForwarderRaw = env.WAKE_FORWARDER_URL?.trim()
  const wakeForwarderUrl =
    wakeForwarderRaw === undefined || wakeForwarderRaw === ''
      ? undefined
      : readWakeForwarderUrl(wakeForwarderRaw)
  const groupCreation = readGroupCreation(env)
  const bootstrapPairingTtlMs =
    positiveNum(env.BOOTSTRAP_PAIRING_TTL_MINUTES, 24 * 60, 'BOOTSTRAP_PAIRING_TTL_MINUTES') *
    MINUTE_MS

  // The provisioning credential [0031]. Exactly one of the two forms, validated here
  // even though the FILE form is only read at boot: a relay whose provisioning API was
  // meant to be reachable and silently is not (empty variable, credential too short to
  // be one) is the failure this refuses to let happen quietly. Neither set is not an
  // error — it is the default, and it means the routes do not exist.
  const tokenSet = env.PROVISIONING_TOKEN !== undefined
  const fileSet = env.PROVISIONING_TOKEN_FILE !== undefined
  if (tokenSet && fileSet) {
    throw new Error(
      'PROVISIONING_TOKEN and PROVISIONING_TOKEN_FILE are both set, and they are two answers to one question. Keep the file if a secret store mounts it; keep the variable otherwise.',
    )
  }
  const provisioningToken = tokenSet
    ? validateProvisioningToken(env.PROVISIONING_TOKEN as string, 'PROVISIONING_TOKEN')
    : undefined
  const provisioningTokenFile = fileSet
    ? (env.PROVISIONING_TOKEN_FILE as string).trim() || undefined
    : undefined
  if (fileSet && provisioningTokenFile === undefined) {
    throw new Error(
      'PROVISIONING_TOKEN_FILE is set but empty. Point it at the file holding the credential, or unset it to run without the provisioning API.',
    )
  }

  const profile = readProfile(env)

  return {
    host,
    port,
    databaseUrl,
    publicRelayUrl,
    publicRelayUrlExplicit,
    publicBrowserRelayUrl,
    publicBrowserRelayUrlExplicit,
    tlsSelfSigned,
    tlsDir,
    httpPort,
    httpAllowPublic,
    tlsExtraSans,
    messageTtlMs,
    pairingCodeTtlMs,
    pairingCodesMaxLive,
    sweepIntervalMs,
    sweepGraceMs,
    historyRetentionMs,
    vapid,
    bodyLimitBytes,
    streamMaxFrameBytes,
    streamHelloTimeoutMs,
    streamIdleTimeoutMs,
    streamMaxConnections,
    streamMaxConnectionsPerEndpoint,
    streamMaxConnectionsPerGroup,
    trustProxy,
    rateLimit,
    caps,
    pushDeadThreshold,
    pushAllowPrivateEndpoints,
    ...(wakeForwarderUrl ? { wakeForwarderUrl } : {}),
    groupCreation,
    bootstrapPairingTtlMs,
    ...(provisioningToken ? { provisioningToken } : {}),
    ...(provisioningTokenFile ? { provisioningTokenFile } : {}),
    ...(profile ? { profile } : {}),
  }
}
