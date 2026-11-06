import { t } from './i18n'

/**
 * The extension's own words for an error the relay answered with.
 *
 * The relay's `message` is written for a log, may change at any time, and is always
 * English (`shared/src/types.ts` §10b). So no screen shows it. A screen asks this module
 * instead, which looks only at the machine-readable `code` (docs/L10N.md, rule 8) and
 * answers with a catalog sentence. A code this build has never heard of reads as an
 * internal error, which is also what the relay means by `internal`.
 *
 * The same code can mean different things in different places: `not_found` on a rename is
 * a device that is gone, on a new setup link it is the whole group. That is the only reason
 * a caller says what it was doing. The iPhone app words its errors the same way
 * (`RelayErrorText.swift`), and the English matches wherever the situation does.
 */

/** What the person was doing when the relay said no. */
export type RelayAction =
  /** Pairing this browser with a setup link (and naming it on the way in). */
  | 'join'
  | 'rename'
  | 'remove'
  /** "Add a device": making a setup link. */
  | 'pairingLink'
  | 'stopReset'
  /** Looking at another relay's address (settings, "Check the relay address"). */
  | 'check'
  /** Anything else: a list that would not load, a poll, a request with no screen of its own. */
  | 'other'

/**
 * An error whose text is already a catalog sentence, safe to put in front of a person. The
 * background worker throws these for its own wording; they cross to the pages as text and
 * come back as this type. Any other error is unexpected, and a screen says
 * `errors.generic` for it instead of its text (`failureText`).
 */
export class UserFacingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UserFacingError'
  }
}

/**
 * The sentence for one relay error code, by what the person was doing. Never the relay's
 * own text. The sentences that already exist for sends are reused where the words are
 * the same.
 */
export function relayErrorLine(code: string, during: RelayAction): string {
  switch (code) {
    case 'unauthorized':
    case 'endpoint_removed':
      return t('errors.relay.unauthorized')
    case 'forbidden':
      return t('errors.relay.forbidden')
    case 'not_found':
      switch (during) {
        case 'rename':
        case 'remove':
          return t('errors.relay.deviceNotFound')
        case 'join':
        case 'check':
          return t('errors.relay.addressNotRelay')
        default:
          return t('errors.relay.groupNotFound')
      }
    case 'invalid_request':
      return t('errors.relay.invalidRequest')
    case 'invalid_pairing_code':
      return during === 'join'
        ? t('errors.relay.linkUnusable')
        : t('send.failure.error.invalidPairingCode')
    case 'group_exists':
      return t('send.failure.error.groupExists')
    case 'limit_reached':
      switch (during) {
        case 'join':
          return t('send.failure.deviceLimit')
        case 'pairingLink':
          return t('errors.relay.linkLimit')
        default:
          return t('errors.relay.limit')
      }
    case 'rate_limited':
      return t('errors.relay.busy')
    default:
      // `internal`, and any code a newer relay has that this build does not know.
      return t('send.failure.unexplained')
  }
}
