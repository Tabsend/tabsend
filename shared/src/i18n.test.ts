import { describe, expect, it } from 'vitest'
import {
  createTranslator,
  formatMessage,
  placeholdersOf,
  PSEUDO_LOCALE,
  resolveLocaleChain,
  splitRich,
} from './i18n'

describe('formatMessage', () => {
  it('leaves a message without placeholders alone, apostrophes included', () => {
    expect(formatMessage("You're offline. It isn't sent.")).toBe("You're offline. It isn't sent.")
    expect(formatMessage('Pair “MacBook Pro M1” first … now ✓')).toBe('Pair “MacBook Pro M1” first … now ✓')
  })

  it('fills named placeholders, strings as they are and numbers per locale', () => {
    expect(formatMessage('Sent to {device}', { device: 'Arc · Mac mini' })).toBe('Sent to Arc · Mac mini')
    expect(formatMessage('{n} tabs', { n: 1234 }, 'en')).toBe('1,234 tabs')
    expect(formatMessage('{n} tabs', { n: 1234 }, 'de')).toBe('1.234 tabs')
    expect(formatMessage('{n, number} tabs', { n: 7 })).toBe('7 tabs')
    expect(formatMessage('{b} {a}', { a: 'one', b: 'two' })).toBe('two one')
  })

  it('does not treat user text as message syntax', () => {
    expect(formatMessage('Sent to {device}', { device: "{count, plural, other {x}} '" })).toBe(
      "Sent to {count, plural, other {x}} '",
    )
  })

  it('picks plural forms from the locale, and # is the number', () => {
    const m = '{count, plural, =0 {Nothing} one {Sent # tab} other {Sent # tabs}}'
    expect(formatMessage(m, { count: 0 })).toBe('Nothing')
    expect(formatMessage(m, { count: 1 })).toBe('Sent 1 tab')
    expect(formatMessage(m, { count: 2 })).toBe('Sent 2 tabs')
    expect(formatMessage(m, { count: 1000 })).toBe('Sent 1,000 tabs')
  })

  it('handles languages with more than two plural forms', () => {
    const m = '{n, plural, one {# plik} few {# pliki} many {# plików} other {# pliku}}'
    expect(formatMessage(m, { n: 1 }, 'pl')).toBe('1 plik')
    expect(formatMessage(m, { n: 3 }, 'pl')).toBe('3 pliki')
    expect(formatMessage(m, { n: 5 }, 'pl')).toBe('5 plików')
    expect(formatMessage(m, { n: 22 }, 'pl')).toBe('22 pliki')
  })

  it('falls back to "other" when a form is missing', () => {
    expect(formatMessage('{n, plural, one {a} other {b}}', { n: 3 }, 'pl')).toBe('b')
  })

  it('selects by value and keeps # meaning the plural number inside a select', () => {
    const m = '{kind, select, tab {this tab} other {this link}}'
    expect(formatMessage(m, { kind: 'tab' })).toBe('this tab')
    expect(formatMessage(m, { kind: 'x' })).toBe('this link')
    const nested = '{n, plural, one {# {kind, select, tab {tab} other {link}}} other {# {kind, select, tab {tabs} other {links}}}}'
    expect(formatMessage(nested, { n: 1, kind: 'tab' })).toBe('1 tab')
    expect(formatMessage(nested, { n: 4, kind: 'x' })).toBe('4 links')
  })

  it('supports placeholders inside plural forms', () => {
    const m = '{count, plural, one {Sent to {device}} other {Sent # tabs to {device}}}'
    expect(formatMessage(m, { count: 3, device: 'Arc' })).toBe('Sent 3 tabs to Arc')
  })

  it('supports a plural offset', () => {
    const m = '{n, plural, offset:1 =0 {nobody} =1 {just you} one {you and one other} other {you and # others}}'
    expect(formatMessage(m, { n: 0 })).toBe('nobody')
    expect(formatMessage(m, { n: 1 })).toBe('just you')
    expect(formatMessage(m, { n: 2 })).toBe('you and one other')
    expect(formatMessage(m, { n: 4 })).toBe('you and 3 others')
  })

  it('quotes braces the ICU way', () => {
    expect(formatMessage("Use '{'braces'}' like this")).toBe('Use {braces} like this')
    expect(formatMessage("It''s fine")).toBe("It's fine")
  })

  it('throws for a missing value or a malformed message, so tests catch them', () => {
    expect(() => formatMessage('Sent to {device}')).toThrow(/device/)
    expect(() => formatMessage('{n, plural, one {a}}', { n: 1 })).toThrow(/other/)
    expect(() => formatMessage('Sent to {device', { device: 'x' })).toThrow()
    expect(() => formatMessage('oops }')).toThrow()
    expect(() => formatMessage('{n, plural, other {x}}', { n: 'many' })).toThrow(/number/)
  })

  it('shows the pseudo-locale as accented, longer, bracketed text with the values intact', () => {
    const out = formatMessage('Sent to {device}', { device: 'Arc' }, 'en', { pseudo: true })
    expect(out.startsWith('[')).toBe(true)
    expect(out.endsWith(']')).toBe(true)
    expect(out).toContain('Arc')
    expect(out).not.toContain('Sent')
    expect(out).toContain('Šéñţ')
    expect(out).toContain('~')
    const plain = 'Sent to '.length
    expect(out.length).toBeGreaterThan(plain + 'Arc'.length + 2)
    expect(PSEUDO_LOCALE).toBe('en-XA')
  })

  it('leaves markup tags readable in the pseudo-locale', () => {
    const out = formatMessage('Sign up at <link>tabsend.org</link> now', {}, 'en', { pseudo: true })
    expect(out).toContain('<link>')
    expect(out).toContain('</link>')
    expect(out).toContain('ţåƀšéñð.öŕĝ')
  })

  it('keeps plural logic working in the pseudo-locale', () => {
    const m = '{count, plural, one {# tab} other {# tabs}}'
    expect(formatMessage(m, { count: 1 }, 'en', { pseudo: true })).toMatch(/^\[1 ţåƀ~*\]$/)
    expect(formatMessage(m, { count: 5 }, 'en', { pseudo: true })).toMatch(/^\[5 ţåƀš~*\]$/)
  })
})

describe('placeholdersOf', () => {
  it('lists every name once, including plural and select selectors and nested names', () => {
    expect(placeholdersOf("It isn't sent.")).toEqual([])
    expect(placeholdersOf('Sent to {device} at {time}, {device}')).toEqual(['device', 'time'])
    expect(
      placeholdersOf('{count, plural, one {Sent to {device}} other {Sent # tabs to {device}}}'),
    ).toEqual(['count', 'device'])
    expect(placeholdersOf('{kind, select, tab {{n} tab} other {link}}')).toEqual(['kind', 'n'])
  })
})

describe('resolveLocaleChain', () => {
  const available = ['en', 'de', 'pt-BR']
  it('walks from the full tag to the language, then English', () => {
    expect(resolveLocaleChain(['de-AT'], available)).toEqual(['de', 'en'])
    expect(resolveLocaleChain(['pt-br'], available)).toEqual(['pt-BR', 'en'])
    expect(resolveLocaleChain(['pt-PT'], available)).toEqual(['en'])
    expect(resolveLocaleChain(['de_DE'], available)).toEqual(['de', 'en'])
  })
  it('tries each language the person listed, in order', () => {
    expect(resolveLocaleChain(['fr-CH', 'de-CH', 'en-GB'], available)).toEqual(['de', 'en'])
  })
  it('is English alone when nothing matches or nothing is asked', () => {
    expect(resolveLocaleChain([], available)).toEqual(['en'])
    expect(resolveLocaleChain(['ja'], ['en'])).toEqual(['en'])
    expect(resolveLocaleChain(['en-US'], ['en'])).toEqual(['en'])
  })
})

describe('createTranslator', () => {
  const en = {
    'send.sent': '{count, plural, one {Sent to {device}} other {Sent # tabs to {device}}}',
    'send.offline': "You're offline",
    'only.english': 'Only in English',
    'broken.in.de': 'Hello {name}',
  }
  const de = {
    'send.sent': '{count, plural, one {An {device} gesendet} other {# Tabs an {device} gesendet}}',
    'send.offline': 'Du bist offline',
    // A translator's slip: the placeholder was renamed. The page must not break.
    'broken.in.de': 'Hallo {nom}',
  }
  const pl = {
    'send.sent': '{count, plural, one {# karta} few {# karty} many {# kart} other {# karty}}',
  }
  const make = (requested: string[], extra: Partial<Parameters<typeof createTranslator>[0]> = {}) =>
    createTranslator({ catalogs: { en, de, pl, 'pt-BR': { 'send.offline': 'Você está offline' } }, requested: () => requested, ...extra })

  it('answers in the browser language, with that language plural rules', () => {
    const tr = make(['de-AT'])
    expect(tr.locale()).toBe('de')
    expect(tr.t('send.offline')).toBe('Du bist offline')
    expect(tr.t('send.sent', { count: 1, device: 'Pixel' })).toBe('An Pixel gesendet')
    expect(tr.t('send.sent', { count: 3, device: 'Pixel' })).toBe('3 Tabs an Pixel gesendet')
    expect(make(['pl']).t('send.sent', { count: 22, device: 'x' })).toBe('22 karty')
    expect(make(['pt-br']).t('send.offline')).toBe('Você está offline')
  })

  it('shows English for a message the language lacks and for a broken translation, never a key', () => {
    const tr = make(['de'])
    expect(tr.t('only.english')).toBe('Only in English')
    expect(tr.t('broken.in.de', { name: 'Ana' })).toBe('Hello Ana')
    expect(make(['ja']).t('send.offline')).toBe("You're offline")
    expect(make([]).locale()).toBe('en')
  })

  it('throws for a key English does not have, and for a broken English message', () => {
    expect(() => make(['de']).t('no.such.key')).toThrow(/no\.such\.key/)
    expect(() => make(['en']).t('broken.in.de')).toThrow(/name/)
  })

  it('can be forced into the pseudo-locale, by build flag or by hand', () => {
    const forced = make(['de'], { pseudo: true })
    expect(forced.isPseudo()).toBe(true)
    expect(forced.t('send.offline')).toMatch(/^\[.+\]$/)
    expect(forced.t('send.offline')).not.toContain('offline')
    const tr = make(['de'])
    tr.setLocale(PSEUDO_LOCALE)
    expect(tr.isPseudo()).toBe(true)
    expect(tr.locale()).toBe('en')
    tr.setLocale()
    expect(tr.isPseudo()).toBe(false)
    expect(tr.locale()).toBe('de')
  })

  it('ignores a browser that asks for the pseudo-locale', () => {
    const tr = make([PSEUDO_LOCALE])
    expect(tr.isPseudo()).toBe(false)
    expect(tr.t('send.offline')).toBe("You're offline")
  })

  it('lists the languages it has, English first', () => {
    expect(make([]).available()).toEqual(['en', 'de', 'pl', 'pt-BR'])
  })
})

describe('splitRich', () => {
  it('splits a sentence around its tags and keeps the words of each tag', () => {
    expect(splitRich('New? <link>Learn more at tabsend.org</link>.')).toEqual([
      'New? ',
      { tag: 'link', text: 'Learn more at tabsend.org' },
      '.',
    ])
  })
  it('leaves plain text, and angle brackets that are not tags, as they are', () => {
    expect(splitRich('Open <LAN-IP>:8787')).toEqual(['Open <LAN-IP>:8787'])
    expect(splitRich('')).toEqual([])
  })
  it('reads several tags in one sentence', () => {
    expect(splitRich('<b>One</b> and <i>two</i>')).toEqual([
      { tag: 'b', text: 'One' },
      ' and ',
      { tag: 'i', text: 'two' },
    ])
  })
})
