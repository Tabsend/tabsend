import type {
  ApiError,
  CreatePairingResponse,
  DeviceToken,
  Endpoint,
  GroupKeysResponse,
  GroupStateResponse,
  HeartbeatResponse,
  HistoryResponse,
  ListEndpointsResponse,
  Message,
  PushSubscription,
  RegisterRequest,
  RegisterResponse,
  ServerConfigResponse,
  StopGroupResetResponse,
  UpdateEndpointRequest,
} from '@tabsend/shared'
import { bearerAuth } from '@tabsend/shared'

/**
 * Thin REST client for the relay (@tabsend/shared §10), the console's subset. Auth
 * is a per-endpoint Bearer device token on everything except register + config.
 *
 * `relayUrl` is usually '' (same-origin: the console is served by the relay, or the
 * dev server proxies `/v1` to it), so requests are relative `/v1/...`. A self-hoster
 * pointing the console at a different origin passes an absolute base.
 *
 * Two failure modes matter to callers:
 *  - `ApiClientError` — the relay answered with a non-2xx error envelope.
 *  - a raw fetch rejection (TypeError) — the relay was unreachable (offline).
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

/** Injectable fetch so tests can drive the client without a network. */
export type FetchLike = typeof fetch

function join(relayUrl: string, path: string): string {
  return `${relayUrl.replace(/\/$/, '')}${path}`
}

async function parse<T>(res: Response): Promise<T> {
  const text = await res.text()
  const body = text.length > 0 ? JSON.parse(text) : undefined
  if (!res.ok) {
    const err = body as ApiError | undefined
    throw new ApiClientError(
      res.status,
      err?.error?.code ?? 'internal',
      err?.error?.message ?? `Request failed (${res.status}).`,
    )
  }
  return body as T
}

export interface ApiOptions {
  relayUrl: string
  fetchImpl?: FetchLike
}

async function req<T>(
  method: string,
  opts: ApiOptions,
  path: string,
  extra: { token?: string; body?: unknown } = {},
): Promise<T> {
  const headers: Record<string, string> = {}
  if (extra.body !== undefined) headers['content-type'] = 'application/json'
  if (extra.token) headers.authorization = bearerAuth(extra.token as DeviceToken)
  const doFetch = opts.fetchImpl ?? fetch
  const res = await doFetch(join(opts.relayUrl, path), {
    method,
    headers,
    body: extra.body === undefined ? undefined : JSON.stringify(extra.body),
  })
  return parse<T>(res)
}

/** GET /v1/config — relay capabilities (unauthenticated). Tells us if push is on. */
export function getConfig(opts: ApiOptions): Promise<ServerConfigResponse> {
  return req<ServerConfigResponse>('GET', opts, '/v1/config')
}

/** POST /v1/endpoints/register — join a group as this console (pairingCode required). */
export function register(opts: ApiOptions, body: RegisterRequest): Promise<RegisterResponse> {
  return req<RegisterResponse>('POST', opts, '/v1/endpoints/register', { body })
}

/** GET /v1/endpoints — every endpoint in the group (console renders the whole list). */
export function listEndpoints(opts: ApiOptions, token: string): Promise<ListEndpointsResponse> {
  return req<ListEndpointsResponse>('GET', opts, '/v1/endpoints', { token })
}

/** PATCH /v1/endpoints/:id — rename any endpoint in the group. */
export function renameEndpoint(
  opts: ApiOptions,
  token: string,
  id: string,
  label: string,
): Promise<Endpoint> {
  const body: UpdateEndpointRequest = { label }
  return req<Endpoint>('PATCH', opts, `/v1/endpoints/${encodeURIComponent(id)}`, { token, body })
}

/** DELETE /v1/endpoints/:id — remove an endpoint from the group. */
export function deleteEndpoint(opts: ApiOptions, token: string, id: string): Promise<unknown> {
  return req<unknown>('DELETE', opts, `/v1/endpoints/${encodeURIComponent(id)}`, { token })
}

/** POST /v1/pairing — mint a short-lived join code (the "add a device" surface). */
export function mintPairing(opts: ApiOptions, token: string): Promise<CreatePairingResponse> {
  return req<CreatePairingResponse>('POST', opts, '/v1/pairing', { token })
}

/** GET /v1/messages?pending=1 — ADR-0010 history copies waiting for THIS console. */
export function getPending(opts: ApiOptions, token: string): Promise<Message[]> {
  return req<Message[]>('GET', opts, '/v1/messages?pending=1', { token })
}

/** GET /v1/messages?history=1 — the whole group's history, newest first [ADR-0028]. */
export function getGroupHistory(opts: ApiOptions, token: string): Promise<HistoryResponse> {
  return req<HistoryResponse>('GET', opts, '/v1/messages?history=1', { token })
}

/** GET /v1/group-keys — every group history key copy sealed to this console [ADR-0028]. */
export function getGroupKeys(opts: ApiOptions, token: string): Promise<GroupKeysResponse> {
  return req<GroupKeysResponse>('GET', opts, '/v1/group-keys', { token })
}

/**
 * GET /v1/group — whether a reset is waiting for this console's group (PLANS.md
 * P-18 item 12). An older relay has no such route and answers 404, read as "none".
 */
export function getGroupState(opts: ApiOptions, token: string): Promise<GroupStateResponse> {
  return req<GroupStateResponse>('GET', opts, '/v1/group', { token })
}

/** POST /v1/group/reset/stop — stop a waiting reset. Answers `{ reset: null }` either way. */
export function stopGroupReset(opts: ApiOptions, token: string): Promise<StopGroupResetResponse> {
  return req<StopGroupResetResponse>('POST', opts, '/v1/group/reset/stop', { token, body: {} })
}

/**
 * Does this error mean the relay simply predates group history?
 *
 * A relay older than ADR-0028 answers `?history=1` with 400 `invalid_request`
 * (it knows only `?pending=1` and `?outbox=1`) and `/v1/group-keys` with 404.
 * Both are the relay saying "that feature is not here", which is a state to
 * report calmly and fall back from, not a failure: the console is served by the
 * relay, but a tab left open across an upgrade, or a self-hosted relay updated
 * by hand, puts a new console in front of an old relay routinely.
 *
 * Everything else (a network drop, 401, 5xx) is deliberately NOT swallowed here.
 * Those are outages or auth problems, and treating them as "no such feature"
 * would permanently disable the panel over a blip.
 */
export function isMissingRouteError(err: unknown): boolean {
  return err instanceof ApiClientError && (err.status === 400 || err.status === 404)
}

/** POST /v1/messages/:id/ack — confirm we recorded the copy; relay deletes the payload. */
export function ackMessage(opts: ApiOptions, token: string, id: string): Promise<unknown> {
  return req<unknown>('POST', opts, `/v1/messages/${encodeURIComponent(id)}/ack`, { token })
}

/** POST /v1/endpoints/:id/heartbeat — refresh presence (keeps the console "online"). */
export function heartbeat(
  opts: ApiOptions,
  token: string,
  endpointId: string,
  pushSubscription?: PushSubscription,
): Promise<HeartbeatResponse> {
  const body = pushSubscription ? { pushSubscription } : {}
  return req<HeartbeatResponse>(
    'POST',
    opts,
    `/v1/endpoints/${encodeURIComponent(endpointId)}/heartbeat`,
    { token, body },
  )
}
