import { createTranslator, type MessageArgs, PSEUDO_LOCALE } from '@tabsend/shared'

/**
 * Where every sentence the console shows comes from (docs/L10N.md; README.md says how to
 * add a string and a language).
 *
 * One catalog per language, split into small files by area: `src/locales/<language>/
 * <area>.json`, each `{ "key": { "message": "...", "description": "..." } }`. The build
 * keeps only the messages (shared/tools/i18n-catalog.ts), and every language folder that
 * exists is bundled, so adding a language is adding a folder and no code. English is the
 * source and the last fallback: a language missing a key, or carrying a broken message,
 * shows the English one, never a key. The choosing and the fallbacks are `createTranslator`
 * in shared/src/i18n.ts, which the browser extension uses too.
 *
 * The language is the browser's (`navigator.languages`, best first). The console has no
 * account language: it knows no email address and no profile, only a pairing.
 */

/** The language the text was written in, and the one to fall back to. */
export const SOURCE_LOCALE = 'en'

declare const __TABSEND_LOCALE__: string

/**
 * A development build can force the pseudo-locale (`TABSEND_LOCALE=en-XA`). Release builds
 * leave it empty; Vite replaces this with a literal, so that branch is dead code there.
 */
const FORCED: string = typeof __TABSEND_LOCALE__ === 'undefined' ? '' : __TABSEND_LOCALE__

type Messages = Record<string, string>

const catalogs: Record<string, Messages> = {}
const files = import.meta.glob<Messages>('../locales/*/*.json', { eager: true, import: 'default' })
for (const [path, messages] of Object.entries(files)) {
  const language = path.split('/').at(-2)
  if (language === undefined) continue
  catalogs[language] = { ...catalogs[language], ...messages }
}

/** The languages the browser asks for, best first. */
function browserLanguages(): string[] {
  if (typeof navigator === 'undefined') return []
  const list = navigator.languages
  if (list && list.length > 0) return [...list]
  return navigator.language ? [navigator.language] : []
}

/** Set by `setLocale` in tests, so the regional variant follows the language chosen by hand. */
let chosenByHand: string | undefined

const translator = createTranslator({
  catalogs,
  source: SOURCE_LOCALE,
  pseudo: FORCED === PSEUDO_LOCALE,
  requested: browserLanguages,
})

/** The message for `key` in the person's language, with `args` filled in. */
export const t = translator.t

/** The catalog language in use (`en`, `de`). Dates and numbers are formatted for this one. */
export const getLocale = translator.locale

/** True when the pseudo-locale is on (a development build or a test). */
export const isPseudo = translator.isPseudo

/**
 * For tests: choose the language by hand (`'de'`, `'en-XA'`), or pass nothing to go back to
 * what the browser says. Not used by the console itself.
 */
export function setLocale(tag?: string): void {
  chosenByHand = tag
  translator.setLocale(tag)
}

/** Language ids that have a catalog, English first. */
export const availableLocales = translator.available

/** Every English message, for tests. */
export function sourceMessages(): Readonly<Messages> {
  return catalogs[SOURCE_LOCALE] ?? {}
}

/** Every message in one language, for tests. */
export function messagesFor(locale: string): Readonly<Messages> {
  return catalogs[locale] ?? {}
}

/**
 * The locale to hand to `Intl` for a date: the language of the text on screen, or, when the
 * browser asks for a regional form of that same language (`en-GB`, `de-AT`), that form, so
 * a person keeps the date order their own browser already shows. A different language in the
 * browser's list (French behind English) never wins over the language shown.
 */
export function dateLocale(): string {
  const shown = translator.locale()
  const wanted = chosenByHand !== undefined ? [chosenByHand] : browserLanguages()
  const lower = shown.toLowerCase()
  const regional = wanted.find((tag) => {
    const id = tag.toLowerCase().replace(/_/g, '-')
    return id === lower || id.startsWith(`${lower}-`)
  })
  return regional && !translator.isPseudo() ? regional : shown
}

/** The values a message takes; re-exported so callers need one import. */
export type { MessageArgs }
