import { describe, expect, it, vi } from 'vitest'
import { FakeElement } from './test-dom'

vi.mock('../lib/ext', () => ({ ext: {} }))

import { t } from '../lib/i18n'
import { doShare, paintShareBox, type ShareEnv, wireHelpRows } from './share-box'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 11, 1)

function env(over: Partial<{ first: number; dismissed: number }> = {}): ShareEnv & {
  state: { first?: number; dismissed?: number }
  opened: string[]
  copied: string[]
} {
  const state = { first: over.first, dismissed: over.dismissed }
  const opened: string[] = []
  const copied: string[] = []
  return {
    state,
    opened,
    copied,
    now: () => NOW,
    getFirstHomeAt: async () => state.first,
    setFirstHomeAt: async (v) => {
      state.first = v
    },
    getDismissedAt: async () => state.dismissed,
    setDismissedAt: async (v) => {
      state.dismissed = v
    },
    copy: async (text) => {
      copied.push(text)
    },
    openTab: (url) => {
      opened.push(url)
    },
  }
}

function els() {
  const e = (tag = 'div') => new FakeElement(tag) as unknown as HTMLElement
  return {
    box: e(),
    body: e('p'),
    go: e('button'),
    more: e('button'),
    dismiss: e('button'),
    note: e('p'),
  }
}
const hidden = (el: HTMLElement) => (el as unknown as FakeElement).classList.contains('hidden')

describe('share box', () => {
  it('records the first paired Home and stays hidden for 30 days', async () => {
    const env1 = env()
    const e = els()
    await paintShareBox(e, { relayUrl: 'https://app.tabsend.org', deviceCount: 2 }, env1)
    expect(env1.state.first).toBe(NOW)
    expect(hidden(e.box)).toBe(true)
  })

  it('shows the credit wording on the hosted relay, expands and collapses', async () => {
    const e = els()
    await paintShareBox(
      e,
      { relayUrl: 'https://app.tabsend.org', deviceCount: 2 },
      env({ first: NOW - 31 * DAY }),
    )
    expect(hidden(e.box)).toBe(false)
    expect(e.body.textContent).toBe(t('share.body.credit'))
    expect(e.body.textContent).toContain('$5 off')
    expect(e.body.textContent).toContain('once a year')
    expect(e.more.textContent).toBe('Read more')
    e.more.onclick?.({} as PointerEvent)
    expect(e.body.textContent).toBe(t('share.expanded.credit'))
    expect(e.more.textContent).toBe('Show less')
    e.more.onclick?.({} as PointerEvent)
    expect(e.more.textContent).toBe('Read more')
  })

  it('shows the plain wording on any other relay, and Share copies the sentence', async () => {
    const e = els()
    const en = env({ first: NOW - 40 * DAY })
    await paintShareBox(e, { relayUrl: 'https://relay.example', deviceCount: 3 }, en)
    expect(e.body.textContent).toBe(t('share.body.plain'))
    e.go.onclick?.({} as PointerEvent)
    await vi.waitFor(() => expect(e.note.textContent).toBe('Copied'))
    expect(en.copied).toEqual([
      'Tabsend sends a link from your computer to your phone, or the other way. https://tabsend.org',
    ])
    expect(en.state.dismissed).toBe(NOW)
  })

  it('Share on the hosted relay opens the account Share page', async () => {
    const e = els()
    const en = env({ first: NOW - 40 * DAY })
    await paintShareBox(e, { relayUrl: 'https://app.tabsend.org', deviceCount: 2 }, en)
    e.go.onclick?.({} as PointerEvent)
    await vi.waitFor(() => expect(en.opened).toEqual(['https://account.tabsend.org/share']))
  })

  it('dismiss hides it and saves the time', async () => {
    const e = els()
    const en = env({ first: NOW - 40 * DAY })
    await paintShareBox(e, { relayUrl: 'https://app.tabsend.org', deviceCount: 2 }, en)
    e.dismiss.onclick?.({} as PointerEvent)
    await vi.waitFor(() => expect(hidden(e.box)).toBe(true))
    expect(en.state.dismissed).toBe(NOW)
    const again = els()
    await paintShareBox(again, { relayUrl: 'https://app.tabsend.org', deviceCount: 2 }, en)
    expect(hidden(again.box)).toBe(true)
  })

  it('stays hidden with one device or when storage fails', async () => {
    const one = els()
    await paintShareBox(
      one,
      { relayUrl: 'https://app.tabsend.org', deviceCount: 1 },
      env({ first: NOW - 40 * DAY }),
    )
    expect(hidden(one.box)).toBe(true)
    const broken = els()
    const bad = env()
    bad.getFirstHomeAt = async () => {
      throw new Error('no storage')
    }
    await paintShareBox(broken, { relayUrl: 'https://app.tabsend.org', deviceCount: 2 }, bad)
    expect(hidden(broken.box)).toBe(true)
  })

  it('reports a copy that fails', async () => {
    const note = els().note
    const en = env()
    en.copy = async () => {
      throw new Error('denied')
    }
    await doShare('plain', en, note)
    expect(note.textContent).toBe(t('share.copy.failed'))
  })
})

describe('Help Tabsend rows', () => {
  it('hides Rate while no link is set and points feedback at the mailbox', () => {
    const rows = {
      share: new FakeElement('button') as unknown as HTMLElement,
      rate: new FakeElement('a') as unknown as HTMLElement,
      feedback: new FakeElement('a') as unknown as HTMLElement,
      note: new FakeElement('p') as unknown as HTMLElement,
    }
    wireHelpRows(rows, 'https://relay.example', env())
    expect(hidden(rows.rate)).toBe(true)
    expect(rows.feedback.getAttribute('href')).toBe(
      'mailto:contact@tabsend.org?subject=Tabsend%20feedback',
    )
  })
})
