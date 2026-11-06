import { formatMessage, placeholdersOf } from '../src/i18n'
import type { CatalogFile } from './i18n-catalog'

/**
 * The checks behind "a language can be added by translating catalogs alone" (docs/L10N.md
 * rule 10). Pure functions over text, so they can be tested with made-up catalogs and
 * run over the real ones. Each returns a list of plain-English problems; empty means fine.
 */

export type Language = Record<string, CatalogFile>

const KEY = /^[a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)+$/

/** All entries of a language in one map, noting a key that appears in two files. */
export function flatten(language: string, files: Language, problems: string[] = []): CatalogFile {
  const all: CatalogFile = {}
  for (const [area, file] of Object.entries(files)) {
    for (const [key, entry] of Object.entries(file)) {
      if (key in all) problems.push(`${language}: "${key}" is defined twice (also in ${area}.json)`)
      all[key] = entry
    }
  }
  return all
}

/** One language on its own: well-formed entries, messages that parse. */
export function checkLanguage(language: string, files: Language): string[] {
  const problems: string[] = []
  flatten(language, files, problems) // reports a key defined in two files
  for (const [area, file] of Object.entries(files)) {
    for (const [key, entry] of Object.entries(file)) {
      const where = `${language}/${area}.json "${key}"`
      if (!KEY.test(key)) problems.push(`${where}: a key looks like area.group.name`)
      if (!key.startsWith(`${area}.`))
        problems.push(`${where}: keys in ${area}.json start with "${area}."`)
      if (typeof entry?.message !== 'string' || entry.message.trim() === '') {
        problems.push(`${where}: has no message`)
        continue
      }
      if (
        language === 'en' &&
        (typeof entry.description !== 'string' || entry.description.trim().length < 10)
      ) {
        problems.push(
          `${where}: needs a description for translators (where it shows, what each {placeholder} is)`,
        )
      }
      try {
        // Every placeholder gets a number: enough to prove the syntax and the plural forms.
        const args = Object.fromEntries(placeholdersOf(entry.message).map((n) => [n, 2]))
        formatMessage(entry.message, args, language)
      } catch (err) {
        problems.push(`${where}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }
  return problems
}

/** A translation against the English source: same keys, same placeholders. */
export function checkAgainstSource(language: string, source: Language, other: Language): string[] {
  const problems: string[] = []
  const en = flatten('en', source, [])
  const tr = flatten(language, other, [])
  for (const key of Object.keys(en)) {
    if (!(key in tr)) problems.push(`${language}: "${key}" is missing (English has it)`)
  }
  for (const [key, entry] of Object.entries(tr)) {
    const english = en[key]
    if (!english) {
      problems.push(
        `${language}: "${key}" is not in English (remove it, or add it to English first)`,
      )
      continue
    }
    try {
      const want = placeholdersOf(english.message).join(', ')
      const got = placeholdersOf(entry.message).join(', ')
      if (want !== got) {
        problems.push(`${language}: "${key}" uses {${got}} but English uses {${want}}`)
      }
    } catch {
      // checkLanguage reports the syntax error.
    }
  }
  return problems
}

export interface KeyUse {
  key: string
  file: string
  /** Names given in a literal `{ ... }` second argument; undefined when not a literal. */
  args?: string[]
}

/** Index of the brace that closes the one at `open`, or -1. */
function closingBrace(text: string, open: number): number {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    const c = text.charAt(i)
    if (c === '{' || c === '(' || c === '[') depth++
    else if (c === '}' || c === ')' || c === ']') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/** The top-level property names of an object literal's body: `a, b: x(1, 2), 'c': 3`. */
function propertyNames(body: string): string[] {
  const names: string[] = []
  let depth = 0
  let start = 0
  const flush = (end: number) => {
    const part = body.slice(start, end).trim()
    const m = /^(?:\.\.\.|\[)?(?:['"]?)([A-Za-z_$][\w$]*)/.exec(part)
    if (part !== '' && m?.[1]) names.push(part.startsWith('...') ? '...' : m[1])
  }
  for (let i = 0; i < body.length; i++) {
    const c = body.charAt(i)
    if ('({['.includes(c)) depth++
    else if (')}]'.includes(c)) depth--
    else if (c === ',' && depth === 0) {
      flush(i)
      start = i + 1
    }
  }
  flush(body.length)
  return names
}

/** Every message a TypeScript file asks for: `t('area.group.name', { ... })`. */
export function keysUsedInCode(file: string, text: string): KeyUse[] {
  const uses: KeyUse[] = []
  const call = /(?<![\w.$])(t|richNodes)\(\s*(['"`])([^'"`$]+)\2\s*([,)])/g
  for (const m of text.matchAll(call)) {
    const use: KeyUse = { key: m[3] ?? '', file }
    if (m[1] === 't' && m[4] === ',') {
      const after = text.slice(m.index + m[0].length)
      const open = after.search(/\S/)
      if (open >= 0 && after.charAt(open) === '{') {
        const end = closingBrace(after, open)
        if (end > 0) use.args = propertyNames(after.slice(open + 1, end))
      }
    }
    uses.push(use)
  }
  return uses
}

/** Keys that are built at run time (`t(\`a.${x}\`)`) cannot be checked; they are not allowed. */
export function dynamicKeysIn(file: string, text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(
    /(?<![\w.$])(?<!function )(?:t|richNodes)\(\s*(`[^`]*\$\{|[A-Za-z_$])/g,
  )) {
    out.push(`${file}: ${text.slice(m.index, m.index + 50).split('\n')[0]}`)
  }
  return out
}

/** Every message a page asks for in its HTML: data-i18n, data-i18n-rich, data-i18n-attrs. */
export function keysUsedInHtml(file: string, html: string): KeyUse[] {
  const uses: KeyUse[] = []
  for (const m of html.matchAll(/data-i18n(?:-rich)?="([^"]+)"/g))
    uses.push({ key: m[1] ?? '', file })
  for (const m of html.matchAll(/data-i18n-attrs="([^"]+)"/g)) {
    for (const pair of (m[1] ?? '').split(';')) {
      const key = pair.split(':')[1]?.trim()
      if (key) uses.push({ key, file })
    }
  }
  return uses
}

/** Used keys against defined ones: nothing missing, nothing unused, arguments that fit. */
export function checkUses(
  english: CatalogFile,
  uses: KeyUse[],
  alsoUsed: Iterable<string> = [],
): string[] {
  const problems: string[] = []
  const used = new Set<string>(alsoUsed)
  for (const use of uses) {
    used.add(use.key)
    const entry = english[use.key]
    if (!entry) {
      problems.push(`${use.file}: uses "${use.key}", which English does not have`)
      continue
    }
    if (use.args && !use.args.includes('...')) {
      const want = placeholdersOf(entry.message)
      const got = [...new Set(use.args)].sort()
      if (want.join(',') !== got.join(',')) {
        problems.push(
          `${use.file}: "${use.key}" is given {${got.join(', ')}} but the message uses {${want.join(', ')}}`,
        )
      }
    }
  }
  for (const key of Object.keys(english)) {
    if (!used.has(key)) problems.push(`"${key}" is in the English catalog but nothing uses it`)
  }
  return problems
}
