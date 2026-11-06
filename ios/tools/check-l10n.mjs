#!/usr/bin/env node
// Checks that the iOS app's text lives in its String Catalogs (docs/L10N.md).
//
//   node ios/tools/check-l10n.mjs
//
// Needs Xcode (it runs `xcrun xcstringstool extract`, Apple's own scanner, on the Swift
// sources) and no build. Fails, with the file and line, when:
//
//   1. a sentence-like string literal in the Swift code is neither in a catalog nor marked
//      `// l10n-ignore: <reason>` on its line (or the line above): it would bypass
//      translation and show in English forever;
//   2. a catalog entry has no use in the code (stale);
//   3. a catalog entry has no translator comment or no English value, or its English is still "new";
//   4. a string that takes a count ("%lld") has no plural forms, unless its comment says
//      the number is not a count (a status code, a protocol version);
//   5. a translation of another language has other placeholders than the English, or is
//      missing, once a language is added;
//   6. the display name or permission text in InfoPlist.xcstrings differs from project.yml;
//   7. the English text has an em dash (the owner's copy rule);
//   8. a screen shows the relay's own error message (`error.message`), which is English,
//      instead of `RelayErrorText.line`.
//
// What it cannot see: a sentence assembled at run time from variables, or a literal handed
// to a function that shows it without looking it up. Reviews and the Simulator pass
// (README.md, "Checking the text") cover that. ios/tools/l10n-sync.sh checks the catalogs
// against the compiler's own list of strings, which needs a build.
//
// Exit codes: 0 fine, 1 problems found, 2 the check could not run.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const IOS = join(dirname(fileURLToPath(import.meta.url)), '..')
const rel = (p) => relative(join(IOS, '..'), p)

/** The builds that read catalogs: which Swift files go in, which catalogs they read. */
const TARGETS = {
  app: {
    dirs: ['App/Sources', 'App/Shared'],
    catalogs: {
      Localizable: 'App/Sources/Localizable.xcstrings',
      Shared: 'App/Shared/Shared.xcstrings',
    },
  },
  share: {
    dirs: ['App/ShareExtension', 'App/Shared'],
    catalogs: {
      Localizable: 'App/ShareExtension/Localizable.xcstrings',
      Shared: 'App/Shared/Shared.xcstrings',
    },
  },
  // The notification extension (docs/PLANS.md P-29). Its text comes from TabsendKit and
  // from the app's catalog (the push's `NEW_LINK` key), so it has no catalog of its own.
  notify: {
    dirs: ['App/NotifyExtension'],
    catalogs: {},
  },
  kit: {
    dirs: ['TabsendKit/Sources/TabsendKit'],
    catalogs: { Localizable: 'TabsendKit/Sources/TabsendKit/Resources/Localizable.xcstrings' },
  },
}
const INFO_PLIST = [
  { catalog: 'App/Sources/InfoPlist.xcstrings', target: 'Tabsend' },
  { catalog: 'App/ShareExtension/InfoPlist.xcstrings', target: 'TabsendShare' },
]

const problems = []
const fail = (where, what) => problems.push(`${where}: ${what}`)

// ---------------------------------------------------------------------------- helpers

function swiftFiles(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...swiftFiles(p))
    else if (name.endsWith('.swift')) out.push(p)
  }
  return out
}

/** "%@", "%lld", "%1$@", "%arg" and "%#@x@" all become "%", so a key written by the
 * compiler and the same key as the lightweight scanner sees it compare equal. */
const norm = (key) =>
  key.replace(/%arg|%(?:\d+\$)?(?:l{0,2}[dDiIuUxXoOcCsSaAeEfFgG@])|%#@\w+@/g, '%')

/** The format specifiers in a string, as a sorted list ("%@", "%lld"), positional marks removed. */
const specifiers = (text) =>
  [...text.replace(/%arg|%#@\w+@/g, '').matchAll(/%(?:\d+\$)?(l{0,2}[dDiIuUxXoOcCsSaAeEfFgG@])/g)]
    .map((m) => `%${m[1]}`)
    .sort()

/** Sentence-like: two words, or a capitalised word (the single words that are button and
 * heading text). Technical strings (identifiers, symbol names, mime types, headers) are not. */
function looksLikeText(s, inApp) {
  const letters = s.replace(/%arg|%\S*/g, '').replace(/[^A-Za-zÀ-ɏ]/g, '')
  if (letters.length < 2) return false
  if (/^[a-z0-9_.:/#@$&=?+*~-]+$/.test(s)) return false // identifier, symbol name, mime type
  if (/^[A-Z]{2,8}$/.test(s)) return false // GET, POST, HTTP
  if (/^[A-Za-z]+(?:-[A-Za-z]+)+$/.test(s)) return false // Content-Type
  if (/^[A-Za-z]+:\/\//.test(s)) return false // an address
  if (/[A-Za-z]{2,}[  ][A-Za-z%]/.test(s)) return true // two words
  return inApp && /^[A-ZÀ-Þ]/.test(s) // one capitalised word, in UI code only
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    fail(rel(path), `cannot read: ${e.message}`)
    return null
  }
}

// ---------------------------------------------------------------------------- scan the code

function xcrun(args) {
  return execFileSync('xcrun', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

try {
  xcrun(['--find', 'xcstringstool'])
} catch {
  console.error('check-l10n: Xcode is needed (xcrun xcstringstool). The check did not run.')
  process.exit(2)
}

const scratch = mkdtempSync(join(tmpdir(), 'tabsend-l10n-'))

/** All string literals of one target's Swift files, from Apple's scanner:
 *  { table, key, file, line } for strings it can prove are looked up (Text, String(localized:)),
 *  and table = null for every other literal that could be a key. */
function scan(targetName, target) {
  const files = target.dirs.flatMap((d) => swiftFiles(join(IOS, d)))
  const out = join(scratch, targetName)
  execFileSync('mkdir', ['-p', out])
  // One file per call keeps the output name unique (several files share a base name).
  const literals = []
  files.forEach((file, index) => {
    const dir = join(out, String(index))
    execFileSync('mkdir', ['-p', dir])
    xcrun([
      'xcstringstool',
      'extract',
      file,
      '--SwiftUI',
      '--modern-localizable-strings',
      '--all-potential-swift-keys',
      '--output-directory',
      dir,
    ])
    for (const name of readdirSync(dir)) {
      const data = JSON.parse(readFileSync(join(dir, name), 'utf8'))
      for (const [table, items] of Object.entries(data.tables ?? {})) {
        for (const item of items) {
          literals.push({
            table: table === '__PotentialKeys' ? null : table,
            key: item.key,
            file,
            line: item.location?.startingLine ?? 0,
          })
        }
      }
    }
  })
  return literals
}

const sourceLines = new Map()
function ignored(file, line) {
  if (!sourceLines.has(file)) sourceLines.set(file, readFileSync(file, 'utf8').split('\n'))
  const lines = sourceLines.get(file)
  // The marker sits on the literal's line or the line above it.
  return [line - 1, line - 2].some((i) => i >= 0 && /l10n-ignore:/.test(lines[i] ?? ''))
}

// ---------------------------------------------------------------------------- the catalogs

const catalogs = {} // path -> parsed
function catalog(path) {
  if (!(path in catalogs)) catalogs[path] = readJson(join(IOS, path))
  return catalogs[path]
}

const usedKeys = {} // catalog path -> Set of normalised keys the code uses

for (const [name, target] of Object.entries(TARGETS)) {
  const inApp = name !== 'kit'
  const literals = scan(name, target)
  const known = {} // normalised key -> catalog path, over this target's catalogs
  for (const [table, path] of Object.entries(target.catalogs)) {
    const parsed = catalog(path)
    if (!parsed) continue
    usedKeys[path] ??= new Set()
    for (const key of Object.keys(parsed.strings)) known[`${table}\u0000${norm(key)}`] = path
  }
  const inAnyCatalog = (key) =>
    Object.keys(target.catalogs).some((table) => known[`${table}\u0000${norm(key)}`])

  for (const { table, key, file, line } of literals) {
    const where = `${rel(file)}:${line}`
    if (table) {
      // The compiler-level scanner proved this is looked up in `table`.
      const path = target.catalogs[table]
      if (!path) {
        fail(
          where,
          `"${key}" is looked up in table "${table}", which has no catalog in this target`,
        )
        continue
      }
      usedKeys[path]?.add(norm(key))
      if (!known[`${table}\u0000${norm(key)}`]) {
        fail(where, `"${key}" is not in ${path}. Run ios/tools/l10n-sync.sh, then add a comment.`)
      }
      continue
    }
    // Any other literal: fine when a catalog has it as a key (a custom view that takes a
    // LocalizedStringKey), fine when it is not a sentence or is marked, otherwise a bypass.
    if (inAnyCatalog(key)) {
      for (const t of Object.keys(target.catalogs)) {
        if (known[`${t}\u0000${norm(key)}`]) usedKeys[target.catalogs[t]].add(norm(key))
      }
      continue
    }
    if (!looksLikeText(key, inApp) || ignored(file, line)) continue
    fail(
      where,
      `"${key}" looks like text a person reads, but it is not in a String Catalog. Use ` +
        'String(localized:comment:) or a SwiftUI literal (Text, Button, Label), or mark the line ' +
        '`// l10n-ignore: <reason>` if it is not shown (a product name, an address, a log line).',
    )
  }
}

// The relay's own error text is English, written for a log and free to change. A screen
// must show `RelayErrorText.line(...)` instead (docs/L10N.md, rule 8). `ApiError.message`
// is read on a variable named `error` or `err`; `parsed.error.message` (where the client
// builds the error) has a dot before it and is not matched.
const RELAY_MESSAGE = /(?<![.\w])(?:error|err)\.message\b/
for (const target of Object.values(TARGETS)) {
  for (const file of target.dirs.flatMap((d) => swiftFiles(join(IOS, d)))) {
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((text, i) => {
        if (/^\s*\/\//.test(text) || !RELAY_MESSAGE.test(text) || ignored(file, i + 1)) return
        fail(
          `${rel(file)}:${i + 1}`,
          "shows the relay's own error text, which is English. Use RelayErrorText.line(error, during:) " +
            '(or mark the line `// l10n-ignore: <reason>` if it is never shown).',
        )
      })
  }
}

// Stale entries: in a catalog, used by no target that reads it.
for (const [path, parsed] of Object.entries(catalogs)) {
  if (!parsed) continue
  const used = usedKeys[path] ?? new Set()
  for (const key of Object.keys(parsed.strings)) {
    if (!used.has(norm(key)))
      fail(path, `"${key}" is in the catalog but nothing in the code uses it`)
  }
}

// ---------------------------------------------------------------------------- catalog hygiene

const NOT_A_COUNT = /not a count|not counts|protocol version/i

for (const [path, parsed] of Object.entries(catalogs)) {
  if (!parsed) continue
  if (parsed.sourceLanguage !== 'en')
    fail(path, `sourceLanguage is "${parsed.sourceLanguage}", expected "en"`)
  const languages = new Set()
  for (const entry of Object.values(parsed.strings)) {
    for (const lang of Object.keys(entry.localizations ?? {})) languages.add(lang)
  }

  for (const [key, entry] of Object.entries(parsed.strings)) {
    const here = `${path}: "${key.slice(0, 70)}${key.length > 70 ? '…' : ''}"`
    if (!entry.comment?.trim()) fail(here, 'has no translator comment')
    if (entry.extractionState === 'stale') fail(here, 'is marked stale')

    // Copy rule (CLAUDE.md, docs/L10N.md): no em dash in the English text. Short sentences
    // or commas instead. Other languages write their own punctuation.
    if ([key, JSON.stringify(entry.localizations?.en ?? {})].some((t) => t.includes('—')))
      fail(here, 'has an em dash in the English text; use two short sentences or a comma')

    const keySpecs = specifiers(key)
    const hasCount = keySpecs.some((s) => /ll?d|u/i.test(s))
    const en = entry.localizations?.en
    // Every key has an explicit English value, so iOS has the string in its tables and
    // `-NSShowNonLocalizedStrings YES` can tell a string it found from one it did not.
    if (!en)
      fail(
        here,
        'has no explicit English value (state "translated"); l10n-sync.sh does not add it, the README says how',
      )
    const plural =
      en?.variations?.plural ||
      Object.values(en?.substitutions ?? {}).some((s) => s.variations?.plural)
    if (hasCount && !plural && !NOT_A_COUNT.test(entry.comment ?? '')) {
      fail(
        here,
        'takes a number but has no plural forms (add them in Xcode: Vary by Plural), or say in the comment that the number is not a count',
      )
    }

    const units = (loc) => {
      const found = []
      const walk = (node) => {
        if (!node || typeof node !== 'object') return
        if (node.stringUnit) found.push(node.stringUnit)
        for (const value of Object.values(node)) walk(value)
      }
      walk(loc)
      return found
    }
    for (const [lang, loc] of Object.entries(entry.localizations ?? {})) {
      for (const unit of units(loc)) {
        if (lang === 'en' && unit.state && unit.state !== 'translated') {
          fail(here, `English is still "${unit.state}"`)
        }
        const mine = specifiers(unit.value ?? '')
        // A plural form may leave the number out ("a tab"); no form may add a placeholder.
        const extra = mine.filter((s) => !keySpecs.includes(s))
        const dropsOther =
          lang !== 'en' && keySpecs.some((s) => !s.match(/ll?d/) && !mine.includes(s))
        if (extra.length)
          fail(here, `${lang}: has placeholders the English key does not: ${extra.join(' ')}`)
        if (dropsOther)
          fail(here, `${lang}: is missing a placeholder of the English key (${keySpecs.join(' ')})`)
      }
    }
    for (const lang of languages) {
      if (lang !== 'en' && !entry.localizations?.[lang] && entry.shouldTranslate !== false) {
        fail(here, `has no ${lang} translation, but ${lang} is in this catalog`)
      }
    }
  }
}

// ---------------------------------------------------------------------------- Info.plist text

const project = readFileSync(join(IOS, 'project.yml'), 'utf8')
function projectValue(targetName, key) {
  const start = project.indexOf(`\n  ${targetName}:`)
  if (start < 0) return null
  const next = project.indexOf('\n  Tabsend', start + 1)
  const block = project.slice(start, next > start ? next : undefined)
  const m = block.match(new RegExp(`\\n\\s+${key}:\\s*(>-\\s*\\n\\s+)?([^\\n]+)`))
  return m ? m[2].trim() : null
}
for (const { catalog: path, target } of INFO_PLIST) {
  const parsed = readJson(join(IOS, path))
  if (!parsed) continue
  for (const [key, entry] of Object.entries(parsed.strings)) {
    const english = entry.localizations?.en?.stringUnit?.value
    const declared = projectValue(target, key)
    if (!entry.comment) fail(`${path}: ${key}`, 'has no translator comment')
    if (declared === null)
      fail(`${path}: ${key}`, `is not an Info.plist key of ${target} in project.yml`)
    else if (declared !== english)
      fail(`${path}: ${key}`, `English "${english}" differs from project.yml "${declared}"`)
  }
  for (const key of [
    'CFBundleDisplayName',
    ...(target === 'Tabsend' ? ['NSCameraUsageDescription'] : []),
  ]) {
    if (!parsed.strings[key]) fail(path, `${key} is missing`)
  }
}

rmSync(scratch, { recursive: true, force: true })

if (problems.length) {
  console.error(`check-l10n: ${problems.length} problem${problems.length === 1 ? '' : 's'}\n`)
  for (const p of problems) console.error(`  ${p}`)
  console.error('\nSee ios/README.md, "Text and languages".')
  process.exit(1)
}
const total = Object.values(catalogs).reduce((n, c) => n + Object.keys(c?.strings ?? {}).length, 0)
console.log(
  `check-l10n: ok (${total} strings in ${Object.keys(catalogs).length} catalogs, no stray text)`,
)
if (!existsSync(join(IOS, 'App/Sources/Localizable.xcstrings'))) process.exit(2)
