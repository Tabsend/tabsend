import type { ApiErrorCode } from '@tabsend/shared'
import { ApiClientError } from './api'
import type { SendFailure } from './strings'

/**
 * Why a send didn't land, and whether the relay is answering at all.
 *
 * Before this module every non-`ApiClientError` send failure was reported as
 * "No connection — will send when you're back online" (send.ts's catch-all).
 * That copy is a *wrong diagnosis* for the self-hosted case: the browser's
 * connection is fine, it's the relay on the mini PC that isn't answering, and a
 * user told "no connection" checks their wifi and finds nothing wrong
 * (dogfood 2026-07-29: Firefox → Arc silently stopped delivering after the move
 * to a LAN relay, with no surface saying so). The split below is the whole
 * point: name the relay when the relay is the thing that's down.
 */

/**
 * True when the browser itself believes it has a network. `navigator.onLine` is
 * a weak signal (it's "the adapter is up", not "the internet works"), so it is
 * only ever used to DEMOTE a relay-unreachable diagnosis to a plain offline one
 * — never to skip a send attempt.
 */
export function isBrowserOnline(): boolean {
  const online = (globalThis as { navigator?: { onLine?: boolean } }).navigator?.onLine
  return online !== false
}

/**
 * Split a failed send into the cases the user can act on.
 *
 * A raw fetch rejection (TypeError) means the relay never answered. With the
 * adapter up that is a relay problem — wrong address, container down, TLS
 * refused — and naming the URL is the only way the user can act on it. An
 * `ApiClientError` means the relay DID answer, which is a different conversation
 * entirely — but not always the same one, because a relay can answer "no" or
 * "not now" and only the first of those is a reason to stop holding the tab.
 */
export function classifySendFailure(err: unknown, relayUrl: string): SendFailure {
  if (err instanceof ApiClientError) {
    if (err.status === 401) return { kind: 'relay-unauthorized' }
    // What decides whether the send is still worth holding is the STATUS, not
    // the code: the HTML 502 a reverse proxy returns while the relay restarts
    // carries no error envelope at all, so `parse` in api.ts can only label it
    // `internal`. Switching on the code alone read that as a permanent relay
    // bug and threw the tab away — for a queue drain, every tab in one pass.
    if (err.status === 429 || err.status >= 500) return { kind: 'relay-busy' }
    // Carry the CODE, not the relay's prose. `error.message` is explicitly
    // allowed to change and is written for whoever is reading a log — putting
    // it in a banner is how "Unknown target." reached the user.
    return { kind: 'relay-error', code: asApiErrorCode(err.code) }
  }
  if (!isBrowserOnline()) return { kind: 'browser-offline' }
  return { kind: 'relay-unreachable', relayUrl }
}

const API_ERROR_CODES = new Set<string>([
  'unauthorized',
  'endpoint_removed',
  'forbidden',
  'not_found',
  'invalid_request',
  'invalid_pairing_code',
  'group_exists',
  // Answered to a register/join call, where the endpoint cap refuses the device
  // with a 409 [0030], and to a pairing mint, where the live-link limit does
  // [0031 amended]. Never to a send: the per-group caps refuse a send per ITEM,
  // in the response body, not as a whole-request error. It is in the set so it
  // survives this fold: a code missing from here becomes `internal`, and
  // "something went wrong inside your relay" is a wrong diagnosis of a relay
  // behaving exactly as configured.
  'limit_reached',
  'rate_limited',
  'internal',
])

/** A relay speaking a newer dialect can send a code we have no copy for. */
function asApiErrorCode(code: string): ApiErrorCode {
  return (API_ERROR_CODES.has(code) ? code : 'internal') as ApiErrorCode
}

/**
 * The rolling verdict on "is our relay answering?", persisted so a surface the
 * user opens LATER (the chooser, options) can explain a standing outage rather
 * than only the send that happened to hit it. Fed by every authenticated call —
 * heartbeat, poll, endpoint list, send — so it stays fresh without its own probe.
 */
export interface RelayHealth {
  /** The relay this verdict is about; a stale verdict for another URL is ignored. */
  relayUrl: string
  /** Did the last call reach it (any HTTP answer counts — even a rejection)? */
  reachable: boolean
  /** ISO — when this reachable/unreachable state began. */
  since: string
  /** ISO — the last time a call actually reached this relay, if ever. */
  lastOkAt?: string
}

/** How long an outage must persist before surfaces call it out (avoid flapping). */
export const OUTAGE_GRACE_MS = 30_000

/**
 * True when the relay has been unreachable long enough to be worth telling the
 * user about. A single missed call during a laptop wake or a container restart
 * is noise; half a minute of silence is a fact.
 */
export function isRelayDown(health: RelayHealth | undefined, now: number): boolean {
  if (!health || health.reachable) return false
  return now - Date.parse(health.since) >= OUTAGE_GRACE_MS
}
