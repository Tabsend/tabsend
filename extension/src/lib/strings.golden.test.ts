import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { collectStrings } from './strings.fixtures'

/**
 * English, word for word. Every sentence the extension says, for every count and name
 * that changes its shape, taken from the code as it was BEFORE the text moved into
 * message catalogs. If this fails, the English a person reads has changed.
 *
 * Change the file on purpose only when the copy itself is meant to change:
 *
 *   UPDATE_GOLDEN=1 pnpm --filter @tabsend/extension test strings.golden
 *
 * The times fall on a fixed time zone (UTC), so the dates do not depend on the machine
 * that runs the test.
 */
const GOLDEN = new URL('./strings.golden.json', import.meta.url)

describe('English copy is unchanged (golden)', () => {
  it('says exactly what it said before the text moved into catalogs', () => {
    const previousTz = process.env.TZ
    process.env.TZ = 'UTC'
    try {
      const now = collectStrings()
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
    } finally {
      if (previousTz === undefined) delete process.env.TZ
      else process.env.TZ = previousTz
    }
  })
})
