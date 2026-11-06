import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  availableLocales,
  dateLocale,
  getLocale,
  isPseudo,
  messagesFor,
  setLocale,
  sourceMessages,
  t,
} from './i18n'
import { absoluteTime } from './time'
import { clockLine, monthDayLine } from './view'

const ISO = '2026-10-27T15:05:09.000Z'

afterEach(() => {
  setLocale()
  vi.unstubAllGlobals()
  delete process.env.TZ
})

describe('the console speaks the language of the browser when a catalog exists', () => {
  it('has English, the source, then every translation', () => {
    expect(availableLocales()).toEqual(['en', 'de'])
    expect(Object.keys(sourceMessages()).length).toBeGreaterThan(100)
    expect(Object.keys(messagesFor('de')).sort()).toEqual(Object.keys(sourceMessages()).sort())
  })

  it('shows English to a browser that asks for a language it has no catalog for', () => {
    vi.stubGlobal('navigator', { languages: ['ja-JP', 'ja'], language: 'ja-JP' })
    setLocale()
    expect(getLocale()).toBe('en')
    expect(t('app.tab.devices')).toBe('Devices')
  })

  it('shows German to a German browser, and to an Austrian one (de-AT falls back to de)', () => {
    vi.stubGlobal('navigator', { languages: ['de-AT', 'de'], language: 'de-AT' })
    setLocale()
    expect(getLocale()).toBe('de')
    expect(t('app.tab.devices')).toBe('Geräte')
  })

  it('never shows a key, and says so loudly when a key is wrong', () => {
    expect(() => t('no.such.key')).toThrow(/no\.such\.key/)
  })

  it('fills in names and counts, with the plural forms of the language', () => {
    expect(t('devices.lastSeen.ago', { ago: '5m ago' })).toBe('last seen 5m ago')
    expect(t('history.batch.heading', { count: 1 })).toBe('1 tab')
    expect(t('history.batch.heading', { count: 3 })).toBe('3 tabs')
    expect(t('time.minutes', { count: 5 })).toBe('5m ago')
  })
})

describe('German numbers and short ages', () => {
  it('writes "vor 5 Min." and "gerade eben", and picks the plural form by German rules', () => {
    setLocale('de')
    expect(t('time.minutes', { count: 5 })).toBe('vor 5 Min.')
    expect(t('time.days', { count: 1 })).toBe('vor 1 Tag')
    expect(t('time.days', { count: 3 })).toBe('vor 3 Tagen')
    expect(t('time.justNow')).toBe('gerade eben')
    expect(t('history.batch.heading', { count: 1 })).toBe('1 Tab')
    expect(t('history.batch.heading', { count: 3 })).toBe('3 Tabs')
  })

  it('groups thousands the German way', () => {
    setLocale('de')
    expect(t('history.batch.heading', { count: 1234 })).toBe('1.234 Tabs')
  })
})

describe('the pseudo-locale', () => {
  it('brackets, accents and lengthens every message, never picked from the browser', () => {
    vi.stubGlobal('navigator', { languages: ['en-XA'], language: 'en-XA' })
    setLocale()
    expect(isPseudo()).toBe(false)
    expect(t('app.tab.devices')).toBe('Devices')
    setLocale('en-XA')
    expect(isPseudo()).toBe(true)
    expect(t('app.tab.devices')).toMatch(/^\[.+\]$/)
    expect(t('app.tab.devices')).not.toContain('Devices')
    expect(t('app.tab.devices').length).toBeGreaterThan('Devices'.length + 2)
  })
})

describe('dates follow the language on screen', () => {
  it('formats the same English as before for an English browser', () => {
    process.env.TZ = 'UTC'
    setLocale('en')
    expect(monthDayLine(ISO)).toBe('October 27')
    expect(clockLine(ISO)).toBe('3:05 PM')
    expect(absoluteTime(ISO)).toBe('10/27/2026, 3:05:09 PM')
  })

  it('keeps the regional form of the same language the browser asks for (en-GB stays en-GB)', () => {
    process.env.TZ = 'UTC'
    vi.stubGlobal('navigator', { languages: ['en-GB', 'en'], language: 'en-GB' })
    setLocale()
    expect(dateLocale()).toBe('en-GB')
    expect(absoluteTime(ISO)).toBe('27/10/2026, 15:05:09')
    // The two dates that read the same on every client stay as they were.
    expect(monthDayLine(ISO)).toBe('October 27')
    expect(clockLine(ISO)).toBe('3:05 PM')
  })

  it('writes the day, the clock and the full timestamp the German way', () => {
    process.env.TZ = 'UTC'
    vi.stubGlobal('navigator', { languages: ['de-DE', 'de'], language: 'de-DE' })
    setLocale()
    expect(getLocale()).toBe('de')
    expect(dateLocale()).toBe('de-DE')
    expect(monthDayLine(ISO)).toBe('27. Oktober')
    expect(clockLine(ISO)).toBe('15:05')
    expect(absoluteTime(ISO)).toBe('27.10.2026, 15:05:09')
  })

  it('does not take another language from the browser list over the one shown', () => {
    vi.stubGlobal('navigator', { languages: ['fr-FR', 'en-US'], language: 'fr-FR' })
    setLocale()
    expect(getLocale()).toBe('en')
    expect(dateLocale()).toBe('en-US')
  })

  it('leaves a time that cannot be read as it came', () => {
    expect(absoluteTime('nonsense')).toBe('nonsense')
    expect(monthDayLine('nonsense')).toBe('nonsense')
  })
})
