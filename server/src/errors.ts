import type { ApiError, ApiErrorCode } from '@tabsend/shared'

/** HTTP status for each machine-readable error code (see @tabsend/shared §10b). */
const STATUS: Record<ApiErrorCode, number> = {
  unauthorized: 401,
  // Also a 401: same auth outcome, but the client is told it is DEFINITIVE.
  endpoint_removed: 401,
  forbidden: 403,
  not_found: 404,
  invalid_request: 400,
  invalid_pairing_code: 400,
  // 409 Conflict, not 400: the request is well-formed and would have been valid on an
  // empty relay — it conflicts with the relay's current state (ADR-0022).
  group_exists: 409,
  // 409 for the same reason [0030]: the call is well formed and would have succeeded
  // one device ago; it conflicts with how full the group already is. NOT 429, which
  // would be a lie in both directions — nothing here is per-second, and every client
  // reads a 429 as "not now, hold the tab and retry", so a permanently full group
  // would be retried forever instead of reported (extension health.ts, SendFeedback).
  limit_reached: 409,
  rate_limited: 429,
  internal: 500,
}

/**
 * A thrown AppError becomes the contract's single error envelope
 * ({ error: { code, message } }) at the Fastify error handler.
 */
export class AppError extends Error {
  readonly code: ApiErrorCode
  readonly statusCode: number

  constructor(code: ApiErrorCode, message: string) {
    super(message)
    this.name = 'AppError'
    this.code = code
    this.statusCode = STATUS[code]
  }

  toBody(): ApiError {
    return { error: { code: this.code, message: this.message } }
  }
}

/** Throw helper: `fail('not_found', 'endpoint gone')`. */
export function fail(code: ApiErrorCode, message: string): never {
  throw new AppError(code, message)
}

/**
 * The body Fastify's not-found handler sends for a URL this relay does not serve.
 *
 * Exported because two guards deliberately IMPERSONATE it: `/admin/status` and the
 * `/admin/provisioning` routes [0031] answer a caller who fails their locality or
 * credential test with exactly this, so an unauthorised caller cannot tell an operator
 * surface apart from a typo. That only works while the bytes match, which is why there
 * is one literal rather than three.
 */
export const NOT_FOUND_BODY: ApiError = {
  error: { code: 'not_found', message: 'Route not found.' },
}
