import { describe, expect, it } from 'vitest'
import { ApiClientError } from './api'
import { failureText } from './failure-text'
import { type RelayAction, relayErrorLine, UserFacingError } from './relay-errors'

/**
 * The extension's own words for what the relay says (`relayErrorLine`), the way the iPhone app
 * words it (`RelayErrorTextTests.swift`). The exact English is pinned in the golden file;
 * these are the rules.
 */
const ACTIONS: RelayAction[] = [
  'join',
  'rename',
  'remove',
  'pairingLink',
  'stopReset',
  'check',
  'other',
]
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
        expect(failureText(err, during), `${code} during ${during}`).not.toContain('Relay wording')
      }
    }
  })

  it('means a device or the whole group for not_found, depending on the screen', () => {
    const device = relayErrorLine('not_found', 'remove')
    expect(device).toBe(relayErrorLine('not_found', 'rename'))
    const group = relayErrorLine('not_found', 'pairingLink')
    expect(group).toBe(relayErrorLine('not_found', 'stopReset'))
    expect(device).not.toBe(group)
    expect(relayErrorLine('not_found', 'join')).toBe(relayErrorLine('not_found', 'check'))
  })

  it('keeps its own words for a full group and a used setup link while pairing', () => {
    expect(relayErrorLine('limit_reached', 'join')).toContain('device limit')
    expect(relayErrorLine('invalid_pairing_code', 'join')).toContain('setup link')
    expect(relayErrorLine('limit_reached', 'pairingLink')).not.toBe(
      relayErrorLine('limit_reached', 'join'),
    )
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
    expect(failureText(err, 'rename')).toBe('Request failed (502).')
  })

  it("passes on a sentence the extension chose, and nothing else's text", () => {
    expect(failureText(new UserFacingError('Enter the relay address.'))).toBe(
      'Enter the relay address.',
    )
    expect(failureText(new Error('Unexpected token < in JSON at position 0'))).toBe(
      'Something went wrong. Try again.',
    )
    expect(failureText(new TypeError('Failed to fetch'))).toBe('Something went wrong. Try again.')
    expect(failureText('boom')).toBe('Something went wrong. Try again.')
  })
})
