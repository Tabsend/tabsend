import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { setLocale } from './i18n'
import { unlocalizedWords } from './pseudo'
import { collectStrings, FIXTURE_VALUES } from './strings.fixtures'

/**
 * Every sentence strings.ts can say, run in the pseudo-locale (en-XA). If any of it was typed
 * into the code instead of coming from the catalog, it shows up here as plain words.
 */
/** The sentences in one output: a string as it is, or the text fields of a title/message/banner. */
function sentences(output: string): string[] {
  if (!output.startsWith('{')) return [output]
  const fields = JSON.parse(output) as Record<string, string>
  // `tone` and `favicon` are data, not words a person reads.
  return Object.entries(fields)
    .filter(([name]) => name !== 'tone' && name !== 'favicon')
    .map(([, value]) => value)
}

describe('strings.ts in the pseudo-locale', () => {
  beforeAll(() => setLocale('en-XA'))
  afterAll(() => setLocale())

  // Outputs that are not messages: dates and times (formatted by Intl), yes/no answers, and
  // text handed in and handed back.
  const NOT_MESSAGES = [
    /^monthDayLine\/20/,
    /^clockLine\/20/,
    /^isRecoverableFailure\//,
    /^SETUP_DOCS_URL$/,
    /^NOT_REGISTERED_ERROR$/,
    /^relayProbeCopy\.error$/,
  ]

  it('says nothing that did not come from the catalog', () => {
    const all = collectStrings()
    const problems: string[] = []
    let checked = 0
    for (const [key, text] of Object.entries(all)) {
      if (NOT_MESSAGES.some((re) => re.test(key))) continue
      checked++
      const left = sentences(text).flatMap((sentence) => unlocalizedWords(sentence, FIXTURE_VALUES))
      if (left.length > 0) problems.push(`${key}: ${text}  (plain words: ${left.join(' ')})`)
    }
    expect(checked).toBeGreaterThan(500)
    expect(problems).toEqual([])
  })

  it('still changes with the count, because plurals live in the messages', () => {
    const one = collectStrings()['heldTabsHeading/1']
    const many = collectStrings()['heldTabsHeading/5']
    expect(one).not.toBe(many)
    expect(many).toContain('5')
  })
})
