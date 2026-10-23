import type {
  EncryptedEnvelope,
  Endpoint,
  EndpointId,
  GroupKeyRecord,
  HistoryRecord,
  IsoTimestamp,
  NewDeviceWatch,
  SendItem,
  SendPayload,
} from '@tabsend/shared'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiClientError } from '../lib/api'
import { generateGroupKey, generateKeyPair, keyId, open, openGroup } from '../lib/crypto'
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
let groupKeys: GroupKeyRecord[] = []
vi.mock('../lib/storage', () => ({
  getCachedEndpoints: vi.fn(async () => endpointList),
  getOutbound: vi.fn(async () => [...outbound]),
  setOutbound: vi.fn(async (q: OutboundItem[]) => {
    outbound = q
  }),
  updateOutbound: vi.fn(async (change: (q: OutboundItem[]) => OutboundItem[]) => {
    outbound = change([...outbound])
    return outbound
  }),
  getSettings: vi.fn(async () => ({ showSuccessToast: false })),
  // history.ts seals the group-history blob under the newest of these.
  getGroupKeys: vi.fn(async () => groupKeys),
}))

/** This browser's watch (P-10): which devices it has accepted, removed, or not answered. */
let watch: NewDeviceWatch | undefined
vi.mock('./newdevices', () => ({ currentDeviceWatch: vi.fn(async () => watch) }))

/** A watch that has accepted every device in `list`, as a settled group's would. */
function acceptAll(list: Endpoint[], extra: Partial<NewDeviceWatch> = {}): NewDeviceWatch {
  return {
    selfId: 'self-1',
    known: ['self-1', ...list.map((e) => e.id)],
    unconfirmed: [],
    keys: Object.fromEntries(list.map((e) => [e.id, e.e2ePubkey])),
    ...extra,
  }
}

vi.mock('./endpoints', () => ({ fetchEndpoints: vi.fn(async () => endpointList) }))
vi.mock('./feedback', () => ({
  feedbackBadge: vi.fn(),
  showFeedback: vi.fn(async () => true),
  activeOrigin: vi.fn(async () => undefined),
}))
vi.mock('./prefs', () => ({ recordSend: vi.fn(async () => undefined) }))
vi.mock('./scheduler', () => ({ ensureRetryAlarm: vi.fn(async () => undefined) }))

interface FakeSession {
  identity: { publicKey: string; privateKey: string; keyId: string }
  registration: { relayUrl: string; deviceToken: string; endpointId: string }
}
let session: FakeSession
/** Set to stand for a browser with no pairing (unpaired, or not yet paired). */
let unpaired = false
vi.mock('./session', () => ({
  requireSession: vi.fn(async () => session),
  currentSession: vi.fn(async () => (unpaired ? null : session)),
}))

import { OUTBOUND_MAX_AGE_MS, OUTBOUND_MAX_ITEMS } from '../lib/outbound'
import { activeOrigin, feedbackBadge, showFeedback } from './feedback'
import {
  buildConsoleCopies,
  cancelHeldTab,
  captureSelectedTabs,
  payloadsFromTabs,
  processOutbound,
  retargetHeldTab,
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
  unpaired = false
  watch = undefined
  groupKeys = []
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

  // `expired_key` rather than a "device gone" answer: since P-15 item 3 those
  // keep the tab for another device (see the describe block below).
  it('a per-item refusal is a drop, not a recovery, and names the device', async () => {
    outbound = [held('a', 'One')]
    sendMessages.mockImplementation(async (...args: unknown[]) => {
      const items = (args[2] as { items: SendItem[] }).items
      return { accepted: [], rejected: [{ id: items[0]!.id, reason: 'expired_key' }] }
    })

    expect(await processOutbound()).toBe(false)
    expect(outbound).toEqual([])
    expect(feedbackBadge).not.toHaveBeenCalled() // never announced as "Sent"
    expect(shown()?.tone).toBe('error')
    expect(shown()?.detail).toContain('The keys on Arc · Mac mini have changed')
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

/**
 * A tab held for a device that was then removed (PLANS.md P-15 item 3). It used
 * to sit in the list until the relay answered, and then be dropped with an
 * error. Now it waits, flagged, and the user sends it to another device.
 */
describe('held tabs for a removed device', () => {
  const oldEnvelope: EncryptedEnvelope = {
    alg: 'x25519-xsalsa20-poly1305/box',
    senderKeyId: 'sender-key',
    targetKeyId: 'removed-key',
    nonce: 'nonce',
    ciphertext: 'sealed-for-the-removed-device',
  }
  const forRemoved = (id: string, extra: Partial<OutboundItem> = {}): OutboundItem => ({
    id,
    targetEndpointId: 'removed-1',
    envelope: oldEnvelope,
    createdAt: '2026-08-16T00:00:00.000Z',
    attempts: 2,
    title: 'All workflows',
    url: 'https://github.com/x/actions',
    targetLabel: 'Galaxy S24 Ultra',
    ...extra,
  })
  const copyOf = (id: string, parent: string): OutboundItem => ({
    id,
    targetEndpointId: 'con-1',
    envelope: oldEnvelope,
    createdAt: '2026-08-16T00:00:00.000Z',
    attempts: 0,
    history: true,
    copyOf: parent,
  })
  const shown = () => vi.mocked(showFeedback).mock.calls[0]?.[0]
  /** The device the tab was for, still (or again) on the relay's list. */
  const removedDevice = (): Endpoint => ({ ...target, id: 'removed-1' as EndpointId })

  beforeEach(() => {
    endpointList = [target] // the removed device is no longer in the group
    watch = acceptAll(endpointList)
    outbound = []
    sendMessages.mockReset()
    sendMessages.mockResolvedValue({ accepted: [], rejected: [] })
    vi.mocked(showFeedback).mockClear()
    vi.mocked(feedbackBadge).mockClear()
  })

  it('flags a tab whose device left the list, posts nothing, and says so once', async () => {
    outbound = [forRemoved('a'), copyOf('a-copy', 'a')]

    // Nothing left that a retry could move, so no retry alarm is needed.
    expect(await processOutbound()).toBe(false)
    expect(sendMessages).not.toHaveBeenCalled()
    expect(outbound.map((i) => i.id)).toEqual(['a', 'a-copy'])
    expect(outbound[0]?.targetGone).toBe(true)
    expect(outbound[0]?.goneFromList).toBe(true)
    expect(outbound[0]?.attempts).toBe(2) // not counted as a failed try
    expect(shown()?.tone).toBe('pending')
    expect(shown()?.headline).toBe('“All workflows” is waiting for a new device')
    // Nobody here removed it: all this browser knows is that it is not in the list (L3).
    expect(shown()?.detail).toBe(
      'Galaxy S24 Ultra is no longer in your group. Open Tabsend to send it to another device.',
    )

    // The flag is stored, so the next drain neither posts nor repeats itself.
    vi.mocked(showFeedback).mockClear()
    await processOutbound()
    expect(sendMessages).not.toHaveBeenCalled()
    expect(showFeedback).not.toHaveBeenCalled()
  })

  it('counts a device this browser removed as gone while the relay keeps listing it (L3)', async () => {
    endpointList = [target, removedDevice()]
    watch = acceptAll(endpointList, { removed: ['removed-1'] })
    outbound = [forRemoved('a')]

    await processOutbound()
    expect(sendMessages).not.toHaveBeenCalled()
    expect(outbound[0]?.targetGone).toBe(true)
    expect(shown()?.detail).toBe(
      'Galaxy S24 Ultra was removed from your group. Open Tabsend to send it to another device.',
    )
  })

  it('takes no verdict from a watch another pairing left behind (L7)', async () => {
    // Written under an earlier registration of this browser, which removed the
    // device. This pairing has never judged it, so the list decides, as before P-10.
    endpointList = [target, removedDevice()]
    watch = { ...acceptAll(endpointList, { removed: ['removed-1'] }), selfId: 'old-self' }
    outbound = [forRemoved('a')]

    await processOutbound()
    const posted = (sendMessages.mock.calls[0]![2] as { items: SendItem[] }).items
    expect(posted.map((i) => i.targetEndpointId)).toEqual(['removed-1'])
    expect(outbound).toEqual([])
  })

  it('does not say "was removed" from a watch another pairing left behind (L7)', async () => {
    endpointList = [target, removedDevice()]
    watch = { ...acceptAll(endpointList, { removed: ['removed-1'] }), selfId: 'old-self' }
    outbound = [forRemoved('a')]
    sendMessages.mockImplementation(async (...args: unknown[]) => {
      const items = (args[2] as { items: SendItem[] }).items
      return { accepted: [], rejected: [{ id: items[0]!.id, reason: 'unknown_target' }] }
    })

    await processOutbound()
    expect(outbound[0]?.targetGone).toBe(true)
    expect(shown()?.detail).toBe(
      'Galaxy S24 Ultra is no longer in your group. Open Tabsend to send it to another device.',
    )
  })

  it('still posts a tab whose device is in the list', async () => {
    outbound = [forRemoved('a', { targetEndpointId: 'target-1' })]
    expect(await processOutbound()).toBe(false)
    expect(sendMessages).toHaveBeenCalledTimes(1)
    expect(outbound).toEqual([])
  })

  it('gives a tab back to its device once a list shows that device accepted again (L3)', async () => {
    // A list left the device out for a while: it is back, and so is its tab.
    endpointList = [target, removedDevice()]
    watch = acceptAll(endpointList)
    outbound = [forRemoved('a', { targetGone: true, goneFromList: true })]

    await processOutbound()
    const posted = (sendMessages.mock.calls[0]![2] as { items: SendItem[] }).items
    expect(posted.map((i) => i.targetEndpointId)).toEqual(['removed-1'])
    expect(outbound).toEqual([])
  })

  it('does not say it twice when a tab given back to its device is then refused', async () => {
    endpointList = [target, removedDevice()]
    watch = acceptAll(endpointList)
    outbound = [forRemoved('a', { targetGone: true, goneFromList: true })]
    sendMessages.mockImplementation(async (...args: unknown[]) => {
      const items = (args[2] as { items: SendItem[] }).items
      return { accepted: [], rejected: [{ id: items[0]!.id, reason: 'unknown_target' }] }
    })

    await processOutbound()
    expect(sendMessages).toHaveBeenCalledTimes(1)
    expect(outbound[0]?.targetGone).toBe(true)
    expect(outbound[0]?.goneFromList).toBeUndefined() // now the relay's flag
    expect(showFeedback).not.toHaveBeenCalled()
  })

  it('keeps a tab the relay calls unknown, instead of dropping it, and holds its copy', async () => {
    // The list here still shows the device: the relay knows better.
    endpointList = [target, removedDevice()]
    watch = acceptAll(endpointList)
    outbound = [forRemoved('a'), copyOf('a-copy', 'a')]
    sendMessages.mockImplementation(async (...args: unknown[]) => {
      const items = (args[2] as { items: SendItem[] }).items
      return { accepted: [], rejected: [{ id: items[0]!.id, reason: 'unknown_target' }] }
    })

    expect(await processOutbound()).toBe(false)
    // The copy names the old device inside its ciphertext: it must not go.
    expect(sendMessages).toHaveBeenCalledTimes(1)
    expect(outbound.map((i) => i.id)).toEqual(['a', 'a-copy'])
    expect(outbound[0]?.targetGone).toBe(true)
    expect(outbound[0]?.goneFromList).toBeUndefined()
    expect(shown()?.tone).toBe('pending') // not "Couldn't send"

    // The relay's word holds against a list that still shows the device.
    sendMessages.mockClear()
    await processOutbound()
    expect(sendMessages).not.toHaveBeenCalled()
    expect(outbound[0]?.targetGone).toBe(true)
  })

  it('sends a moved tab to the new device, sealed afresh for its key', async () => {
    const consoleKp = await generateKeyPair()
    endpointList = [target, consoleEndpoint('con-1', consoleKp.publicKey)]
    watch = acceptAll(endpointList)
    const groupKey = await generateGroupKey()
    groupKeys = [
      { key: groupKey, keyId: 'gk-1', createdAt: '2026-08-01T00:00:00.000Z' as IsoTimestamp },
    ]
    const oldHistory = {
      alg: 'xsalsa20-poly1305/secretbox' as const,
      keyId: 'gk-1',
      nonce: 'n',
      ciphertext: 'names-the-removed-device',
    }
    outbound = [
      forRemoved('a', { targetGone: true, groupHistory: oldHistory }),
      copyOf('a-copy', 'a'),
      forRemoved('b'),
    ]

    expect(await retargetHeldTab('a', 'target-1')).toBe(true)

    // Still queued, in the old one's place, now for the new device.
    const [moved, copy, other] = outbound
    expect(outbound).toHaveLength(3)
    expect(moved?.id).not.toBe('a')
    expect(moved?.targetEndpointId).toBe('target-1')
    expect(moved?.targetLabel).toBe('Arc · Mac mini')
    expect(moved?.targetGone).toBeUndefined()
    expect(moved?.createdAt).toBe('2026-08-16T00:00:00.000Z')
    expect(moved?.url).toBe('https://github.com/x/actions')
    // Never the old ciphertext: the new device opens it with its own key.
    expect(moved?.envelope.ciphertext).not.toBe(oldEnvelope.ciphertext)
    expect(moved?.envelope.targetKeyId).toBe(await keyId(targetKeys.publicKey))
    const opened = JSON.parse(
      await open(moved!.envelope, session.identity.publicKey, targetKeys.privateKey),
    ) as SendPayload
    expect(opened.url).toBe('https://github.com/x/actions')
    expect(opened.title).toBe('All workflows')
    // A new history blob, under the group key, that names the new device (L7).
    expect(moved?.groupHistory).toBeDefined()
    expect(moved?.groupHistory?.ciphertext).not.toBe(oldHistory.ciphertext)
    const record = JSON.parse(await openGroup(moved!.groupHistory!, groupKey)) as HistoryRecord
    expect(record.targetLabelAtSend).toBe('Arc · Mac mini')
    expect(record.payload.url).toBe('https://github.com/x/actions')
    // The old console copy is gone; a new one names the new device.
    expect(copy?.history).toBe(true)
    expect(copy?.copyOf).toBe(moved?.id)
    const copyPayload = JSON.parse(
      await open(copy!.envelope, session.identity.publicKey, consoleKp.privateKey),
    ) as SendPayload
    expect(copyPayload.historyOf).toEqual({ targetEndpointId: 'target-1' })
    expect(other?.id).toBe('b')

    // The drain then delivers it like any held tab.
    await processOutbound()
    const posted = (sendMessages.mock.calls[0]![2] as { items: SendItem[] }).items
    expect(posted[0]?.targetEndpointId).toBe('target-1')
    // The relay is handed the new blob, never the one naming the removed device.
    expect(posted[0]?.history).toEqual(moved?.groupHistory)
    expect(outbound.map((i) => i.id)).toEqual(['b'])
    expect(vi.mocked(feedbackBadge).mock.calls[0]?.[0]?.headline).toBe('Sent “All workflows”')
  })

  it('may move the tab back to its own device once that device is accepted again', async () => {
    endpointList = [target, removedDevice()]
    watch = acceptAll(endpointList)
    outbound = [forRemoved('a', { targetGone: true })] // the relay refused it once

    expect(await retargetHeldTab('a', 'removed-1')).toBe(true)
    expect(outbound[0]?.targetEndpointId).toBe('removed-1')
    expect(outbound[0]?.id).not.toBe('a')
  })

  it('moves nothing to this browser itself, to an unknown device, or for a gone id', async () => {
    outbound = [forRemoved('a', { targetGone: true })]
    expect(await retargetHeldTab('a', 'self-1')).toBe(false)
    expect(await retargetHeldTab('a', 'nobody')).toBe(false)
    expect(await retargetHeldTab('zzz', 'target-1')).toBe(false)
    expect(outbound.map((i) => i.id)).toEqual(['a'])
  })

  it('moves nothing to a device the relay lists but this browser has not accepted (L3)', async () => {
    const consoleKp = await generateKeyPair()
    const stranger = { ...target, id: 'stranger' as EndpointId }
    const pending = { ...target, id: 'pending' as EndpointId }
    const onCard = { ...target, id: 'on-card' as EndpointId }
    endpointList = [
      target,
      removedDevice(),
      stranger,
      pending,
      onCard,
      consoleEndpoint('con-1', consoleKp.publicKey),
    ]
    const notice = (id: string) => ({ id, label: id, createdAt: target.createdAt })
    watch = {
      ...acceptAll(endpointList.filter((e) => e.id !== 'stranger')),
      removed: ['removed-1'],
      unconfirmed: [notice('pending')],
      review: [notice('on-card')],
    }
    outbound = [forRemoved('a', { targetGone: true })]

    expect(await retargetHeldTab('a', 'stranger')).toBe(false) // never accepted
    expect(await retargetHeldTab('a', 'removed-1')).toBe(false) // removed here, still listed
    expect(await retargetHeldTab('a', 'pending')).toBe(false) // "new device" unanswered
    expect(await retargetHeldTab('a', 'on-card')).toBe(false) // first look unanswered
    expect(await retargetHeldTab('a', 'con-1')).toBe(false) // a console
    expect(outbound.map((i) => i.id)).toEqual(['a'])
    // A watch from another pairing accepts nothing.
    watch = { ...acceptAll([target]), selfId: 'someone-else' }
    expect(await retargetHeldTab('a', 'target-1')).toBe(false)
    expect(outbound.map((i) => i.id)).toEqual(['a'])
  })

  it('seals nothing but a web address again', async () => {
    outbound = [forRemoved('a', { targetGone: true, url: 'javascript:alert(1)' })]
    expect(await retargetHeldTab('a', 'target-1')).toBe(false)
    expect(outbound.map((i) => i.id)).toEqual(['a'])
  })
})

/**
 * Several things write the queue, and a drain spends seconds on the network
 * between reading it and writing it (SECURITY_REVIEW L4). Each test holds the
 * drain's first POST open, changes the queue meanwhile, then lets it finish.
 */
describe('a drain that is still posting', () => {
  const item = (id: string, extra: Partial<OutboundItem> = {}): OutboundItem => ({
    id,
    targetEndpointId: 'target-1',
    envelope: {
      alg: 'x25519-xsalsa20-poly1305/box',
      senderKeyId: 'sender-key',
      targetKeyId: 'target-key',
      nonce: 'nonce',
      ciphertext: `sealed-${id}`,
    },
    createdAt: '2026-08-16T00:00:00.000Z',
    attempts: 1,
    title: id,
    url: `https://example.com/${id}`,
    targetLabel: 'Arc · Mac mini',
    ...extra,
  })

  /** Hold the first POST until `release` is called; every POST then gets `answer`. */
  function holdFirstPost(answer: () => Promise<unknown>): {
    posting: Promise<void>
    release: () => void
  } {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let started!: () => void
    const posting = new Promise<void>((resolve) => {
      started = resolve
    })
    let first = true
    sendMessages.mockImplementation(async () => {
      if (first) {
        first = false
        started()
        await gate
      }
      return answer()
    })
    return { posting, release }
  }

  const offline = async () => {
    throw new TypeError('Failed to fetch')
  }

  beforeEach(() => {
    endpointList = [target, { ...target, id: 'pixel' as EndpointId, label: 'Pixel 8' }]
    watch = acceptAll(endpointList)
    sendMessages.mockReset()
    vi.mocked(showFeedback).mockClear()
  })

  it('does not undo a move made meanwhile, and the tab goes once', async () => {
    outbound = [item('x'), item('a', { targetEndpointId: 'gone-1', targetGone: true })]
    const { posting, release } = holdFirstPost(async () => ({ accepted: [], rejected: [] }))

    const draining = processOutbound()
    await posting
    expect(await retargetHeldTab('a', 'pixel')).toBe(true)
    release()
    await draining

    // The old row did not come back beside its replacement to be moved again.
    expect(outbound.some((i) => i.id === 'a')).toBe(false)
    expect(outbound.map((i) => i.targetEndpointId)).toEqual(['pixel'])
    sendMessages.mockReset()
    sendMessages.mockResolvedValue({ accepted: [], rejected: [] })
    await processOutbound()
    expect(sendMessages).toHaveBeenCalledTimes(1)
    expect(outbound).toEqual([])
  })

  it('does not bring back a tab cancelled meanwhile', async () => {
    outbound = [item('x'), item('y')]
    const { posting, release } = holdFirstPost(offline)

    const draining = processOutbound()
    await posting
    await cancelHeldTab('y')
    release()
    await draining

    expect(outbound.map((i) => i.id)).toEqual(['x'])
    expect(outbound[0]?.attempts).toBe(2)
  })

  it('keeps a send queued meanwhile', async () => {
    outbound = [item('x')]
    const { posting, release } = holdFirstPost(async () => ({ accepted: [], rejected: [] }))

    const draining = processOutbound()
    await posting
    outbound = [...outbound, item('new', { attempts: 0 })] // as enqueueOutbound would
    release()
    await draining

    expect(outbound.map((i) => i.id)).toEqual(['new'])
  })

  it('does not restore what an unpair wiped meanwhile', async () => {
    outbound = [item('x'), item('y')]
    const { posting, release } = holdFirstPost(offline)

    const draining = processOutbound()
    await posting
    outbound = [] // clearRegistrationState
    unpaired = true
    release()
    await draining

    expect(outbound).toEqual([])
  })

  it('announces nothing for a pass an unpair overtook', async () => {
    outbound = [item('x'), item('y')]
    const { posting, release } = holdFirstPost(async () => ({ accepted: [], rejected: [] }))
    vi.mocked(feedbackBadge).mockClear()

    const draining = processOutbound()
    await posting
    outbound = [] // clearRegistrationState
    unpaired = true
    release()
    expect(await draining).toBe(false)

    expect(outbound).toEqual([])
    expect(feedbackBadge).not.toHaveBeenCalled()
    expect(showFeedback).not.toHaveBeenCalled()
  })

  it('posts and writes nothing without a pairing', async () => {
    unpaired = true
    outbound = [item('x')]
    expect(await processOutbound()).toBe(false)
    expect(sendMessages).not.toHaveBeenCalled()
    expect(outbound.map((i) => i.attempts)).toEqual([1])
  })
})

/**
 * A later outcome (the relay came back, refused a held tab, or lost its
 * device) goes up as a banner only on the tab the send came from, and names
 * the tab only when it was that tab's own page (SECURITY_REVIEW L8). Before,
 * every one of them landed in whatever page was in front.
 */
describe('later outcomes go only to the tab they came from (L8)', () => {
  const envelope: EncryptedEnvelope = {
    alg: 'x25519-xsalsa20-poly1305/box',
    senderKeyId: 'sender-key',
    targetKeyId: 'target-key',
    nonce: 'nonce',
    ciphertext: 'ciphertext',
  }
  const ORIGIN = { tabId: 7, url: 'https://a.example/a' }
  function held(id: string, extra: Partial<OutboundItem> = {}): OutboundItem {
    return {
      id,
      targetEndpointId: 'target-1',
      envelope,
      createdAt: '2026-08-16T00:00:00.000Z',
      attempts: 1,
      title: `Title ${id}`,
      url: `https://a.example/${id}`,
      ...extra,
    }
  }
  const call = () => vi.mocked(showFeedback).mock.calls[0]
  const refuse = () =>
    sendMessages.mockRejectedValue(new ApiClientError(401, 'unauthorized', 'Bad token.'))

  beforeEach(() => {
    endpointList = [target]
    watch = acceptAll(endpointList)
    outbound = []
    sendMessages.mockReset()
    vi.mocked(showFeedback).mockClear()
    vi.mocked(activeOrigin).mockReset()
    vi.mocked(activeOrigin).mockResolvedValue(undefined)
  })

  it('keeps the tab and page a held send came from, on the tab itself only', async () => {
    vi.mocked(activeOrigin).mockResolvedValue(ORIGIN)
    sendMessages.mockRejectedValue(new TypeError('fetch failed'))
    const [own] = payloadsFromTabs([fakeTab(ORIGIN.url, 'Title a')])
    await sendToTarget('target-1', own)

    expect(outbound.length).toBeGreaterThan(0)
    expect(outbound.filter((i) => !i.history).map((i) => i.origin)).toEqual([ORIGIN])
    // The immediate banner goes to that tab, and may name it: it is its own page.
    expect(call()?.[1]).toEqual({ origin: ORIGIN, titleFrom: ORIGIN.url })
  })

  it('shows a refusal on the tab it came from, named only when it was that page', async () => {
    outbound = [held('a', { origin: ORIGIN })]
    refuse()
    await processOutbound()

    const [named, opts] = call() ?? []
    expect(named?.headline).toBe("Couldn't send “Title a”")
    expect(opts?.origin).toEqual(ORIGIN)
    expect(opts?.titleFrom).toBe('https://a.example/a')
    // For a page that the name isn't from, the same news without it.
    expect(opts?.untitled?.headline).toBe("Couldn't send the tab that was waiting")
  })

  it('gives the badge alone for a held tab with no known origin', async () => {
    outbound = [held('a')]
    refuse()
    await processOutbound()
    expect(call()?.[1]?.origin).toBeUndefined()
  })

  it('gives the badge alone when the held tabs came from different pages', async () => {
    outbound = [
      held('a', { origin: ORIGIN }),
      held('b', { origin: { tabId: 7, url: 'https://a.example/b' } }),
    ]
    refuse()
    await processOutbound()
    expect(call()?.[1]?.origin).toBeUndefined()
  })

  it('has an untitled wording for a tab that lost its device', async () => {
    // Its device is no longer in the group.
    outbound = [held('a', { origin: ORIGIN, targetEndpointId: 'gone-1', targetLabel: 'Pixel 8' })]
    await processOutbound()
    const [named, opts] = call() ?? []
    expect(named?.headline).toBe('“Title a” is waiting for a new device')
    expect(opts?.origin).toEqual(ORIGIN)
    expect(opts?.untitled?.headline).toBe('A tab is waiting for a new device')
  })
})
