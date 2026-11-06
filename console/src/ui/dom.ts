/**
 * Tiny DOM helpers. Deliberately not a framework — the reactive store (lib/store.ts)
 * drives updates; these just build elements. User-controlled strings (labels, titles,
 * URLs from group members) are ALWAYS set via textContent / setAttribute, never
 * innerHTML, so a crafted label/title can't inject markup into the console.
 */

import { splitRich } from '@tabsend/shared'
import { type MessageArgs, t } from '../lib/i18n'

type Attrs = Record<string, string | number | boolean | ((ev: Event) => void) | undefined>
type Child = Node | string | number | null | undefined | false

/** Create an element. `on*` attrs become listeners; class/other attrs are set safely. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue
    if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value as EventListener)
    } else if (key === 'class') {
      node.className = String(value)
    } else if (value === true) {
      node.setAttribute(key, '')
    } else {
      node.setAttribute(key, String(value))
    }
  }
  for (const child of children) append(node, child)
  return node
}

function append(parent: Node, child: Child): void {
  if (child === null || child === undefined || child === false) return
  if (child instanceof Node) parent.appendChild(child)
  else parent.appendChild(document.createTextNode(String(child)))
}

/** Replace all children of `node` with `children`. */
export function replaceChildren(node: Element, ...children: Child[]): void {
  node.textContent = ''
  for (const child of children) append(node, child)
}

/** Inline an SVG string safely into a container (trusted, self-authored markup only). */
export function svg(markup: string): DocumentFragment {
  const tpl = document.createElement('template')
  tpl.innerHTML = markup
  return tpl.content
}

/**
 * Nodes for a sentence that holds an element: `<link>tabsend.org</link>` in the message
 * becomes whatever `tags.link('tabsend.org')` returns, in the order the language puts it.
 * One sentence, one message; the translator moves the words and the tags together.
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
