import type { MessageArgs } from '@tabsend/shared'
import { getLocale, t } from './i18n'
import { splitRich } from './i18n-rich'

/**
 * Puts the visitor's language into a page's static text. The HTML file only says which
 * message goes where (tools/i18n-html.ts fills the build's language in at build time, so the
 * page opens complete); this runs when the page starts and does it again in the browser's own
 * language. Call it once, first, from every page.
 *
 *   data-i18n="key"                      the element's text
 *   data-i18n-attrs="title:key;aria-label:key"   attributes
 *   data-i18n-rich="key"                 a sentence with <tag>…</tag> parts that stay real
 *                                        elements (children marked data-i18n-tag="tag")
 */
export function localizePage(doc: Document = document): void {
  doc.documentElement?.setAttribute('lang', getLocale())

  for (const el of Array.from(doc.querySelectorAll('[data-i18n]'))) {
    // i18n-ignore: the attribute name, not text
    el.textContent = t(el.getAttribute('data-i18n') ?? '')
  }

  for (const el of Array.from(doc.querySelectorAll('[data-i18n-rich]'))) {
    const children = new Map<string, Element>()
    for (const child of Array.from(el.querySelectorAll('[data-i18n-tag]'))) {
      children.set(child.getAttribute('data-i18n-tag') ?? '', child)
    }
    const nodes = splitRich(t(el.getAttribute('data-i18n-rich') ?? '')).map((part) => {
      if (typeof part === 'string') return doc.createTextNode(part)
      const child = children.get(part.tag)
      // i18n-ignore: developer error
      if (!child) throw new Error(`No data-i18n-tag="${part.tag}" in the page`)
      child.textContent = part.text
      return child
    })
    el.replaceChildren(...nodes)
  }

  for (const el of Array.from(doc.querySelectorAll('[data-i18n-attrs]'))) {
    for (const pair of (el.getAttribute('data-i18n-attrs') ?? '').split(';')) {
      const [name, key] = pair.split(':').map((s) => s.trim())
      if (name && key) el.setAttribute(name, t(key))
    }
  }
}

/**
 * Nodes for a sentence that holds elements: `<link>tabsend.org</link>` in the message becomes
 * whatever `tags.link('tabsend.org')` returns. For text built in code; for text in an HTML
 * file use `data-i18n-rich`.
 */
export function richNodes(
  key: string,
  args: MessageArgs,
  tags: Record<string, (text: string) => Node>,
): Node[] {
  return splitRich(t(key, args)).map((part) => {
    if (typeof part === 'string') return document.createTextNode(part)
    const make = tags[part.tag]
    if (!make) throw new Error(`No element for <${part.tag}> in "${key}"`) // i18n-ignore: developer error
    return make(part.text)
  })
}
