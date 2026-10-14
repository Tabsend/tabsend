/**
 * The forwarder's one error envelope: `{ error: { code, message } }`, matching the
 * relay's shape so a client library reading both does not need two parsers.
 *
 * Invariant: a refusal here can only ever be about the SHAPE of a request, its RATE, or a
 * capability this DEPLOYMENT does not have. There is deliberately no code meaning "that
 * token does not exist", because answering that question would make the wake route a
 * token-validity oracle for anyone on the internet (PROTOCOL.md §4). If a future route
 * needs such a code, that section has to be rewritten first.
 */

export type ForwarderErrorCode =
  | 'invalid_request'
  | 'rate_limited'
  | 'internal'
  | 'not_found'
  /**
   * This forwarder is not configured for the push provider the caller asked for — only
   * reachable from `/v1/register`, and about the deployment rather than the request. It
   * says nothing about any token, so §4's oracle argument does not reach it: an Android
   * phone learns that THIS forwarder has no Google credentials, which it would learn
   * anyway the first time nothing rang, and learns it in time to fall back honestly
   * instead of believing it is set up.
   */
  | 'unsupported'

const STATUS: Record<ForwarderErrorCode, number> = {
  invalid_request: 400,
  not_found: 404,
  rate_limited: 429,
  // 501, not 400: the request was well formed and the caller cannot fix it by changing it.
  unsupported: 501,
  internal: 500,
}

export interface ForwarderErrorBody {
  error: { code: ForwarderErrorCode; message: string }
}

export class ForwarderError extends Error {
  readonly code: ForwarderErrorCode
  readonly statusCode: number
  /** Seconds to put in `Retry-After`, set on rate-limit refusals. */
  readonly retryAfterSeconds: number | undefined

  constructor(code: ForwarderErrorCode, message: string, retryAfterSeconds?: number) {
    super(message)
    this.name = 'ForwarderError'
    this.code = code
    this.statusCode = STATUS[code]
    this.retryAfterSeconds = retryAfterSeconds
  }

  toBody(): ForwarderErrorBody {
    return { error: { code: this.code, message: this.message } }
  }
}

/** Throw helper: `fail('invalid_request', '…')`. */
export function fail(code: ForwarderErrorCode, message: string, retryAfterSeconds?: number): never {
  throw new ForwarderError(code, message, retryAfterSeconds)
}
