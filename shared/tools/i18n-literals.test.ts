import { describe, expect, it } from 'vitest'
import { literalProblems } from './i18n-literals'

const find = (code: string) => literalProblems('x.ts', code)

describe('literalProblems', () => {
  it('flags words typed into text sinks', () => {
    expect(find("el.textContent = 'Saved ✓'")).toHaveLength(1)
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the text is code the scanner reads, not a template
    expect(find('el.textContent = `Sent to ${label}`')).toHaveLength(1)
    expect(find("btn.setAttribute('aria-label', 'Close')")).toHaveLength(1)
    expect(find("create({ id: 'x', title: 'Open Tabsend chooser…' })")).toHaveLength(1)
    expect(find("throw new Error('A device needs a name.')")).toHaveLength(1)
    expect(find("el.textContent = ok ? 'Answering' : ''")).toHaveLength(1)
    expect(find("el.textContent =\n  ok\n    ? 'Answering'\n    : ''")).toHaveLength(1)
  })
  it('leaves symbols, empty text, catalog calls and plain data alone', () => {
    expect(find("btn.textContent = '×'")).toEqual([])
    expect(find("el.textContent = ''")).toEqual([])
    expect(find("el.textContent = t('options.saved')")).toEqual([])
    expect(find('el.title = item.url')).toEqual([])
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the text is code the scanner reads, not a template
    expect(find('el.textContent = `${count}`')).toEqual([])
    expect(find("const id = 'send-to-primary'")).toEqual([])
    expect(find("// el.textContent = 'a comment'")).toEqual([])
    expect(find(" * el.textContent = 'a doc comment'")).toEqual([])
  })
  it('accepts a line that says why it is right as it is', () => {
    expect(find("el.textContent = 'css' // i18n-ignore: stylesheet")).toEqual([])
    expect(find("// i18n-ignore: stylesheet\nel.textContent = 'css'")).toEqual([])
  })
})

describe("literalProblems with a surface's own sinks", () => {
  const DOM_TEXT = [
    /\bel\(\s*['"][a-z0-9]+['"]\s*,\s*\{[^{}]*\}\s*,\s*(?=['"`])/,
    /^\s*(?=['"`][A-Z][a-z]|`[a-z])/,
  ]
  const find = (code: string) => literalProblems('x.ts', code, { sinks: DOM_TEXT })
  it('flags words handed to a page builder, on one line or on a line of their own', () => {
    expect(find("el('p', { class: 'muted' }, 'Nothing here yet.')")).toHaveLength(1)
    expect(find("el('p', {},\n  'Nothing here yet.',\n)")).toHaveLength(1)
  })
  it('leaves attributes, symbols and catalog calls alone', () => {
    expect(find("el('p', { class: 'muted note' }, t('devices.empty'))")).toEqual([])
    expect(find("el('span', { class: 'sep' }, '·')")).toEqual([])
    expect(find("el(\n  'button',\n  { class: 'btn' },\n  t('common.save'),\n)")).toEqual([])
    expect(find("req<Out>(\n  'POST',\n  opts,\n)")).toEqual([])
    expect(find("el('span', { class: 'dot' })")).toEqual([])
  })
})
