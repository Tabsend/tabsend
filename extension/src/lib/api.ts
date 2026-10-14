import type {
  ApiError,
  CreatePairingResponse,
  DeviceToken,
  Endpoint,
  GroupKeyRequest,
  GroupKeyResponse,
  GroupKeysResponse,
  HeartbeatRequest,
  HeartbeatResponse,
  HistoryResponse,
  ListEndpointsResponse,
  Message,
  OutboxMessagesResponse,
  PushSubscription,
  RegisterRequest,
  RegisterResponse,
  SendRequest,
  SendResponse,
  ServerConfigResponse,
  UpdateEndpointRequest,
} from '@tabsend/shared'
import { bearerAuth, isDefinitiveRemoval } from '@tabsend/shared'

/**
 * Thin REST client for the relay (@tabsend/shared §10). Auth is a per-endpoint
 * Bearer device token on everything except register.
 *
 * Two failure modes matter to callers:
 *  - `ApiClientError` — the relay answered with a non-2xx error envelope. The
 *    send pipeline surfaces these as hard errors.
 *  - a raw fetch rejection (TypeError) — the relay was unreachable. The send
 *    pipeline catches these and enqueues to the outbound queue.
 */
export class ApiClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ApiClientError'
  }
}

function join(relayUrl: string, path: string): string {
  return `${relayUrl.replace(/\/$/, '')}${path}`
}

/**
 * Fires when an AUTHENTICATED call is rejected. Registered once by identity.ts so
 * every call site (heartbeat, poll, send, rename, …) shares one place that
 * notices, instead of each swallowing the 401 as a generic failure.
 *
 * `definitive` says whether the relay PROVED this endpoint was removed from its
 * group, rather than merely failing to recognise the token — the latter is also
 * what a relay says when restarted on an empty database, and acting on it
 * destructively un-pairs healthy devices [shared §10b isDefinitiveRemoval].
 */
let onUnauthorized: ((definitive: boolean) => void) | undefined
export function setUnauthorizedHandler(handler: (definitive: boolean) => void): void {
  onUnauthorized = handler
}

/**
 * Fires when an AUTHENTICATED call SUCCEEDS. The counterpart to the above: an
 * ambiguous rejection leaves a warning behind, and the only honest proof that
 * the relay is itself again is a call that actually worked.
 */
let onAuthorized: (() => void) | undefined
export function setAuthorizedHandler(handler: () => void): void {
  onAuthorized = handler
}

/**
 * Fires on EVERY non-probe call with whether the relay answered at all. `ok`
 * means we got an HTTP response — a 500 still proves the relay is alive, which
 * is a different problem from "nothing is listening on that address".
 *
 * One handler for every call site (heartbeat, poll, endpoints, send) means the
 * relay-down verdict stays fresh from ordinary traffic, with no extra probe and
 * no per-call-site guessing.
 */
let onTransport: ((relayUrl: string, reachable: boolean) => void) | undefined
export function setTransportHandler(handler: (relayUrl: string, reachable: boolean) => void): void {
  onTransport = handler
}

async function parse<T>(res: Response, authenticated: boolean): Promise<T> {
  const text = await res.text()
  const body = text.length > 0 ? JSON.parse(text) : undefined
  if (!res.ok) {
    const err = body as ApiError | undefined
    if (authenticated && res.status === 401) {
      onUnauthorized?.(isDefinitiveRemoval(err?.error?.code ?? 'unauthorized'))
    }
    throw new ApiClientError(
      res.status,
      err?.error?.code ?? 'internal',
      err?.error?.message ?? `Request failed (${res.status}).`,
    )
  }
  if (authenticated) onAuthorized?.()
  return body as T
}

/**
 * How long to wait on a relay that has accepted the connection and then gone
 * quiet, before calling it unreachable.
 *
 * Without a deadline there isn't one short of the OS TCP timeout, and a relay
 * that black-holes (host asleep, VPN dropped, captive portal) left the chooser
 * showing "Loading…" for minutes rather than falling through to the cached list
 * and the relay-down strip — both of which exist precisely for this. Generous
 * enough for a slow phone tethering to a home server, far short of a hang.
 */
const REQUEST_TIMEOUT_MS = 8000

async function req<T>(
  method: string,
  relayUrl: string,
  path: string,
  opts: { token?: string; body?: unknown; probe?: boolean } = {},
): Promise<T> {
  const headers: Record<string, string> = {}
  if (opts.body !== undefined) headers['content-type'] = 'application/json'
  if (opts.token) headers.authorization = bearerAuth(opts.token as DeviceToken)
  let res: Response
  try {
    res = await fetch(join(relayUrl, path), {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      // A timeout lands here as an AbortError, which is exactly the shape the
      // catch below already handles: nothing answered, so record the relay as
      // unreachable and let the caller fall back to whatever it caches.
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (err) {
    // Nothing answered. A PROBE aims at a candidate URL that isn't our relay yet,
    // so its silence says nothing about the relay we're actually registered to.
    if (!opts.probe) onTransport?.(relayUrl, false)
    throw err
  }
  if (!opts.probe) onTransport?.(relayUrl, true)
  return parse<T>(res, Boolean(opts.token) && !opts.probe)
}

export function getConfig(relayUrl: string): Promise<ServerConfigResponse> {
  return req<ServerConfigResponse>('GET', relayUrl, '/v1/config', {})
}

export function register(relayUrl: string, body: RegisterRequest): Promise<RegisterResponse> {
  return req<RegisterResponse>('POST', relayUrl, '/v1/endpoints/register', { body })
}

export function listEndpoints(relayUrl: string, token: string): Promise<ListEndpointsResponse> {
  return req<ListEndpointsResponse>('GET', relayUrl, '/v1/endpoints', { token })
}

/**
 * Same call as `listEndpoints`, aimed at a CANDIDATE relay URL to prove the
 * device token is recognised there before adopting the address [P-4]. A 401
 * here means "that URL isn't our relay", not "our relay rejected us" — so it
 * must NOT fire the unauthorized handler (which would warn/unpair a healthy
 * registration over a bad address).
 */
export function probeEndpoints(relayUrl: string, token: string): Promise<ListEndpointsResponse> {
  return req<ListEndpointsResponse>('GET', relayUrl, '/v1/endpoints', { token, probe: true })
}

export function mintPairing(relayUrl: string, token: string): Promise<CreatePairingResponse> {
  return req<CreatePairingResponse>('POST', relayUrl, '/v1/pairing', { token })
}

/** PATCH /v1/endpoints/:id — rename (+ optionally set the device tie). */
export function updateEndpoint(
  relayUrl: string,
  token: string,
  endpointId: string,
  body: UpdateEndpointRequest,
): Promise<Endpoint> {
  return req<Endpoint>('PATCH', relayUrl, `/v1/endpoints/${encodeURIComponent(endpointId)}`, {
    token,
    body,
  })
}

/** DELETE /v1/endpoints/:id — remove an endpoint from the group. */
export function deleteEndpoint(
  relayUrl: string,
  token: string,
  endpointId: string,
): Promise<unknown> {
  return req<unknown>('DELETE', relayUrl, `/v1/endpoints/${encodeURIComponent(endpointId)}`, {
    token,
  })
}

export function sendMessages(
  relayUrl: string,
  token: string,
  body: SendRequest,
): Promise<SendResponse> {
  return req<SendResponse>('POST', relayUrl, '/v1/messages', { token, body })
}

export function getPending(relayUrl: string, token: string): Promise<Message[]> {
  return req<Message[]>('GET', relayUrl, '/v1/messages?pending=1', { token })
}

export function getOutbox(relayUrl: string, token: string): Promise<OutboxMessagesResponse> {
  return req<OutboxMessagesResponse>('GET', relayUrl, '/v1/messages?outbox=1', { token })
}

/**
 * GET /v1/messages?history=1 — the caller's whole GROUP, newest first [ADR-0028].
 * Blobs are opaque here; opening them needs a group key the relay never holds.
 */
export function getHistory(relayUrl: string, token: string): Promise<HistoryResponse> {
  return req<HistoryResponse>('GET', relayUrl, '/v1/messages?history=1', { token })
}

/** GET /v1/group-keys — every copy of a group key sealed TO this endpoint. */
export function getGroupKeys(relayUrl: string, token: string): Promise<GroupKeysResponse> {
  return req<GroupKeysResponse>('GET', relayUrl, '/v1/group-keys', { token })
}

/** POST /v1/group-keys — hand the current group key to members that lack it. */
export function postGroupKeys(
  relayUrl: string,
  token: string,
  body: GroupKeyRequest,
): Promise<GroupKeyResponse> {
  return req<GroupKeyResponse>('POST', relayUrl, '/v1/group-keys', { token, body })
}

/**
 * True when the relay ANSWERED but does not implement ADR-0028.
 *
 * A browser extension updates itself and a self-hosted relay is updated by hand,
 * so new-client-against-old-relay is the normal state for a while, not an edge
 * case. An older relay refuses `?history=1` with `invalid_request` (it knows only
 * `?pending=1` and `?outbox=1`) and has no `/v1/group-keys` route at all. Both
 * mean exactly "this relay has no group history" — a fact about the relay, never
 * an error to show anyone and never a reason to retry harder.
 */
export function isHistoryUnsupported(err: unknown): boolean {
  if (!(err instanceof ApiClientError)) return false
  return err.status === 404 || (err.status === 400 && err.code === 'invalid_request')
}

export function ackMessage(relayUrl: string, token: string, id: string): Promise<unknown> {
  return req<unknown>('POST', relayUrl, `/v1/messages/${encodeURIComponent(id)}/ack`, { token })
}

export function heartbeat(
  relayUrl: string,
  token: string,
  endpointId: string,
  pushSubscription?: PushSubscription,
): Promise<HeartbeatResponse> {
  const body: HeartbeatRequest = pushSubscription ? { pushSubscription } : {}
  return req<HeartbeatResponse>(
    'POST',
    relayUrl,
    `/v1/endpoints/${encodeURIComponent(endpointId)}/heartbeat`,
    { token, body },
  )
}
