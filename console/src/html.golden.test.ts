import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { formatMessage } from '../../shared/src/i18n'
import { fillHtml, visibleText } from '../../shared/tools/i18n-html'
import { languageMessages } from '../tools/i18n-vite'

/**
 * English, word for word, on the page the browser receives before any script runs: the
 * title, the description search engines show, and the text for a browser with scripts off.
 * The file was taken from index.html BEFORE its text moved into the catalog. The test builds
 * the page the way the build does (filling `data-i18n` from the English catalog) and reads
 * back what a person or a search engine would read.
 *
 * Change the golden on purpose only when the copy itself is meant to change:
 *
 *   UPDATE_GOLDEN=1 pnpm --filter @tabsend/console test html.golden
 */
const CONSOLE = resolve(import.meta.dirname, '..')
const GOLDEN = new URL('./html.golden.txt', import.meta.url)

function builtPage(): string {
  const messages = languageMessages('en')
  return fillHtml(readFileSync(resolve(CONSOLE, 'index.html'), 'utf8'), (key) => {
    const message = messages[key]
    if (message === undefined) throw new Error(`index.html asks for the missing message "${key}"`)
    return formatMessage(message, {}, 'en')
  })
}

describe('index.html', () => {
  it('says exactly what it said before its text moved into the catalog (golden)', () => {
    const now = visibleText(builtPage())
    if (process.env.UPDATE_GOLDEN === '1') {
      writeFileSync(GOLDEN, `${now}\n`)
      return
    }
    expect(now).toBe(readFileSync(GOLDEN, 'utf8').trimEnd())
  })

  it('holds no words of its own: every sentence comes from the catalog', () => {
    // A source page whose catalog lookups all return nothing shows no words at all (an empty
    // `[content=]` is the description tag with nothing in it).
    const source = fillHtml(readFileSync(resolve(CONSOLE, 'index.html'), 'utf8'), () => '')
    expect(
      visibleText(source)
        .replace(/\[[a-z-]+=\]/g, '')
        .trim(),
    ).toBe('')
  })
})
