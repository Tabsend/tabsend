import type {
  BrowserFamily,
  EncryptedEnvelope,
  EndpointKind,
  GroupSealed,
  Platform,
  PushSubscription,
} from '@tabsend/shared'
import { AppError } from './errors'
import { validatePushEndpoint } from './push-egress'

const ENDPOINT_KINDS: readonly EndpointKind[] = ['extension', 'mobile', 'console']
const BROWSER_FAMILIES: readonly BrowserFamily[] = [
  'chrome',
  'firefox',
  'edge',
  'brave',
  'opera',
  'vivaldi',
  'arc',
  'other',
]
const PLATFORMS: readonly Platform[] = ['macos', 'windows', 'linux', 'android', 'ios', 'unknown']

export function asObject(body: unknown, what = 'request body'): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new AppError('invalid_request', `Expected a JSON object ${what}.`)
  }
  return body as Record<string, unknown>
}

export function reqString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key]
  if (typeof v !== 'string' || v.length === 0) {
    throw new AppError(
      'invalid_request',
      `Missing or invalid "${key}" (expected non-empty string).`,
    )
  }
  refuseNul(v, key)
  return v
}

/**
 * Refuse a NUL character in a string the relay may store [2026-10-01]. JSON can carry
 * one; Postgres text cannot hold one and failed the whole request with a 500, while
 * SQLite stored it, so the same body got two different answers depending on the
 * database. No field this relay accepts has any use for one.
 */
function refuseNul(v: string, key: string): void {
  if (v.includes('\u0000')) {
    throw new AppError('invalid_request', `"${key}" must not contain a NUL character.`)
  }
}

/**
 * The longest client-chosen id the relay stores [2026-10-01 follow-up review, R7].
 *
 * Every id a real client sends is far shorter: a message id is a UUID (36 characters)
 * and a group-key delivery id is `gk-<keyId>-<endpointId>` (83). Unbounded, an id was
 * the one part of a stored row nothing measured: it rode past the group-key size bound
 * and the byte caps alike (neither counts it), a single one could be most of a 1 MiB
 * request, and on Postgres a long one failed the primary-key index and answered 500.
 */
export const MAX_ID_LENGTH = 128

/** A required id: a non-empty string no longer than {@link MAX_ID_LENGTH}. */
export function reqId(obj: Record<string, unknown>, key: string): string {
  const v = reqString(obj, key)
  if (v.length > MAX_ID_LENGTH) {
    throw new AppError(
      'invalid_request',
      `"${key}" must be at most ${MAX_ID_LENGTH} characters. Ids the relay stores are short handles, never content.`,
    )
  }
  return v
}

export function optString(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string') {
    throw new AppError('invalid_request', `Invalid "${key}" (expected string).`)
  }
  refuseNul(v, key)
  return v
}

export function reqEnum<T extends string>(
  obj: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T {
  const v = reqString(obj, key)
  if (!(allowed as readonly string[]).includes(v)) {
    throw new AppError('invalid_request', `Invalid "${key}": ${v}.`)
  }
  return v as T
}

/**
 * Like reqEnum, but an unrecognized VALUE degrades to `fallback` instead of 400.
 * For descriptive enums (browser, platform) whose values only label a device:
 * a client newer than this relay must still be able to register. Wrong TYPES
 * (missing / non-string) still throw — that's a malformed request, not skew.
 */
export function reqEnumOr<T extends string>(
  obj: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const v = reqString(obj, key)
  return (allowed as readonly string[]).includes(v) ? (v as T) : fallback
}

// `kind` stays strict (reqEnum): it selects routing/behaviour, so an unknown
// value is a request this relay genuinely cannot serve.
export function reqKind(obj: Record<string, unknown>): EndpointKind {
  return reqEnum(obj, 'kind', ENDPOINT_KINDS)
}

export function reqPlatform(obj: Record<string, unknown>): Platform {
  return reqEnumOr(obj, 'platform', PLATFORMS, 'unknown')
}

/** `browser` is `BrowserFamily | null` (null for console / unknown). */
export function reqBrowser(obj: Record<string, unknown>): BrowserFamily | null {
  const v = obj.browser
  if (v === null || v === undefined) return null
  if (typeof v !== 'string' || v.length === 0) {
    throw new AppError('invalid_request', `Invalid "browser": ${String(v)}.`)
  }
  return (BROWSER_FAMILIES as readonly string[]).includes(v) ? (v as BrowserFamily) : 'other'
}

/**
 * The relay settings that decide which push subscriptions it can honour. Structurally
 * a slice of `Config`, so both call sites pass `ctx.config` and nothing has to be
 * unpacked and re-packed on the way in.
 */
export interface PushPolicy {
  pushAllowPrivateEndpoints: boolean
  /** Set ⇒ this relay can ring the wake-up forwarder, so `forwarder` is acceptable. */
  wakeForwarderUrl?: string
}

/**
 * Refusal for a `forwarder` registration on a relay with no forwarder [0032].
 *
 * REFUSED, not accepted-and-never-rung. Silent acceptance would leave a phone paired,
 * apparently set up for background delivery, and permanently silent — with nothing
 * anywhere to look at. And the client can see this coming: `GET /v1/config` carries
 * `wakeForwarder`, so a phone app reads the hint and registers `{transport:'none'}`
 * instead. A refusal it could have avoided is a bug in the client; a silence nobody
 * can diagnose is a bug in the relay.
 *
 * Register-path messages ride through to the user verbatim (ADR-0029), so this says
 * what to do rather than only what went wrong, and names the setting for whoever runs
 * the relay.
 */
const NO_WAKE_FORWARDER_MESSAGE =
  'This relay has no wake-up forwarder, so it cannot wake a phone in the background. Register with pushSubscription.transport "none" instead: an iPhone then collects its tabs when the app is opened, and an Android phone keeps its own connection. Or ask whoever runs this relay to set WAKE_FORWARDER_URL.'

export function reqPushSubscription(
  obj: Record<string, unknown>,
  policy: PushPolicy,
): PushSubscription {
  const sub = asObject(obj.pushSubscription, '"pushSubscription"')
  const transport = sub.transport
  if (transport === 'webpush') {
    const keys = asObject(sub.keys, '"pushSubscription.keys"')
    const endpoint = reqString(sub, 'endpoint')
    validatePushEndpoint(endpoint, policy.pushAllowPrivateEndpoints)
    return {
      transport: 'webpush',
      endpoint,
      keys: { p256dh: reqString(keys, 'p256dh'), auth: reqString(keys, 'auth') },
    }
  }
  if (transport === 'unifiedpush') {
    const endpoint = reqString(sub, 'endpoint')
    validatePushEndpoint(endpoint, policy.pushAllowPrivateEndpoints)
    return { transport: 'unifiedpush', endpoint }
  }
  if (transport === 'fcm') {
    return { transport: 'fcm', token: reqString(sub, 'token') }
  }
  if (transport === 'none') {
    // No wake channel [0015]: WS fast path + client polling deliver; wake() no-ops.
    return { transport: 'none' }
  }
  if (transport === 'forwarder') {
    if (policy.wakeForwarderUrl === undefined) {
      throw new AppError('invalid_request', NO_WAKE_FORWARDER_MESSAGE)
    }
    // ONLY the token is kept. Any url/endpoint the caller also sent is dropped here
    // rather than refused, because it is not part of the contract to begin with
    // (shared §2 has no such field) — the relay rings the forwarder ITS OPERATOR
    // configured, and a register body must never be able to choose that. Returning a
    // fresh literal instead of `sub` is what makes that structural rather than a rule
    // somebody has to remember.
    return { transport: 'forwarder', wakeToken: reqString(sub, 'wakeToken') }
  }
  throw new AppError(
    'invalid_request',
    `Invalid "pushSubscription.transport": ${String(transport)}.`,
  )
}

export function reqEnvelope(obj: Record<string, unknown>): EncryptedEnvelope {
  const env = asObject(obj.envelope, '"envelope"')
  if (env.alg !== 'x25519-xsalsa20-poly1305/box') {
    throw new AppError('invalid_request', `Invalid "envelope.alg": ${String(env.alg)}.`)
  }
  return {
    alg: 'x25519-xsalsa20-poly1305/box',
    senderKeyId: reqString(env, 'senderKeyId'),
    targetKeyId: reqString(env, 'targetKeyId'),
    nonce: reqString(env, 'nonce'),
    ciphertext: reqString(env, 'ciphertext'),
  }
}

/**
 * The optional group-history blob on a send item [0028]. Absent for a pre-0028
 * sender or a group with no history key, which is why this returns undefined
 * rather than failing — an old client must keep sending successfully.
 *
 * Shape only, exactly like `reqEnvelope`: the relay holds no key that can open
 * this and validates nothing about its contents (ADR-0016 — it imports no crypto).
 */
export function optGroupSealed(obj: Record<string, unknown>): GroupSealed | undefined {
  if (obj.history === undefined || obj.history === null) return undefined
  const blob = asObject(obj.history, '"history"')
  if (blob.alg !== 'xsalsa20-poly1305/secretbox') {
    throw new AppError('invalid_request', `Invalid "history.alg": ${String(blob.alg)}.`)
  }
  return {
    alg: 'xsalsa20-poly1305/secretbox',
    keyId: reqString(blob, 'keyId'),
    nonce: reqString(blob, 'nonce'),
    ciphertext: reqString(blob, 'ciphertext'),
  }
}
