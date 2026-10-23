import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * A small stand-in for the DOM, enough to import an extension page in the node
 * test environment and press its buttons. Test-only: imported by `*.test.ts`
 * files, never by a page.
 *
 * `getElementById` answers only for ids the page's real HTML file declares, so a
 * page and its markup that drift apart fail here rather than in a browser.
 */

type Listener = (event: FakeEvent) => void

interface FakeEvent {
  type: string
  key?: string
  target: FakeElement
}

class FakeClassList {
  private readonly names = new Set<string>()
  add(...names: string[]): void {
    for (const n of names) this.names.add(n)
  }
  remove(...names: string[]): void {
    for (const n of names) this.names.delete(n)
  }
  toggle(name: string, force?: boolean): boolean {
    const on = force ?? !this.names.has(name)
    if (on) this.names.add(name)
    else this.names.delete(name)
    return on
  }
  contains(name: string): boolean {
    return this.names.has(name)
  }
  setFrom(value: string): void {
    this.names.clear()
    for (const n of value.split(/\s+/).filter(Boolean)) this.names.add(n)
  }
  toString(): string {
    return [...this.names].join(' ')
  }
}

export class FakeElement {
  id = ''
  type = ''
  value = ''
  checked = false
  disabled = false
  readonly style: Record<string, string> = {}
  readonly dataset: Record<string, string> = {}
  readonly classList = new FakeClassList()
  readonly children: FakeElement[] = []
  parent: FakeElement | null = null
  private ownText = ''
  private readonly attributes = new Map<string, string>()
  private readonly listeners = new Map<string, Listener[]>()
  onchange: Listener | null = null

  constructor(readonly tagName: string) {}

  get className(): string {
    return this.classList.toString()
  }
  set className(value: string) {
    this.classList.setFrom(value)
  }

  get textContent(): string {
    return this.ownText + this.children.map((c) => c.textContent).join('')
  }
  set textContent(value: string) {
    this.detachChildren()
    this.ownText = value
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null
  }

  append(...nodes: Array<FakeElement | string>): void {
    for (const node of nodes) {
      const el = typeof node === 'string' ? textNode(node) : node
      el.parent?.removeChild(el)
      el.parent = this
      this.children.push(el)
    }
  }
  replaceChildren(...nodes: Array<FakeElement | string>): void {
    this.detachChildren()
    this.ownText = ''
    this.append(...nodes)
  }
  remove(): void {
    this.parent?.removeChild(this)
  }
  private removeChild(el: FakeElement): void {
    const i = this.children.indexOf(el)
    if (i >= 0) this.children.splice(i, 1)
    el.parent = null
  }
  private detachChildren(): void {
    for (const c of this.children) c.parent = null
    this.children.length = 0
  }

  addEventListener(type: string, fn: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn])
  }
  removeEventListener(type: string, fn: Listener): void {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((l) => l !== fn),
    )
  }
  dispatch(type: string, extra: Partial<FakeEvent> = {}): void {
    const event: FakeEvent = { type, target: this, ...extra }
    for (const fn of this.listeners.get(type) ?? []) fn(event)
    if (type === 'change') this.onchange?.(event)
  }
  click(): void {
    if (!this.disabled) this.dispatch('click')
  }

  /** Every descendant, depth first. */
  descendants(): FakeElement[] {
    return this.children.flatMap((c) => [c, ...c.descendants()])
  }
  /** `.name` or a bare tag name; anything else matches nothing. */
  querySelectorAll(selector: string): FakeElement[] {
    if (selector.startsWith('.')) {
      const name = selector.slice(1)
      return this.descendants().filter((e) => e.classList.contains(name))
    }
    if (/^[a-z]+$/.test(selector)) return this.descendants().filter((e) => e.tagName === selector)
    return []
  }

  focus(): void {}
  select(): void {}
  showModal(): void {}
  close(): void {}
}

function textNode(text: string): FakeElement {
  const el = new FakeElement('#text')
  el.textContent = text
  return el
}

/** Every `id="..."` the page's HTML file declares, with its tag. */
function idsIn(htmlFile: string): Map<string, string> {
  const path = fileURLToPath(new URL(`../../${htmlFile}`, import.meta.url))
  const html = readFileSync(path, 'utf8')
  const ids = new Map<string, string>()
  for (const m of html.matchAll(/<([a-z0-9]+)\b[^>]*\bid="([^"]+)"/g)) {
    ids.set(m[2] as string, m[1] as string)
  }
  return ids
}

export interface FakePage {
  byId: (id: string) => FakeElement
  /** The buttons under `id` whose text or accessible name is `name`. */
  buttons: (id: string, name: string) => FakeElement[]
  /** What `window.confirm` was asked, in order. */
  asked: string[]
  /** The answer `window.confirm` gives next. */
  confirmAnswer: { value: boolean }
  location: { hash: string; pathname: string }
}

/**
 * Install a fresh fake `document`, `window`, `location` and `history` built from
 * `htmlFile` (relative to the extension folder). Call before importing the page.
 */
export function installFakePage(htmlFile: string, opts: { hash?: string } = {}): FakePage {
  const ids = idsIn(htmlFile)
  const made = new Map<string, FakeElement>()
  const body = new FakeElement('body')
  const docListeners = new FakeElement('#document')
  const byId = (id: string): FakeElement => {
    const existing = made.get(id)
    if (existing) return existing
    const tag = ids.get(id)
    if (!tag) throw new Error(`${htmlFile} has no #${id}`)
    const el = new FakeElement(tag)
    el.id = id
    made.set(id, el)
    return el
  }
  const asked: string[] = []
  const confirmAnswer = { value: true }
  const location = {
    hash: opts.hash ?? '',
    pathname: `/${htmlFile}`,
    reload: () => undefined,
  }

  const document = {
    body,
    visibilityState: 'visible',
    getElementById: (id: string) => (ids.has(id) ? byId(id) : null),
    createElement: (tag: string) => new FakeElement(tag),
    createElementNS: (_ns: string, tag: string) => new FakeElement(tag),
    // Attribute selectors (the toolbar radios) are not modelled: none match.
    querySelectorAll: (_selector: string): FakeElement[] => [],
    addEventListener: (type: string, fn: Listener) => docListeners.addEventListener(type, fn),
  }
  const g = globalThis as Record<string, unknown>
  g.document = document
  g.window = {
    confirm: (question: string) => {
      asked.push(question)
      return confirmAnswer.value
    },
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  }
  g.location = location
  g.history = {
    replaceState: (_state: unknown, _title: string, url: string) => {
      const hashAt = url.indexOf('#')
      location.hash = hashAt >= 0 ? url.slice(hashAt) : ''
    },
  }

  const buttons = (id: string, name: string): FakeElement[] =>
    byId(id)
      .descendants()
      .filter(
        (e) =>
          e.tagName === 'button' &&
          (e.textContent === name || e.getAttribute('aria-label') === name),
      )

  return { byId, buttons, asked, confirmAnswer, location }
}

/** Remove what `installFakePage` put on the global object. */
export function uninstallFakePage(): void {
  const g = globalThis as Record<string, unknown>
  for (const key of ['document', 'window', 'location', 'history']) delete g[key]
}
