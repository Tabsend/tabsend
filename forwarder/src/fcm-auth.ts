import { createPrivateKey, type KeyObject, sign } from 'node:crypto'

/**
 * The OAuth2 access token that authenticates the forwarder to Google, obtained by signing
 * a service-account assertion with `node:crypto` alone — no googleapis dependency for what
 * is one JWT and one form post.
 *
 * The shape differs from Apple's on one point worth stating, because it is the only reason
 * this file is more than `apns-jwt.ts` with a different algorithm: Apple accepts the signed
 * JWT directly as the bearer token, while Google makes you EXCHANGE it for an access token
 * at a second endpoint. So this holds a token it was given rather than one it minted, and
 * it has to make a network call to refresh — which is why `current()` is async here and
 * synchronous there.
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging'

/** Google's assertions may not claim more than an hour. */
const ASSERTION_LIFETIME_SECONDS = 3600

/**
 * Use a cached access token until this close to its expiry. Past it, a ring exchanges
 * for itself, which only happens when the timer below could not keep up.
 */
const EXPIRY_MARGIN_MS = 30 * 1000

/**
 * Refresh this long before the access token expires, on a timer [2026-10-02,
 * SECURITY_REVIEW G14]. Google issues them for an hour. A refresh used to happen on
 * whichever ring found the token stale, and that ring then paid for signing an assertion
 * and a round trip to Google after its reply: busy time an unknown token never caused.
 */
const REFRESH_AHEAD_MS = 5 * 60 * 1000

/** Never schedule refreshes closer together than this, whatever Google says. */
const MIN_REFRESH_GAP_MS = 30 * 1000

/**
 * Nor further apart than this. Google's tokens last an hour; a far longer lifetime from a
 * token endpoint would otherwise overflow the timer, which Node then fires at once, and
 * the refresh would loop [2026-10-02 verification pass].
 */
const MAX_REFRESH_GAP_MS = 60 * 60 * 1000

/**
 * Back-off after a failed exchange: start here, double, stop doubling at the cap. It holds
 * for rings as well as for the timer [2026-10-20, SECURITY_REVIEW G17]: a ring that finds
 * no usable token during the back-off fails at once rather than signing and posting an
 * assertion of its own, which used to happen on every ring for as long as Google refused.
 */
const RETRY_FIRST_MS = 30 * 1000
const RETRY_MAX_MS = 10 * 60 * 1000

/**
 * A 401 from the send path drops the cached access token, but at most this often
 * [2026-10-20, G17]. A token Google no longer accepts would otherwise be used for the rest
 * of its hour; a 401 on every ring must not become an exchange on every ring either.
 */
const MIN_INVALIDATE_GAP_MS = 30 * 1000

/**
 * The shortest token lifetime accepted [2026-10-20 review of G17]. A token is used only
 * until 30 s before it expires (`EXPIRY_MARGIN_MS`), so one shorter than that was cached and
 * never used, and every ring exchanged again. Google issues them for an hour.
 */
const MIN_TOKEN_LIFETIME_SECONDS = 60

/** Google's token answers are a few hundred bytes. Past this, the rest is not read. */
const MAX_TOKEN_REPLY_BYTES = 64 * 1024

/** Run `task` after `delayMs`; returns a cancel. Injected in tests. */
export type Scheduler = (task: () => void, delayMs: number) => () => void

/** A timer that does not hold the process open: a refresh is never a reason to stay up. */
export const unrefScheduler: Scheduler = (task, delayMs) => {
  const timer = setTimeout(task, delayMs)
  timer.unref()
  return () => clearTimeout(timer)
}

/** The three fields the forwarder needs out of a service-account JSON. */
export interface ServiceAccount {
  projectId: string
  clientEmail: string
  privateKey: KeyObject
}

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url')
}

/**
 * Parse a service-account JSON. Throws with an actionable message on anything else,
 * including the mistake most likely to happen here: handing it the `google-services.json`
 * that belongs in the Android app, which looks like a Firebase credential and is not one.
 */
export function loadServiceAccount(json: string): ServiceAccount {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch (cause) {
    throw new Error(
      'Could not read the Google service-account credential as JSON. It must be the JSON file Firebase gives you under Project settings → Service accounts → Generate new private key.',
      { cause },
    )
  }
  const bag = (parsed ?? {}) as Record<string, unknown>
  const projectId = typeof bag.project_id === 'string' ? bag.project_id : ''
  const clientEmail = typeof bag.client_email === 'string' ? bag.client_email : ''
  const privateKeyPem = typeof bag.private_key === 'string' ? bag.private_key : ''
  if (!projectId || !clientEmail || !privateKeyPem) {
    throw new Error(
      'That JSON is not a Firebase service account: it is missing project_id, client_email or private_key. The file you want comes from Project settings → Service accounts → Generate new private key. It is NOT google-services.json, which is the client config that ships inside the Android app and carries no credential at all.',
    )
  }
  let privateKey: KeyObject
  try {
    privateKey = createPrivateKey(privateKeyPem)
  } catch (cause) {
    throw new Error(
      "The service account's private_key could not be read as a PEM key. The usual cause is a copy that lost its newlines: in the JSON the key is one line with literal \\n escapes, and those must survive into whatever supplies FCM_SERVICE_ACCOUNT_JSON.",
      { cause },
    )
  }
  // [2026-10-20, SECURITY_REVIEW G13] Google signs service accounts with RSA and accepts
  // nothing else here. Any other key started and signed something Google refuses, so
  // every Android ring failed on a forwarder that had looked fine at boot.
  if (privateKey.asymmetricKeyType !== 'rsa') {
    throw new Error(
      `The service account's private_key is a ${privateKey.asymmetricKeyType ?? 'non-RSA'} key, and Google accepts only RSA here. Use the JSON Firebase generates under Project settings → Service accounts → Generate new private key, unedited.`,
    )
  }
  return { projectId, clientEmail, privateKey }
}

/** Sign one service-account assertion. `issuedAtSeconds` is injectable for tests. */
export function signServiceAccountAssertion(params: {
  account: ServiceAccount
  issuedAtSeconds?: number
}): string {
  const iat = params.issuedAtSeconds ?? Math.floor(Date.now() / 1000)
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const payload = base64url(
    JSON.stringify({
      iss: params.account.clientEmail,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat,
      exp: iat + ASSERTION_LIFETIME_SECONDS,
    }),
  )
  const signingInput = `${header}.${payload}`
  const signature = sign('sha256', Buffer.from(signingInput), params.account.privateKey)
  return `${signingInput}.${base64url(signature)}`
}

/** The exchange, isolated so a test can supply one without a network. */
export type TokenExchange = (
  assertion: string,
  timeoutMs: number,
) => Promise<{
  accessToken: string
  expiresInSeconds: number
}>

/**
 * Read at most `limit` bytes of a response body, then stop reading [2026-10-20, G17]. A
 * body cut short no longer parses, and the caller treats it as a refusal.
 */
async function readCapped(response: Response, limit: number): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.length
    if (size > limit) {
      await reader.cancel().catch(() => undefined)
      break
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * The exchange as one form post to a token endpoint. Production uses Google's
 * (`fetchAccessToken`); a test passes a local one. It follows no redirect and reads at most
 * 64 KiB of the answer [2026-10-20, SECURITY_REVIEW G17]: the host is fixed, so a redirect
 * is never a legitimate answer from it, and a reply is a few hundred bytes.
 */
export function httpTokenExchange(url: string = TOKEN_URL): TokenExchange {
  return async (assertion, timeoutMs) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }),
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    })
    let body: unknown = {}
    try {
      body = JSON.parse(await readCapped(response, MAX_TOKEN_REPLY_BYTES))
    } catch {
      // Leave it empty; the status alone is reported.
    }
    return readTokenAnswer(response.ok, response.status, body)
  }
}

/** The real exchange: one form post to Google's token endpoint. */
export const fetchAccessToken: TokenExchange = httpTokenExchange()

function readTokenAnswer(
  ok: boolean,
  status: number,
  body: unknown,
): { accessToken: string; expiresInSeconds: number } {
  const bag = (body ?? {}) as Record<string, unknown>
  if (!ok || typeof bag.access_token !== 'string' || bag.access_token === '') {
    // `error_description` is Google's own words about a credential problem, and an
    // operator with a misconfigured service account needs them. It describes the
    // forwarder's credential, never a user or a device.
    const detail =
      typeof bag.error_description === 'string'
        ? bag.error_description
        : typeof bag.error === 'string'
          ? bag.error
          : ok
            ? 'no access token in the answer'
            : `HTTP ${status}`
    throw new Error(`Google refused the service-account assertion: ${detail}`)
  }
  // No lifetime, or a useless one, is a failed exchange rather than an hour assumed
  // [2026-10-20 review of G17]: it is refused, and the back-off starts.
  if (typeof bag.expires_in !== 'number') {
    throw new Error('Google refused the service-account assertion: no lifetime in the answer')
  }
  return { accessToken: bag.access_token, expiresInSeconds: bag.expires_in }
}

/**
 * Holds one access token and keeps it fresh.
 *
 * Once started, a timer exchanges a new token before the old one expires, so a ring finds
 * one waiting and never pays for an exchange [2026-10-02, SECURITY_REVIEW G14]. A ring
 * still exchanges for itself when there is no usable token at all (the first refresh has
 * not landed, or every refresh since has failed), because a doorbell that waits for the
 * timer would not ring.
 *
 * Concurrent callers share one in-flight exchange rather than starting one each: a burst of
 * rings on a cold cache would otherwise hit Google's token endpoint once per ring, which
 * is both wasteful and the kind of thing that gets rate limited at the worst moment.
 */
export class FcmTokenSource {
  private cached: { token: string; expiresAt: number } | undefined
  private inFlight: Promise<string> | undefined
  private cancelTimer: (() => void) | undefined
  private running = false
  /** Exchanges failed in a row. Zero once one succeeds. */
  private failures = 0
  /** Until when a ring with no usable token fails at once rather than exchanging. */
  private blockedUntil = 0
  private lastError: Error | undefined
  private lastInvalidatedAt = Number.NEGATIVE_INFINITY

  constructor(
    private readonly account: ServiceAccount,
    private readonly timeoutMs: number,
    private readonly exchange: TokenExchange = fetchAccessToken,
    private readonly now: () => number = () => Date.now(),
    private readonly schedule: Scheduler = unrefScheduler,
    private readonly onRefreshError?: (err: Error) => void,
  ) {}

  /** Exchange now, and keep exchanging ahead of expiry until `stop`. Idempotent. */
  start(): void {
    if (this.running) return
    this.running = true
    this.refresh()
  }

  /** Cancel the timer. A token already held stays usable until it expires. */
  stop(): void {
    this.running = false
    this.cancelTimer?.()
    this.cancelTimer = undefined
  }

  /**
   * False while the last exchange failed [2026-10-20, SECURITY_REVIEW G13]. The register
   * route refuses Android sign-ups then: a phone that signs up closes its own connection
   * and waits to be rung, and with no access token it never would be. True again once an
   * exchange succeeds, and true before the first one has come back.
   */
  get healthy(): boolean {
    return this.failures === 0
  }

  async current(): Promise<string> {
    if (this.cached && this.now() < this.cached.expiresAt - EXPIRY_MARGIN_MS) {
      return this.cached.token
    }
    if (this.now() < this.blockedUntil && !this.inFlight) {
      // Inside the back-off: fail now, without signing anything [G17].
      throw new Error(
        `No Google access token: the last exchange failed (${this.lastError?.message ?? 'unknown'}). The next try is in ${Math.ceil((this.blockedUntil - this.now()) / 1000)} s.`,
      )
    }
    return this.exchangeShared()
  }

  /**
   * Google answered a send with 401, so the access token it was given no longer works:
   * drop it, if it is still the one held, and fetch a new one in the background now
   * [2026-10-20, SECURITY_REVIEW G17]. At most once per `MIN_INVALIDATE_GAP_MS`.
   */
  invalidate(token: string): void {
    if (this.cached?.token !== token) return
    if (this.now() - this.lastInvalidatedAt < MIN_INVALIDATE_GAP_MS) return
    this.lastInvalidatedAt = this.now()
    this.cached = undefined
    if (!this.running) return
    this.cancelTimer?.()
    this.refresh()
  }

  private refresh(): void {
    this.cancelTimer = undefined
    this.exchangeShared().then(
      () => {
        const lifetime = (this.cached?.expiresAt ?? this.now()) - this.now()
        const ahead =
          lifetime > 2 * REFRESH_AHEAD_MS ? lifetime - REFRESH_AHEAD_MS : Math.floor(lifetime / 2)
        this.scheduleRefresh(Math.min(Math.max(ahead, MIN_REFRESH_GAP_MS), MAX_REFRESH_GAP_MS))
      },
      (err: unknown) => {
        // The next try is already scheduled, by `exchangeShared`.
        this.onRefreshError?.(err instanceof Error ? err : new Error(String(err)))
      },
    )
  }

  private scheduleRefresh(delayMs: number): void {
    if (!this.running) return
    this.cancelTimer?.()
    this.cancelTimer = this.schedule(() => this.refresh(), delayMs)
  }

  private exchangeShared(): Promise<string> {
    if (this.inFlight) return this.inFlight
    const pending = (async () => {
      const assertion = signServiceAccountAssertion({
        account: this.account,
        issuedAtSeconds: Math.floor(this.now() / 1000),
      })
      const { accessToken, expiresInSeconds } = await this.exchange(assertion, this.timeoutMs)
      // Never cached: an empty token, or one that is already over [2026-10-20, G17].
      if (typeof accessToken !== 'string' || accessToken === '') {
        throw new Error(
          'Google refused the service-account assertion: no access token in the answer',
        )
      }
      if (!Number.isFinite(expiresInSeconds) || expiresInSeconds < MIN_TOKEN_LIFETIME_SECONDS) {
        throw new Error(
          `Google refused the service-account assertion: the token's lifetime (${expiresInSeconds} s) is shorter than ${MIN_TOKEN_LIFETIME_SECONDS} s`,
        )
      }
      this.cached = { token: accessToken, expiresAt: this.now() + expiresInSeconds * 1000 }
      return accessToken
    })()
    this.inFlight = pending
    pending.then(
      () => {
        if (this.inFlight === pending) this.inFlight = undefined
        this.failures = 0
        this.blockedUntil = 0
        this.lastError = undefined
      },
      (err: unknown) => {
        // Cleared, so a failed exchange does not poison every later caller with the same
        // rejected promise; and the back-off starts, so nor does every later caller sign
        // and post an assertion of its own.
        if (this.inFlight === pending) this.inFlight = undefined
        this.failures += 1
        const wait = Math.min(RETRY_FIRST_MS * 2 ** (this.failures - 1), RETRY_MAX_MS)
        this.blockedUntil = this.now() + wait
        this.lastError = err instanceof Error ? err : new Error(String(err))
        // Whoever's exchange it was, the timer tries again when the back-off is over, so
        // the next attempt is never left to a ring (G14).
        this.scheduleRefresh(wait)
      },
    )
    return pending
  }
}
