/**
 * A small stand-in for the browser's DOM, enough to mount the console in the node test
 * environment, press its buttons and read back what a person would see. Test-only:
 * imported by `*.test.ts` and `*.fixtures.ts`, never by the app.
 *
 * What it keeps: elements with their attributes, text, children and click handlers.
 * What it leaves out: layout, styles, events other than a plain click or keydown.
 */

type Listener = (event: { type: string; key?: string; target: FakeElement }) => void

export class FakeNode {
  parent: FakeElement | FakeFragment | null = null
}

export class FakeText extends FakeNode {
  constructor(public data: string) {
    super()
  }
}

/** Markup set through innerHTML (the console's SVG icons). Kept as text, never parsed. */
export class FakeRaw extends FakeNode {
  constructor(public markup: string) {
    super()
  }
}

export class FakeFragment extends FakeNode {
  readonly children: FakeNode[] = []
}

export class FakeElement extends FakeNode {
  readonly children: FakeNode[] = []
  readonly attrs = new Map<string, string>()
  private readonly listeners = new Map<string, Listener[]>()
  private typed: string | undefined
  disabled = false

  constructor(readonly tagName: string) {
    super()
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value)
    if (name === 'disabled') this.disabled = true
  }
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null
  }
  get className(): string {
    return this.attrs.get('class') ?? ''
  }
  set className(value: string) {
    this.attrs.set('class', value)
  }
  /** Like a real input: what was typed, else the `value` attribute. */
  get value(): string {
    return this.typed ?? this.attrs.get('value') ?? ''
  }
  set value(v: string) {
    this.typed = v
  }

  appendChild<T extends FakeNode>(child: T): T {
    if (child instanceof FakeFragment) {
      for (const c of [...child.children]) this.appendChild(c)
      child.children.length = 0
      return child
    }
    child.parent = this
    this.children.push(child)
    return child
  }

  /** `Element.append`: nodes or plain text. */
  append(...items: (FakeNode | string)[]): void {
    for (const item of items) this.appendChild(typeof item === 'string' ? new FakeText(item) : item)
  }

  get textContent(): string {
    return this.children
      .map((c) => (c instanceof FakeText ? c.data : c instanceof FakeElement ? c.textContent : ''))
      .join('')
  }
  set textContent(text: string) {
    this.children.length = 0
    if (text !== '') this.appendChild(new FakeText(text))
  }

  set innerHTML(markup: string) {
    this.children.length = 0
    this.appendChild(new FakeRaw(markup))
  }
  /** `<template>.content`: what innerHTML put in, as a fragment. */
  get content(): FakeFragment {
    const fragment = new FakeFragment()
    for (const c of this.children) fragment.children.push(c)
    return fragment
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }
  dispatch(type: string, extra: { key?: string } = {}): void {
    for (const l of this.listeners.get(type) ?? []) l({ type, target: this, ...extra })
  }
  click(): void {
    if (!this.disabled) this.dispatch('click')
  }
}

export function installFakeDom(location: { hostname: string; origin: string }): () => void {
  const g = globalThis as unknown as Record<string, unknown>
  const saved: Record<string, PropertyDescriptor | undefined> = {}
  const set = (name: string, value: unknown) => {
    saved[name] = Object.getOwnPropertyDescriptor(globalThis, name)
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
  }
  set('Node', FakeNode)
  set('document', {
    createElement: (tag: string) => new FakeElement(tag),
    createTextNode: (text: string) => new FakeText(text),
  })
  set('window', { location })
  // The same browser on every machine, so the suggested name and the language do not
  // depend on where the test runs.
  set('navigator', {
    platform: 'MacIntel',
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    language: 'en-US',
    languages: ['en-US'],
    clipboard: { writeText: async () => undefined },
  })
  return () => {
    for (const [name, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else delete g[name]
    }
  }
}

/** Every element under `root` that matches, in document order. */
export function findAll(root: FakeNode, test: (el: FakeElement) => boolean): FakeElement[] {
  const found: FakeElement[] = []
  const walk = (node: FakeNode) => {
    if (!(node instanceof FakeElement)) return
    if (test(node)) found.push(node)
    for (const c of node.children) walk(c)
  }
  walk(root)
  return found
}

export function findButton(root: FakeNode, label: string): FakeElement {
  const hit = findAll(root, (e) => e.tagName === 'button' && e.textContent === label)[0]
  if (!hit) throw new Error(`No button "${label}"`)
  return hit
}

// What a person can read or hear. `class` and the rest are not words.
const VISIBLE_ATTRS = [
  'title',
  'aria-label',
  'aria-description',
  'placeholder',
  'alt',
  'value',
  'href',
  'role',
]

/**
 * The page as an outline: one line per element or run of text, children indented, only
 * the attributes that carry words. An element hidden from screen readers and holding
 * no text (an icon) is left out.
 */
export function outline(root: FakeNode): string {
  const lines: string[] = []
  const walk = (node: FakeNode, depth: number) => {
    const pad = '  '.repeat(depth)
    if (node instanceof FakeText) {
      lines.push(`${pad}"${node.data}"`)
    } else if (node instanceof FakeRaw) {
      const label = /aria-label="([^"]*)"/.exec(node.markup)?.[1]
      if (label !== undefined) lines.push(`${pad}<svg aria-label="${label}">`)
    } else if (node instanceof FakeElement) {
      // A text box shows what was typed or set in it, not only its starting `value`.
      const shown = (a: string) => (a === 'value' ? node.value : node.attrs.get(a))
      const attrs = VISIBLE_ATTRS.filter((a) => node.attrs.has(a))
        .map((a) => ` ${a}="${shown(a)}"`)
        .join('')
      lines.push(`${pad}<${node.tagName}${attrs}>`)
      for (const c of node.children) walk(c, depth + 1)
    }
  }
  walk(root, 0)
  return lines.join('\n')
}
