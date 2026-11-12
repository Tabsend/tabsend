import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryKv } from '../lib/session'
import { renderHelpSection, renderShareBox as renderShareBoxReal, type ShareEnv } from './share'
import { type FakeElement, findAll, findButton, installFakeDom, outline } from './test-dom'

const DAY = 24 * 60 * 60 * 1000
const T0 = Date.UTC(2026, 10, 1)

let restore: () => void
let clock = T0
let opened: string[]
let copied: string[]
let env: ShareEnv

beforeEach(() => {
  restore = installFakeDom({ hostname: 'relay.example.com', origin: 'https://relay.example.com' })
  clock = T0
  opened = []
  copied = []
  env = {
    kv: new MemoryKv(),
    now: () => clock,
    copy: async (text) => {
      copied.push(text)
    },
    openTab: (url) => {
      opened.push(url)
    },
  }
})
afterEach(() => restore())

const hosted = 'https://app.tabsend.org'

// The fake page stand-ins replace the real elements in these tests.
const renderShareBox = (input: Parameters<typeof renderShareBoxReal>[0], e: ShareEnv) =>
  renderShareBoxReal(input, e) as unknown as FakeElement | null
const renderHelpSectionFake = (relay: string, e: ShareEnv) =>
  renderHelpSection(relay, e) as unknown as FakeElement

describe('console share box', () => {
  it('stays hidden until 30 days after the first paired Home', () => {
    expect(renderShareBox({ relayUrl: hosted, deviceCount: 2 }, env)).toBeNull()
    clock = T0 + 29 * DAY
    expect(renderShareBox({ relayUrl: hosted, deviceCount: 2 }, env)).toBeNull()
    clock = T0 + 31 * DAY
    expect(renderShareBox({ relayUrl: hosted, deviceCount: 2 }, env)).not.toBeNull()
  })

  it('needs two devices', () => {
    renderShareBox({ relayUrl: hosted, deviceCount: 1 }, env)
    clock = T0 + 40 * DAY
    expect(renderShareBox({ relayUrl: hosted, deviceCount: 1 }, env)).toBeNull()
  })

  it('credit wording on the hosted address, Share opens the account Share page', () => {
    renderShareBox({ relayUrl: hosted, deviceCount: 2 }, env)
    clock = T0 + 40 * DAY
    const box = renderShareBox({ relayUrl: hosted, deviceCount: 2 }, env)
    if (!box) throw new Error('expected a box')
    const text = outline(box)
    expect(text).toContain("Know someone who'd like Tabsend?")
    expect(text).toContain('$5 off your next payment')
    expect(text).toContain('once a year')
    findButton(box, 'Read more').click()
    expect(outline(box)).toContain("It's not for everyone")
    expect(findButton(box, 'Show less')).toBeDefined()
    findButton(box, 'Share Tabsend').click()
    expect(opened).toEqual(['https://account.tabsend.org/share'])
  })

  it('plain wording elsewhere, Share copies the sentence', async () => {
    renderShareBox({ relayUrl: 'https://relay.example.com', deviceCount: 3 }, env)
    clock = T0 + 40 * DAY
    const box = renderShareBox({ relayUrl: 'https://relay.example.com', deviceCount: 3 }, env)
    if (!box) throw new Error('expected a box')
    expect(outline(box)).toContain('would you share it with a coworker or friend?')
    expect(outline(box)).not.toContain('$5')
    findButton(box, 'Share Tabsend').click()
    await vi.waitFor(() => expect(outline(box)).toContain('Copied'))
    expect(copied).toEqual([
      'Tabsend sends a link from your computer to your phone, or the other way. https://tabsend.org',
    ])
  })

  it('rests for a year after Dismiss, then may return', () => {
    renderShareBox({ relayUrl: hosted, deviceCount: 2 }, env)
    clock = T0 + 40 * DAY
    const box = renderShareBox({ relayUrl: hosted, deviceCount: 2 }, env)
    if (!box) throw new Error('expected a box')
    findAll(box, (e) => e.attrs.get('aria-label') === 'Dismiss')[0]?.click()
    expect(box.attrs.has('hidden')).toBe(true)
    clock = T0 + 40 * DAY + 364 * DAY
    expect(renderShareBox({ relayUrl: hosted, deviceCount: 2 }, env)).toBeNull()
    clock = T0 + 40 * DAY + 366 * DAY
    expect(renderShareBox({ relayUrl: hosted, deviceCount: 2 }, env)).not.toBeNull()
  })
})

describe('console Help Tabsend section', () => {
  it('has Share and feedback, and no Rate while no link is set', () => {
    const section = renderHelpSectionFake(hosted, env)
    const text = outline(section)
    expect(text).toContain('Help Tabsend')
    expect(text).toContain('Share Tabsend')
    expect(text).toContain('Something not working? Tell me')
    expect(text).toContain('mailto:contact@tabsend.org?subject=Tabsend%20feedback')
    expect(text).not.toContain('Rate Tabsend')
    findButton(section, 'Share Tabsend').click()
    expect(opened).toEqual(['https://account.tabsend.org/share'])
  })
})
