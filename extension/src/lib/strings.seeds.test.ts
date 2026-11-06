import { defaultDeviceName, PLACEHOLDER_BROWSER_NAME, type Platform } from '@tabsend/shared'
import { describe, expect, it } from 'vitest'
import { browserNameSeed, deviceNameSeed } from './strings'

/**
 * The setup page fills the name boxes from the catalog. The shared module keeps its own
 * English default (the relay and the other apps use it), so these tests keep the two
 * identical in English: a change in either one shows up here.
 */
describe('names filled in on the setup page', () => {
  const platforms: Platform[] = ['macos', 'windows', 'linux', 'android', 'ios', 'unknown']

  it('give the same English device names as the shared default', () => {
    for (const platform of platforms) {
      expect(deviceNameSeed(platform)).toBe(defaultDeviceName(platform))
    }
  })

  it('give the same English words for a browser nobody can name', () => {
    const guess = { value: PLACEHOLDER_BROWSER_NAME, confident: false }
    expect(browserNameSeed(guess)).toBe(PLACEHOLDER_BROWSER_NAME)
  })

  it('leave a real browser name alone', () => {
    expect(browserNameSeed({ value: 'Vivaldi', confident: true })).toBe('Vivaldi')
    expect(browserNameSeed({ value: 'Chrome', confident: false })).toBe('Chrome')
  })
})
