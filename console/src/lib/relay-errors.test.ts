import { describe, expect, it } from 'vitest'
import { ApiClientError } from './api'
import { failureText } from './failure-text'
import { type RelayAction, relayErrorLine, UserFacingError } from './relay-errors'

/**
 * The console's own words for what the relay says (`relayErrorLine`), the way the browser
 * extension and the iPhone app word it. The exact English is pinned in the golden file; these
 * are the rules.
 */
const ACTIONS: RelayAction[] = ['join', 'rename', 'remove', 'pairingLink', 'stopReset', 'other']
const CODES = [
  'unauthorized',
  'endpoint_removed',
  'forbidden',
  'not_found',
  'invalid_request',
  'invalid_pairing_code',
  'group_exists',
  'limit_reached',
  'rate_limited',
  'internal',
]

describe('relayErrorLine', () => {
  it('has words for every code on every screen, with no em dash', () => {
    for (const during of ACTIONS) {
      for (const code of CODES) {
        const line = relayErrorLine(code, during)
        expect(line, `${code} during ${during}`).not.toBe('')
        expect(line, `${code} during ${during}`).not.toContain('—')
      }
    }
  })

  it("never shows the relay's own message", () => {
    for (const during of ACTIONS) {
      for (const code of [...CODES, 'from_a_newer_relay']) {
        const err = new ApiClientError(400, code, 'Relay wording that must not show up.')
        expect(failureText(err, during, ''), `${code} during ${during}`).not.toContain(
          'Relay wording',
        )
      }
    }
  })

  it('means a device or the whole group for not_found, depending on the screen', () => {
    const device = relayErrorLine('not_found', 'remove')
    expect(device).toBe(relayErrorLine('not_found', 'rename'))
    const group = relayErrorLine('not_found', 'pairingLink')
    expect(group).toBe(relayErrorLine('not_found', 'stopReset'))
    expect(device).not.toBe(group)
  })

  it('reads a code from a newer relay as an internal error', () => {
    for (const during of ACTIONS) {
      expect(relayErrorLine('from_a_newer_relay', during)).toBe(relayErrorLine('internal', during))
    }
  })
})

describe('failureText', () => {
  it('says the status when the reply had no error envelope at all', () => {
    const err = new ApiClientError(502, 'internal', 'x', true)
    expect(failureText(err, 'remove', '')).toBe('Request failed (502).')
  })

  it('says the relay is not answering when the request got no answer', () => {
    expect(failureText(new TypeError('Failed to fetch'), 'rename', '')).toBe(
      "Couldn't reach this relay. Is the relay running and reachable?",
    )
    expect(failureText(new TypeError('Failed to fetch'), 'rename', 'https://relay.example')).toBe(
      "Couldn't reach https://relay.example. Is the relay running and reachable?",
    )
  })

  it("passes on a sentence the console chose, and nothing else's text", () => {
    expect(
      failureText(
        new UserFacingError('The relay returned an invalid setup link.'),
        'pairingLink',
        '',
      ),
    ).toBe('The relay returned an invalid setup link.')
    expect(failureText(new Error('Unexpected token < in JSON'), 'rename', '')).toBe(
      'Rename failed.',
    )
    expect(failureText('boom', 'remove', '')).toBe('Remove failed.')
    expect(failureText(new Error('x'), 'join', '')).toBe('Pairing failed.')
    expect(failureText(new Error('x'), 'pairingLink', '')).toBe('Could not make a setup link.')
    expect(failureText(new Error('x'), 'stopReset', '')).toBe('Request failed.')
  })
})
