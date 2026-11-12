import { describe, expect, it } from 'vitest'
import { isHostedRelay, rateUrl, shareBoxVariant, shareVariant } from './sharebox'

const DAY = 24 * 60 * 60 * 1000
const now = Date.UTC(2026, 11, 1)
const base = {
  relayUrl: 'https://app.tabsend.org',
  deviceCount: 2,
  firstHomeAt: now - 31 * DAY,
  dismissedAt: undefined,
  now,
}

describe('relay variant', () => {
  it('knows the hosted addresses and nothing else', () => {
    expect(isHostedRelay('https://app.tabsend.org')).toBe(true)
    expect(isHostedRelay('https://app.tabsend.org/')).toBe(true)
    expect(isHostedRelay('https://demo.tabsend.org')).toBe(true)
    expect(isHostedRelay('https://app.tabsend.org.evil.example')).toBe(false)
    expect(isHostedRelay('http://192.168.1.5:8787')).toBe(false)
    expect(isHostedRelay('')).toBe(false)
    expect(isHostedRelay(undefined)).toBe(false)
    expect(isHostedRelay('not a url')).toBe(false)
  })
  it('picks credit for hosted and plain otherwise', () => {
    expect(shareVariant('https://app.tabsend.org')).toBe('credit')
    expect(shareVariant('https://relay.example.com')).toBe('plain')
  })
})

describe('shareBoxVariant', () => {
  it('shows credit on the hosted relay after 30 days with two devices', () => {
    expect(shareBoxVariant(base)).toBe('credit')
  })
  it('shows plain on any other relay', () => {
    expect(shareBoxVariant({ ...base, relayUrl: 'https://relay.example.com' })).toBe('plain')
  })
  it('waits 30 days from the first paired Home', () => {
    expect(shareBoxVariant({ ...base, firstHomeAt: now - 29 * DAY })).toBeNull()
    expect(shareBoxVariant({ ...base, firstHomeAt: now - 30 * DAY })).toBe('credit')
    expect(shareBoxVariant({ ...base, firstHomeAt: undefined })).toBeNull()
  })
  it('needs two or more devices', () => {
    expect(shareBoxVariant({ ...base, deviceCount: 1 })).toBeNull()
  })
  it('hides for a year after a dismissal, then may return', () => {
    expect(shareBoxVariant({ ...base, dismissedAt: now - 364 * DAY })).toBeNull()
    expect(shareBoxVariant({ ...base, dismissedAt: now - 365 * DAY })).toBe('credit')
  })
})

describe('rateUrl', () => {
  it('ships unset', () => {
    expect(rateUrl()).toBeNull()
  })
  it('returns a configured link', () => {
    expect(rateUrl(' https://example.com/r ')).toBe('https://example.com/r')
    expect(rateUrl('  ')).toBeNull()
  })
})
