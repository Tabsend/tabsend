import type { Endpoint, EndpointId, IsoTimestamp } from '@tabsend/shared'
import type { FetchLike } from './api'
import { Controller } from './controller'
import { makeEndpoint } from './fixtures'
import { t } from './i18n'
import type { ConsoleSession, HistoryEntry } from './model'
import { protocolMismatchMessage } from './pairing'
import { InMemoryHistoryStore } from './persist'
import { projectEntry } from './receive'
import { MemoryKv, saveSession } from './session'
import { absoluteTime, relativeTime } from './time'
import * as view from './view'

/**
 * Every sentence the console's logic (not its screens) can say, for the counts and names
 * that change its shape, as a flat `name -> text` map. Test support only: the golden test
 * reads it; nothing in the app imports it. The screens are covered by
 * `ui/scenes.fixtures.ts`.
 */
export const NOW = Date.parse('2026-11-03T12:00:00.000Z')
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString()

const SESSION: ConsoleSession = {
  relayUrl: 'https://relay.example.com',
  endpointId: 'console-1',
  groupId: 'group-1',
  deviceToken: 'tok',
  label: 'Web console',
  publicKey: 'pub',
  privateKey: 'priv',
  keyId: 'kid',
}

function entry(over: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: 'e1',
    sourceEndpointId: 's',
    targetEndpointId: 't',
    sentAt: iso(MIN),
    recordedAt: iso(MIN),
    sourceLabelAtSend: 'S',
    targetLabelAtSend: 'T',
    ...over,
  }
}

type Handler = (path: string) => Response | undefined

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const refused = (message?: string): Response =>
  json(403, { error: { code: 'forbidden', ...(message ? { message } : {}) } })
/** A relay refusal with a code. Its wording is the relay's own English and must never be shown. */
const said = (code: string): Response =>
  json(400, { error: { code, message: 'Relay wording that must not show up.' } })
const CODES = [
  'unauthorized',
  'endpoint_removed',
  'forbidden',
  'not_found',
  'invalid_request',
  'invalid_pairing_code',
  'group_exists',
  'limit_reached',
  'rate_limited',
  'internal',
  'something_new',
]

/**
 * Every status line a controller sets while one action runs, in order, against a relay
 * that answers as scripted. A path with no answer is a network failure (a TypeError, as
 * a real fetch gives when the relay is unreachable).
 */
async function statusLines(
  handler: Handler,
  act: (c: Controller) => Promise<void>,
  options: { paired?: boolean; relayUrl?: string } = {},
): Promise<string> {
  const lines: string[] = []
  const kv = new MemoryKv()
  const session = { ...SESSION, relayUrl: options.relayUrl ?? SESSION.relayUrl }
  if (options.paired !== false) saveSession(session, kv)
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input)
    const path = url.slice(url.indexOf('/v1/'))
    const response = handler(path)
    if (!response) throw new TypeError('Failed to fetch')
    return response
  }) as FetchLike
  const controller = new Controller({
    kv,
    store: new InMemoryHistoryStore(),
    fetchImpl,
    now: () => NOW,
    detectPlatform: () => 'macos',
  })
  if (options.paired !== false) controller.session.set(session)
  const set = controller.status.set.bind(controller.status)
  controller.status.set = (value) => {
    lines.push(`${value.kind}: ${value.message}`)
    set(value)
  }
  await act(controller)
  controller.teardown()
  return lines.join(' || ')
}

export async function collectStrings(): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const put = (name: string, text: string) => {
    out[name] = text
  }

  // --- view.ts ---
  for (const [name, iso] of [
    ['morning', '2026-10-27T08:05:00.000Z'],
    ['afternoon', '2026-10-27T15:05:00.000Z'],
    ['noon', '2026-11-03T12:00:00.000Z'],
    ['midnight', '2026-11-03T00:00:00.000Z'],
    ['single-digit-day', '2026-01-04T21:45:00.000Z'],
  ] as const) {
    put(`monthDayLine/${name}`, view.monthDayLine(iso))
    put(`clockLine/${name}`, view.clockLine(iso))
  }
  put('monthDayLine/unreadable', view.monthDayLine('not a time'))
  put('clockLine/unreadable', view.clockLine('not a time'))

  put('groupResetCopy.title', view.groupResetCopy.title)
  put(
    'groupResetCopy.body',
    view.groupResetCopy.body('2026-10-27T09:30:00.000Z', '2026-10-30T15:05:00.000Z'),
  )
  put('groupResetCopy.stop', view.groupResetCopy.stop)
  put('groupResetCopy.dismiss', view.groupResetCopy.dismiss)
  put('groupResetCopy.stopped', view.groupResetCopy.stopped)
  put('groupResetCopy.stopFailedOffline', view.groupResetCopy.stopFailedOffline)

  for (const [name, relayUrl] of [
    ['hosted', 'https://app.tabsend.org'],
    ['home', 'http://192.168.1.20:8787'],
    ['local', 'http://localhost:8787'],
  ] as const) {
    for (const conn of ['live', 'polling', 'offline']) {
      put(`connectionTitle/${conn}/${name}`, view.connectionTitle(conn, relayUrl))
    }
  }

  const rows = view.toDeviceRows(
    [
      makeEndpoint({ id: 'a' as EndpointId, presence: 'online' }),
      makeEndpoint({
        id: 'b' as EndpointId,
        presence: 'offline',
        lastSeenAt: iso(3 * HOUR) as IsoTimestamp,
      }),
    ],
    null,
    NOW,
    true,
  )
  for (const [i, r] of rows.entries()) put(`toDeviceRows/known/${i}`, r.lastSeenLabel)
  const unknownPresence = view.toDeviceRows(
    [
      makeEndpoint({
        id: 'a' as EndpointId,
        presence: 'online',
        lastSeenAt: iso(2 * MIN) as IsoTimestamp,
      }),
    ],
    null,
    NOW,
    false,
  )

  for (const [i, r] of unknownPresence.entries())
    put(`toDeviceRows/presence-unknown/${i}`, r.lastSeenLabel)

  const waiting = { createdAt: iso(HOUR), expiresAt: iso(-DAY), deliveredAt: null, ackedAt: null }
  const arrived = { ...waiting, ackedAt: iso(MIN) }
  const never = { ...waiting, expiresAt: iso(MIN) }
  for (const [name, delivery] of [
    ['arrived', arrived],
    ['waiting', waiting],
    ['never-arrived', never],
  ] as const) {
    const badge = view.deliveryBadge(entry({ delivery }), NOW)
    put(`deliveryBadge/${name}.label`, badge?.label ?? '(none)')
    put(`deliveryBadge/${name}.note`, badge?.note ?? '(none)')
  }
  put('deliveryBadge/copy', String(view.deliveryBadge(entry())))

  put('SEALED_ROW_TITLE', view.sealedRowTitle())
  put('SEALED_ROW_NOTE', view.sealedRowNote())

  // 1 of 1 is not reachable (a batch is two or more tabs), so it is not pinned here.
  for (const [arrivedCount, sent] of [
    [2, 2],
    [3, 3],
    [12, 12],
    [1, 3],
    [2, 5],
    [1, 2],
  ] as const) {
    const group = {
      batchId: 'b',
      sentCount: sent,
      entries: Array.from({ length: arrivedCount }, (_, i) => entry({ id: `x${i}` })),
    }
    put(`batchHeading/${arrivedCount}of${sent}`, view.batchHeading(group))
  }

  put('introCopy.title', view.introCopy.title)
  put('introCopy.what', view.introCopy.what)
  // One sentence with a link inside it; the link's own tags are not words.
  put('introCopy.newHereSentence', t('onboarding.newHere').replace(/<\/?link>/g, ''))
  put('introCopy.pairTitle', view.introCopy.pairTitle)
  put('introCopy.pairBody', view.introCopy.pairBody)
  put('introCopy.privacy', view.introCopy.privacy)

  for (const host of ['app.tabsend.org', 'relay.example.com']) {
    put(
      `projectLinks/${host}`,
      view
        .projectLinks(host)
        .map((l) => `${l.label} -> ${l.href}`)
        .join(' | '),
    )
  }

  // --- time.ts ---
  const spans: [string, number][] = [
    ['future', -5 * MIN],
    ['10s', 10_000],
    ['59s', 59_000],
    ['1m', MIN],
    ['5m', 5 * MIN],
    ['59m', 59 * MIN],
    ['1h', HOUR],
    ['3h', 3 * HOUR],
    ['23h', 23 * HOUR],
    ['1d', DAY],
    ['2d', 2 * DAY],
    ['29d', 29 * DAY],
    ['30d', 30 * DAY],
    ['45d', 45 * DAY],
    ['59d', 59 * DAY],
    ['60d', 60 * DAY],
    ['11mo', 359 * DAY],
    ['12mo', 360 * DAY],
    ['1y', 400 * DAY],
    ['2y', 800 * DAY],
    ['12y', 4400 * DAY],
  ]
  for (const [name, ms] of spans) put(`relativeTime/${name}`, relativeTime(iso(ms), NOW))
  put('relativeTime/unreadable', relativeTime('nonsense', NOW))
  put('absoluteTime/morning', absoluteTime('2026-10-27T08:05:09.000Z'))
  put('absoluteTime/afternoon', absoluteTime('2026-10-27T15:05:09.000Z'))
  put('absoluteTime/unreadable', absoluteTime('nonsense'))

  // --- pairing.ts ---
  const config = (over: Record<string, unknown>) =>
    ({ vapidPublicKey: '', ...over }) as Parameters<typeof protocolMismatchMessage>[0]
  put('protocolMismatch/ok', String(protocolMismatchMessage(config({ protocol: 99 }))))
  put(
    'protocolMismatch/client-too-old',
    String(protocolMismatchMessage(config({ protocolVersion: 99, minClientProtocol: 99 }))),
  )
  put(
    'protocolMismatch/relay-too-old',
    String(protocolMismatchMessage(config({ protocolVersion: 0, minClientProtocol: 0 }))),
  )

  // --- receive.ts: a copy from a device the list does not know ---
  const copy = projectEntry(
    {
      id: 'm1',
      sourceEndpointId: 'ghost',
      envelope: {},
    } as never,
    {
      url: 'https://example.com',
      sentAt: iso(MIN),
      historyOf: { targetEndpointId: 'ghost-2' },
    } as never,
    [] as Endpoint[],
    SESSION,
    NOW,
  )
  put('projectEntry/unknown-source', copy.sourceLabelAtSend)
  put('projectEntry/unknown-target', copy.targetLabelAtSend)

  // --- controller.ts status lines ---
  const LINK = 'https://relay.example.com/pair#c=ABCD2345'
  const modern = { vapidPublicKey: '', protocol: 99, minClientProtocol: 1 }
  const join = (handler: Handler, link = LINK, name = 'Mine') =>
    statusLines(handler, (c) => c.join(link, name), { paired: false })

  put('controller.join/empty-link', await join(() => undefined, ''))
  put('controller.join/not-a-link', await join(() => undefined, 'not a link'))
  put('controller.join/unreachable-relay', await join(() => undefined))
  put('controller.join/same-origin-unreachable', await join(() => undefined, '/pair#c=ABCD2345'))
  put(
    'controller.join/relay-says-why',
    await join((p) =>
      p === '/v1/config'
        ? json(200, modern)
        : json(400, { error: { code: 'invalid_pairing_code', message: 'That code has expired.' } }),
    ),
  )
  put(
    'controller.join/relay-says-nothing',
    await join((p) => (p === '/v1/config' ? json(200, modern) : json(502, {}))),
  )
  put(
    'controller.join/client-too-old',
    await join(() => json(200, { ...modern, minClientProtocol: 999 })),
  )
  put(
    'controller.join/relay-too-old',
    await join(() => json(200, { vapidPublicKey: '', protocol: 1 })),
  )

  put(
    'controller.stopGroupReset/ok',
    await statusLines(
      () => json(200, {}),
      (c) => c.stopGroupReset(),
    ),
  )
  put(
    'controller.stopGroupReset/offline',
    await statusLines(
      () => undefined,
      (c) => c.stopGroupReset(),
    ),
  )
  put(
    'controller.stopGroupReset/reason',
    await statusLines(
      () => refused('No reset is waiting'),
      (c) => c.stopGroupReset(),
    ),
  )
  put(
    'controller.stopGroupReset/reason-with-stop',
    await statusLines(
      () => refused('No reset is waiting.'),
      (c) => c.stopGroupReset(),
    ),
  )
  put(
    'controller.stopGroupReset/no-reason',
    await statusLines(
      () => json(500, {}),
      (c) => c.stopGroupReset(),
    ),
  )
  put(
    'controller.rename/reason',
    await statusLines(
      () => refused('Names must be short.'),
      (c) => c.rename('ext-1', 'x'),
    ),
  )
  put(
    'controller.rename/no-reason',
    await statusLines(
      () => json(500, {}),
      (c) => c.rename('ext-1', 'x'),
    ),
  )
  put(
    'controller.rename/offline',
    await statusLines(
      () => undefined,
      (c) => c.rename('ext-1', 'x'),
    ),
  )
  put(
    'controller.remove/reason',
    await statusLines(
      () => refused('Not allowed.'),
      (c) => c.remove('ext-1'),
    ),
  )
  put(
    'controller.remove/no-reason',
    await statusLines(
      () => json(500, {}),
      (c) => c.remove('ext-1'),
    ),
  )
  put(
    'controller.remove/self',
    await statusLines(
      () => json(200, {}),
      (c) => c.remove('console-1'),
    ),
  )
  put(
    'controller.addDevice/reason',
    await statusLines(
      () => refused('Too many links.'),
      (c) => c.addDevice(),
    ),
  )
  put(
    'controller.addDevice/no-reason',
    await statusLines(
      () => json(500, {}),
      (c) => c.addDevice(),
    ),
  )
  put(
    'controller.addDevice/invalid-link',
    await statusLines(
      () => json(200, { link: 'nonsense', expiresAt: iso(-MIN) }),
      (c) => c.addDevice(),
    ),
  )
  // --- what the relay's refusals say, by code and by what the person was doing
  const modernConfig = (p: string) => (p === '/v1/config' ? json(200, modern) : undefined)
  for (const code of CODES) {
    put(`controller.join/code/${code}`, await join((p) => modernConfig(p) ?? said(code)))
    put(
      `controller.rename/code/${code}`,
      await statusLines(
        () => said(code),
        (c) => c.rename('ext-1', 'x'),
      ),
    )
    put(
      `controller.remove/code/${code}`,
      await statusLines(
        () => said(code),
        (c) => c.remove('ext-1'),
      ),
    )
    put(
      `controller.addDevice/code/${code}`,
      await statusLines(
        () => said(code),
        (c) => c.addDevice(),
      ),
    )
    put(
      `controller.stopGroupReset/code/${code}`,
      await statusLines(
        () => said(code),
        (c) => c.stopGroupReset(),
      ),
    )
  }
  put(
    'controller.rename/offline-same-origin',
    await statusLines(
      () => undefined,
      (c) => c.rename('ext-1', 'x'),
      { relayUrl: '' },
    ),
  )
  put(
    'controller.addDevice/offline',
    await statusLines(
      () => undefined,
      (c) => c.addDevice(),
    ),
  )
  put(
    'controller.addDevice/invalid-qr-link',
    await statusLines(
      () =>
        json(200, {
          browserLink: 'https://relay.example.com/pair#c=ABCD2345',
          link: 'nonsense',
          expiresAt: iso(-MIN),
        }),
      (c) => c.addDevice(),
    ),
  )
  return out
}
