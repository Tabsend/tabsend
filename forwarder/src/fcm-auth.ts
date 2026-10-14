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

/** Back-off for a refresh that failed: start here, double, stop doubling at the cap. */
const RETRY_FIRST_MS = 30 * 1000
const RETRY_MAX_MS = 10 * 60 * 1000

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
  try {
    return { projectId, clientEmail, privateKey: createPrivateKey(privateKeyPem) }
  } catch (cause) {
    throw new Error(
      "The service account's private_key could not be read as a PEM key. The usual cause is a copy that lost its newlines: in the JSON the key is one line with literal \\n escapes, and those must survive into whatever supplies FCM_SERVICE_ACCOUNT_JSON.",
      { cause },
    )
  }
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

/** The real exchange: one form post to Google's token endpoint. */
export const fetchAccessToken: TokenExchange = async (assertion, timeoutMs) => {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const body: unknown = await response.json().catch(() => ({}))
  const bag = (body ?? {}) as Record<string, unknown>
  if (!response.ok || typeof bag.access_token !== 'string') {
    // `error_description` is Google's own words about a credential problem, and an
    // operator with a misconfigured service account needs them. It describes the
    // forwarder's credential, never a user or a device.
    const detail =
      typeof bag.error_description === 'string'
        ? bag.error_description
        : typeof bag.error === 'string'
          ? bag.error
          : `HTTP ${response.status}`
    throw new Error(`Google refused the service-account assertion: ${detail}`)
  }
  const expiresIn = typeof bag.expires_in === 'number' ? bag.expires_in : 3600
  return { accessToken: bag.access_token, expiresInSeconds: expiresIn }
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
  private retryMs = RETRY_FIRST_MS

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

  async current(): Promise<string> {
    if (this.cached && this.now() < this.cached.expiresAt - EXPIRY_MARGIN_MS) {
      return this.cached.token
    }
    return this.exchangeShared()
  }

  private refresh(): void {
    this.cancelTimer = undefined
    this.exchangeShared().then(
      () => {
        this.retryMs = RETRY_FIRST_MS
        const lifetime = (this.cached?.expiresAt ?? this.now()) - this.now()
        const ahead =
          lifetime > 2 * REFRESH_AHEAD_MS ? lifetime - REFRESH_AHEAD_MS : Math.floor(lifetime / 2)
        this.scheduleRefresh(Math.min(Math.max(ahead, MIN_REFRESH_GAP_MS), MAX_REFRESH_GAP_MS))
      },
      (err: unknown) => {
        this.onRefreshError?.(err instanceof Error ? err : new Error(String(err)))
        const wait = this.retryMs
        this.retryMs = Math.min(this.retryMs * 2, RETRY_MAX_MS)
        this.scheduleRefresh(wait)
      },
    )
  }

  private scheduleRefresh(delayMs: number): void {
    if (!this.running) return
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
      this.cached = { token: accessToken, expiresAt: this.now() + expiresInSeconds * 1000 }
      return accessToken
    })()
    this.inFlight = pending
    // Cleared whether it resolved or threw, so a failed exchange does not poison every
    // later caller with the same rejected promise.
    const clear = () => {
      if (this.inFlight === pending) this.inFlight = undefined
    }
    pending.then(clear, clear)
    return pending
  }
}
