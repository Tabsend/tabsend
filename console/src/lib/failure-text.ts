import { ApiClientError } from './api'
import { t } from './i18n'
import { type RelayAction, relayErrorLine, UserFacingError } from './relay-errors'

/**
 * What the status line says when something failed. The one place that turns a thrown error
 * into text for the screen, so nothing reads `err.message` (a test fails on that).
 *
 * - An error the relay answered with: a catalog sentence chosen by its code and by what the
 *   person was doing (`relayErrorLine`). A reply with no error envelope at all (an HTML 502
 *   from a proxy) says only the status, as it always has.
 * - An error the console raised for the person (`UserFacingError`): its text, already a
 *   catalog sentence.
 * - The browser could not reach the relay (`fetch` rejects with a `TypeError`): the relay is
 *   not answering. `relayUrl` is '' when the relay is the page's own address.
 * - Anything else is unexpected, and its text is a developer's, in English: say what was being
 *   attempted instead.
 */
export function failureText(err: unknown, during: RelayAction, relayUrl: string): string {
  if (err instanceof ApiClientError) return relayFailureText(err, during)
  // relay-text-ignore: a UserFacingError carries a sentence from our own catalog
  if (err instanceof UserFacingError) return err.message
  if (err instanceof TypeError) {
    return relayUrl === ''
      ? t('status.unreachableSameOrigin')
      : t('status.unreachable', { relayUrl })
  }
  return unexpectedText(during)
}

/** The relay answered with an error: its code decides the sentence, never its message. */
export function relayFailureText(err: ApiClientError, during: RelayAction): string {
  return err.noEnvelope
    ? t('status.requestFailedHttp', { status: String(err.status) })
    : relayErrorLine(err.code, during)
}

/** What a failure nobody planned for says, by what was being attempted. */
function unexpectedText(during: RelayAction): string {
  switch (during) {
    case 'join':
      return t('status.joinFailed')
    case 'rename':
      return t('status.renameFailed')
    case 'remove':
      return t('status.removeFailed')
    case 'pairingLink':
      return t('status.setupLinkFailed')
    case 'stopReset':
    case 'other':
      return t('status.requestFailed')
  }
}
