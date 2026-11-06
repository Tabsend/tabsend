import { describe, expect, it } from 'vitest'
import { relayTextProblems } from './i18n-relay-text'

const find = (code: string) => relayTextProblems('x.ts', code)

describe('relayTextProblems', () => {
  it("flags an error's own text on its way to a screen", () => {
    expect(find('el.textContent = err.message')).toHaveLength(1)
    expect(find('showError(err instanceof Error ? err.message : String(err))')).toHaveLength(1)
    expect(find('statusBar.textContent = error.message')).toHaveLength(1)
    expect(find('return { ok: false, error: String(error) }')).toHaveLength(1)
    expect(find('throw new Error(err.message)')).toHaveLength(1)
  })
  it('leaves other things named message or error alone', () => {
    expect(find('statusBar.textContent = s.message')).toEqual([])
    expect(find('const text = parsed.error.message')).toEqual([])
    expect(find('const body = res.error')).toEqual([])
    expect(find('event.message')).toEqual([])
    expect(find('super(message)')).toEqual([])
    expect(find("// err.message is the relay's text")).toEqual([])
    expect(find(' * String(err) is never shown')).toEqual([])
  })
  it('accepts a line that says why it is right as it is', () => {
    expect(find('return err.message // relay-text-ignore: our own catalog sentence')).toEqual([])
    expect(find('// relay-text-ignore: our own catalog sentence\nreturn err.message')).toEqual([])
  })
})
