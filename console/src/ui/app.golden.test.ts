import { readFileSync, writeFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { setLocale } from '../lib/i18n'
import { collectScenes, NOW } from './scenes.fixtures'

/**
 * English, word for word, on every screen. Each scene (a tab, a dialog, a warning, an
 * empty state) is mounted into a stand-in page and read back as an outline of the words,
 * titles, labels and addresses a person sees. The file was taken from the code BEFORE the
 * text moved into message catalogs. If this fails, what a person reads has changed.
 *
 * Change the file on purpose only when the copy itself is meant to change:
 *
 *   UPDATE_GOLDEN=1 pnpm --filter @tabsend/console test app.golden
 *
 * The clock is pinned and the time zone is UTC. The logic's own sentences are pinned in
 * lib/strings.golden.test.ts.
 */
const GOLDEN = new URL('./app.golden.json', import.meta.url)

describe('English screens are unchanged (golden)', () => {
  const previousTz = process.env.TZ
  beforeAll(() => {
    process.env.TZ = 'UTC'
    setLocale('en')
    vi.useFakeTimers({ toFake: ['Date'], now: NOW })
  })
  afterAll(() => {
    setLocale()
    vi.useRealTimers()
    if (previousTz === undefined) delete process.env.TZ
    else process.env.TZ = previousTz
  })

  it('shows exactly what it showed before the text moved into catalogs', async () => {
    const now = await collectScenes()
    if (process.env.UPDATE_GOLDEN === '1') {
      writeFileSync(GOLDEN, `${JSON.stringify(now, null, 2)}\n`)
      return
    }
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as Record<string, string>
    expect(Object.keys(now)).toEqual(Object.keys(golden))
    for (const [name, text] of Object.entries(golden)) {
      expect(now[name], `scene ${name}`).toBe(text)
    }
  }, 30_000)
})
