import type {
  EncryptedEnvelope,
  Endpoint,
  EndpointId,
  IsoTimestamp,
  SendItem,
  SendPayload,
} from '@tabsend/shared'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiClientError } from '../lib/api'
import { generateKeyPair, keyId, open } from '../lib/crypto'
import type { OutboundItem } from '../lib/model'

// --- mocks for the runSend pipeline tests -----------------------------------
// buildConsoleCopies/payloadsFromTabs are pure and use none of these; the
// pipeline tests drive sendToTarget end-to-end with REAL sealing (libsodium)
// and a fake relay, so what's asserted is the wire shape, not internals.

const sendMessages = vi.fn<(...args: unknown[]) => Promise<unknown>>()
vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>()
  return { ...actual, sendMessages: (...args: unknown[]) => sendMessages(...args) }
})

const tabsQuery = vi.fn<(...args: unknown[]) => Promise<chrome.tabs.Tab[]>>()
vi.mock('../lib/ext', () => ({
  ext: { tabs: { query: (...args: unknown[]) => tabsQuery(...args) } },
}))

// health.ts is deliberately NOT mocked. Which failures keep a tab and which
// throw it away is decided there, from the HTTP status, and stubbing that out
// would have hidden the exact bug these tests exist to pin down. It is safe in
// the node env because `isBrowserOnline` treats a missing `navigator.onLine` as
// online rather than guessing an outage.

let endpointList: Endpoint[] = []
let outbound: OutboundItem[] = []
vi.mock('../lib/storage', () => ({
  getCachedEndpoints: vi.fn(async () => endpointList),
  getOutbound: vi.fn(async () => [...outbound]),
  setOutbound: vi.fn(async (q: OutboundItem[]) => {
    outbound = q
  }),
  getSettings: vi.fn(async () => ({ showSuccessToast: false })),
}))

vi.mock('./endpoints', () => ({ fetchEndpoints: vi.fn(async () => endpointList) }))
vi.mock('./feedback', () => ({
  feedbackBadge: vi.fn(),
  showFeedback: vi.fn(async () => true),
}))
vi.mock('./prefs', () => ({ recordSend: vi.fn(async () => undefined) }))
vi.mock('./scheduler', () => ({ ensureRetryAlarm: vi.fn(async () => undefined) }))

interface FakeSession {
  identity: { publicKey: string; privateKey: string; keyId: string }
  registration: { relayUrl: string; deviceToken: string; endpointId: string }
}
let session: FakeSession
vi.mock('./session', () => ({ requireSession: vi.fn(async () => session) }))

import { OUTBOUND_MAX_AGE_MS, OUTBOUND_MAX_ITEMS } from '../lib/outbound'
import { feedbackBadge, showFeedback } from './feedback'
import {
  buildConsoleCopies,
  cancelHeldTab,
  captureSelectedTabs,
  payloadsFromTabs,
  processOutbound,
  sendToTarget,
} from './send'

/**
 * Console history copies (ADR-0010 §2, folded in from chunk-5b): every send seals
 * one extra envelope PER console endpoint, sealed to the console's own key,
 * addressed to the console, carrying `historyOf` INSIDE the ciphertext.
 */

function consoleEndpoint(id: string, e2ePubkey: string): Endpoint {
  return {
    id: id as EndpointId,
    groupId: 'g' as Endpoint['groupId'],
    kind: 'console',
    browser: null,
    platform: 'unknown',
    label: 'Web console',
    e2ePubkey,
    presence: 'online',
    lastSeenAt: '2026-07-18T00:00:00.000Z' as IsoTimestamp,
    createdAt: '2026-07-18T00:00:00.000Z' as IsoTimestamp,
  }
}

const payload: SendPayload = {
  url: 'https://example.com/article',
  title: 'An article',
  sentAt: '2026-07-18T00:00:00.000Z' as IsoTimestamp,
}

describe('buildConsoleCopies (ADR-0010 history copies)', () => {
  it('seals one copy per console, addressed to it, with historyOf inside the ciphertext', async () => {
    const sender = await generateKeyPair()
    const senderKeyId = await keyId(sender.publicKey)
    const consoleKp = await generateKeyPair()
    const con = consoleEndpoint('con-1', consoleKp.publicKey)
    const realTargetId = 'target-firefox'

    const items = await buildConsoleCopies(
      [con],
      payload,
      realTargetId,
      senderKeyId,
      sender.privateKey,
    )

    expect(items).toHaveLength(1)
    expect(items[0]!.targetEndpointId).toBe('con-1') // addressed to the console
    expect(items[0]!.envelope.targetKeyId).toBe(await keyId(consoleKp.publicKey))
    expect(items[0]!.envelope.senderKeyId).toBe(senderKeyId)

    // The console opens it with its own key + the sender's pubkey → the payload,
    // with historyOf naming the REAL target (so it renders "source → target").
    const json = await open(items[0]!.envelope, sender.publicKey, consoleKp.privateKey)
    const opened = JSON.parse(json) as SendPayload
    expect(opened.url).toBe(payload.url)
    expect(opened.historyOf).toEqual({ targetEndpointId: realTargetId })
  })

  it('mints nothing when there are no console endpoints', async () => {
    const sender = await generateKeyPair()
    const senderKeyId = await keyId(sender.publicKey)
    expect(await buildConsoleCopies([], payload, 't', senderKeyId, sender.privateKey)).toEqual([])
  })

  it('is best-effort: a console with an unusable key is skipped, never thrown', async () => {
    const sender = await generateKeyPair()
    const senderKeyId = await keyId(sender.publicKey)
    const bad = consoleEndpoint('con-bad', 'not-a-real-key')
    // Must resolve (not throw) and simply drop the unsealed copy.
    await expect(
      buildConsoleCopies([bad], payload, 't', senderKeyId, sender.privateKey),
    ).resolves.toEqual([])
  })
})

// --- multi-tab send ---------------------------------------------------------

function fakeTab(
  url: string,
  title: string,
  extra: Partial<chrome.tabs.Tab> = {},
): chrome.tabs.Tab {
  return { url, title, highlighted: true, ...extra } as chrome.tabs.Tab
}

describe('payloadsFromTabs (batch stamping)', () => {
  it('stamps every payload of a multi-tab selection with ONE shared id and the count', () => {
    const payloads = payloadsFromTabs([
      fakeTab('https://a.example/1', 'One'),
      fakeTab('https://a.example/2', 'Two'),
      fakeTab('https://a.example/3', 'Three'),
    ])
    expect(payloads).toHaveLength(3)
    const batch = payloads[0]?.batch
    expect(batch?.count).toBe(3)
    expect(batch?.id).toBeTruthy()
    for (const p of payloads) expect(p.batch).toEqual(batch)
    // Each tab keeps its own identity — the queue and receivers name tabs by it.
    expect(payloads.map((p) => p.url)).toEqual([
      'https://a.example/1',
      'https://a.example/2',
      'https://a.example/3',
    ])
  })

  it('never stamps a single tab — a solo send stays exactly today’s payload', () => {
    const payloads = payloadsFromTabs([fakeTab('https://a.example/1', 'One')])
    expect(payloads).toHaveLength(1)
    expect(payloads[0]?.batch).toBeUndefined()
  })

  it('keeps the favicon size guard: an oversized data: favicon is dropped', () => {
    const huge = `data:image/png;base64,${'A'.repeat(9 * 1024)}`
    const payloads = payloadsFromTabs([
      fakeTab('https://a.example/1', 'One', { favIconUrl: huge }),
      fakeTab('https://a.example/2', 'Two', { favIconUrl: 'https://a.example/icon.png' }),
    ])
    expect(payloads[0]?.favicon).toBeUndefined()
    expect(payloads[1]?.favicon).toBe('https://a.example/icon.png')
  })
})

describe('captureSelectedTabs', () => {
  it('keeps the single-tab fallback: nothing sendable highlighted → most recent real page', async () => {
    const extensionPage = fakeTab('chrome-extension://abc/chooser.html', 'Send to…')
    tabsQuery.mockImplementation(async (...args: unknown[]) => {
      const q = args[0] as { highlighted?: boolean }
      if (q.highlighted) return [extensionPage]
      return [
        extensionPage,
        fakeTab('https://old.example/', 'Old', { lastAccessed: 1 }),
        fakeTab('https://new.example/', 'New', { lastAccessed: 2 }),
      ]
    })
    const payloads = await captureSelectedTabs()
    expect(payloads).toHaveLength(1)
    expect(payloads[0]?.url).toBe('https://new.example/')
    expect(payloads[0]?.batch).toBeUndefined()
  })

  it('captures the whole highlighted selection, batch-stamped', async () => {
    tabsQuery.mockImplementation(async () => [
      fakeTab('https://a.example/1', 'One'),
      fakeTab('https://a.example/2', 'Two'),
    ])
    const payloads = await captureSelectedTabs()
    expect(payloads).toHaveLength(2)
    expect(payloads[0]?.batch).toEqual(payloads[1]?.batch)
    expect(payloads[0]?.batch?.count).toBe(2)
  })
})

/**
 * A FROZEN CLOCK for the whole file, and the reason is a bug these tests grew into.
 *
 * The drain decides a held tab's fate by its AGE (`OUTBOUND_MAX_AGE_MS`, seven days),
 * so a fixture with a literal date in it is fresh when it is written and expired a week
 * later — silently, with no edit anywhere. That is exactly what happened: nine of these
 * tests started failing once the calendar passed 2026-08-23, asserting behaviour about
 * queue items the code was correctly throwing away. Pinning `Date` makes "fresh" and
 * "ancient" mean the same thing on every run, today and in a year.
 *
 * Only `Date` is faked. `send.ts` schedules nothing, but faking timers wholesale would
 * make that a trap for whoever adds the first `setTimeout` to this path.
 */
const NOW = new Date('2026-08-16T12:00:00.000Z')

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
})

let targetKeys: { publicKey: string; privateKey: string }
let target: Endpoint

beforeAll(async () => {
  const sender = await generateKeyPair()
  session = {
    identity: {
      publicKey: sender.publicKey,
      privateKey: sender.privateKey,
      keyId: await keyId(sender.publicKey),
    },
    registration: { relayUrl: 'https://relay.test', deviceToken: 'tok', endpointId: 'self-1' },
  }
  targetKeys = await generateKeyPair()
  target = {
    id: 'target-1' as EndpointId,
    groupId: 'g' as Endpoint['groupId'],
    kind: 'extension',
    browser: 'chrome',
    platform: 'macos',
    label: 'Arc · Mac mini',
    e2ePubkey: targetKeys.publicKey,
    presence: 'online',
    lastSeenAt: '2026-08-03T00:00:00.000Z' as IsoTimestamp,
    createdAt: '2026-08-03T00:00:00.000Z' as IsoTimestamp,
  }
})

describe('runSend with a batch (via sendToTarget)', () => {
  beforeEach(() => {
    endpointList = [target]
    outbound = []
    sendMessages.mockReset()
  })

  const tabs = (): chrome.tabs.Tab[] => [
    fakeTab('https://a.example/1', 'One'),
    fakeTab('https://a.example/2', 'Two'),
    fakeTab('https://a.example/3', 'Three'),
  ]

  function postedItems(): SendItem[] {
    const body = sendMessages.mock.calls[0]?.[2] as { items: SendItem[] } | undefined
    if (!body) throw new Error('sendMessages was never called')
    return body.items
  }

  it('seals one item per tab and POSTs the whole batch in ONE call', async () => {
    sendMessages.mockResolvedValue({ accepted: [], rejected: [] })
    const res = await sendToTarget('target-1', payloadsFromTabs(tabs()))

    expect(sendMessages).toHaveBeenCalledTimes(1)
    const items = postedItems()
    expect(items).toHaveLength(3)
    // The batch stamp rides INSIDE the ciphertext — open one and check.
    const opened = JSON.parse(
      await open(items[1]!.envelope, session.identity.publicKey, targetKeys.privateKey),
    ) as SendPayload
    expect(opened.url).toBe('https://a.example/2')
    expect(opened.batch?.count).toBe(3)

    expect(res.ok).toBe(true)
    expect(res.count).toBe(3)
    expect(res.rejectedCount).toBeUndefined()
    expect(res.failure).toBeUndefined()
  })

  it('a single send produces exactly today’s result shape — no count, no batch', async () => {
    sendMessages.mockResolvedValue({ accepted: [], rejected: [] })
    const [payload] = payloadsFromTabs([fakeTab('https://a.example/1', 'One')])
    const res = await sendToTarget('target-1', payload)

    expect(res).toEqual({
      ok: true,
      queued: false,
      offline: false,
      targetLabel: 'Arc · Mac mini',
      title: 'One',
    })
    const opened = JSON.parse(
      await open(postedItems()[0]!.envelope, session.identity.publicKey, targetKeys.privateKey),
    ) as SendPayload
    expect(opened.batch).toBeUndefined()
  })

  it('reports a PARTIAL delivery when the relay refuses some-but-not-all of the batch', async () => {
    sendMessages.mockImplementation(async (...args: unknown[]) => {
      const items = (args[2] as { items: SendItem[] }).items
      return { accepted: [], rejected: [{ id: items[2]!.id, reason: 'expired_key' }] }
    })
    const res = await sendToTarget('target-1', payloadsFromTabs(tabs()))

    expect(res.ok).toBe(true)
    expect(res.count).toBe(3)
    expect(res.rejectedCount).toBe(1)
    // The failure is attached, so no surface can read this as a clean "Sent 3".
    expect(res.failure).toEqual({ kind: 'relay-rejected', reason: 'expired_key' })
  })

  it('a full-batch refusal is a failure, with the counts', async () => {
    sendMessages.mockImplementation(async (...args: unknown[]) => {
      const items = (args[2] as { items: SendItem[] }).items
      return {
        accepted: [],
        rejected: items.map((i) => ({ id: i.id, reason: 'unknown_target' })),
      }
    })
    const res = await sendToTarget('target-1', payloadsFromTabs(tabs()))

    expect(res.ok).toBe(false)
    expect(res.count).toBe(3)
    expect(res.rejectedCount).toBe(3)
    expect(res.failure).toEqual({ kind: 'relay-rejected', reason: 'unknown_target' })
  })

  it('queues the WHOLE batch on an outage, each real item named by its own tab', async () => {
    // A console in the group: its history copies must queue too, flagged so the
    // held list never counts them.
    const consoleKeys = await generateKeyPair()
    endpointList = [target, consoleEndpoint('con-1', consoleKeys.publicKey)]
    sendMessages.mockRejectedValue(new TypeError('fetch failed'))
    const res = await sendToTarget('target-1', payloadsFromTabs(tabs()))

    expect(res.ok).toBe(true)
    expect(res.offline).toBe(true)
    expect(res.count).toBe(3)
    expect(res.failure?.kind).toBe('relay-unreachable')

    const real = outbound.filter((i) => !i.history)
    expect(real.map((i) => ({ url: i.url, title: i.title }))).toEqual([
      { url: 'https://a.example/1', title: 'One' },
      { url: 'https://a.example/2', title: 'Two' },
      { url: 'https://a.example/3', title: 'Three' },
    ])
    expect(outbound.filter((i) => i.history)).toHaveLength(3) // one copy per tab
  })

  /**
   * A relay that says "not now" is not a relay that said no. This used to return
   * a hard error and enqueue nothing, so a rate limit or a restarting container
   * cost the user the tab outright — with a banner telling them to check their
   * setup, for something that would have fixed itself in seconds.
   */
  it('a 429 holds the tab for retry instead of failing it', async () => {
    sendMessages.mockRejectedValue(new ApiClientError(429, 'rate_limited', 'Slow down.'))
    const res = await sendToTarget(
      'target-1',
      payloadsFromTabs([fakeTab('https://a.example/1', 'One')]),
    )

    expect(res.ok).toBe(true)
    expect(res.failure).toEqual({ kind: 'relay-busy' })
    expect(outbound.map((i) => i.url)).toEqual(['https://a.example/1'])
  })

  it('a 502 from a proxy in front of a restarting relay holds the whole batch', async () => {
    sendMessages.mockRejectedValue(new ApiClientError(502, 'internal', 'Request failed (502).'))
    const res = await sendToTarget('target-1', payloadsFromTabs(tabs()))

    expect(res.ok).toBe(true)
    expect(res.failure).toEqual({ kind: 'relay-busy' })
    expect(outbound.filter((i) => !i.history)).toHaveLength(3)
  })

  /**
   * A per-group cap [0030] refuses items one at a time, inside a 200. Every one
   * of those caps clears itself — the send window rolls over inside a minute,
   * the queue caps drain as the target reads its tabs — so the tab belongs in
   * the queue that already holds tabs through an outage, not in the bin. It used
   * to be dropped on the spot with "Something went wrong inside your relay".
   */
  it('holds a cap-refused batch for retry instead of failing it', async () => {
    sendMessages.mockImplementation(async (...args: unknown[]) => {
      const items = (args[2] as { items: SendItem[] }).items
      return {
        accepted: [],
        rejected: items.map((i) => ({
          id: i.id,
          reason: 'limit_reached',
          limit: 'sends_per_window',
        })),
      }
    })
    const res = await sendToTarget('target-1', payloadsFromTabs(tabs()))

    // `ok` for the same reason an outage is: the tabs are here, not lost.
    expect(res.ok).toBe(true)
    expect(res.failure).toEqual({
      kind: 'relay-rejected',
      reason: 'limit_reached',
      limit: 'sends_per_window',
    })
    expect(outbound.filter((i) => !i.history).map((i) => i.url)).toEqual([
      'https://a.example/1',
      'https://a.example/2',
      'https://a.example/3',
    ])
  })

  it('a partially cap-refused batch queues only the refused tabs', async () => {
    sendMessages.mockImplementation(async (...args: unknown[]) => {
      const items = (args[2] as { items: SendItem[] }).items
      return {
        accepted: items.slice(0, 2).map((i) => i.id),
        rejected: [{ id: items[2]!.id, reason: 'limit_reached', limit: 'queued_messages' }],
      }
    })
    const res = await sendToTarget('target-1', payloadsFromTabs(tabs()))

    expect(res.rejectedCount).toBe(1)
    expect(outbound.map((i) => i.url)).toEqual(['https://a.example/3'])
  })

  /**
   * A batch that hit BOTH a cap and a real refusal. The cap-held tab is queued
   * either way, but the sentence the user gets is the one they have to act on:
   * the other tab is already looking after itself.
   */
  it('lets a final refusal explain a batch that also hit a cap', async () => {
    sendMessages.mockImplementation(async (...args: unknown[]) => {
      const items = (args[2] as { items: SendItem[] }).items
      return {
        accepted: [],
        rejected: [
          { id: items[0]!.id, reason: 'limit_reached', limit: 'queued_bytes' },
          { id: items[1]!.id, reason: 'unknown_target' },
          { id: items[2]!.id, reason: 'unknown_target' },
        ],
      }
    })
    const res = await sendToTarget('target-1', payloadsFromTabs(tabs()))

    expect(res.failure).toEqual({ kind: 'relay-rejected', reason: 'unknown_target' })
    expect(res.ok).toBe(false)
    expect(outbound.map((i) => i.url)).toEqual(['https://a.example/1'])
  })

  it('a 403 is still a dead end — nothing is queued to replay it forever', async () => {
    sendMessages.mockRejectedValue(new ApiClientError(403, 'forbidden', 'Not your group.'))
    const res = await sendToTarget('target-1', payloadsFromTabs(tabs()))

    expect(res.ok).toBe(false)
    expect(res.failure).toEqual({ kind: 'relay-error', code: 'forbidden' })
    expect(outbound).toEqual([])
  })
})

/**
 * The drain. An item leaves the queue only on a DEFINITE answer, and whichever
 * answer it was, the "waiting to send" promise made when the tab was held has to
 * be settled out loud.
 */
describe('processOutbound', () => {
  const envelope: EncryptedEnvelope = {
    alg: 'x25519-xsalsa20-poly1305/box',
    senderKeyId: 'sender-key',
    targetKeyId: 'target-key',
    nonce: 'nonce',
    ciphertext: 'ciphertext',
  }

  function held(id: string, title: string, extra: Partial<OutboundItem> = {}): OutboundItem {
    return {
      id,
      targetEndpointId: 'target-1',
      envelope,
      createdAt: '2026-08-16T00:00:00.000Z',
      attempts: 1,
      title,
      url: `https://a.example/${id}`,
      ...extra,
    }
  }

  /** The banner the drain showed, if it showed one. */
  function shown() {
    return vi.mocked(showFeedback).mock.calls[0]?.[0]
  }

  beforeEach(() => {
    endpointList = [target]
    outbound = []
    sendMessages.mockReset()
    vi.mocked(showFeedback).mockClear()
    vi.mocked(feedbackBadge).mockClear()
  })

  /**
   * THE regression. Every non-2xx counted as a permanent refusal, so one pass
   * against a relay behind a proxy serving HTML 502 for the few seconds it takes
   * to restart discarded the entire held queue — silently, after the user had
   * been told the tabs were waiting and had walked away.
   */
  it('keeps every item when the relay answers 502', async () => {
    outbound = [held('a', 'One'), held('b', 'Two'), held('c', 'Three')]
    sendMessages.mockRejectedValue(new ApiClientError(502, 'internal', 'Request failed (502).'))

    expect(await processOutbound()).toBe(true)
    expect(outbound.map((i) => i.id)).toEqual(['a', 'b', 'c'])
    expect(outbound.map((i) => i.attempts)).toEqual([2, 2, 2]) // counted, not dropped
    expect(showFeedback).not.toHaveBeenCalled() // nothing has been settled to announce
  })

  it('keeps them on a 429 too, and on plain silence', async () => {
    outbound = [held('a', 'One')]
    sendMessages.mockRejectedValue(new ApiClientError(429, 'rate_limited', 'Slow down.'))
    expect(await processOutbound()).toBe(true)

    sendMessages.mockRejectedValue(new TypeError('fetch failed'))
    expect(await processOutbound()).toBe(true)
    expect(outbound.map((i) => i.attempts)).toEqual([3])
  })

  it('announces the tabs that finally went, as it always did', async () => {
    outbound = [held('a', 'One')]
    sendMessages.mockResolvedValue({ accepted: [], rejected: [] })

    expect(await processOutbound()).toBe(false)
    expect(outbound).toEqual([])
    // showSuccessToast is off in these tests, so the confirmation is badge-only.
    expect(vi.mocked(feedbackBadge).mock.calls[0]?.[0]?.headline).toBe('Sent “One”')
  })

  /**
   * The original bug with a longer fuse: the tab was promised, the relay came
   * back, and the answer was no. It left the queue in total silence.
   */
  it('says so when a held tab is finally refused, and drops it', async () => {
    outbound = [held('a', 'One'), held('h', 'copy', { history: true })]
    sendMessages.mockRejectedValue(new ApiClientError(401, 'unauthorized', 'Bad token.'))

    expect(await processOutbound()).toBe(false)
    expect(outbound).toEqual([])
    // The console history copy is best-effort and never surfaces, so the count
    // stays at the one tab the user actually sent.
    expect(shown()?.tone).toBe('error')
    expect(shown()?.headline).toBe("Couldn't send “One”")
    expect(shown()?.detail).toContain('Set Tabsend up again')
  })

  it('a per-item refusal is a drop, not a recovery, and names the device', async () => {
    outbound = [held('a', 'One')]
    sendMessages.mockImplementation(async (...args: unknown[]) => {
      const items = (args[2] as { items: SendItem[] }).items
      return { accepted: [], rejected: [{ id: items[0]!.id, reason: 'not_in_group' }] }
    })

    expect(await processOutbound()).toBe(false)
    expect(outbound).toEqual([])
    expect(feedbackBadge).not.toHaveBeenCalled() // never announced as "Sent"
    expect(shown()?.tone).toBe('error')
    expect(shown()?.detail).toBe('Your relay says Arc · Mac mini has left your group of devices.')
  })

  /**
   * The drain half of the same rule [0030]. A cap refusal is the one per-item
   * answer that retrying CAN change, so the item stays and nothing is announced:
   * announcing it would withdraw a promise that is still being kept.
   */
  it('keeps a cap-refused item queued, and says nothing about it', async () => {
    outbound = [held('a', 'One')]
    sendMessages.mockImplementation(async (...args: unknown[]) => {
      const items = (args[2] as { items: SendItem[] }).items
      return {
        accepted: [],
        rejected: [{ id: items[0]!.id, reason: 'limit_reached', limit: 'sends_per_window' }],
      }
    })

    expect(await processOutbound()).toBe(true)
    expect(outbound.map((i) => i.id)).toEqual(['a'])
    expect(outbound.map((i) => i.attempts)).toEqual([2]) // counted, not dropped
    expect(showFeedback).not.toHaveBeenCalled()
    expect(feedbackBadge).not.toHaveBeenCalled()
  })

  it('a cap-refused history copy is kept too, not silently released', async () => {
    outbound = [held('h', 'copy', { history: true })]
    sendMessages.mockImplementation(async (...args: unknown[]) => {
      const items = (args[2] as { items: SendItem[] }).items
      return { accepted: [], rejected: [{ id: items[0]!.id, reason: 'limit_reached' }] }
    })

    expect(await processOutbound()).toBe(true)
    expect(outbound.map((i) => i.id)).toEqual(['h'])
  })

  it('settles a mixed pass every way at once', async () => {
    outbound = [held('good', 'One'), held('gone', 'Two'), held('busy', 'Three')]
    sendMessages.mockImplementation(async (...args: unknown[]) => {
      const [item] = (args[2] as { items: SendItem[] }).items
      if (item?.id === 'gone') throw new ApiClientError(401, 'unauthorized', 'Bad token.')
      if (item?.id === 'busy') throw new ApiClientError(503, 'internal', 'restarting')
      return { accepted: [], rejected: [] }
    })

    expect(await processOutbound()).toBe(true)
    expect(outbound.map((i) => i.id)).toEqual(['busy']) // the only undecided one
    expect(vi.mocked(feedbackBadge).mock.calls[0]?.[0]?.headline).toBe('Sent “One”')
    expect(shown()?.headline).toBe("Couldn't send “Two”")
  })

  /**
   * The other side of the split (INTERACTION_FLOWS §4f). Keeping a tab through
   * every 429, every 5xx and every silence is right, and unchanged — but nothing
   * ever ENDED a wait, so an envelope one relay permanently 5xxes was retried on
   * every drain and every heartbeat for as long as the profile lived. It is
   * never competing with newer sends for the size cap, so only its own age can
   * finish it, which is why the sweep runs at the top of the drain and not only
   * when something is enqueued.
   */
  it('gives up on a tab the relay has been refusing for longer than the TTL', async () => {
    const ancient = new Date(Date.now() - OUTBOUND_MAX_AGE_MS - 1000).toISOString()
    outbound = [held('poison', 'Stuck', { createdAt: ancient }), held('fresh', 'Recent')]
    sendMessages.mockRejectedValue(new ApiClientError(502, 'internal', 'Request failed (502).'))

    expect(await processOutbound()).toBe(true)
    // The 502 still keeps the tab it is about — that rule does NOT weaken here.
    expect(outbound.map((i) => i.id)).toEqual(['fresh'])
    expect(sendMessages).toHaveBeenCalledTimes(1) // the dead one is not even tried
    expect(shown()?.tone).toBe('error')
    expect(shown()?.headline).toBe("Couldn't send “Stuck”")
    expect(shown()?.detail).toContain('7 days')
  })

  /** A given-up tab is announced, never quietly deleted: the user was told it
   *  was waiting, so the promise has to be settled out loud (§4d). */
  it('never gives up on a tab in silence', async () => {
    const ancient = new Date(Date.now() - OUTBOUND_MAX_AGE_MS - 1000).toISOString()
    outbound = [held('a', 'One', { createdAt: ancient })]
    sendMessages.mockResolvedValue({ accepted: [], rejected: [] })

    expect(await processOutbound()).toBe(false)
    expect(outbound).toEqual([])
    expect(showFeedback).toHaveBeenCalledTimes(1)
    expect(shown()?.detail).toContain('never taken')
  })

  /** A console history copy is not a tab anybody sent, so it may never be
   *  counted in what the user is told about [ADR-0010]. */
  it('does not count a history copy among the tabs it gave up on', async () => {
    const ancient = new Date(Date.now() - OUTBOUND_MAX_AGE_MS - 1000).toISOString()
    outbound = [
      held('a', 'One', { createdAt: ancient }),
      held('c', 'copy', { createdAt: ancient, history: true, copyOf: 'a' }),
    ]
    sendMessages.mockResolvedValue({ accepted: [], rejected: [] })

    expect(await processOutbound()).toBe(false)
    expect(outbound).toEqual([])
    expect(shown()?.headline).toBe("Couldn't send “One”") // one tab, not two
  })
})

/**
 * The size cap, at the end where a burst actually arrives. Age alone does not
 * bound one: a multi-tab send is N items in a single click, and a week is a long
 * time to keep clicking.
 */
describe('enqueueing onto a full queue (via sendToTarget)', () => {
  const envelope: EncryptedEnvelope = {
    alg: 'x25519-xsalsa20-poly1305/box',
    senderKeyId: 'sender-key',
    targetKeyId: 'target-key',
    nonce: 'nonce',
    ciphertext: 'ciphertext',
  }

  beforeEach(() => {
    endpointList = [target]
    sendMessages.mockReset()
    vi.mocked(showFeedback).mockClear()
  })

  it('evicts the oldest to make room, and says so', async () => {
    // A full queue, oldest first, then one more send while the relay is silent.
    outbound = Array.from({ length: OUTBOUND_MAX_ITEMS }, (_, n) => ({
      id: `old-${n}`,
      targetEndpointId: 'target-1',
      envelope,
      createdAt: new Date(Date.now() - (OUTBOUND_MAX_ITEMS - n) * 60_000).toISOString(),
      attempts: 1,
      title: `Tab ${n}`,
      url: `https://a.example/${n}`,
    }))
    sendMessages.mockRejectedValue(new TypeError('fetch failed'))

    const [payload] = payloadsFromTabs([fakeTab('https://a.example/new', 'The one just sent')])
    await sendToTarget('target-1', payload)

    expect(outbound).toHaveLength(OUTBOUND_MAX_ITEMS)
    // The newest is the one the user just clicked for; the oldest is what goes.
    expect(outbound.some((i) => i.title === 'The one just sent')).toBe(true)
    expect(outbound.some((i) => i.id === 'old-0')).toBe(false)
    const banners = vi.mocked(showFeedback).mock.calls.map((call) => call[0])
    const dropped = banners.find((b) => b.headline.startsWith("Couldn't send"))
    expect(dropped?.detail).toContain('200')
  })
})

/**
 * Abandoning a held tab (INTERACTION_FLOWS §4f). The waiting list used to be
 * read-only on every client, so a tab aimed at a relay that was never coming
 * back could only be watched.
 */
describe('cancelHeldTab', () => {
  const envelope: EncryptedEnvelope = {
    alg: 'x25519-xsalsa20-poly1305/box',
    senderKeyId: 'sender-key',
    targetKeyId: 'target-key',
    nonce: 'nonce',
    ciphertext: 'ciphertext',
  }
  const queued = (id: string, extra: Partial<OutboundItem> = {}): OutboundItem => ({
    id,
    targetEndpointId: 'target-1',
    envelope,
    createdAt: '2026-08-16T00:00:00.000Z',
    attempts: 1,
    ...extra,
  })

  beforeEach(() => {
    sendMessages.mockReset()
  })

  it('forgets the tab locally and sends nothing at all', async () => {
    outbound = [queued('a'), queued('b')]
    await cancelHeldTab('a')
    expect(outbound.map((i) => i.id)).toEqual(['b'])
    // The whole point of a local delete: there is no retraction to transmit,
    // exactly as with an undo inside the quick-send window.
    expect(sendMessages).not.toHaveBeenCalled()
  })

  /** Otherwise the console keeps a history row for a tab that never went. */
  it('takes the cancelled tab’s console copies with it', async () => {
    outbound = [queued('a'), queued('a-copy', { history: true, copyOf: 'a' }), queued('b')]
    await cancelHeldTab('a')
    expect(outbound.map((i) => i.id)).toEqual(['b'])
  })
})
