import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type SendBanner, sendBanner } from '../lib/strings'

/**
 * The in-page banner is drawn inside a web page, so the page can see whatever
 * it says (SECURITY_REVIEW L8). These tests run the real injected function
 * against a small fake DOM and check what reaches the page: the shadow root is
 * closed, a banner goes only to the tab and page the send came from, another
 * page's title never appears, nor does the relay's address, and Undo answers
 * to a real click only.
 */

// --- a fake page ------------------------------------------------------------

type Listener = (event: { isTrusted: boolean }) => void

class FakeElement {
  id = ''
  className = ''
  textContent = ''
  src = ''
  alt = ''
  style = { cssText: '' }
  attrs: Record<string, string> = {}
  children: FakeElement[] = []
  parent: FakeElement | undefined
  listeners: Record<string, Listener[]> = {}
  /** What the page itself can reach: null for a closed root, as in a browser. */
  shadowRoot: FakeElement | null = null
  /** The root whatever its mode. Test-only: the page has no way to this. */
  innerRoot: FakeElement | undefined

  constructor(readonly tag: string) {}
  attachShadow({ mode }: { mode: 'open' | 'closed' }): FakeElement {
    const root = new FakeElement('#shadow-root')
    this.innerRoot = root
    this.shadowRoot = mode === 'open' ? root : null
    return root
  }
  appendChild(child: FakeElement): FakeElement {
    child.parent = this
    this.children.push(child)
    return child
  }
  append(...nodes: FakeElement[]): void {
    for (const node of nodes) this.appendChild(node)
  }
  remove(): void {
    if (!this.parent) return
    this.parent.children = this.parent.children.filter((c) => c !== this)
    this.parent = undefined
  }
  setAttribute(name: string, value: string): void {
    this.attrs[name] = value
  }
  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners[type] ?? []
    list.push(listener)
    this.listeners[type] = list
  }
  get childElementCount(): number {
    return this.children.length
  }
  click(isTrusted: boolean): void {
    for (const l of this.listeners.click ?? []) l({ isTrusted })
  }
}

/** Every string in the tree, following roots only as far as `reach` allows. */
function textOf(el: FakeElement, reach: 'page' | 'all'): string {
  const root = reach === 'page' ? el.shadowRoot : (el.innerRoot ?? null)
  const below = [...el.children, ...(root ? [root] : [])]
  return [el.textContent, el.src, ...below.map((c) => textOf(c, reach))].join(' ')
}

function findAll(el: FakeElement, pred: (e: FakeElement) => boolean): FakeElement[] {
  const below = [...el.children, ...(el.innerRoot ? [el.innerRoot] : [])]
  return [...(pred(el) ? [el] : []), ...below.flatMap((c) => findAll(c, pred))]
}

let html: FakeElement
const sendMessage = vi.fn()

function installPage(href: string): void {
  html = new FakeElement('html')
  const g = globalThis as Record<string, unknown>
  g.document = {
    documentElement: html,
    createElement: (tag: string) => new FakeElement(tag),
    getElementById: (id: string) => findAll(html, (e) => e.id === id)[0] ?? null,
  }
  g.window = {
    matchMedia: () => ({ matches: false }),
    setTimeout: () => 1,
    clearTimeout: () => undefined,
  }
  g.location = { href }
  g.chrome = { runtime: { sendMessage } }
}

function host(): FakeElement | undefined {
  return findAll(html, (e) => e.id === '__tabsend_feedback__')[0]
}

// --- the extension side -----------------------------------------------------

const executeScript = vi.fn(
  async (injection: {
    target: { tabId: number }
    func: (...a: unknown[]) => unknown
    args: unknown[]
  }) => [{ result: injection.func(...injection.args) }],
)
const activeTab = { id: 99, url: 'https://elsewhere.example/bank' }
vi.mock('../lib/ext', () => ({
  ext: {
    scripting: { executeScript: (i: never) => executeScript(i) },
    tabs: { query: vi.fn(async () => [activeTab]) },
  },
}))
const badgeTitle = vi.fn()
vi.mock('./badge', () => ({
  badgeError: vi.fn(),
  badgeQueued: vi.fn(),
  badgeSuccess: vi.fn(),
  badgeTitle: (t: string) => badgeTitle(t),
}))

import { activeOrigin, showFeedback } from './feedback'

const PAGE = 'https://news.example/story'
const ORIGIN = { tabId: 7, url: PAGE }
const banner: SendBanner = {
  tone: 'success',
  headline: 'Sent to Pixel 8',
  title: 'Account overview · My Bank',
  favicon: 'https://bank.example/favicon.ico',
}

beforeEach(() => {
  installPage(PAGE)
  executeScript.mockClear()
  sendMessage.mockClear()
  badgeTitle.mockClear()
})
afterEach(() => {
  const g = globalThis as Record<string, unknown>
  for (const k of ['document', 'window', 'location', 'chrome']) delete g[k]
})

describe('the in-page banner (SECURITY_REVIEW L8)', () => {
  it('is drawn in a CLOSED shadow root, so the page cannot read it', async () => {
    expect(await showFeedback(banner, { origin: ORIGIN, titleFrom: PAGE })).toBe(true)
    const el = host()
    expect(el).toBeDefined()
    // Drawn, with the tab's name, as before...
    expect(textOf(el!, 'all')).toContain('Sent to Pixel 8')
    // ...but out of the page's reach.
    expect(el!.shadowRoot).toBeNull()
    expect(textOf(el!, 'page')).not.toContain('Sent to Pixel 8')
  })

  it('without the tab the send came from, sets the badge and draws nothing anywhere', async () => {
    expect(await showFeedback(banner)).toBe(false)
    // Never the tab that happens to be in front (`activeTab` here).
    expect(executeScript).not.toHaveBeenCalled()
    expect(badgeTitle).toHaveBeenCalledWith('Sent to Pixel 8')
  })

  it('draws nothing when that tab has moved on to another page', async () => {
    installPage('https://bank.example/account') // same tab, different page now
    expect(await showFeedback(banner, { origin: ORIGIN, titleFrom: PAGE })).toBe(false)
    expect(executeScript).toHaveBeenCalledTimes(1)
    expect(executeScript.mock.calls[0]?.[0].target).toEqual({ tabId: 7 })
    expect(host()).toBeUndefined()
    expect(badgeTitle).toHaveBeenCalled()
  })

  it("names a tab only on that tab's own page", async () => {
    // The title came from another page (a multi-tab send, a held tab): left out.
    await showFeedback(banner, { origin: ORIGIN, titleFrom: 'https://bank.example/account' })
    const text = textOf(host()!, 'all')
    expect(text).toContain('Sent to Pixel 8')
    expect(text).not.toContain('My Bank')
    expect(text).not.toContain('bank.example')

    // Its own page: named, as before.
    await showFeedback(banner, { origin: ORIGIN, titleFrom: PAGE })
    expect(textOf(host()!, 'all')).toContain('Account overview · My Bank')
  })

  it('uses the untitled wording when the headline itself would name another page', async () => {
    const named: SendBanner = { tone: 'error', headline: 'Couldn’t send “My Bank”' }
    const untitled: SendBanner = {
      tone: 'error',
      headline: "Couldn't send the tab that was waiting",
    }
    await showFeedback(named, { origin: ORIGIN, titleFrom: 'https://bank.example/', untitled })
    const text = textOf(host()!, 'all')
    expect(text).toContain('the tab that was waiting')
    expect(text).not.toContain('My Bank')
    // The badge's tooltip is Tabsend's own, and may name it.
    expect(badgeTitle).toHaveBeenCalledWith('Couldn’t send “My Bank”')
  })

  it("never puts the relay's address in the page; the tooltip keeps it", async () => {
    const relayUrl = 'https://relay.home.example:8443'
    const held = sendBanner({
      ok: true,
      queued: false,
      offline: true,
      targetLabel: 'Pixel 8',
      title: 'A story',
      failure: { kind: 'relay-unreachable', relayUrl },
    })
    await showFeedback(held, { origin: ORIGIN, titleFrom: PAGE })
    const args = JSON.stringify(executeScript.mock.calls[0]?.[0].args)
    expect(args).not.toContain('relay.home.example')
    expect(textOf(host()!, 'all')).toContain("Can't reach your relay. The tab is held here")
    expect(badgeTitle.mock.calls[0]?.[0]).toContain(relayUrl)
  })

  it("answers Undo only to a real click, and only with its own send's id", async () => {
    await showFeedback(
      { tone: 'pending', headline: 'Sending to Pixel 8' },
      { origin: ORIGIN, undoId: 'undo-1', durationMs: 4000 },
    )
    const undo = findAll(host()!, (e) => e.tag === 'button' && e.textContent === 'Undo')[0]
    expect(undo).toBeDefined()
    undo!.click(false) // a script's synthetic click
    expect(sendMessage).not.toHaveBeenCalled()
    undo!.click(true)
    expect(sendMessage).toHaveBeenCalledWith({ __tabsendUndo: true, id: 'undo-1' })
  })
})

describe('activeOrigin', () => {
  it('is the tab in front and its address, read when the send starts', async () => {
    expect(await activeOrigin()).toEqual({ tabId: 99, url: 'https://elsewhere.example/bank' })
  })
})
