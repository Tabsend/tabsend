import { describe, expect, it } from 'vitest'
import {
  browserLabel,
  browserNameSuggestion,
  defaultDeviceName,
  detectBrowser,
  detectPlatform,
  deviceNameFromLabel,
  endpointLabel,
  PLACEHOLDER_BROWSER_NAME,
  resolveBrowserName,
  uniqueBrowserName,
  uniqueLabel,
} from './naming'

const CHROME_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36'
const EDGE_WIN =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36 Edg/150.0.0.0'
const FIREFOX_LINUX = 'Mozilla/5.0 (X11; Linux x86_64; rv:152.0) Gecko/20100101 Firefox/152.0'

const GREASE = { brand: 'Not(A:Brand', version: '99' }

describe('ua detection (ADR-0004 label seeding)', () => {
  it('detects browser families', () => {
    expect(detectBrowser(CHROME_MAC)).toBe('chrome')
    expect(detectBrowser(EDGE_WIN)).toBe('edge')
    expect(detectBrowser(FIREFOX_LINUX)).toBe('firefox')
  })

  it('detects platforms', () => {
    expect(detectPlatform(CHROME_MAC)).toBe('macos')
    expect(detectPlatform(EDGE_WIN)).toBe('windows')
    expect(detectPlatform(FIREFOX_LINUX)).toBe('linux')
  })

  it('builds the {browser} · {device} label from user-named parts', () => {
    expect(endpointLabel('Chrome', 'MacBook')).toBe('Chrome · MacBook')
    expect(endpointLabel('Dia', 'MacBook Pro M1 Pro')).toBe('Dia · MacBook Pro M1 Pro')
    // No device yet (provisional label between join and the device step).
    expect(endpointLabel('Firefox', '')).toBe('Firefox')
    expect(endpointLabel('', 'Box')).toBe('Browser · Box')
    expect(browserLabel('firefox')).toBe('Firefox')
    expect(defaultDeviceName('macos')).toBe('Mac')
  })

  it('recovers the device name from a label (pre-deviceName-field endpoints)', () => {
    expect(deviceNameFromLabel('Dia · Macbook Pro M1 Pro')).toBe('Macbook Pro M1 Pro')
    expect(deviceNameFromLabel('Arc · Macbook Pro M1 Pro')).toBe('Macbook Pro M1 Pro')
    // No separator ⇒ no device tie yet (provisional label, or a bare browser name).
    expect(deviceNameFromLabel('Firefox')).toBeUndefined()
  })
})

describe('browserNameSuggestion (dogfood pass-2 #1 — a guess, never a confident wrong one)', () => {
  it('takes ANY self-declared brand verbatim — niche forks need no allow-list', () => {
    // The point: a browser we've never heard of still gets named correctly.
    for (const brand of ['Comet', 'Islands', 'Whale', 'Some Browser 2029']) {
      expect(
        browserNameSuggestion({
          userAgent: CHROME_MAC,
          userAgentData: {
            brands: [GREASE, { brand: 'Chromium', version: '150' }, { brand, version: '1' }],
          },
        }),
      ).toEqual({ value: brand, confident: true })
    }
  })

  it('takes an unknown UA token verbatim too (Vivaldi, Whale, tomorrow’s fork)', () => {
    expect(browserNameSuggestion({ userAgent: `${CHROME_MAC} Vivaldi/7.0` })).toEqual({
      value: 'Vivaldi',
      confident: true,
    })
    expect(browserNameSuggestion({ userAgent: `${CHROME_MAC} Whale/4.0.0` })).toEqual({
      value: 'Whale',
      confident: true,
    })
    // Cryptic vendor tokens get tidied into the name a human would type.
    expect(browserNameSuggestion({ userAgent: `${CHROME_MAC} OPR/120.0` })).toEqual({
      value: 'Opera',
      confident: true,
    })
  })

  it('is confident for a distinct second brand (Edge/Brave)', () => {
    const edge = browserNameSuggestion({
      userAgent: EDGE_WIN,
      userAgentData: {
        brands: [
          GREASE,
          { brand: 'Chromium', version: '150' },
          { brand: 'Microsoft Edge', version: '150' },
        ],
      },
    })
    expect(edge).toEqual({ value: 'Edge', confident: true })

    const brave = browserNameSuggestion({
      userAgent: CHROME_MAC,
      userAgentData: { brands: [{ brand: 'Brave', version: '1' }, GREASE] },
    })
    expect(brave).toEqual({ value: 'Brave', confident: true })
  })

  it('is confident for Firefox (honest UA, no userAgentData)', () => {
    expect(browserNameSuggestion({ userAgent: FIREFOX_LINUX })).toEqual({
      value: 'Firefox',
      confident: true,
    })
  })

  it('is confident for a distinct UA token even without client hints (Edge)', () => {
    expect(browserNameSuggestion({ userAgent: EDGE_WIN })).toEqual({
      value: 'Edge',
      confident: true,
    })
  })

  it('falls back to the family it can see, flagged as a guess', () => {
    // Dia, Comet and plain Chrome all report only Chromium + Google Chrome, so
    // "Chrome" is right for the majority and one edit away for the rest. Two of
    // them meeting in a group is the dedupe's job, not the guess's.
    const dia = browserNameSuggestion({
      userAgent: CHROME_MAC,
      userAgentData: {
        brands: [
          GREASE,
          { brand: 'Chromium', version: '150' },
          { brand: 'Google Chrome', version: '150' },
        ],
      },
    })
    expect(dia).toEqual({ value: 'Chrome', confident: false })

    // No client hints at all → same guess.
    expect(browserNameSuggestion({ userAgent: CHROME_MAC })).toEqual({
      value: 'Chrome',
      confident: false,
    })

    // Not even a family: nothing true is left to say, so the placeholder.
    expect(browserNameSuggestion({ userAgent: 'something 1.0' })).toEqual({
      value: PLACEHOLDER_BROWSER_NAME,
      confident: false,
    })
  })
})

describe('uniqueBrowserName (no two identical names on one device)', () => {
  const TAKEN = ['Chrome · MacBook', 'Firefox · MacBook', 'Chrome · Work PC']

  it('leaves a free name alone', () => {
    expect(uniqueBrowserName('Dia', 'MacBook', TAKEN)).toBe('Dia')
  })

  it('leaves a duplicate on a DIFFERENT device alone — the device tells them apart', () => {
    expect(uniqueBrowserName('Chrome', 'Work PC', ['Chrome · MacBook'])).toBe('Chrome')
  })

  it('counts up past a collision on the same device', () => {
    expect(uniqueBrowserName('Chrome', 'MacBook', TAKEN)).toBe('Chrome 2')
    expect(uniqueBrowserName('Chrome', 'MacBook', [...TAKEN, 'Chrome 2 · MacBook'])).toBe(
      'Chrome 3',
    )
  })

  it('continues an existing series instead of stacking counters', () => {
    expect(uniqueBrowserName('Chrome 2', 'MacBook', ['Chrome 2 · MacBook'])).toBe('Chrome 3')
  })

  it('matches case-insensitively — “chrome” and “Chrome” are the same name', () => {
    expect(uniqueBrowserName('chrome', 'MacBook', TAKEN)).toBe('chrome 2')
  })

  it('uniqueLabel splits a label and suffixes the BROWSER half (the relay path)', () => {
    // "Chrome · MacBook 2" would claim a second machine; "Chrome 2 · MacBook" is
    // the only honest reading of a name clash on one device.
    expect(uniqueLabel('Chrome · MacBook', ['Chrome · MacBook'])).toBe('Chrome 2 · MacBook')
    expect(uniqueLabel('Chrome · MacBook', ['Chrome · Work PC'])).toBe('Chrome · MacBook')
    // No device half (a console, a phone): one name, suffixed whole.
    expect(uniqueLabel('Web console', ['Web console'])).toBe('Web console 2')
    expect(uniqueLabel('Pixel 8', [])).toBe('Pixel 8')
  })

  it('de-duplicates the family fallback, which is exactly what two hidden forks share', () => {
    // Real Chrome kept the default, then Dia lands on the same machine and is
    // also guessed as "Chrome" — the dedupe is what keeps the two rows apart.
    expect(uniqueBrowserName('Chrome', 'MacBook', ['Chrome · MacBook'])).toBe('Chrome 2')
  })
})

describe('resolveBrowserName (engine probes the UA string can’t see)', () => {
  it('trusts Firefox’s getBrowserInfo over the UA — so forks get their REAL name', async () => {
    await expect(
      resolveBrowserName({
        userAgent: FIREFOX_LINUX,
        getBrowserInfo: async () => ({ name: 'Zen Browser' }),
      }),
    ).resolves.toEqual({ value: 'Zen Browser', confident: true })
  })

  it('detects Brave via navigator.brave when brands stay silent', async () => {
    await expect(
      resolveBrowserName({ userAgent: CHROME_MAC, brave: { isBrave: async () => true } }),
    ).resolves.toEqual({ value: 'Brave', confident: true })
  })

  it('detects Opera via the injected `opr` global', async () => {
    await expect(resolveBrowserName({ userAgent: CHROME_MAC, opr: {} })).resolves.toEqual({
      value: 'Opera',
      confident: true,
    })
  })

  it('falls back to the UA guess when a probe is absent, refuses, or says no', async () => {
    await expect(
      resolveBrowserName({
        userAgent: CHROME_MAC,
        getBrowserInfo: async () => {
          throw new Error('nope')
        },
        brave: { isBrave: async () => false },
      }),
    ).resolves.toEqual({ value: 'Chrome', confident: false })
  })
})
