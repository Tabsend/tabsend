package io.tabsend.app.logic

import io.tabsend.app.R

/**
 * The phone's own words for an error the relay answered with. The Android twin of iOS's
 * `RelayErrorText` (`ios/TabsendKit`), with the same sentence for the same code.
 *
 * The relay's `message` is written for a log, may change at any time, and is always English
 * (`shared/src/types.ts` §10b). So no screen shows it. A screen asks this instead, which looks
 * only at the machine-readable `code` (docs/L10N.md, rule 8) and answers with a catalog
 * sentence. A code this app has never heard of reads as an internal error, which is also what
 * the relay means by `internal`. The phone says less than the relay did: no count of pairing
 * links, no suspension details.
 *
 * The same code can mean different things in different places: `not_found` on a rename is a
 * device that is gone, on a new pairing link it is the whole group. That is the only reason a
 * caller says what it was doing.
 */
object RelayErrorText {
    /** What the person was doing when the relay said no. */
    enum class Action {
        RENAME_DEVICE,
        REMOVE_DEVICE,
        PAIRING_LINK,
        STOP_RESET,

        /** Pairing this phone with a setup link. */
        JOIN,

        /** Looking at another relay's address (moving to a different relay). */
        CHECK,
    }

    fun line(text: TextSource, code: String, during: Action): String = when (code) {
        "unauthorized", "endpoint_removed" -> text.string(R.string.relay_error_unauthorized)
        "forbidden" -> text.string(R.string.relay_error_forbidden)
        "not_found" -> when (during) {
            Action.RENAME_DEVICE, Action.REMOVE_DEVICE -> text.string(R.string.relay_error_device_not_found)
            Action.PAIRING_LINK, Action.STOP_RESET -> text.string(R.string.relay_error_group_not_found)
            Action.JOIN, Action.CHECK -> text.string(R.string.relay_error_address_not_found)
        }
        "invalid_request" -> text.string(R.string.relay_error_invalid_request)
        "invalid_pairing_code" ->
            if (during == Action.JOIN) {
                text.string(R.string.relay_error_pairing_code_join)
            } else {
                text.string(R.string.relay_error_pairing_code_gone)
            }
        "group_exists" -> text.string(R.string.relay_line_group_exists)
        "limit_reached" -> when (during) {
            Action.JOIN -> Feedback.deviceLimitLine(text)
            Action.PAIRING_LINK -> text.string(R.string.relay_error_too_many_links)
            else -> text.string(R.string.relay_error_limit_general)
        }
        "rate_limited" -> text.string(R.string.relay_error_rate_limited)
        else -> text.string(R.string.relay_line_internal)
    }
}
