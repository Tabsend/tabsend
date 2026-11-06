import type { ApiErrorCode, GroupLimit } from '@tabsend/shared'
import { ApiClientError } from './api'
import { failureText } from './failure-text'
import type { InboxItem } from './model'
import { type RelayAction, relayErrorLine, UserFacingError } from './relay-errors'
import type { ArrivalPlace, SendFailure } from './strings'
import * as strings from './strings'

/**
 * Every sentence in strings.ts, for every count and name that changes its shape, as a flat
 * list of `name -> text`. Test support only (the golden test and the pseudo-locale test read
 * it); no page imports it.
 *
 * The device names, page titles and addresses below are what a person would have typed; the
 * pseudo-locale test relies on knowing them (see FIXTURE_VALUES) to tell a person's words from
 * the program's.
 */
export const NOW = Date.parse('2026-10-27T12:00:00Z')
const iso = (minutesAgo: number): string => new Date(NOW - minutesAgo * 60000).toISOString()

const REASONS = ['unknown_target', 'expired_key', 'not_in_group', 'limit_reached', 'new_reason']
const LIMITS: (GroupLimit | undefined)[] = [
  undefined,
  'sends_per_window',
  'queued_messages',
  'queued_bytes',
  'endpoints',
]
const CODES: ApiErrorCode[] = [
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
]

const ACTIONS: RelayAction[] = [
  'join',
  'rename',
  'remove',
  'pairingLink',
  'stopReset',
  'check',
  'other',
]

function failures(): { name: string; failure: SendFailure }[] {
  const out: { name: string; failure: SendFailure }[] = [
    { name: 'browser-offline', failure: { kind: 'browser-offline' } },
    {
      name: 'relay-unreachable',
      failure: { kind: 'relay-unreachable', relayUrl: 'http://192.168.1.50:8786' },
    },
    { name: 'relay-busy', failure: { kind: 'relay-busy' } },
    { name: 'relay-unauthorized', failure: { kind: 'relay-unauthorized' } },
    { name: 'given-up/too-old', failure: { kind: 'given-up', reason: 'too-old' } },
    { name: 'given-up/queue-full', failure: { kind: 'given-up', reason: 'queue-full' } },
    { name: 'no-target', failure: { kind: 'no-target' } },
    { name: 'no-tab', failure: { kind: 'no-tab' } },
  ]
  for (const reason of REASONS) {
    for (const limit of LIMITS) {
      out.push({
        name: `relay-rejected/${reason}/${limit ?? 'no-limit'}`,
        failure: {
          kind: 'relay-rejected',
          reason: reason as never,
          ...(limit ? { limit } : {}),
        },
      })
    }
  }
  for (const code of CODES) {
    out.push({ name: `relay-error/${code}`, failure: { kind: 'relay-error', code } })
  }
  out.push({
    name: 'relay-error/unheard-of',
    failure: { kind: 'relay-error', code: 'something_new' as never },
  })
  return out
}

const item = (over: Partial<InboxItem> = {}): InboxItem => ({
  id: 'm1',
  url: 'https://example.com/a',
  title: 'A page',
  sourceLabel: 'Arc · Mac mini',
  sentAt: iso(3),
  receivedAt: NOW,
  ...over,
})

export function collectStrings(): Record<string, string> {
  const out: Record<string, string> = {}
  const put = (key: string, value: unknown) => {
    if (key in out) throw new Error(`duplicate key ${key}`)
    out[key] = typeof value === 'string' ? value : JSON.stringify(value)
  }
  const s = strings

  // --- feedbackCopy
  for (const label of ['Pixel 9', 'Arc · Mac mini']) {
    put(`feedbackCopy.sentOnline/${label}`, s.feedbackCopy.sentOnline(label))
    put(`feedbackCopy.sentOffline/${label}`, s.feedbackCopy.sentOffline(label))
  }
  for (const n of [2, 3, 12]) put(`feedbackCopy.sentMultiAll/${n}`, s.feedbackCopy.sentMultiAll(n))
  for (const [n, off] of [
    [2, 1],
    [5, 5],
    [12, 3],
  ] as const) {
    put(`feedbackCopy.sentMultiSome/${n}/${off}`, s.feedbackCopy.sentMultiSome(n, off))
  }
  put('feedbackCopy.sourceOffline', s.feedbackCopy.sourceOffline())
  put('feedbackCopy.noDevices', s.feedbackCopy.noDevices())
  put('feedbackCopy.hardError', s.feedbackCopy.hardError())

  // --- send failures: every kind, with and without a device name, one tab and several
  for (const { name, failure } of failures()) {
    for (const label of [undefined, 'Pixel 9']) {
      for (const count of [1, 3]) {
        const k = `${name}/${label ?? 'no-label'}/n${count}`
        put(`sendFailureLine/${k}`, s.sendFailureLine(failure, label, count))
        put(`pageFailureLine/${k}`, s.pageFailureLine(failure, label, count))
      }
    }
    put(`isRecoverableFailure/${name}`, s.isRecoverableFailure(failure))
  }
  put('sendFailureLine/default-args', s.sendFailureLine({ kind: 'no-target' }))
  put('DEVICE_LIMIT_LINE', s.deviceLimitLine())

  // --- names filled in on the setup page
  for (const platform of ['macos', 'windows', 'linux', 'android', 'ios', 'unknown'] as const) {
    put(`deviceNameSeed/${platform}`, s.deviceNameSeed(platform))
  }
  put(
    'browserNameSeed/guess',
    s.browserNameSeed({ value: 'My favorite browser', confident: false }),
  )

  // --- relay down, and times
  for (const minutes of [0, 0.4, 1, 5, 59, 60, 90, 119, 120, 1500]) {
    put(`relayDownLine/public/${minutes}`, s.relayDownLine('https://app.tabsend.org', minutes))
    put(`relayDownLine/home/${minutes}`, s.relayDownLine('http://192.168.1.20:8786', minutes))
  }
  for (const minutes of [0, 0.4, 0.6, 1, 2, 59, 60, 89, 90, 120, 1439, 1440, 1441, 2880, 8640]) {
    put(`agoLine/${minutes}`, s.agoLine(iso(minutes), NOW))
  }
  put('agoLine/future', s.agoLine(new Date(NOW + 60000).toISOString(), NOW))
  put('agoLine/garbage', s.agoLine('not a time', NOW))
  for (const when of ['2026-10-27T15:05:00Z', '2026-01-02T00:00:00Z', '2026-12-31T23:59:00Z']) {
    put(`monthDayLine/${when}`, s.monthDayLine(when))
    put(`clockLine/${when}`, s.clockLine(when))
  }
  put('monthDayLine/garbage', s.monthDayLine('soon'))
  put('clockLine/garbage', s.clockLine('soon'))

  // --- new device notices
  const dev = (label: string, minutes: number) => ({ label, createdAt: iso(minutes) })
  put('newDeviceCopy.alert/one', s.newDeviceCopy.alert([dev('Pixel 9', 4)], NOW))
  put('newDeviceCopy.alert/one-hour', s.newDeviceCopy.alert([dev('Pixel 9', 130)], NOW))
  put('newDeviceCopy.alert/two', s.newDeviceCopy.alert([dev('Pixel 9', 4), dev('iPad', 8)], NOW))
  put(
    'newDeviceCopy.alert/three',
    s.newDeviceCopy.alert([dev('Pixel 9', 4), dev('iPad', 8), dev('Home PC', 9)], NOW),
  )
  put('newDeviceCopy.firstListAlert/one', s.newDeviceCopy.firstListAlert([{ label: 'Pixel 9' }]))
  put(
    'newDeviceCopy.firstListAlert/two',
    s.newDeviceCopy.firstListAlert([{ label: 'Pixel 9' }, { label: 'iPad' }]),
  )
  put(
    'newDeviceCopy.firstListAlert/three',
    s.newDeviceCopy.firstListAlert([{ label: 'Pixel 9' }, { label: 'iPad' }, { label: 'Home PC' }]),
  )
  put('newDeviceCopy.vanishedTitle', s.newDeviceCopy.vanishedTitle('Pixel 9'))
  put('newDeviceCopy.vanishedBody', s.newDeviceCopy.vanishedBody(iso(95), NOW))
  put('newDeviceCopy.vanishedDismiss', s.newDeviceCopy.vanishedDismiss)

  // --- unreachable
  put('unreachableCopy.title', s.unreachableCopy.title('Pixel 9'))
  put('unreachableCopy.body', s.unreachableCopy.body)
  put('unreachableCopy.pairAgain', s.unreachableCopy.pairAgain('Pixel 9'))
  put('unreachableCopy.dismiss', s.unreachableCopy.dismiss)
  put('unreachableCopy.rowStatus', s.unreachableCopy.rowStatus)
  put('unreachableCopy.tooltip/1', s.unreachableCopy.tooltip(['Pixel 9']))
  put('unreachableCopy.tooltip/2', s.unreachableCopy.tooltip(['Pixel 9', 'iPad']))
  put('unreachableCopy.tooltip/3', s.unreachableCopy.tooltip(['Pixel 9', 'iPad', 'Home PC']))

  // --- group reset
  const g = s.groupResetCopy
  put('groupResetCopy.alertTitle', g.alertTitle)
  put('groupResetCopy.alertMessage', g.alertMessage('2026-10-27T08:30:00Z'))
  put('groupResetCopy.title', g.title)
  put('groupResetCopy.body', g.body('2026-10-27T08:30:00Z', '2026-10-28T08:30:00Z'))
  put('groupResetCopy.body/pm', g.body('2026-10-27T18:05:00Z', '2026-10-28T18:05:00Z'))
  put('groupResetCopy.stop', g.stop)
  put('groupResetCopy.stopping', g.stopping)
  put('groupResetCopy.dismiss', g.dismiss)
  put('groupResetCopy.stopped', g.stopped)
  put('groupResetCopy.stopFailedOffline', g.stopFailedOffline)

  // --- chooser rows
  for (const count of [1, 2, 7]) put(`pendingRow/${count}`, s.pendingRow(count, 'Pixel 9'))
  for (const count of [0, 1, 2, 5, 200]) put(`heldTabsHeading/${count}`, s.heldTabsHeading(count))
  put('heldTabLabel/title', s.heldTabLabel({ title: 'A page', url: 'https://example.com/a' }))
  put('heldTabLabel/blank-title', s.heldTabLabel({ title: '  ', url: 'https://example.com/a' }))
  put('heldTabLabel/no-title', s.heldTabLabel({ url: 'https://example.com/a' }))
  put('heldTabLabel/bad-url', s.heldTabLabel({ url: 'not a url' }))
  put('heldTabLabel/nothing', s.heldTabLabel({}))
  put('multiSelectionLine/2', s.multiSelectionLine(2))
  put('multiSelectionLine/9', s.multiSelectionLine(9))

  // --- arrival notifications
  const one = [item()]
  const two = [item(), item({ id: 'm2', title: 'B page' })]
  const mixed = [item(), item({ id: 'm2', sourceLabel: 'Pixel 9' }), item({ id: 'm3' })]
  const long = [item({ title: 'A very long page title that keeps going and going and going on' })]
  const untitled = [item({ title: undefined })]
  for (const [name, items] of Object.entries({ one, two, mixed, long, untitled })) {
    put(`receivedNotificationLine/${name}`, s.receivedNotificationLine(items))
    const places: ArrivalPlace[] = [
      { kind: 'only-window' },
      { kind: 'window', activeTitle: 'Inbox (3) - Mail' },
      {
        kind: 'window',
        activeTitle: 'A window title that is much too long to fit in a notification',
      },
      { kind: 'unknown' },
    ]
    for (const place of places) {
      put(
        `arrivalPlaceLine/${name}/${place.kind}${'activeTitle' in place ? `/${place.activeTitle.length}` : ''}`,
        s.arrivalPlaceLine(items, place),
      )
    }
  }
  put('receivedNotificationLine/no-label', s.receivedNotificationLine([item({ sourceLabel: '' })]))

  // --- recovered and dropped queues
  for (const count of [1, 2, 6]) {
    put(`recoveredLine/${count}/title`, s.recoveredLine(count, 'A page'))
    put(`recoveredLine/${count}/no-title`, s.recoveredLine(count))
    put(`droppedLine/${count}/title`, s.droppedLine(count, 'A page'))
    put(`droppedLine/${count}/no-title`, s.droppedLine(count))
  }

  // --- pairing
  put('pairingErrorLine/unregistered', s.pairingErrorLine({ kind: 'unregistered' }))
  put(
    'pairingErrorLine/unreachable',
    s.pairingErrorLine({ kind: 'unreachable', relayUrl: 'http://192.168.1.50:8786' }),
  )
  put('pairingErrorLine/unauthorized', s.pairingErrorLine({ kind: 'unauthorized' }))
  put('pairingErrorLine/relay', s.pairingErrorLine({ kind: 'relay', detail: 'Too many links.' }))
  put('pairingLocalOnlyLine', s.pairingLocalOnlyLine('http://localhost:8786'))
  put(
    'pairingRoutesLine',
    s.pairingRoutesLine('http://192.168.1.50:8786', 'https://192.168.1.50:8787'),
  )
  put('notRegisteredLine', s.notRegisteredLine())
  put('SETUP_DOCS_URL', s.SETUP_DOCS_URL)

  // --- relay copy
  const url = 'http://192.168.1.50:8786'
  put('relayProbeCopy.same', s.relayProbeCopy.same())
  put('relayProbeCopy.sameUnverified', s.relayProbeCopy.sameUnverified())
  put('relayProbeCopy.different', s.relayProbeCopy.different())
  put('relayProbeCopy.unreachable', s.relayProbeCopy.unreachable(url))
  put('relayProbeCopy.error', s.relayProbeCopy.error('The relay is on fire.'))
  put('relayProbeCopy.updated', s.relayProbeCopy.updated(url))
  put('relayProbeCopy.notPaired', s.relayProbeCopy.notPaired())
  put('relayAccessCopy.denied', s.relayAccessCopy.denied())
  put('relayAccessCopy.missing', s.relayAccessCopy.missing(url))
  put('relayAccessCopy.allow', s.relayAccessCopy.allow)
  put('relayAccessCopy.openSettings', s.relayAccessCopy.openSettings)
  put('relaySwitchCopy.pending', s.relaySwitchCopy.pending(url))
  put('relaySwitchCopy.pendingSafe', s.relaySwitchCopy.pendingSafe('https://app.tabsend.org'))
  put('relaySwitchCopy.pendingUnpaired', s.relaySwitchCopy.pendingUnpaired())
  put('relaySwitchCopy.target', s.relaySwitchCopy.target(url))
  put('relaySwitchCopy.cost', s.relaySwitchCopy.cost('https://app.tabsend.org'))
  put('relaySwitchCopy.keep', s.relaySwitchCopy.keep('https://app.tabsend.org'))
  put('relaySwitchCopy.reusedLink', s.relaySwitchCopy.reusedLink())
  put('relayChangeCopy.unreachable', s.relayChangeCopy.unreachable(url))
  put('relayChangeCopy.differentRelay', s.relayChangeCopy.differentRelay())
  put('relayChangeCopy.tokenRejected', s.relayChangeCopy.tokenRejected())
  put('relayChangeCopy.probeFailed', s.relayChangeCopy.probeFailed('Not allowed.'))
  put('soloGroupCopy.body', s.soloGroupCopy.body(url))

  // --- delivery feedback: the toolbar line and the banner, over every shape of result
  const results: Record<string, Parameters<typeof s.sendBanner>[0]> = {}
  for (const ok of [true, false]) {
    for (const queued of [false, true]) {
      for (const offline of [false, true]) {
        for (const count of [undefined, 1, 4]) {
          for (const targetLabel of [undefined, 'Pixel 9']) {
            for (const title of [undefined, 'A page']) {
              results[
                `ok${ok}/queued${queued}/offline${offline}/n${count ?? 'x'}/${targetLabel ?? 'nolabel'}/${title ? 'title' : 'notitle'}`
              ] = {
                ok,
                queued,
                offline,
                ...(targetLabel ? { targetLabel } : {}),
                ...(title ? { title, favicon: 'https://example.com/f.ico' } : {}),
                ...(count ? { count } : {}),
              }
            }
          }
        }
      }
    }
  }
  for (const [name, base] of Object.entries(results)) {
    put(`sendFeedbackLine/${name}`, s.sendFeedbackLine(base))
    put(`sendBanner/${name}`, s.sendBanner(base))
  }
  const failSample = failures().filter(
    (f) =>
      !f.name.startsWith('relay-rejected/new_reason') &&
      !f.name.startsWith('relay-rejected/expired_key') &&
      !f.name.startsWith('relay-error'),
  )
  for (const { name, failure } of failSample) {
    for (const count of [1, 3]) {
      for (const targetLabel of [undefined, 'Pixel 9']) {
        const base = {
          ok: false,
          queued: false,
          offline: false,
          failure,
          count,
          title: 'A page',
          ...(targetLabel ? { targetLabel } : {}),
        }
        const k = `${name}/n${count}/${targetLabel ?? 'nolabel'}`
        put(`sendFeedbackLine/failure/${k}`, s.sendFeedbackLine(base))
        put(`sendBanner/failure/${k}`, s.sendBanner(base))
      }
    }
  }
  for (const { name, failure } of failures().filter((f) => f.name.startsWith('relay-error'))) {
    put(
      `sendBanner/failure/${name}`,
      s.sendBanner({ ok: false, queued: false, offline: false, failure }),
    )
  }
  // A partial batch: some delivered, the rest refused, with and without a cap.
  for (const failure of [
    undefined,
    { kind: 'relay-rejected', reason: 'not_in_group' } as SendFailure,
    { kind: 'relay-rejected', reason: 'limit_reached', limit: 'queued_bytes' } as SendFailure,
    { kind: 'relay-rejected', reason: 'limit_reached' } as SendFailure,
  ]) {
    for (const [count, rejectedCount] of [
      [3, 1],
      [5, 2],
      [4, 4],
      [1, 1],
    ] as const) {
      const base = {
        ok: true,
        queued: false,
        offline: false,
        targetLabel: 'Pixel 9',
        title: 'A page',
        count,
        rejectedCount,
        ...(failure ? { failure } : {}),
      }
      const kind =
        failure?.kind === 'relay-rejected'
          ? `${failure.reason}/${failure.limit ?? 'no-limit'}`
          : 'none'
      const k = `${kind}/${count}/${rejectedCount}`
      put(`sendFeedbackLine/partial/${k}`, s.sendFeedbackLine(base))
      put(`sendBanner/partial/${k}`, s.sendBanner(base))
    }
  }

  put('neverArrivedBanner/1/title', s.neverArrivedBanner(1, 'Pixel 9', 'A page'))
  put('neverArrivedBanner/1', s.neverArrivedBanner(1, 'Pixel 9'))
  put('neverArrivedBanner/3', s.neverArrivedBanner(3, 'Pixel 9', 'A page'))
  put('sendingBanner/1', s.sendingBanner('Pixel 9'))
  put('sendingBanner/1/title', s.sendingBanner('Pixel 9', 'A page', 'https://example.com/f.ico'))
  put('sendingBanner/4', s.sendingBanner('Pixel 9', 'A page', undefined, 4))

  // --- a held tab whose device was removed
  const gt = s.goneTargetCopy
  for (const removedHere of [true, false]) {
    put(`goneTargetCopy.removedLine/${removedHere}/label`, gt.removedLine('Pixel 9', removedHere))
    put(`goneTargetCopy.removedLine/${removedHere}/nolabel`, gt.removedLine(undefined, removedHere))
    for (const count of [1, 3]) {
      for (const firstTitle of [undefined, 'A page']) {
        for (const targetLabel of [undefined, 'Pixel 9']) {
          put(
            `goneTargetCopy.banner/${removedHere}/n${count}/${firstTitle ? 'title' : 'notitle'}/${targetLabel ?? 'nolabel'}`,
            gt.banner(count, firstTitle, targetLabel, removedHere),
          )
        }
      }
    }
  }
  put('goneTargetCopy.sendTo', gt.sendTo)
  put('goneTargetCopy.sendToMenu', gt.sendToMenu)
  put('goneTargetCopy.noOtherDevice', gt.noOtherDevice)
  put('goneTargetCopy.sendToAria', gt.sendToAria('A page', 'Pixel 9'))

  // --- what a relay refusal says, by code and by what the person was doing
  for (const during of ACTIONS) {
    for (const code of [...CODES, 'something_new']) {
      put(`relayErrorLine/${during}/${code}`, relayErrorLine(code, during))
      put(
        `failureText/relay/${during}/${code}`,
        failureText(new ApiClientError(400, code, 'The relay wording that must not show.'), during),
      )
    }
    put(
      `failureText/no-envelope/${during}`,
      failureText(new ApiClientError(502, 'internal', 'x', true), during),
    )
    put(`failureText/offline/${during}`, failureText(new TypeError('Failed to fetch'), during))
    put(`failureText/unexpected/${during}`, failureText(new Error('boom'), during))
  }
  put('failureText/not-an-error', failureText('boom'))
  put('failureText/ours', failureText(new UserFacingError('Enter the relay address.')))
  return out
}

/** The words a person would have supplied in the fixtures above. */
export const FIXTURE_VALUES = [
  'Arc · Mac mini',
  'Pixel 9',
  'iPad',
  'Home PC',
  'A page',
  'A very long page title that keeps going and going and going on',
  'A window title that is much too long to fit in a notification',
  'Inbox (3) - Mail',
  'The relay is on fire.',
  'The relay said no',
  'Too many links.',
  'Enter the relay address.',
  'Not allowed.',
  'example.com',
  // Text the functions are given and pass on as it is.
  'not a url',
  'not a time',
  'soon',
]
