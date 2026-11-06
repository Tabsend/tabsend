import { t } from './i18n'

/**
 * The console's own words for an error the relay answered with.
 *
 * The relay's `message` is written for a log, may change at any time, and is always
 * English (`shared/src/types.ts` §10b). So no screen shows it. The status line asks this
 * module instead, which looks only at the machine-readable `code` (docs/L10N.md, rule 8)
 * and answers with a catalog sentence. A code this build has never heard of reads as an
 * internal error, which is also what the relay means by `internal`.
 *
 * The same code can mean different things in different places: `not_found` on a rename is a
 * device that is gone, on a new setup link it is the whole group. That is the only reason a
 * caller says what it was doing. The browser extension and the iPhone app word their errors
 * the same way, and the English matches wherever the situation does.
 */

/** What the person was doing when the relay said no. */
export type RelayAction =
  | 'join'
  | 'rename'
  | 'remove'
  /** "Add a device": making a setup link. */
  | 'pairingLink'
  | 'stopReset'
  /** Anything else: a request with no status line of its own. */
  | 'other'

/**
 * An error whose text is already a catalog sentence, safe to put in front of a person (a relay
 * that is too old, a setup link the relay made that cannot be used). Any other error is
 * unexpected, and the status line says a plain sentence for it instead of its text
 * (`failureText`).
 */
export class UserFacingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UserFacingError'
  }
}

/** The sentence for one relay error code, by what the person was doing. Never the relay's text. */
export function relayErrorLine(code: string, during: RelayAction): string {
  switch (code) {
    case 'unauthorized':
    case 'endpoint_removed':
      return t('status.relay.unauthorized')
    case 'forbidden':
      return t('status.relay.forbidden')
    case 'not_found':
      switch (during) {
        case 'rename':
        case 'remove':
          return t('status.relay.deviceNotFound')
        case 'join':
          return t('status.relay.addressNotRelay')
        default:
          return t('status.relay.groupNotFound')
      }
    case 'invalid_request':
      return t('status.relay.invalidRequest')
    case 'invalid_pairing_code':
      return during === 'join' ? t('status.relay.linkUnusable') : t('status.relay.linkInvalid')
    case 'group_exists':
      return t('status.relay.groupExists')
    case 'limit_reached':
      switch (during) {
        case 'join':
          return t('status.relay.deviceLimit')
        case 'pairingLink':
          return t('status.relay.linkLimit')
        default:
          return t('status.relay.limit')
      }
    case 'rate_limited':
      return t('status.relay.busy')
    default:
      // `internal`, and any code a newer relay has that this build does not know.
      return t('status.relay.unexplained')
  }
}
