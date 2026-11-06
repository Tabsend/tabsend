import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { HOME_NETWORK_HINT } from '@tabsend/shared'
import { describe, expect, it } from 'vitest'
import {
  checkAgainstSource,
  checkLanguage,
  checkUses,
  dynamicKeysIn,
  flatten,
  type KeyUse,
  keysUsedInCode,
  keysUsedInHtml,
} from '../../../shared/tools/i18n-check'
import { literalProblems } from '../../../shared/tools/i18n-literals'
import { relayTextProblems } from '../../../shared/tools/i18n-relay-text'
import { languageFolders, readLanguage } from '../../tools/i18n-vite'

/**
 * The catalogs and the code that uses them, checked against each other (docs/L10N.md rule
 * 10). Adding a language adds it to these checks without touching this file.
 */
const CONSOLE = resolve(import.meta.dirname, '..', '..')
const SRC = join(CONSOLE, 'src')

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : [path]
  })
}

/** Code that ships: not tests, not test support, not the catalogs. */
const codeFiles = walk(SRC).filter(
  (f) =>
    f.endsWith('.ts') &&
    !f.endsWith('.test.ts') &&
    !f.endsWith('.fixtures.ts') &&
    !f.endsWith('test-dom.ts') &&
    !f.endsWith('.d.ts') &&
    // Test data, not text: the same sample devices and links the tests use.
    !f.endsWith('lib/fixtures.ts'),
)
const htmlFiles = [join(CONSOLE, 'index.html')]

/**
 * The console builds its page with `el(tag, attributes, ...children)`: a word in a child
 * is on screen. Besides the places the scanner always looks, look at a child that follows
 * the attributes on the same line, and at a sentence or label alone on its line (a child
 * the formatter moved down). The second test only looks at text that starts with a capital
 * and a small letter, or at a template, so tag names, class names and 'POST' are left alone.
 */
const DOM_TEXT = [
  /\bel\(\s*['"][a-z0-9]+['"]\s*,\s*\{[^{}]*\}\s*,\s*(?=['"`])/,
  /^\s*(?=['"`][A-Z][a-z]|`[a-z])/,
]
const rel = (f: string) => relative(CONSOLE, f)

describe('message catalogs', () => {
  const languages = languageFolders()
  const english = readLanguage('en')

  it('has an English catalog, the source of every other language', () => {
    expect(languages[0]).toBe('en')
  })

  it('English is well formed and every message has a note for translators', () => {
    expect(checkLanguage('en', english)).toEqual([])
  })

  for (const language of languages.filter((l) => l !== 'en')) {
    it(`${language} has every key English has, with the same placeholders`, () => {
      const files = readLanguage(language)
      expect([
        ...checkLanguage(language, files),
        ...checkAgainstSource(language, english, files),
      ]).toEqual([])
    })
  }

  it('every message the code or the page asks for exists, none goes unused, and the names fit', () => {
    const uses: KeyUse[] = []
    for (const f of codeFiles) uses.push(...keysUsedInCode(rel(f), readFileSync(f, 'utf8')))
    for (const f of htmlFiles) uses.push(...keysUsedInHtml(rel(f), readFileSync(f, 'utf8')))
    expect(checkUses(flatten('en', english), uses)).toEqual([])
  })

  it('no message key is built at run time', () => {
    // i18n.ts is the machinery, and dom.ts passes on the key it was given.
    const problems = codeFiles
      .filter((f) => !/[\\/]lib[\\/]i18n\.ts$/.test(f) && !/[\\/]ui[\\/]dom\.ts$/.test(f))
      .flatMap((f) => dynamicKeysIn(rel(f), readFileSync(f, 'utf8')))
    expect(problems).toEqual([])
  })

  it('no sentence is typed into the code', () => {
    const problems = codeFiles.flatMap((f) =>
      // Only app.ts builds screens with el(); elsewhere a child-shaped line may be markup.
      literalProblems(rel(f), readFileSync(f, 'utf8'), {
        sinks: f.endsWith(join('ui', 'app.ts')) ? DOM_TEXT : [],
      }),
    )
    expect(problems).toEqual([])
  })

  it("no screen shows an error's own text: the relay's English, or an exception's", () => {
    // The status line says a catalog sentence chosen by the relay's error code (failureText).
    const problems = codeFiles.flatMap((f) => relayTextProblems(rel(f), readFileSync(f, 'utf8')))
    expect(problems).toEqual([])
  })

  it('the home-network sentence is the one Android, iOS and the extension say', () => {
    const flat = flatten('en', english)
    expect(flat['connection.offline.titleHomeNetwork']?.message.endsWith(HOME_NETWORK_HINT)).toBe(
      true,
    )
  })
})
