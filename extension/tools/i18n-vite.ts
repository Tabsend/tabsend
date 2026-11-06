import { resolve } from 'node:path'
import type { Plugin } from 'vite'
import { formatMessage, PSEUDO_LOCALE } from '../../shared/src/i18n'
import * as catalog from '../../shared/tools/i18n-catalog'

/**
 * Build-time pieces of the extension's message catalogs. See src/lib/i18n.ts for the
 * runtime half and the README for the whole picture. Most of it is shared with the web
 * console and lives in shared/tools/i18n-catalog.ts; this file binds it to the extension's
 * folder and adds what only the browser extension needs.
 *
 *  - `catalogMessages`: keeps the translators' descriptions out of the bundle (and out of
 *    the service worker's start-up).
 *  - `localizedHtml`: the pages' static text lives in the catalog too. The HTML source
 *    only says which message goes where (`data-i18n`), and this fills in the build's
 *    language, so the page is complete the moment it opens, with no flash of empty text.
 *    The page then re-applies its own language when it starts (i18n-dom.ts).
 *  - `nativeLocales`: the browser reads a few strings itself (the extension's name and
 *    description, the shortcut names) from `_locales/<language>/messages.json`. Those
 *    come from the same catalogs (`manifest.json` in each language folder), so a
 *    translator works in one place.
 */

export type { CatalogEntry, CatalogFile } from '../../shared/tools/i18n-catalog'
export { catalogMessages } from '../../shared/tools/i18n-catalog'

const SRC = resolve(import.meta.dirname, '..', 'src')
export const LOCALES_DIR = resolve(SRC, 'locales')

/** Every language folder under src/locales, English first. */
export const languageFolders = (): string[] => catalog.languageFolders(LOCALES_DIR)

/** The raw catalog files of one language, by area name. */
export const readLanguage = (language: string): Record<string, catalog.CatalogFile> =>
  catalog.readLanguage(LOCALES_DIR, language)

/** All messages of one language in one object. */
export const languageMessages = (language: string): Record<string, string> =>
  catalog.languageMessages(LOCALES_DIR, language)

/** `manifest.name` becomes `manifest_name`: the browser allows only letters, digits and `_`. */
export function nativeKey(key: string): string {
  return key.replace(/[^A-Za-z0-9_@]/g, '_')
}

export function localizedHtml(locale: string): Plugin {
  return catalog.localizedHtml(LOCALES_DIR, locale)
}

/** Emit `_locales/<language>/messages.json` from each language's `manifest.json` catalog. */
export function nativeLocales(locale: string): Plugin {
  const pseudo = locale === PSEUDO_LOCALE
  return {
    name: 'tabsend-native-locales',
    generateBundle() {
      for (const language of languageFolders()) {
        const file = readLanguage(language).manifest
        if (!file) continue
        const out: Record<string, { message: string; description?: string }> = {}
        for (const [key, entry] of Object.entries(file)) {
          out[nativeKey(key)] = {
            message: pseudo
              ? formatMessage(entry.message, {}, 'en', { pseudo: true })
              : entry.message,
            ...(entry.description === undefined ? {} : { description: entry.description }),
          }
        }
        this.emitFile({
          type: 'asset',
          fileName: `_locales/${language}/messages.json`,
          source: `${JSON.stringify(out, null, 2)}\n`,
        })
      }
    },
  }
}
