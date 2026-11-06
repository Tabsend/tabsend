import { describe, expect, it } from 'vitest'
import {
  checkAgainstSource,
  checkLanguage,
  checkUses,
  dynamicKeysIn,
  keysUsedInCode,
  keysUsedInHtml,
} from './i18n-check'

const en = {
  send: {
    'send.sent': {
      message: '{count, plural, one {Sent to {device}} other {Sent # tabs to {device}}}',
      description: 'Confirmation after a send. {count} tabs, {device} the target.',
    },
    'send.none': {
      message: 'Nothing to send.',
      description: 'Shown when the page cannot be sent.',
    },
  },
}

describe('checkLanguage', () => {
  it('accepts a well-formed catalog', () => {
    expect(checkLanguage('en', en)).toEqual([])
  })
  it('flags a missing description, a broken message, a bad key, and a key in the wrong file', () => {
    const bad = {
      send: {
        'send.sent': {
          message: 'Sent {device',
          description: 'Broken on purpose, no closing brace.',
        },
        'send.none': { message: 'Nothing.', description: '' },
        'Send Thing': { message: 'x', description: 'A bad key on purpose.' },
        'chooser.row': { message: 'x', description: 'In the wrong file on purpose.' },
      },
    }
    const problems = checkLanguage('en', bad).join('\n')
    expect(problems).toContain('send.sent')
    expect(problems).toContain('needs a description')
    expect(problems).toContain('area.group.name')
    expect(problems).toContain('start with "send."')
  })
  it('flags a key defined in two files', () => {
    const twice = {
      ...en,
      other: { 'send.sent': { message: 'x', description: 'Defined twice on purpose.' } },
    }
    expect(checkLanguage('en', twice).join('\n')).toContain('defined twice')
  })
})

describe('checkAgainstSource', () => {
  it('accepts a translation with the same keys and placeholders, whatever the plural forms', () => {
    const de = {
      send: {
        'send.sent': {
          message:
            '{count, plural, one {An {device} gesendet} few {# an {device}} other {# Tabs an {device}}}',
        },
        'send.none': { message: 'Nichts zu senden.' },
      },
    }
    expect(checkAgainstSource('de', en, de as never)).toEqual([])
  })
  it('flags a missing key, an extra key and a lost or renamed placeholder', () => {
    const de = {
      send: {
        'send.sent': {
          message: '{count, plural, one {Gesendet} other {# Tabs gesendet an {geraet}}}',
        },
        'send.extra': { message: 'Zusatz' },
      },
    }
    const problems = checkAgainstSource('de', en, de as never).join('\n')
    expect(problems).toContain('"send.none" is missing')
    expect(problems).toContain('"send.extra" is not in English')
    expect(problems).toContain('"send.sent" uses {count, geraet} but English uses {count, device}')
  })
})

describe('keys used in code', () => {
  it('finds literal keys and the names of a literal argument object', () => {
    const code = [
      "const a = t('send.sent', { count: n, device: label })",
      "const b = t('send.none')",
      "const c = t('send.sent', { count, device: pick(a, b), ...rest })",
      "const d = list.t('not.a.call')",
    ].join('\n')
    const uses = keysUsedInCode('x.ts', code)
    expect(uses.map((u) => u.key)).toEqual(['send.sent', 'send.none', 'send.sent'])
    expect(uses[0]?.args).toEqual(['count', 'device'])
    expect(uses[1]?.args).toBeUndefined()
    expect(uses[2]?.args).toEqual(['count', 'device', '...'])
  })
  it('refuses keys built at run time', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the text is code the scanner reads, not a template
    expect(dynamicKeysIn('x.ts', 't(`send.${kind}`)')).toHaveLength(1)
    expect(dynamicKeysIn('x.ts', 't(key)')).toHaveLength(1)
    expect(dynamicKeysIn('x.ts', "t('send.none')")).toEqual([])
  })
  it('finds keys in HTML', () => {
    const html =
      '<h1 data-i18n="a.b.c"></h1><p data-i18n-rich="d.e.f"></p><i data-i18n-attrs="title:g.h.i;aria-label:j.k.l">'
    expect(keysUsedInHtml('x.html', html).map((u) => u.key)).toEqual([
      'a.b.c',
      'd.e.f',
      'g.h.i',
      'j.k.l',
    ])
  })
})

describe('checkUses', () => {
  const english = en.send
  it('passes when every key is used with the right names', () => {
    const uses = [
      { key: 'send.sent', file: 'a.ts', args: ['count', 'device'] },
      { key: 'send.none', file: 'a.ts' },
    ]
    expect(checkUses(english, uses)).toEqual([])
  })
  it('flags a missing key, an unused key and wrong argument names', () => {
    const uses = [
      { key: 'send.sent', file: 'a.ts', args: ['count', 'label'] },
      { key: 'send.typo', file: 'a.ts' },
    ]
    const problems = checkUses(english, uses).join('\n')
    expect(problems).toContain('"send.typo", which English does not have')
    expect(problems).toContain('is given {count, label} but the message uses {count, device}')
    expect(problems).toContain('"send.none" is in the English catalog but nothing uses it')
  })
})
