import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fillHtml, visibleText } from './i18n-html'
import { languageMessages } from './i18n-vite'

/**
 * The pages' static text, word for word. `html-text.golden.json` was taken from the HTML
 * files as they were BEFORE their text moved into the catalog; this fills each page from the
 * English catalog the way the build does and compares what a person would read and hear.
 * It also fails if a source page still holds words of its own.
 *
 *   UPDATE_GOLDEN=1 pnpm --filter @tabsend/extension test html-text
 *
 * regenerates the snapshot, for when the copy is meant to change.
 */
const ROOT = resolve(import.meta.dirname, '..')
const GOLDEN = resolve(import.meta.dirname, 'html-text.golden.json')
const PAGES = ['chooser', 'firstrun', 'history', 'options'] as const
const english = languageMessages('en')
const lookup = (key: string): string => {
  const message = english[key]
  if (message === undefined) throw new Error(`HTML asks for the missing message "${key}"`)
  return message
}

const source = (page: string): string => readFileSync(resolve(ROOT, `${page}.html`), 'utf8')

describe('page text', () => {
  it('reads exactly as it did before it moved into the catalog', () => {
    const now = Object.fromEntries(PAGES.map((p) => [p, visibleText(fillHtml(source(p), lookup))]))
    if (process.env.UPDATE_GOLDEN === '1') {
      writeFileSync(GOLDEN, `${JSON.stringify(now, null, 2)}\n`)
      return
    }
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as Record<string, string>
    for (const page of PAGES) expect(now[page], `${page}.html`).toBe(golden[page])
  })

  it('has no words of its own in the HTML source: only data-i18n elements carry text', () => {
    for (const page of PAGES) {
      // Fill every message with nothing: what remains is text the catalog does not own.
      const emptied = fillHtml(source(page), () => '')
      const words =
        visibleText(emptied)
          .replace(/\[[a-z-]+=/g, '')
          .match(/\p{L}+/gu) ?? []
      expect(words, `${page}.html`).toEqual([])
    }
  })
})
