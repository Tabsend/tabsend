import { readFileSync, writeFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { setLocale } from './i18n'
import { collectStrings, NOW } from './strings.fixtures'

/**
 * English, word for word. Every sentence the console's logic says (view.ts, time.ts, the
 * controller's status lines, pairing.ts, receive.ts), for the counts and names that change
 * its shape, taken from the code as it was BEFORE the text moved into message catalogs. If
 * this fails, the English a person reads has changed.
 *
 * Change the file on purpose only when the copy itself is meant to change:
 *
 *   UPDATE_GOLDEN=1 pnpm --filter @tabsend/console test strings.golden
 *
 * The clock is pinned and the time zone is UTC, so dates do not depend on the machine.
 * The screens are pinned the same way in ui/app.golden.test.ts.
 */
const GOLDEN = new URL('./strings.golden.json', import.meta.url)

describe('English copy is unchanged (golden)', () => {
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

  it('says exactly what it said before the text moved into catalogs', async () => {
    const now = await collectStrings()
    if (process.env.UPDATE_GOLDEN === '1') {
      writeFileSync(GOLDEN, `${JSON.stringify(now, null, 2)}\n`)
      return
    }
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as Record<string, string>
    expect(Object.keys(now)).toEqual(Object.keys(golden))
    const changed = Object.entries(golden)
      .filter(([key, value]) => now[key] !== value)
      .map(([key, value]) => `${key}\n    was: ${value}\n    now: ${now[key]}`)
    expect(changed, 'English text that is no longer word for word the same').toEqual([])
  }, 30_000)
})
