/**
 * The message formatter every TypeScript surface shares (docs/L10N.md): the browser
 * extension today, the web console when it moves over. Pure, no DOM, no `chrome`, so it
 * runs in a service worker, a page, and a test alike.
 *
 * A message is a whole sentence with NAMED placeholders, in the ICU MessageFormat subset
 * translators already know from every translation tool:
 *
 *   Sent to {device}
 *   {count, plural, one {Sent # tab} other {Sent # tabs}}
 *   {count, number}
 *   {kind, select, tab {this tab} other {this link}}
 *
 * Plurals go through `Intl.PluralRules`, so a language with more than two forms (Polish,
 * Arabic) works with no change here; the message just lists the forms it needs. Inside a
 * plural, `#` is the number. An apostrophe is an ordinary letter ("isn't"); it only
 * starts a quote when it sits right before a brace, and `''` is a literal apostrophe,
 * which is how ICU itself behaves.
 *
 * `en-XA` is the pseudo-locale (see `PSEUDO_LOCALE`): the same message with accented
 * letters, about 40 percent longer, in brackets. It is a development switch that shows
 * which text never reached a catalog.
 */

/** Values a message can use. Numbers are formatted for the locale; strings go in as they are. */
export type MessageArgs = Readonly<Record<string, string | number>>

/** The development-only locale that accents and brackets English. Never shipped. */
export const PSEUDO_LOCALE = 'en-XA'

type Part =
  | string
  | { pound: true }
  | { arg: string; number?: true }
  | { arg: string; kind: 'plural'; offset: number; cases: Record<string, Part[]> }
  | { arg: string; kind: 'select'; cases: Record<string, Part[]> }

class MessageSyntaxError extends Error {
  constructor(message: string, source: string, at: number) {
    super(`${message} at ${at} in "${source}"`)
    this.name = 'MessageSyntaxError'
  }
}

const NAME = /[A-Za-z0-9_.]/
const SELECTOR = /[A-Za-z0-9_=]/

/** Parse once per distinct message; a message is a few dozen characters, so this stays small. */
const parsed = new Map<string, Part[]>()

function parse(source: string): Part[] {
  const cached = parsed.get(source)
  if (cached) return cached
  let i = 0

  const fail = (what: string): never => {
    throw new MessageSyntaxError(what, source, i)
  }
  const skipSpace = () => {
    while (i < source.length && /\s/.test(source.charAt(i))) i++
  }
  const readWhile = (re: RegExp): string => {
    const start = i
    while (i < source.length && re.test(source.charAt(i))) i++
    return source.slice(start, i)
  }
  const expect = (ch: string) => {
    if (source.charAt(i) !== ch) fail(`Expected "${ch}"`)
    i++
  }

  // `nested` means we are inside a { } branch and stop at its closing brace;
  // `inPlural` means a bare # is the plural's number.
  const sequence = (nested: boolean, inPlural: boolean): Part[] => {
    const parts: Part[] = []
    let text = ''
    const flush = () => {
      if (text !== '') parts.push(text)
      text = ''
    }
    while (i < source.length) {
      const c = source.charAt(i)
      if (c === "'") {
        const next = source.charAt(i + 1)
        if (next === "'") {
          text += "'"
          i += 2
        } else if (next === '{' || next === '}') {
          // Quoted run: everything up to the next lone apostrophe is literal.
          i++
          while (i < source.length) {
            if (source.charAt(i) === "'") {
              if (source.charAt(i + 1) === "'") {
                text += "'"
                i += 2
                continue
              }
              i++
              break
            }
            text += source.charAt(i++)
          }
        } else {
          text += c
          i++
        }
      } else if (c === '{') {
        flush()
        i++
        parts.push(argument(inPlural))
      } else if (c === '}') {
        if (!nested) fail('Unmatched "}"')
        break
      } else if (c === '#' && inPlural) {
        flush()
        parts.push({ pound: true })
        i++
      } else {
        text += c
        i++
      }
    }
    flush()
    return parts
  }

  const branches = (inPlural: boolean, allowOffset: boolean) => {
    const cases: Record<string, Part[]> = {}
    let offset = 0
    for (;;) {
      skipSpace()
      if (source.charAt(i) === '}') break
      const selector = readWhile(SELECTOR)
      if (selector === '') fail('Expected a plural or select form')
      if (allowOffset && selector === 'offset' && source.charAt(i) === ':') {
        i++
        skipSpace()
        offset = Number(readWhile(/[0-9]/))
        continue
      }
      skipSpace()
      expect('{')
      cases[selector] = sequence(true, inPlural)
      expect('}')
    }
    if (!('other' in cases)) fail('A plural or select needs an "other" form')
    return { cases, offset }
  }

  const argument = (outerPlural: boolean): Part => {
    skipSpace()
    const name = readWhile(NAME)
    if (name === '') fail('Expected a placeholder name')
    skipSpace()
    if (source.charAt(i) === '}') {
      i++
      return { arg: name }
    }
    expect(',')
    skipSpace()
    const kind = readWhile(/[a-z]/)
    skipSpace()
    if (kind === 'number') {
      expect('}')
      return { arg: name, number: true }
    }
    if (kind !== 'plural' && kind !== 'select') return fail(`Unknown placeholder type "${kind}"`)
    expect(',')
    // A # inside a select that sits inside a plural still means the plural's number.
    const { cases, offset } = branches(kind === 'plural' || outerPlural, kind === 'plural')
    expect('}')
    return kind === 'plural' ? { arg: name, kind, offset, cases } : { arg: name, kind, cases }
  }

  const result = sequence(false, false)
  parsed.set(source, result)
  return result
}

/** The placeholder names a message uses (plural and select selectors included), sorted. */
export function placeholdersOf(message: string): string[] {
  const names = new Set<string>()
  const walk = (parts: Part[]) => {
    for (const part of parts) {
      if (typeof part === 'string' || 'pound' in part) continue
      names.add(part.arg)
      if ('cases' in part) for (const branch of Object.values(part.cases)) walk(branch)
    }
  }
  walk(parse(message))
  return [...names].sort()
}

const numberFormats = new Map<string, Intl.NumberFormat>()
function formatNumber(n: number, locale: string): string {
  let nf = numberFormats.get(locale)
  if (!nf) {
    nf = new Intl.NumberFormat(locale)
    numberFormats.set(locale, nf)
  }
  return nf.format(n)
}

const pluralRules = new Map<string, Intl.PluralRules>()
function pluralCategory(n: number, locale: string): string {
  let rules = pluralRules.get(locale)
  if (!rules) {
    rules = new Intl.PluralRules(locale)
    pluralRules.set(locale, rules)
  }
  return rules.select(n)
}

const ACCENTS: Record<string, string> = {
  a: 'å', b: 'ƀ', c: 'ç', d: 'ð', e: 'é', f: 'ƒ', g: 'ĝ', h: 'ĥ', i: 'î', j: 'ĵ', k: 'ķ', l: 'ļ',
  m: 'ɱ', n: 'ñ', o: 'ö', p: 'þ', q: 'ǫ', r: 'ŕ', s: 'š', t: 'ţ', u: 'ü', v: 'ṽ', w: 'ŵ', x: 'ẋ',
  y: 'ý', z: 'ž', A: 'Å', B: 'Ɓ', C: 'Ç', D: 'Ð', E: 'É', F: 'Ƒ', G: 'Ĝ', H: 'Ĥ', I: 'Î', J: 'Ĵ',
  K: 'Ķ', L: 'Ļ', M: 'Ṁ', N: 'Ñ', O: 'Ö', P: 'Þ', Q: 'Ǫ', R: 'Ŕ', S: 'Š', T: 'Ţ', U: 'Ü', V: 'Ṽ',
  W: 'Ŵ', X: 'Ẋ', Y: 'Ý', Z: 'Ž',
}

// Markup tags in a message (<link>..</link>) are code, not words: leave them readable.
const TAG = /(<\/?[a-z][a-z0-9]*>)/

function accent(text: string): string {
  return text
    .split(TAG)
    .map((piece, i) => {
      if (i % 2 === 1) return piece
      let out = ''
      for (const ch of piece) out += ACCENTS[ch] ?? ch
      return out
    })
    .join('')
}

interface Run {
  locale: string
  args: MessageArgs
  pseudo: boolean
  /** Letters of fixed text shown, so the pseudo padding is about 40 percent of it. */
  literal: number
}

function numberArg(args: MessageArgs, name: string, source: string): number {
  const value = args[name]
  const n = typeof value === 'number' ? value : Number(value)
  if (value === undefined || Number.isNaN(n)) {
    throw new Error(`Placeholder {${name}} needs a number in "${source}"`)
  }
  return n
}

function render(parts: Part[], run: Run, source: string, pound?: number): string {
  let out = ''
  for (const part of parts) {
    if (typeof part === 'string') {
      run.literal += part.length
      out += run.pseudo ? accent(part) : part
    } else if ('pound' in part) {
      out += formatNumber(pound ?? 0, run.locale)
    } else {
      const value = run.args[part.arg]
      if (value === undefined) throw new Error(`Missing placeholder {${part.arg}} for "${source}"`)
      if (!('kind' in part)) {
        out += part.number || typeof value === 'number'
          ? formatNumber(numberArg(run.args, part.arg, source), run.locale)
          : String(value)
      } else if (part.kind === 'plural') {
        const n = numberArg(run.args, part.arg, source) - part.offset
        const exact = part.cases[`=${n + part.offset}`]
        const branch = exact ?? part.cases[pluralCategory(n, run.locale)] ?? part.cases.other
        out += render(branch ?? [], run, source, n)
      } else {
        const branch = part.cases[String(value)] ?? part.cases.other
        out += render(branch ?? [], run, source, pound)
      }
    }
  }
  return out
}

/**
 * Fill a message in. Throws if the message is malformed or a placeholder has no value: a
 * catalog is checked by tests, and the extension falls back to English if a translation
 * ever throws here (see `translate` in the extension).
 *
 * `locale` picks the plural rules and number format; use the locale of the catalog the
 * message came from, so a German sentence gets German plurals.
 */
export function formatMessage(
  message: string,
  args: MessageArgs = {},
  locale = 'en',
  options: { pseudo?: boolean } = {},
): string {
  const pseudo = options.pseudo === true
  const run: Run = { locale: pseudo ? 'en' : locale, args, pseudo, literal: 0 }
  const text = render(parse(message), run, message)
  if (!pseudo) return text
  // About 40 percent longer than the English it stands for, then bracketed.
  return `[${text}${'~'.repeat(Math.ceil(run.literal * 0.4))}]`
}

/**
 * The locales to try, best first, for what the person asked for. `de-AT` gives
 * `['de-AT', 'de', 'en']` when those are available; `en` (the source) is always last and
 * always present. Matching ignores case (`pt-br` finds `pt-BR`); underscores count as
 * dashes. Never returns a locale that has no catalog.
 */
export function resolveLocaleChain(
  requested: readonly string[],
  available: readonly string[],
  source = 'en',
): string[] {
  const byLower = new Map(available.map((id) => [id.toLowerCase(), id]))
  const chain: string[] = []
  const add = (id: string | undefined) => {
    if (id !== undefined && !chain.includes(id)) chain.push(id)
  }
  for (const tag of requested) {
    const parts = tag.trim().replace(/_/g, '-').split('-')
    for (let n = parts.length; n >= 1; n--) add(byLower.get(parts.slice(0, n).join('-').toLowerCase()))
  }
  add(source)
  return chain
}

export type Catalog = Readonly<Record<string, string>>

export interface TranslatorOptions {
  /** Messages by language id: `{ en: { 'send.sent': '...' }, de: { ... } }`. */
  catalogs: Readonly<Record<string, Catalog>>
  /** The languages the person asked for, best first (the browser's own language). */
  requested: () => readonly string[]
  /** The language the text was written in; the last fallback. Defaults to `en`. */
  source?: string
  /** Force the pseudo-locale (development builds only). */
  pseudo?: boolean
}

export interface Translator {
  /**
   * The message for `key` in the person's language, with `args` filled in. A message a
   * language lacks, or carries broken, is shown in the source language instead; never a
   * key. Throws if even the source has no such key or a placeholder has no value.
   */
  t(key: string, args?: MessageArgs): string
  /** The catalog language in use (`en`, `de`). Dates and numbers are formatted for it. */
  locale(): string
  isPseudo(): boolean
  /** Tests: choose a language by hand (`de`, `en-XA`), or nothing to ask `requested()` again. */
  setLocale(tag?: string): void
  /** Language ids that have a catalog, the source first. */
  available(): string[]
}

/** The one place that decides which catalog a message comes from. See the extension README. */
export function createTranslator(options: TranslatorOptions): Translator {
  const source = options.source ?? 'en'
  const available = (): string[] =>
    Object.keys(options.catalogs).sort((a, b) =>
      a === source ? -1 : b === source ? 1 : a.localeCompare(b),
    )
  let active: { chain: string[]; pseudo: boolean } | undefined

  // The pseudo-locale is never picked from what the browser asks for (Chrome itself has an
  // en-XA debugging language); only a development build or a test turns it on.
  const choose = (tags: readonly string[], pseudo: boolean) => ({
    chain: pseudo ? [source] : resolveLocaleChain(tags, available(), source),
    pseudo,
  })
  const current = () => {
    active ??= choose(options.requested(), options.pseudo === true)
    return active
  }

  return {
    t(key, args) {
      const { chain, pseudo } = current()
      for (const locale of chain) {
        const message = options.catalogs[locale]?.[key]
        if (message === undefined) continue
        try {
          return formatMessage(message, args, locale, { pseudo })
        } catch (err) {
          // A translator's slip (a lost placeholder, a stray brace) must not break the page:
          // say it in the source language instead. The source itself failing is a bug.
          if (locale === source) throw err
        }
      }
      throw new Error(`No message "${key}" in the ${source} catalog`)
    },
    locale: () => current().chain[0] ?? source,
    isPseudo: () => current().pseudo,
    setLocale(tag) {
      active =
        tag === undefined
          ? undefined
          : choose([tag], options.pseudo === true || tag === PSEUDO_LOCALE)
    },
    available,
  }
}

/**
 * A few sentences hold a link or a key name in the middle: "Sign up at <link>tabsend.org</link>,
 * then paste your setup link here." The translator moves the words and the tags together and
 * the page keeps the real element (its address, its look). One sentence, one message.
 *
 * A tag is a lowercase word in angle brackets with a matching closing tag; anything else with
 * angle brackets (`<LAN-IP>`) is plain text. The tags do not nest.
 */
export type RichPart = string | { tag: string; text: string }

const RICH_TAG = /<([a-z][a-z0-9]*)>([\s\S]*?)<\/\1>/g

export function splitRich(text: string): RichPart[] {
  const parts: RichPart[] = []
  let last = 0
  for (const match of text.matchAll(RICH_TAG)) {
    if (match.index > last) parts.push(text.slice(last, match.index))
    parts.push({ tag: match[1] ?? '', text: match[2] ?? '' })
    last = match.index + match[0].length
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts
}
