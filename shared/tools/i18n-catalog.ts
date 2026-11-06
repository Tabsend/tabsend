import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { formatMessage, PSEUDO_LOCALE } from '../src/i18n'
import { fillHtml } from './i18n-html'

/**
 * Build-time pieces of a message catalog that every TypeScript surface shares (docs/L10N.md):
 * the browser extension and the web console read the same file format and run the same
 * checks. Each surface keeps its catalogs in `<surface>/src/locales/<language>/<area>.json`
 * and says where in its own thin wrapper (extension/tools/i18n-vite.ts,
 * console/tools/i18n-vite.ts).
 *
 *  - A catalog file is `{ key: { message, description } }`, so a translator sees the context;
 *    the program only needs the message. `catalogMessages` keeps the descriptions out of the
 *    bundle.
 *  - `localizedHtml` fills a page's static text from the catalog at build time. The HTML
 *    source only says which message goes where (`data-i18n`), so the page is complete the
 *    moment it opens, with no flash of empty text.
 *
 * Nothing here imports Vite (this package does not depend on it); the two plugins are plain
 * objects with the hooks Vite calls, and Vite accepts them as they are.
 */

export interface CatalogEntry {
  message: string
  description?: string
}
export type CatalogFile = Record<string, CatalogEntry>

/** The few Vite plugin hooks these helpers use. */
export interface BuildPlugin {
  name: string
  enforce?: 'pre' | 'post'
  transform?(code: string, id: string): { code: string; map: null; moduleType: 'js' } | null
  transformIndexHtml?: { order: 'pre' | 'post'; handler(html: string): string }
}

/** Every language folder under a locales folder, English first. */
export function languageFolders(localesDir: string): string[] {
  return readdirSync(localesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort((a, b) => (a === 'en' ? -1 : b === 'en' ? 1 : a.localeCompare(b)))
}

/**
 * The one key a catalog file may carry that is not a message: the "generated, do not edit"
 * notice i18n-kit writes at the top of every translated file it exports (it uses it to tell
 * its own output from a hand-written file). It is a note about the file, not a string, so
 * the readers skip it. Any other stray key is still a mistake and is still reported.
 */
export const GENERATED_NOTICE_KEY = '_generated'

/** The raw catalog files of one language, by area name. */
export function readLanguage(localesDir: string, language: string): Record<string, CatalogFile> {
  const dir = resolve(localesDir, language)
  const files: Record<string, CatalogFile> = {}
  for (const name of readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()) {
    const file = JSON.parse(readFileSync(resolve(dir, name), 'utf8')) as Record<string, unknown>
    delete file[GENERATED_NOTICE_KEY]
    files[name.replace(/\.json$/, '')] = file as CatalogFile
  }
  return files
}

export function messagesOf(file: CatalogFile): Record<string, string> {
  return Object.fromEntries(
    Object.entries(file)
      .filter(([key]) => key !== GENERATED_NOTICE_KEY)
      .map(([key, entry]) => [key, entry.message]),
  )
}

/** All messages of one language in one object. */
export function languageMessages(localesDir: string, language: string): Record<string, string> {
  return Object.assign({}, ...Object.values(readLanguage(localesDir, language)).map(messagesOf))
}

const CATALOG_PATH = /[\\/]src[\\/]locales[\\/][^\\/]+[\\/][^\\/]+\.json$/

/** Turns a catalog file into a module of messages only (no translator notes in the bundle). */
export function catalogMessages(): BuildPlugin {
  return {
    name: 'tabsend-catalog-messages',
    enforce: 'pre',
    transform(code, id) {
      if (!CATALOG_PATH.test(id.split('?')[0] ?? '')) return null
      const file = JSON.parse(code) as CatalogFile
      // `moduleType: 'js'`: the file is a .json one, and without this the bundler would
      // still try to read the JavaScript below as JSON.
      return {
        code: `export default ${JSON.stringify(messagesOf(file))}`,
        map: null,
        moduleType: 'js',
      }
    },
  }
}

/**
 * Fills `data-i18n` text into the built HTML with the English catalog (or the pseudo-locale
 * when `locale` is `en-XA`). The page then sets its own language when it starts.
 */
export function localizedHtml(localesDir: string, locale: string): BuildPlugin {
  const pseudo = locale === PSEUDO_LOCALE
  const messages = languageMessages(localesDir, 'en')
  return {
    name: 'tabsend-localized-html',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        return fillHtml(html, (key) => {
          const message = messages[key]
          if (message === undefined) throw new Error(`HTML asks for the missing message "${key}"`)
          return formatMessage(message, {}, 'en', { pseudo })
        })
      },
    },
  }
}
