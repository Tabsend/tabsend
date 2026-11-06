import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { unlocalizedWords } from '../../../shared/tools/i18n-pseudo'
import { setLocale } from './i18n'
import { collectStrings } from './strings.fixtures'

/**
 * The status line at the bottom of the page, for every way pairing, renaming, removing, making
 * a setup link and stopping a reset can fail, run in the pseudo-locale (en-XA). Every sentence
 * must come from the catalog, chosen by the relay's error code: the relay's own English (the
 * fixtures make it say "Relay wording that must not show up.") and an exception's text
 * ("Failed to fetch") show up here as plain words.
 */
const NOT_WORDS_A_PERSON_READS = [
  // The line is printed as `kind: text || kind: text`; the kind is the line's colour, not text.
  'info',
  'error',
  'idle',
  // The relay address the fixtures put in a session.
  'https',
  'relay',
  'example',
  'com',
]

describe('the status line in the pseudo-locale', () => {
  beforeAll(() => setLocale('en-XA'))
  afterAll(() => setLocale())

  it('says nothing that did not come from the catalog', async () => {
    const all = await collectStrings()
    const problems: string[] = []
    let checked = 0
    for (const [name, text] of Object.entries(all)) {
      if (!name.startsWith('controller.')) continue
      checked++
      const left = unlocalizedWords(text.replaceAll(' || ', ' '), NOT_WORDS_A_PERSON_READS)
      if (left.length > 0) problems.push(`${name}: plain words ${left.join(' ')}  in  ${text}`)
    }
    expect(checked).toBeGreaterThan(60)
    expect(problems).toEqual([])
  }, 30_000)
})
