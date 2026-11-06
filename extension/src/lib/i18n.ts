import { createTranslator, PSEUDO_LOCALE } from '@tabsend/shared'
import { ext } from './ext'

/**
 * Where every sentence the extension shows comes from (docs/L10N.md; the extension
 * README says how to add a string and a language).
 *
 * One catalog per language, split into small files by area: `src/locales/<language>/
 * <area>.json`, each `{ "key": { "message": "...", "description": "..." } }`. The build
 * keeps only the messages (tools/i18n-vite.ts), and every language folder that exists is
 * bundled, so adding a language is adding a folder and no code. English is the source and
 * the last fallback: a language missing a key, or carrying a broken message, shows the
 * English one, never a key. The choosing and the fallbacks are `createTranslator` in
 * shared/src/i18n.ts, which the web console will use too.
 *
 * Works the same in the service worker (no DOM), the pages and tests, because it is plain
 * code and plain data. The page and the toast injected into a web page get their text from
 * here too: pages through `localizePage` (i18n-dom.ts), the toast through arguments the
 * service worker passes in, since an injected function carries nothing with it.
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

const translator = createTranslator({
  catalogs,
  source: SOURCE_LOCALE,
  pseudo: FORCED === PSEUDO_LOCALE,
  // What the person asked for: the browser's own language, which the toolbar uses too.
  requested: () => {
    const ui = ext?.i18n?.getUILanguage?.()
    if (ui) return [ui]
    return typeof navigator === 'undefined' ? [] : [navigator.language]
  },
})

/** The message for `key` in the person's language, with `args` filled in. */
export const t = translator.t

/** The catalog language in use (`en`, `de`). Dates and numbers are formatted for this one. */
export const getLocale = translator.locale

/** True when the pseudo-locale is on (a development build or a test). */
export const isPseudo = translator.isPseudo

/**
 * For tests: choose the language by hand (`'de'`, `'en-XA'`), or pass nothing to go back to
 * what the browser says. Not used by the extension itself.
 */
export const setLocale = translator.setLocale

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
