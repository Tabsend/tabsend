import { resolve } from 'node:path'
import * as catalog from '../../shared/tools/i18n-catalog'

/**
 * Build-time pieces of the console's message catalogs. The reading, the plugins and the
 * checks are shared with the browser extension (shared/tools/); this file only says where
 * the console keeps its catalogs: `src/locales/<language>/<area>.json`. See README.md,
 * "Text and languages".
 */

export type { CatalogEntry, CatalogFile } from '../../shared/tools/i18n-catalog'
export { catalogMessages } from '../../shared/tools/i18n-catalog'

export const LOCALES_DIR = resolve(import.meta.dirname, '..', 'src', 'locales')

/** Every language folder under src/locales, English first. */
export const languageFolders = (): string[] => catalog.languageFolders(LOCALES_DIR)

/** The raw catalog files of one language, by area name. */
export const readLanguage = (language: string): Record<string, catalog.CatalogFile> =>
  catalog.readLanguage(LOCALES_DIR, language)

/** All messages of one language in one object. */
export const languageMessages = (language: string): Record<string, string> =>
  catalog.languageMessages(LOCALES_DIR, language)

/** Fills the page's `data-i18n` text from the catalog at build time (index.html). */
export const localizedHtml = (locale: string): catalog.BuildPlugin =>
  catalog.localizedHtml(LOCALES_DIR, locale)
