import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { HOME_NETWORK_HINT } from '@tabsend/shared'
import { describe, expect, it } from 'vitest'
import { relayTextProblems } from '../../../shared/tools/i18n-relay-text'
import {
  checkAgainstSource,
  checkLanguage,
  checkUses,
  dynamicKeysIn,
  flatten,
  type KeyUse,
  keysUsedInCode,
  keysUsedInHtml,
} from '../../tools/i18n-check'
import { literalProblems } from '../../tools/i18n-literals'
import { languageFolders, nativeKey, readLanguage } from '../../tools/i18n-vite'

/**
 * The catalogs and the code that uses them, checked against each other (docs/L10N.md rule
 * 10). Adding a language adds it to these checks without touching this file.
 */
const EXTENSION = resolve(import.meta.dirname, '..', '..')
const SRC = join(EXTENSION, 'src')

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
    !f.endsWith('.d.ts'),
)
const htmlFiles = readdirSync(EXTENSION)
  .filter((f) => f.endsWith('.html'))
  .map((f) => join(EXTENSION, f))
const rel = (f: string) => relative(EXTENSION, f)

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

  it('every message the code or a page asks for exists, none goes unused, and the names fit', () => {
    const uses: KeyUse[] = []
    for (const f of codeFiles) uses.push(...keysUsedInCode(rel(f), readFileSync(f, 'utf8')))
    for (const f of htmlFiles) uses.push(...keysUsedInHtml(rel(f), readFileSync(f, 'utf8')))

    // The browser reads these from the manifests: __MSG_manifest_name__ and so on.
    const manifests = ['manifest.json', 'manifest.firefox.json'].map((f) =>
      readFileSync(join(EXTENSION, 'public', f), 'utf8'),
    )
    const inManifest = (text: string) =>
      new Set([...text.matchAll(/__MSG_([A-Za-z0-9_@]+)__/g)].map((m) => m[1]))
    const [chrome, firefox] = manifests.map(inManifest) as [Set<string>, Set<string>]
    const flat = flatten('en', english)
    const manifestKeys = Object.keys(flat).filter((k) => k.startsWith('manifest.'))
    const problems: string[] = []
    for (const key of manifestKeys) {
      const native = nativeKey(key)
      if (!chrome.has(native) || !firefox.has(native)) {
        problems.push(`"${key}" is not used by both manifests (__MSG_${native}__)`)
      }
    }
    const known = new Set(manifestKeys.map(nativeKey))
    for (const name of new Set([...chrome, ...firefox])) {
      if (!known.has(name))
        problems.push(`a manifest uses __MSG_${name}__, which the catalog does not have`)
    }
    problems.push(...checkUses(flat, uses, manifestKeys))
    expect(problems).toEqual([])
  })

  it('no message key is built at run time', () => {
    // i18n.ts and i18n-dom.ts are the machinery: they pass on keys they were given.
    const problems = codeFiles
      .filter((f) => !/[\\/]i18n(?:-dom)?\.ts$/.test(f))
      .flatMap((f) => dynamicKeysIn(rel(f), readFileSync(f, 'utf8')))
    expect(problems).toEqual([])
  })

  it('no sentence is typed into the code', () => {
    const problems = codeFiles.flatMap((f) => literalProblems(rel(f), readFileSync(f, 'utf8')))
    expect(problems).toEqual([])
  })

  it("no screen shows an error's own text: the relay's English, or an exception's", () => {
    // Sentences come from the catalog, chosen by the relay's error code (failureText).
    const problems = codeFiles.flatMap((f) => relayTextProblems(rel(f), readFileSync(f, 'utf8')))
    expect(problems).toEqual([])
  })

  it('the home-network sentence is the one Android, iOS and the console say', () => {
    const flat = flatten('en', english)
    expect(flat['relay.down.homeNetwork']?.message.endsWith(HOME_NETWORK_HINT)).toBe(true)
  })
})
