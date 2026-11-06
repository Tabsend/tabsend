#!/usr/bin/env node
// Checks that the Android app's text lives in strings.xml (docs/L10N.md, android/README.md).
//
//   node android/tools/check-l10n.mjs
//
// Needs only Node, no build and no Android tools. Fails, with the file and line, when:
//
//   1. a sentence-like string literal in the Kotlin code is not marked
//      `// l10n-ignore: <reason>` on its line (or the line above) and is not in a place that
//      never reaches a person (a log line, an exception message, an HTTP header): it would
//      bypass translation and show in English forever;
//   2. a screen shows the relay's own error text (`.message` of what the relay sent), which is
//      English: it asks RelayErrorText for a sentence by error code instead (rule 8);
//   3. the code picks between words by comparing a count to 1 next to a string resource: the
//      platform's plural system (`<plurals>`, CLDR categories) does that (rule 4);
//   4. a layout, menu, XML resource or the manifest carries literal text instead of `@string/`;
//   5. strings.xml: an entry has no translator comment; its comment does not name each
//      placeholder (`%1$s`); a `<string>` prints a count (`%d`) instead of using `<plurals>`
//      (unless its comment says "not a count"); a `<plurals>` lacks `other`; two placeholders
//      are not positional; the English has an exclamation mark or a new em dash;
//   6. a key is used in code but missing from strings.xml, or defined and never used;
//   7. a `values-xx/strings.xml` (once a language is added) has other keys than English,
//      other placeholders, or a plural category CLDR does not have;
//   8. debug builds do not enable the pseudo-locales (en-XA), or release builds do.
//
// What it cannot see: a sentence assembled at run time from variables with no literal in it,
// or a literal handed to a function that shows it. Reviews and the pseudo-locale pass
// (android/README.md, "Checking the text") cover that.
//
// Exit codes: 0 fine, 1 problems found, 2 the check could not run.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ANDROID = join(dirname(fileURLToPath(import.meta.url)), '..')
const APP = join(ANDROID, 'app')
const SRC = join(APP, 'src', 'main')
const rel = (p) => relative(join(ANDROID, '..'), p)

/** English sentences that already had an em dash when the catalog was made (the owner's copy rule
 * says no em dashes in anything new; these keep theirs until the owner has them matched on every
 * client, docs/L10N.md "iOS notes"). A new entry with a dash fails. Shrink this list, never grow it. */
export const KNOWN_DASH = new Set([
  'send_sent_offline',
  'send_source_offline',
  'send_no_devices',
  'send_hard_error',
  'share_pick_gone',
  'protocol_outdated',
  'join_error_cert_mismatch',
  'join_error_cleartext',
])

// ---------------------------------------------------------------------------- Kotlin scanning

/**
 * Splits Kotlin source into string literals and everything else.
 * Returns the literals, each as { text, line }: `text` is the static part with every `$name`
 * and `${...}` replaced by U+0001, escapes resolved; `line` is where it starts (1-based).
 * Comments are skipped (KDoc and `//`), as are character literals.
 */
export function kotlinLiterals(source) {
  const out = []
  let i = 0
  let line = 1
  const n = source.length

  /** Reads a double-quoted or raw string starting at the opening quote; returns its static text. */
  function readString() {
    const startLine = line
    const raw = source.startsWith('"""', i)
    i += raw ? 3 : 1
    let text = ''
    for (;;) {
      if (i >= n) break
      const c = source[i]
      if (raw ? source.startsWith('"""', i) : c === '"') {
        i += raw ? 3 : 1
        break
      }
      if (c === '\n') line++
      if (!raw && c === '\\') {
        const next = source[i + 1]
        if (next === 'u') {
          text += String.fromCharCode(parseInt(source.slice(i + 2, i + 6), 16))
          i += 6
        } else {
          text += { n: '\n', t: '\t', r: '\r', b: '\b' }[next] ?? next
          i += 2
        }
        continue
      }
      if (c === '$' && source[i + 1] === '{') {
        text += '\u0001'
        i += 2
        skipCode('}') // a template expression is code, with its own strings
        continue
      }
      if (c === '$' && /[A-Za-z_]/.test(source[i + 1] ?? '')) {
        text += '\u0001'
        i++
        while (i < n && /\w/.test(source[i])) i++
        continue
      }
      text += c
      i++
    }
    out.push({ text, line: startLine })
  }

  /** Skips code up to the closing [end] bracket at depth 0, recording any string literals met. */
  function skipCode(end) {
    let depth = 0
    while (i < n) {
      const c = source[i]
      if (c === '\n') line++
      if (c === '/' && source[i + 1] === '/') {
        while (i < n && source[i] !== '\n') i++
        continue
      }
      if (c === '/' && source[i + 1] === '*') {
        const close = source.indexOf('*/', i + 2)
        const stop = close < 0 ? n : close + 2
        for (let k = i; k < stop; k++) if (source[k] === '\n') line++
        i = stop
        continue
      }
      if (c === '"') {
        readString()
        continue
      }
      if (c === "'") {
        // A character literal: 'a', '\n', '\u00e9', '"'. Skip to its closing quote.
        const close = source.indexOf("'", i + (source[i + 1] === '\\' ? 3 : 2))
        i = close < 0 || close - i > 8 ? i + 1 : close + 1
        continue
      }
      if (c === '{' || c === '(' || c === '[') depth++
      if (c === '}' || c === ')' || c === ']') {
        if (depth === 0 && c === end) {
          i++
          return
        }
        depth--
      }
      i++
    }
  }

  skipCode('\u0000') // the whole file: never closes
  return out
}

/** Sentence-like: two words, or one capitalised word of three letters or more. */
export function looksLikeText(text) {
  const t = text.replace(/\u0001/g, '')
  if (/[A-Za-z]{2,}[  ][A-Za-z]/.test(text)) return true
  if (/^[A-Z][a-z]{2,}[.!?…:]?$/.test(t) && text === t) return true
  return false
}

/** Where a literal never reaches a person: logs, exception messages, HTTP headers, tags. */
const NOT_UI = [
  /\bLog\.[a-z]\(/,
  /\blog\(/,
  /\b(?:\w*Exception|\w*Error|AssertionError)\(/,
  /\b(?:require|check|error|assert\w*|requireNotNull|checkNotNull)\(/,
  /\b(?:header|addHeader|removeHeader|addQueryParameter|toMediaType|toMediaTypeOrNull)\(/,
  /\bTAG\b/,
  /\bLOG_TAG\b/,
  /\bUSER_AGENT\b/,
  /@SerialName/,
  /\bRegex\(/,
  /\.toRegex\(\)/,
]

/** The code of the Kotlin files under src/main/java, with the literals that look like UI text. */
export function findTypedText(source) {
  const lines = source.split('\n')
  const problems = []
  for (const { text, line } of kotlinLiterals(source)) {
    if (!looksLikeText(text)) continue
    const here = lines[line - 1] ?? ''
    const above = lines[line - 2] ?? ''
    const above2 = lines[line - 3] ?? ''
    // The marker sits on the literal's line or the line above it.
    if (/l10n-ignore:/.test(here) || /l10n-ignore:/.test(above)) continue
    // A literal on a continuation line takes the context of the statement it continues.
    const context = [here]
    if (/[(,+]\s*$/.test(above)) context.push(above)
    if (/[(,+]\s*$/.test(above) && /[(,+]\s*$/.test(above2)) context.push(above2)
    if (context.some((c) => NOT_UI.some((re) => re.test(c)))) continue
    problems.push({ line, text: text.replace(/\u0001/g, '${…}') })
  }
  return problems
}

/** `.message` read in a file that shows things to a person. */
export function findRelayMessage(source) {
  const out = []
  source.split('\n').forEach((text, index) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(text)) return
    if (/l10n-ignore:/.test(text) || /l10n-ignore:/.test(source.split('\n')[index - 1] ?? '')) return
    if (/\bLog\.[a-z]\(/.test(text)) return // a log line is for developers
    if (/\.message\b(?!\s*\()/.test(text)) out.push({ line: index + 1, text: text.trim() })
  })
  return out
}

/** A count compared to 1 within a few lines of a string resource being picked. */
export function findCountChecks(source) {
  const lines = source.split('\n')
  const out = []
  lines.forEach((text, index) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(text)) return
    if (!/(?:==|!=|<=|>=|<|>)\s*1\b(?!\d)/.test(text.replace(/\/\/.*$/, ''))) return
    if (!/\b(count|size|n|num\w*|total|\w*Count|\w*\.size)\b/.test(text)) return
    const near = lines.slice(index, index + 4).join('\n')
    if (!/R\.string\.|getString\(|R\.plurals\./.test(near)) return
    if (/l10n-ignore:/.test(text) || /l10n-ignore:/.test(lines[index - 1] ?? '')) return
    out.push({ line: index + 1, text: text.trim() })
  })
  return out
}

// ---------------------------------------------------------------------------- the catalog

/** Parses a strings.xml into entries, each with the comments above it. */
export function parseCatalog(xml) {
  const entries = []
  const re = /<!--([\s\S]*?)-->|<(string|plurals)\b([^>]*)>([\s\S]*?)<\/\2>/g
  let comments = [] // comments since the last entry: { text, endIndex }
  let last = 0
  let m
  while ((m = re.exec(xml))) {
    const gap = xml.slice(last, m.index)
    if (m[1] !== undefined) {
      comments.push({ text: m[1], start: m.index, end: m.index + m[0].length })
    } else {
      const attrs = m[3]
      const name = /name="([^"]+)"/.exec(attrs)?.[1]
      const entry = {
        kind: m[2],
        name,
        translatable: !/translatable="false"/.test(attrs),
        line: xml.slice(0, m.index).split('\n').length,
        items: [],
        text: '',
        comment: '',
      }
      if (m[2] === 'string') {
        entry.text = m[4]
      } else {
        for (const item of m[4].matchAll(/<item\b[^>]*quantity="(\w+)"[^>]*>([\s\S]*?)<\/item>/g)) {
          entry.items.push({ quantity: item[1], text: item[2] })
        }
        entry.text = entry.items.map((it) => it.text).join('\n')
      }
      // The comment above counts when nothing but white space (and no blank line) separates it
      // from the entry, or from other entries that share it in a run.
      const near = [...comments].reverse().find((c) => {
        const between = xml.slice(c.end, m.index)
        return !/\n[ \t]*\n/.test(between)
      })
      entry.comment = near ? near.text : ''
      entries.push(entry)
      comments = comments.filter((c) => c === near)
    }
    void gap
    last = m.index + m[0].length
  }
  return entries
}

/** Positional placeholders ("%1$s") in a text, as tokens "%1$s". */
export const placeholders = (text) => [...text.matchAll(/%(\d+)\$[sdf]/g)].map((m) => m[0])
const unnumbered = (text) => [...text.matchAll(/%(?!\d+\$)[sdf]/g)].map((m) => m[0])

export function checkCatalog(entries, fail, where) {
  const seen = new Set()
  for (const e of entries) {
    const at = `${where}:${e.line}`
    if (seen.has(e.name)) fail(at, `${e.name}: defined twice`)
    seen.add(e.name)
    const texts = e.kind === 'plurals' ? e.items.map((i) => i.text) : [e.text]
    const tokens = [...new Set(texts.flatMap(placeholders))]
    if (texts.some((t) => unnumbered(t).length > 0)) {
      fail(at, `${e.name}: use positional placeholders (%1$s), so a translation can reorder them`)
    }
    if (!e.comment.trim()) {
      fail(at, `${e.name}: no translator comment (where it appears, what each placeholder holds)`)
    } else {
      for (const token of tokens) {
        const position = token.slice(0, token.indexOf('$') + 1) // "%1$"
        if (!e.comment.includes(position)) {
          fail(at, `${e.name}: its comment does not say what ${token} holds (name it as ${position}s)`)
        }
      }
    }
    if (e.kind === 'plurals') {
      const have = new Set(e.items.map((i) => i.quantity))
      if (!have.has('other')) fail(at, `${e.name}: a <plurals> needs an "other" form`)
      if (!have.has('one')) fail(at, `${e.name}: a <plurals> needs a "one" form for English`)
      for (const q of have) {
        if (!['zero', 'one', 'two', 'few', 'many', 'other'].includes(q)) fail(at, `${e.name}: "${q}" is not a CLDR category`)
      }
    } else if (/%\d+\$d|%d/.test(e.text) && !/not a count/i.test(e.comment)) {
      fail(at, `${e.name}: prints a number, so it needs <plurals>; if the number is not a count say "not a count" in its comment`)
    }
    if (e.translatable) {
      if (/!/.test(e.text.replace(/<[^>]*>/g, ''))) fail(at, `${e.name}: no exclamation marks in English copy`)
      if (/[—–]/.test(e.text) && !KNOWN_DASH.has(e.name)) fail(at, `${e.name}: no em dashes in English copy (short sentences or commas)`)
    }
  }
}

/** Another language must match English: same keys, same placeholders, valid plural categories. */
export function checkTranslation(english, other, fail, where) {
  const byName = new Map(english.map((e) => [e.name, e]))
  const names = new Set(other.map((e) => e.name))
  for (const e of english) {
    if (e.translatable && !names.has(e.name)) fail(where, `${e.name}: missing (English has it)`)
  }
  for (const t of other) {
    const e = byName.get(t.name)
    const at = `${where}:${t.line}`
    if (!e) {
      fail(at, `${t.name}: not in English (stale)`)
      continue
    }
    if (!e.translatable) {
      fail(at, `${t.name}: marked translatable="false" in English`)
      continue
    }
    if (e.kind !== t.kind) {
      fail(at, `${t.name}: is a <${t.kind}> here and a <${e.kind}> in English`)
      continue
    }
    const want = (e.kind === 'plurals' ? e.items.find((i) => i.quantity === 'other')?.text ?? '' : e.text)
    const gotTexts = t.kind === 'plurals' ? t.items.map((i) => i.text) : [t.text]
    const wantTokens = [...new Set(placeholders(want))].sort()
    for (const got of gotTexts) {
      const gotTokens = [...new Set(placeholders(got))].sort()
      // A "one" form may leave the number out; every placeholder it has must exist in English.
      const extra = gotTokens.filter((g) => !wantTokens.includes(g))
      if (extra.length) fail(at, `${t.name}: has ${extra.join(', ')}, which English does not`)
    }
    const all = [...new Set(gotTexts.flatMap(placeholders))].sort()
    const missing = wantTokens.filter((w) => !all.includes(w))
    if (missing.length) fail(at, `${t.name}: lacks ${missing.join(', ')}, which English has`)
    if (t.kind === 'plurals') {
      const cats = t.items.map((i) => i.quantity)
      if (!cats.includes('other')) fail(at, `${t.name}: a <plurals> needs an "other" form`)
      for (const q of cats) {
        if (!['zero', 'one', 'two', 'few', 'many', 'other'].includes(q)) fail(at, `${t.name}: "${q}" is not a CLDR category`)
      }
    }
  }
}

// ---------------------------------------------------------------------------- files

function walk(dir, ext, out = []) {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, ext, out)
    else if (ext.some((e) => name.endsWith(e))) out.push(p)
  }
  return out
}

/** Strings a layout takes from a library (Material), not from our catalog. */
const LIBRARY_KEYS = new Set(['appbar_scrolling_view_behavior'])

/** The files whose strings a person reads: screens, notifications, dialogs. Relay text may not reach them. */
const SCREEN_FILES = [
  'ui/',
  'send/ShareActivity.kt',
  'send/SendNotifications.kt',
  'send/ShareShortcuts.kt',
  'receive/Notifications.kt',
  'receive/NewDeviceWatcher.kt',
  'receive/GroupResetWatcher.kt',
  'receive/StreamService.kt',
  'receive/OpenLinksActivity.kt',
]

export function run() {
  const problems = []
  const fail = (where, what) => problems.push(`${where}: ${what}`)

  const catalogPath = join(SRC, 'res', 'values', 'strings.xml')
  if (!existsSync(catalogPath)) {
    console.error(`check-l10n: ${rel(catalogPath)} not found. The check did not run.`)
    return 2
  }
  const english = parseCatalog(readFileSync(catalogPath, 'utf8'))
  checkCatalog(english, fail, rel(catalogPath))
  for (const known of KNOWN_DASH) {
    if (!english.some((e) => e.name === known && /[—–]/.test(e.text))) {
      fail(rel(catalogPath), `${known} is on the known-dash list but has no dash: remove it from KNOWN_DASH in check-l10n.mjs`)
    }
  }
  const defined = new Set(english.map((e) => e.name))

  // 1-3: the Kotlin code.
  const kotlin = walk(join(SRC, 'java'), ['.kt'])
  const used = new Set()
  for (const file of kotlin) {
    const source = readFileSync(file, 'utf8')
    const where = rel(file)
    for (const m of source.matchAll(/(?<![\w.])R\.(?:string|plurals)\.(\w+)/g)) used.add(m[1])
    for (const m of source.matchAll(/(?<!android\.)\bio\.tabsend\.app\.R\.(?:string|plurals)\.(\w+)/g)) used.add(m[1])
    for (const p of findTypedText(source)) {
      fail(`${where}:${p.line}`, `typed-in text "${p.text}": move it into strings.xml, or mark the line \`// l10n-ignore: <reason>\``)
    }
    const underJava = relative(join(SRC, 'java', 'io', 'tabsend', 'app'), file)
    if (SCREEN_FILES.some((s) => (s.endsWith('/') ? underJava.startsWith(s) : underJava === s))) {
      for (const p of findRelayMessage(source)) {
        fail(`${where}:${p.line}`, `the relay's own message is English: ask RelayErrorText for a sentence by code (${p.text})`)
      }
    }
    for (const p of findCountChecks(source)) {
      fail(`${where}:${p.line}`, `a count compared to 1 picks between sentences: use <plurals> and getQuantityString (${p.text})`)
    }
  }

  // 4: layouts, menus, XML resources, manifest.
  const xmlFiles = [
    ...walk(join(SRC, 'res', 'layout'), ['.xml']),
    ...walk(join(SRC, 'res', 'menu'), ['.xml']),
    ...walk(join(SRC, 'res', 'xml'), ['.xml']),
    ...walk(join(SRC, 'res', 'drawable'), ['.xml']),
    join(SRC, 'AndroidManifest.xml'),
  ].filter(existsSync)
  for (const file of xmlFiles) {
    const xml = readFileSync(file, 'utf8')
    for (const m of xml.matchAll(/(?<!tools:)(?:android|app):(text|hint|contentDescription|label|title|subtitle|tooltipText|shortcutShortLabel|shortcutLongLabel|summary)="([^"@?]*[A-Za-z][^"]*)"/g)) {
      const line = xml.slice(0, m.index).split('\n').length
      fail(`${rel(file)}:${line}`, `literal ${m[1]}="${m[2]}": use @string/ so it can be translated`)
    }
    for (const m of xml.matchAll(/@(?:string|plurals)\/(\w+)/g)) if (!LIBRARY_KEYS.has(m[1])) used.add(m[1])
  }

  // 6: keys used and defined.
  for (const key of used) {
    if (!defined.has(key)) fail(rel(catalogPath), `${key}: used in the code but not defined`)
  }
  for (const e of english) {
    if (!used.has(e.name)) fail(`${rel(catalogPath)}:${e.line}`, `${e.name}: defined but never used`)
  }

  // 7: other languages.
  const resDir = join(SRC, 'res')
  for (const dir of readdirSync(resDir)) {
    if (!/^values-(?:[a-z]{2,3}(?:-r[A-Z]{2})?|b\+[A-Za-z+]+)$/.test(dir)) continue
    const file = join(resDir, dir, 'strings.xml')
    if (!existsSync(file)) continue
    checkTranslation(english, parseCatalog(readFileSync(file, 'utf8')), fail, rel(file))
  }

  // 8: pseudo-locales.
  const gradle = readFileSync(join(APP, 'build.gradle.kts'), 'utf8')
  const block = (name) => {
    const start = gradle.search(new RegExp(`\\b${name}\\s*\\{`))
    if (start < 0) return ''
    let depth = 0
    for (let i = gradle.indexOf('{', start); i < gradle.length; i++) {
      if (gradle[i] === '{') depth++
      if (gradle[i] === '}' && --depth === 0) return gradle.slice(start, i)
    }
    return ''
  }
  if (!/isPseudoLocalesEnabled\s*=\s*true/.test(block('debug'))) {
    fail(rel(join(APP, 'build.gradle.kts')), 'the debug build type must set isPseudoLocalesEnabled = true (en-XA)')
  }
  if (/isPseudoLocalesEnabled\s*=\s*true/.test(block('release'))) {
    fail(rel(join(APP, 'build.gradle.kts')), 'the release build type must not enable pseudo-locales')
  }

  if (problems.length) {
    console.error(`check-l10n: ${problems.length} problem${problems.length === 1 ? '' : 's'}\n`)
    for (const p of problems) console.error(`  ${p}`)
    console.error('\nSee docs/L10N.md and android/README.md, "Text and languages".')
    return 1
  }
  console.log(`check-l10n: ${english.length} messages, ${kotlin.length} Kotlin files, all text in strings.xml`)
  return 0
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(run())
