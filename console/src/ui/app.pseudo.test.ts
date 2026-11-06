import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { unlocalizedWords } from '../../../shared/tools/i18n-pseudo'
import { setLocale } from '../lib/i18n'
import { collectScenes, NOW } from './scenes.fixtures'

/**
 * Every screen, run in the pseudo-locale (en-XA). In en-XA each catalog message is accented
 * and wrapped in brackets, so once the bracketed parts are taken out, only words a person
 * supplied (a device name, a page title, an address) may be left. A sentence that was typed
 * into the code instead of coming from the catalog shows up here as plain words, on the
 * screen where a person would meet it.
 */

/** What the fixtures put in as a person's own words, and the names of products and systems. */
const PERSON_AND_PRODUCT_WORDS = [
  // Device names and what a person typed
  "Ben's web console",
  'Chrome · Work',
  'Pixel 9',
  'Firefox · Old laptop',
  'iPhone',
  'Kitchen console',
  'Edge',
  'Old tablet',
  'Mystery laptop',
  'Broken clock',
  // Page titles and addresses
  'An Article',
  'Never opened',
  'First of three',
  'Second of three',
  'Third of three',
  'Partial one',
  'Partial two',
  'Older copy',
  'From a removed device',
  'Not a web address',
  'example.com',
  'news.example.org',
  'example.net',
  'copy.example.com',
  'one.example.com',
  'two.example.com',
  'three.example.com',
  'p1.example.com',
  'p2.example.com',
  'gone.example.com',
  'relay.example.com',
  'https://relay.example.com',
  'localhost',
  'tabsend.org',
  'app.tabsend.org',
  'group-abc',
  'console-1',
  // The kind of browser and system, which are product names
  'Chrome',
  'Firefox',
  'Windows',
  'macOS',
  'Android',
  'iOS',
  'Linux',
  'Mac',
  // Times a browser formats itself (11/3/2026, 12:15:00 PM)
  'AM',
  'PM',
]

/**
 * What a person reads on a screen: all its text in reading order as one run (a message with a
 * link inside it is several text nodes, and its brackets span them), then each attribute they
 * can read or hear (a tooltip, a placeholder) on its own.
 */
function wordsOnScreen(outline: string): string[] {
  const text: string[] = []
  const attributes: string[] = []
  for (const line of outline.split('\n')) {
    const node = /^\s*"(.*)"$/.exec(line)
    if (node) {
      text.push(node[1] ?? '')
      continue
    }
    for (const m of line.matchAll(/ (title|aria-label|placeholder|alt|value)="(.*?)"(?= \w|>)/g)) {
      attributes.push(m[2] ?? '')
    }
  }
  return [text.join(' '), ...attributes]
}

describe('every screen in the pseudo-locale', () => {
  beforeAll(() => {
    process.env.TZ = 'UTC'
    setLocale('en-XA')
    vi.useFakeTimers({ toFake: ['Date'], now: NOW })
  })
  afterAll(() => {
    setLocale()
    vi.useRealTimers()
    delete process.env.TZ
  })

  it('says nothing that did not come from the catalog', async () => {
    const scenes = await collectScenes()
    const problems: string[] = []
    let checked = 0
    for (const [name, outline] of Object.entries(scenes)) {
      for (const text of wordsOnScreen(outline)) {
        checked++
        const left = unlocalizedWords(text, PERSON_AND_PRODUCT_WORDS)
        if (left.length > 0) {
          problems.push(`${name}: plain words ${left.join(' ')}  in  ${text.slice(0, 160)}`)
        }
      }
    }
    expect(Object.keys(scenes).length).toBeGreaterThan(30)
    expect(checked).toBeGreaterThan(250)
    expect(problems).toEqual([])
  }, 30_000)

  it('shows the whole page in brackets: a heading, a button, a tooltip', async () => {
    const scenes = await collectScenes()
    expect(scenes['devices.groupReset']).toMatch(/"\[Šöɱéöñé/)
    expect(scenes.devices).toMatch(/<button>\n\s+"\[Åðð å ðéṽîçé/)
    expect(scenes.pairing).toContain('<svg aria-label="[')
    expect(scenes['history.ready']).toMatch(/title="\[Šéñţ ƀý~*\]"/)
  }, 30_000)
})
