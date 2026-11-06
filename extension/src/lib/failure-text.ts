import { ApiClientError } from './api'
import { t } from './i18n'
import { type RelayAction, relayErrorLine, UserFacingError } from './relay-errors'

/**
 * What a person reads when something failed. The one place that turns a thrown error into
 * text for a screen, so no screen has to read `err.message` (a test fails on that).
 *
 * - An error the relay answered with: a catalog sentence chosen by its code and by what the
 *   person was doing (`relayErrorLine`). A reply with no error envelope at all (an HTML 502
 *   from a proxy) says only the status, as it always has.
 * - An error Tabsend raised for the person (`UserFacingError`, which includes a bad relay
 *   address and a relay that is too old): its text, already a catalog sentence.
 * - Anything else is unexpected, and its text is a developer's, in English: say so plainly.
 *   (A request that never got an answer is the background's to name: see `isNetworkFailure`
 *   and rpc.ts. On a page a `TypeError` is a bug, not a dead relay.)
 */
export function failureText(err: unknown, during: RelayAction = 'other'): string {
  if (err instanceof ApiClientError) return relayFailureText(err, during)
  // relay-text-ignore: a UserFacingError carries a sentence from our own catalog
  if (err instanceof UserFacingError) return err.message
  return t('errors.generic')
}

/** The relay answered with an error: its code decides the sentence, never its message. */
export function relayFailureText(err: ApiClientError, during: RelayAction): string {
  return err.noEnvelope
    ? t('errors.api.requestFailed', { status: String(err.status) })
    : relayErrorLine(err.code, during)
}

/**
 * True when a request from the background worker never got an answer: no connection, or the
 * deadline in api.ts ran out. Only meaningful where the request was made (the worker).
 */
export function isNetworkFailure(err: unknown): boolean {
  return err instanceof TypeError || (err instanceof Error && err.name === 'TimeoutError')
}
