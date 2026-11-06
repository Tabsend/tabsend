import type {
  ApiErrorCode,
  BrowserNameSuggestion,
  GroupLimit,
  Platform,
  SendResponse,
} from '@tabsend/shared'
import { isHomeNetworkRelay, PLACEHOLDER_BROWSER_NAME } from '@tabsend/shared'
import { getLocale, t } from './i18n'
import type { InboxItem } from './model'
import { OUTBOUND_MAX_AGE_DAYS, OUTBOUND_MAX_ITEMS } from './outbound'
import { UserFacingError } from './relay-errors'

/** The relay's per-item refusal reasons [shared SendResponse.rejected]. */
export type SendRejectionReason = SendResponse['rejected'][number]['reason']

/**
 * Feedback copy — the strings from INTERACTION_FLOWS §4's copy table.
 *
 * Every sentence in this file lives in the message catalog (src/locales/<language>/*.json),
 * not here. These functions only choose WHICH message and hand it the names and counts;
 * how a count changes the wording ("this tab", "these tabs") is the message's own plural
 * rule, so a language with other plural forms needs no change in this file.
 *
 * Chunk 4 routes these through the action badge tooltip + the popup status line
 * (in-page content-script toasts are Chunk 5, which reuses THIS module verbatim).
 * Tone: lowercase-verb, device-named, no exclamation, no brand word — the copy
 * reads as the action, not the app (PRD §5A). The offline variant is the one
 * that matters most for reliability trust: it pre-empts "did it even send?" for
 * a target that's asleep [ADR-0008 / §3.8].
 */
export const feedbackCopy = {
  /** Sent, target online. */
  sentOnline: (label: string): string => t('send.sent', { count: 1, device: label }),
  /** Sent, target offline/asleep — the honest "queued" toast. */
  sentOffline: (label: string): string => t('send.sentQueued', { count: 1, device: label }),
  /** Multi-target, all online (P1; strings ready for Chunk 5). */
  sentMultiAll: (n: number): string => t('send.multi.all', { count: n }),
  /** Multi-target, some offline (P1). */
  sentMultiSome: (n: number, offline: number): string =>
    t('send.multi.some', { count: n, offline }),
  /** Source offline — held in the outbound queue, will send on reconnect. */
  sourceOffline: (): string => t('send.offline'),
  /** No devices paired yet (blind-fire/hotkey) → routes to onboarding. */
  noDevices: (): string => t('send.noDevices'),
  /** Hard error (unlinked/rejected) → routes to console. */
  hardError: (): string => t('send.hardError'),
} as const

/**
 * Why a send is not delivered. `browser-offline` and `relay-unreachable` are
 * both "held in the local outbound queue" outcomes — the tab is safe and will
 * retry — but they have DIFFERENT causes and different fixes, and collapsing
 * them into one "no connection" line is what made a dead self-hosted relay look
 * like a flaky laptop (see health.ts).
 */
export type SendFailure =
  /** This browser has no network at all. Nothing to fix but the wifi. */
  | { kind: 'browser-offline' }
  /** Network is up; the relay never answered. Names the address it tried. */
  | { kind: 'relay-unreachable'; relayUrl: string }
  /**
   * The relay took the request but refused this item (per-item reason set).
   *
   * `limit` rides along with `limit_reached` and names WHICH per-group cap said
   * no [0030], which is what lets the copy describe the wait instead of a
   * generic refusal. That one reason is also the only refusal here that is NOT
   * final: every cap clears itself, so the tab is held and retried exactly like
   * a `relay-busy` answer (see `isCapRejection`). The rest stay final.
   */
  | { kind: 'relay-rejected'; reason: SendRejectionReason; limit?: GroupLimit }
  /** The relay answered the whole request with an error envelope. */
  | { kind: 'relay-error'; code: ApiErrorCode }
  /**
   * The relay answered, but with something that says "not now" rather than "no":
   * a 429, or any 5xx — including the HTML 502/504 a reverse proxy or a
   * restarting container returns, which api.ts can only map to the generic
   * `internal` code.
   *
   * Recoverable, and that is the whole point of separating it from
   * `relay-error`: treating a 502 as a definite refusal DISCARDED the tab, and
   * in one drain of the outbound queue discarded every tab it was holding. A
   * relay that is merely having a bad minute must not cost anyone their links.
   */
  | { kind: 'relay-busy' }
  /** The relay no longer accepts this browser's token. */
  | { kind: 'relay-unauthorized' }
  /**
   * Tabsend itself stopped holding the tab. Not a thing the relay said — this is
   * the ONE failure the client decides on its own, which is why it is a
   * classification and not a wire code, and why `shared/src/types.ts` does not
   * grow a member for it.
   *
   * Final, and deliberately so: the queue kept the tab through every 429, every
   * 5xx and every silence, and this is what eventually ends that. `too-old` is
   * the relay's own message TTL running out; `queue-full` is the size cap making
   * room for the send the user just asked for. The two are told apart because
   * they are told to the user differently, and one sentence for both would be
   * false half the time.
   */
  | { kind: 'given-up'; reason: 'too-old' | 'queue-full' }
  /** The chosen target is gone from the group. */
  | { kind: 'no-target' }
  /** Nothing sendable in the current tab. */
  | { kind: 'no-tab' }

/**
 * One sentence saying what happened and, where there is one, what to do about
 * it. Used as the banner's status line and as the chooser's, so the same
 * diagnosis reaches the user whichever surface they sent from.
 *
 * NOTHING here may leak a wire code. `unknown_target` and `expired_key` are
 * things the relay says to a program; a person reading a banner needs to know
 * which device is affected and what to try, in a sentence they'd say out loud.
 * The target's name is threaded through for exactly that reason — "Arc isn't on
 * your relay any more" beats "Unknown target" every time.
 */
export function sendFailureLine(failure: SendFailure, targetLabel?: string, count = 1): string {
  // Every line below places `device` MID-sentence. A device label is a proper
  // noun ("Arc · Mac mini") but the no-label fallback is not, so a sentence that
  // opened with it would read "that device isn't…" — lowercase and wrong.
  const device = targetLabel ?? t('send.fallback.thatDevice')
  // `count` > 1 means the send was a multi-tab batch, so the held/refused thing
  // is "these tabs", not "this tab". The message says which, in its own plural.
  switch (failure.kind) {
    case 'browser-offline':
      return t('send.failure.browserOffline', { count })
    case 'relay-unreachable':
      return t('send.failure.relayUnreachable', { count, relayUrl: failure.relayUrl })
    case 'relay-rejected':
      return rejectionLine(failure.reason, device, count, failure.limit)
    case 'relay-error':
      return relayErrorLine(failure.code, device)
    case 'relay-busy':
      return t('send.failure.relayBusy', { count })
    case 'relay-unauthorized':
      return t('send.failure.unauthorized')
    case 'given-up':
      return givenUpLine(failure.reason, count)
    case 'no-target':
      return t('send.failure.noTarget', { device })
    case 'no-tab':
      return t('send.failure.noTab')
  }
}

/**
 * `sendFailureLine` for the banner drawn inside a web page. The same sentence,
 * except that it never names the relay's address: that is for Tabsend's own
 * pages, and any script on the page can read what the banner says
 * (SECURITY_REVIEW L8). The toolbar tooltip and the chooser keep the address.
 */
export function pageFailureLine(failure: SendFailure, targetLabel?: string, count = 1): string {
  if (failure.kind !== 'relay-unreachable') return sendFailureLine(failure, targetLabel, count)
  return t('send.failure.relayUnreachablePage', { count })
}

/**
 * The two ways Tabsend gives up on a tab it was holding.
 *
 * Both name the number that decided it, because the number is the only thing
 * that makes the sentence answerable: "it waited seven days" tells a self-hoster
 * their relay has been down for a week, and "at most 200" tells someone who sent
 * a whole window of tabs exactly what happened to the rest. Neither line names a
 * device, so all three clients say them verbatim and the §4c "this phone" /
 * "this browser" rule does not bite.
 */
function givenUpLine(reason: 'too-old' | 'queue-full', count: number): string {
  if (reason === 'too-old') {
    return t('send.failure.givenUp.tooOld', { count, days: OUTBOUND_MAX_AGE_DAYS })
  }
  return t('send.failure.givenUp.queueFull', { count, max: OUTBOUND_MAX_ITEMS })
}

/**
 * Per-item refusals [SendResponse.rejected] — always about ONE target.
 *
 * The `default` is the unknown-reason fallback Android and iOS have always had
 * (`SendFeedback.kt`, `SendFeedback.swift`) and this switch did not: a relay newer
 * than this browser sends reasons there is no copy for, and falling out of an
 * exhaustive switch returned `undefined` straight into the banner. `limit_reached`
 * [0030] was the first reason to reach it; it has its own copy now, written on all
 * three clients together (cross-client parity), and the fallback stays for the next.
 */
function rejectionLine(
  reason: SendRejectionReason,
  device: string,
  count = 1,
  limit?: GroupLimit,
): string {
  switch (reason) {
    case 'unknown_target':
      return t('send.failure.unknownTarget', { count, device })
    case 'expired_key':
      return t('send.failure.expiredKey', { device })
    case 'not_in_group':
      return t('send.failure.notInGroup', { device })
    case 'limit_reached':
      return capHeldLine(limit, count)
    default:
      return unexplainedLine()
  }
}

/**
 * A per-group cap refused the item [0030]. Said as a wait, not as a failure,
 * because every one of these caps clears itself: the send window rolls over
 * within a minute of the relay's own clock, and the queue caps drain as the
 * receiving device reads what is already waiting for it. The tab is in the same
 * local queue that holds tabs through an outage, and the same drain sends it.
 *
 * Named per cap because the two waits end for different reasons, and "shortly"
 * would be a lie about a queue that only moves when someone picks up their
 * phone. `endpoints` cannot refuse a send (it refuses a join), and a fifth cap
 * added later has no literal here, so both take the general line — which is true
 * of every cap and is why the relay may leave the field off entirely.
 *
 * Word-for-word the same sentences as `SendFeedback.kt` and `SendFeedback.swift`,
 * bar the plural, which only this client can produce (a multi-tab send).
 */
function capHeldLine(limit: GroupLimit | undefined, count: number): string {
  switch (limit) {
    case 'sends_per_window':
      return t('send.cap.pacing', { count })
    case 'queued_messages':
    case 'queued_bytes':
      return t('send.cap.holding', { count })
    default:
      return t('send.cap.general', { count })
  }
}

/** Said when the relay's answer is one this build has no sentence for. */
const unexplainedLine = (): string => t('send.failure.unexplained')

/**
 * The device cap turned this browser away at the door [0030]. Said in the
 * client's own words rather than passing the relay's prose through: `message` is
 * written for a log and is explicitly allowed to change (types.ts §10b), and
 * this is a banner.
 *
 * FINAL, which is what makes it read nothing like the cap lines above. A group
 * that is full stays full until a person removes a device, so there is no retry
 * to promise and the only useful sentence is the one naming the action. Nothing
 * is queued either — pairing never got as far as an identity on the relay.
 *
 * Word-for-word the same sentence as `SendFeedback.kt` and `SendFeedback.swift`.
 */
export const deviceLimitLine = (): string => t('send.failure.deviceLimit')

/** Whole-request errors [ApiError.code]. The relay answered, and said no. */
function relayErrorLine(code: ApiErrorCode, device: string): string {
  switch (code) {
    case 'not_found':
      return t('send.failure.error.notFound', { device })
    case 'forbidden':
      return t('send.failure.error.forbidden', { device })
    case 'invalid_request':
      return t('send.failure.error.invalidRequest')
    // classifySendFailure routes a 429 to `relay-busy`, which DOES retry itself,
    // so this is belt-and-braces for a relay that sends the code with some other
    // status. Asking for the retry is still the right instruction there: nothing
    // was queued, because nothing recognised the answer as "not now".
    case 'rate_limited':
      return t('send.failure.error.rateLimited')
    case 'internal':
      return unexplainedLine()
    // Both mean "your token is no good"; classifySendFailure routes them to
    // `relay-unauthorized` before they ever get here, so this is belt-and-braces.
    case 'unauthorized':
    case 'endpoint_removed':
      return t('send.failure.unauthorized')
    case 'invalid_pairing_code':
      return t('send.failure.error.invalidPairingCode')
    // Only ever answered to a register/create call [ADR-0022], never to a send;
    // it exists here so the switch stays exhaustive as the wire set grows.
    case 'group_exists':
      return t('send.failure.error.groupExists')
    // Not reachable on a send either: of the per-group caps, only the endpoint one
    // can refuse a whole call, and it does that to a join [0030]. Unlike the caps
    // that hold a send, this one does NOT clear itself — a device stays paired
    // until somebody removes it — so the line asks for the action instead of
    // promising a retry. The pairing mint can also answer `limit_reached` since
    // [0031 amended], and does NOT come through here: `classifyMintFailure` words it
    // as a mint (`relayErrorLine`, `pairingLink`), which is the one that names that limit.
    case 'limit_reached':
      return deviceLimitLine()
    // Same fallback as rejectionLine, and it should never be reached: health.ts
    // folds a code this build does not know down to `internal` before a failure is
    // built. It is here because the wire set grows (`limit_reached`, [0030]) and a
    // build that cannot compile is worse than one that says something general.
    default:
      return unexplainedLine()
  }
}

/** True when the tab is safely queued and will retry itself (no user action). */
export function isRecoverableFailure(failure: SendFailure): boolean {
  return (
    failure.kind === 'browser-offline' ||
    failure.kind === 'relay-unreachable' ||
    failure.kind === 'relay-busy' ||
    (failure.kind === 'relay-rejected' && isCapRejection(failure.reason))
  )
}

/**
 * The one per-item refusal that is not final [0030].
 *
 * A cap refusal is the relay saying "not this minute", not "no" — the send
 * window rolls over on its own, and the queue caps drain as the target reads its
 * tabs. Treating it as final threw away a tab over a wait of about a minute,
 * which is the same mistake `relay-busy` exists to prevent for a 429.
 *
 * Keyed on the REASON and never on `limit`: a relay that names no cap has still
 * said the same thing, and `capHeldLine` has a sentence for that.
 */
export function isCapRejection(reason: SendRejectionReason): boolean {
  return reason === 'limit_reached'
}

/**
 * The standing relay-outage line shown on surfaces the user opens LATER (the
 * chooser). Not tied to any one send — it answers "why did nothing arrive?"
 * for someone who has already walked away from the tab they sent.
 *
 * A relay on a home-network address gets one more sentence (PLANS.md P-15
 * item 4): away from home, that address cannot answer, and the bare outage line
 * read as a refresh bug. Same rule and words on Android, iOS and the console.
 */
export function relayDownLine(relayUrl: string, sinceMinutes: number): string {
  const ago =
    sinceMinutes < 1
      ? t('common.time.ago.now')
      : sinceMinutes < 60
        ? t('common.time.ago.minutes', { count: sinceMinutes })
        : t('common.time.ago.hours', { count: Math.round(sinceMinutes / 60) })
  return isHomeNetworkRelay(relayUrl)
    ? t('relay.down.homeNetwork', { relayUrl, ago })
    : t('relay.down', { relayUrl, ago })
}

/** "just now", "5m ago", "3h ago", "2d ago": the short relative time the device list uses. */
export function agoLine(iso: string, now: number): string {
  // A time the relay sent that cannot be read says "recently", like the phones do.
  if (Number.isNaN(Date.parse(iso))) return t('common.time.ago.recently')
  const mins = Math.max(0, Math.round((now - Date.parse(iso)) / 60000))
  if (mins < 1) return t('common.time.ago.now')
  if (mins < 60) return t('common.time.ago.minutes', { count: mins })
  const hours = Math.round(mins / 60)
  if (hours < 24) return t('common.time.ago.hours', { count: hours })
  return t('common.time.ago.days', { count: Math.round(hours / 24) })
}

/**
 * The "new device joined" notice (PLANS.md P-10). The same words on every
 * client; change them there first. The alert is posted once when a device is
 * spotted; the banner stays until the user answers it.
 */
export const newDeviceCopy = {
  // Told once, as information (P-23): a phone tells, or a browser when the group has no phone.
  alert(
    joined: readonly { label: string; createdAt: string }[],
    now: number,
  ): {
    title: string
    message: string
  } {
    const [first] = joined
    const labels = joined.map((j) => j.label)
    return {
      title: t('devices.added.title', { count: joined.length, device: first?.label ?? '' }),
      message: t('devices.added.message', {
        count: joined.length,
        ago: first ? agoLine(first.createdAt, now) : '',
        devices: listOfLabels(labels),
      }),
    }
  },
  /** A fresh pairing whose link did not vouch for every device already in the group. */
  firstListAlert(devices: readonly { label: string }[]): { title: string; message: string } {
    const [first] = devices
    return {
      title: t('devices.listed.title', { count: devices.length, device: first?.label ?? '' }),
      message: t('devices.listed.message', {
        count: devices.length,
        devices: listOfLabels(devices.map((d) => d.label)),
      }),
    }
  },
  // A device announced as new and then hidden from the list (GH7).
  vanishedTitle: (label: string): string => t('devices.vanished.title', { device: label }),
  vanishedBody: (createdAt: string, now: number): string =>
    t('devices.vanished.body', { ago: agoLine(createdAt, now) }),
  get vanishedDismiss(): string {
    return t('common.dismiss')
  },
}

/**
 * A device a send could not reach because the relay no longer has it (PLANS.md
 * P-20). Worded for any device, phone or browser: the cause is the same either
 * way (Tabsend removed or reinstalled there, or the device removed from the
 * group), and so is the fix (pair it again from here).
 */
export const unreachableCopy = {
  title: (label: string): string => t('devices.unreachable.title', { device: label }),
  get body(): string {
    return t('devices.unreachable.body')
  },
  pairAgain: (label: string): string => t('devices.unreachable.pairAgain', { device: label }),
  get dismiss(): string {
    return t('common.dismiss')
  },
  /** The device's row, when the list still shows it. */
  get rowStatus(): string {
    return t('devices.unreachable.rowStatus')
  },
  /** The toolbar icon's tooltip while the "!" is up. */
  tooltip: (labels: readonly string[]): string =>
    t('devices.unreachable.tooltip', { count: labels.length, device: labels[0] ?? '' }),
} as const

/** "October 27", in this browser's time zone. An unreadable time is shown as sent. */
export function monthDayLine(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString(getLocale(), { month: 'long', day: 'numeric' })
}

/** "3:05 PM", in this browser's time zone. ICU's narrow space before AM/PM made plain. */
export function clockLine(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d
    .toLocaleTimeString(getLocale(), { hour: 'numeric', minute: '2-digit' })
    .replace(/\s/g, ' ')
}

/**
 * The reset that waits (PLANS.md P-18 item 12). Word for word the same on Android,
 * iOS and the console: every paired device shows it, and any one can stop it.
 */
export const groupResetCopy = {
  get alertTitle(): string {
    return t('devices.reset.alertTitle')
  },
  alertMessage: (requestedAt: string): string =>
    t('devices.reset.alertMessage', { date: monthDayLine(requestedAt) }),
  get title(): string {
    return t('devices.reset.title')
  },
  body: (requestedAt: string, resetsAt: string): string =>
    t('devices.reset.body', {
      requestedDate: monthDayLine(requestedAt),
      resetsDate: monthDayLine(resetsAt),
      resetsTime: clockLine(resetsAt),
    }),
  get stop(): string {
    return t('devices.reset.stop')
  },
  get stopping(): string {
    return t('devices.reset.stopping')
  },
  get dismiss(): string {
    return t('devices.reset.dismiss')
  },
  get stopped(): string {
    return t('devices.reset.stopped')
  },
  get stopFailedOffline(): string {
    return t('devices.reset.stopFailedOffline')
  },
} as const

/**
 * "A", "A and B", "A, B and C": the parts of the list are catalog messages (two, start,
 * middle, end), the way CLDR builds a list, so each language joins in its own way.
 */
export function listOfLabels(labels: readonly string[]): string {
  const n = labels.length
  if (n <= 1) return labels.join('')
  const at = (i: number): string => labels[i] ?? ''
  if (n === 2) return t('common.list.two', { first: at(0), second: at(1) })
  let rest = t('common.list.end', { first: at(n - 2), second: at(n - 1) })
  for (let i = n - 3; i >= 1; i--) rest = t('common.list.middle', { first: at(i), second: rest })
  return t('common.list.start', { first: at(0), second: rest })
}

/**
 * The name filled in the device box on the setup page. The shared module (which the relay
 * and the other apps use too) keeps its English default; here the same words come from the
 * catalog, so a language can change them. A test keeps the English identical to the shared one.
 */
export function deviceNameSeed(platform: Platform): string {
  return t('firstrun.device.nameSeed', { platform })
}

/** The name filled in the browser box: the guess as it is, or the catalog's words when it is the blank-guess one. */
export function browserNameSeed(suggestion: BrowserNameSuggestion): string {
  return suggestion.value === PLACEHOLDER_BROWSER_NAME && !suggestion.confident
    ? t('firstrun.name.unknownBrowser')
    : suggestion.value
}

/** The chooser-only ⏳ pending row (INTERACTION_FLOWS §3.1). */
export function pendingRow(count: number, label: string): string {
  return t('chooser.pending.row', { count, device: label })
}

/**
 * Where someone actually goes to get a relay running. Every shipped surface that
 * says "set one up" resolves its link from HERE, so there is one place to change.
 *
 * Shipped copy must never name a repo-relative path (this used to say
 * `docs/reports/chunk-4.md`): a user who installed from a store has no checkout
 * to open it in, and an internal build-report filename reads as a dead end at the
 * exact moment they're already stuck (dogfood 2026-07-29).
 *
 * TODO(hosted-docs): point at the hosted self-hosting guide once it exists, and
 * re-read the surfaces below with it — the wording assumes a GitHub file today.
 * Surface: humanRegisterError (identity.ts). Tracked in docs/ROADMAP.md,
 * Phase 3.
 */
export const SETUP_DOCS_URL = 'https://github.com/Tabsend/tabsend/blob/main/docs/DEPLOY.md'

/**
 * Heading for the list of tabs still sitting on THIS browser because the relay
 * hasn't taken them. Distinct from the ⏳ row above, which counts tabs the relay
 * already HAS and is holding for a sleeping target — that's a different promise,
 * and merging them would make an outage look like a normal sleeping device.
 */
export function heldTabsHeading(count: number): string {
  return t('chooser.held.heading', { count })
}

/**
 * What to call a held tab in a list. The title is what the user recognises; the
 * site is the fallback when a tab had no title, because a bare URL path tells
 * nobody anything.
 */
export function heldTabLabel(item: { title?: string; url?: string }): string {
  if (item.title && item.title.trim() !== '') return item.title
  if (!item.url) return t('common.untitledTab')
  try {
    return new URL(item.url).hostname
  } catch {
    return item.url
  }
}

/**
 * The receive-side pop-up notification's title line [P-7 addendum]. Names the
 * sender, same as the badge tooltip and the inbox row below it, rather than
 * the page title — "who sent this" is the fact worth a glance from an OS
 * notification; the tab itself is one click away either way.
 */
export function receivedNotificationLine(items: InboxItem[]): string {
  const n = items.length
  const senders = new Set(items.map((i) => i.sourceLabel))
  if (senders.size === 1) {
    const label = items[0]?.sourceLabel ?? t('common.aDevice')
    return t('notify.received.fromOne', { count: n, device: label })
  }
  return t('notify.received.fromMany', { count: n, devices: senders.size })
}

/**
 * Where a received tab landed, as far as the worker could tell when it posted
 * the notification. `window` names the window by the title of the tab showing
 * in it, because that is the one thing about a window a person recognises.
 */
export type ArrivalPlace =
  /** The only normal window there is: "which window" needs no answer. */
  | { kind: 'only-window' }
  /** One of several windows, recognisable by its showing tab's title. */
  | { kind: 'window'; activeTitle: string }
  /** Could not tell (no tab id, a lookup failed, nothing worth naming). */
  | { kind: 'unknown' }

/** Long titles make notifications wrap or clip mid-word; cut them ourselves. */
export function shortTitle(title: string, max: number): string {
  const t = title.trim().replace(/\s+/g, ' ')
  if (t.length <= max) return t
  return `${t.slice(0, max - 1).trimEnd()}…`
}

const ARRIVAL_TITLE_MAX = 48
const WINDOW_TITLE_MAX = 40

/**
 * The body of the arrival notification, under `receivedNotificationLine` as
 * its title: WHAT arrived and WHERE it went [owner report 2026-10-07: tabs
 * "arrive in a new tab in a random window … nothing helping me learn that, or
 * where, the tab arrived"]. A multi-tab batch keeps the count wording of the
 * title line, and the click goes to the first of them.
 */
export function arrivalPlaceLine(items: InboxItem[], place: ArrivalPlace): string {
  const n = items.length
  const first = items[0]
  const title = n === 1 && first ? shortTitle(heldTabLabel(first), ARRIVAL_TITLE_MAX) : ''
  switch (place.kind) {
    case 'window':
      return t('notify.arrival.window', {
        count: n,
        title,
        windowTitle: shortTitle(place.activeTitle, WINDOW_TITLE_MAX),
      })
    case 'only-window':
      return t('notify.arrival.background', { count: n, title })
    case 'unknown':
      return t('notify.arrival.newTab', { count: n, title })
  }
}

/** Confirmation that the queue drained, naming the tab when there's just one. */
export function recoveredLine(count: number, firstTitle?: string): string {
  return t('send.recovered', {
    count,
    hasTitle: firstTitle ? 'yes' : 'no',
    title: firstTitle ?? '',
  })
}

/**
 * The other half of `recoveredLine`: the relay finally answered about a held tab
 * and the answer was no, so it left the queue unsent.
 *
 * Said out loud for the same reason the queue exists at all — the user was told
 * "waiting to send" and walked away. A tab that then dies on a 401 or a
 * `not_in_group` when the relay comes back would otherwise vanish with nothing
 * said, which is the original invisible-failure bug with a longer fuse.
 */
export function droppedLine(count: number, firstTitle?: string): string {
  return t('send.dropped', { count, hasTitle: firstTitle ? 'yes' : 'no', title: firstTitle ?? '' })
}

/**
 * Why "show me a pairing link" failed, in words the user can act on.
 *
 * Minting is the ONE pairing step that needs a live relay round-trip — the code
 * is issued by the relay, not made up locally — while every other surface
 * (chooser rows, device list, settings) falls back to cached state and keeps
 * rendering. So when the relay is down, pairing is the only thing that breaks,
 * and a generic "Failed to fetch" would leave the user with no idea why
 * (dogfood 2026-07-24: the button simply did nothing, on every surface).
 */
export function pairingErrorLine(cause: PairingFailure): string {
  switch (cause.kind) {
    case 'unregistered':
      return t('pairing.error.unregistered')
    case 'unreachable':
      return t('pairing.error.unreachable', { relayUrl: cause.relayUrl })
    case 'unauthorized':
      return t('pairing.error.unauthorized')
    case 'relay':
      return t('pairing.error.relay', { detail: cause.detail })
  }
}

/**
 * The warning shown next to a QR whose relay URL is loopback.
 *
 * The code is honest — it points at exactly the relay this browser is connected
 * to — but that relay is only reachable from this one machine, so the QR is a
 * dead end for every device that would actually scan it (dogfood 2026-07-27).
 */
export function pairingLocalOnlyLine(relayUrl: string): string {
  return t('pairing.localOnly', { relayUrl })
}

/** Explain the two deliberate doors on a self-signed LAN relay. */
export function pairingRoutesLine(browserRelayUrl: string, nativeRelayUrl: string): string {
  return t('pairing.routes', { browserRelayUrl, nativeRelayUrl })
}

/**
 * Thrown by every background path that needs a registration and hasn't got one.
 * A settings tab that was registered when it loaded has to tell this apart from a
 * relay-side refusal, and re-render itself instead of printing an internal
 * sentence at a user who can do nothing with it (dogfood 2026-08-05). The pages
 * match on the sentence (`isNotRegistered`), which works because the background
 * and the pages read the same browser language.
 */
export class NotRegisteredError extends UserFacingError {
  constructor() {
    super(notRegisteredLine())
    this.name = 'NotRegisteredError'
  }
}

export const notRegisteredLine = (): string => t('errors.notRegistered')

/** True for the error `NotRegisteredError` raised, once it has crossed to a page as text. */
export function isNotRegistered(err: unknown): boolean {
  // relay-text-ignore: compared with our own sentence, never shown
  return err instanceof Error && err.message === notRegisteredLine()
}

/** Why a pairing mint failed, classified where the relay URL and error type are known. */
export type PairingFailure =
  | { kind: 'unregistered' }
  | { kind: 'unreachable'; relayUrl: string }
  | { kind: 'unauthorized' }
  | { kind: 'relay'; detail: string }

/**
 * Copy for the merged relay flow (options → "Where is your relay now?").
 *
 * The panel asks for ONE address and `probeRelay` classifies it, so none of these
 * lines has to teach the same-relay/different-relay distinction up front. Each
 * one reports a finding about the address just typed; the button beside it is
 * the matching action. That replaced ~150 words of standing explanation the user
 * had to read and apply correctly before the app would tell them what it already
 * knew (dogfood 2026-07-29).
 *
 * Each line leaves the word its button already carries ("address") to
 * the button, so the pair doesn't repeat itself. No em dashes: short sentences
 * instead, so the fix is legible split across the icon + text row in a boxed
 * callout rather than one long run-on line.
 */
export const relayProbeCopy = {
  /** Our relay, new URL. The reassurance IS the message. */
  same: (): string => t('relay.probe.same'),
  /** Same, but one side predates relayId — say so rather than imply proof. */
  sameUnverified: (): string => t('relay.probe.sameUnverified'),
  /** A relay that has never heard of us. Name the cost, don't moralise about it. */
  different: (): string => t('relay.probe.different'),
  /** Nothing answered. */
  unreachable: (relayUrl: string): string => t('relay.probe.unreachable', { relayUrl }),
  /**
   * Answered, unusable (protocol mismatch or a relay-side error). `detail` is already a
   * whole sentence from the catalog (`failureText`), never the relay's own text.
   */
  error: (detail: string): string => detail,
  /** Committed the address change. */
  updated: (relayUrl: string): string => t('relay.probe.updated', { relayUrl }),
  /**
   * The panel was asked to move an address this browser no longer has. Reachable
   * on a settings tab left open while the pairing ended somewhere else (another
   * tab finished a move, or another device removed this one). It used to surface
   * the raw internal "Tabsend is not registered yet.", which named no cause and
   * offered no way out (dogfood 2026-08-05), so it names both.
   */
  notPaired: (): string => t('relay.probe.notPaired'),
} as const

/**
 * The browser's own permission to reach the relay (`relay-access.ts`). Asked for
 * once, at pairing; these lines cover a "no" there, and a grant that was later
 * taken away in the browser's settings, which looks to the extension exactly
 * like a relay that stopped answering.
 */
export const relayAccessCopy = {
  /** The user said no to the browser's prompt. */
  denied: (): string => t('relay.access.denied'),
  /** Paired, but the permission is missing. */
  missing: (relayUrl: string): string => t('relay.access.missing', { relayUrl }),
  /** Settings button that asks again. */
  get allow(): string {
    return t('relay.access.allow')
  },
  /** Popup button: the browser asks from Settings, not from a popup that closes. */
  get openSettings(): string {
    return t('relay.access.openSettings')
  },
} as const

/**
 * The relay move while it is in flight, on both surfaces that show it.
 *
 * Choosing a different relay used to unpair immediately and hand the user to
 * onboarding, which meant backing out of setup left the browser with no relay at
 * all and no route back (dogfood 2026-08-05). The move is now just an intention
 * until the new relay grants a registration, so the copy's job is to say which
 * relay is which, and what the finish costs.
 */
export const relaySwitchCopy = {
  /** Settings, with a move recorded and not finished. */
  pending: (relayUrl: string): string => t('relay.switch.pending', { relayUrl }),
  /** ...and the reassurance that matters: nothing has been given up yet. */
  pendingSafe: (currentRelayUrl: string): string =>
    t('relay.switch.pendingSafe', { relayUrl: currentRelayUrl }),
  /** ...when there is no current relay to fall back on (an older interrupted move). */
  pendingUnpaired: (): string => t('relay.switch.pendingUnpaired'),
  /** Onboarding, arriving from settings with a relay already chosen. */
  target: (relayUrl: string): string => t('relay.switch.target', { relayUrl }),
  /** ...spelling out the one-way step, at the screen where it is about to happen. */
  cost: (currentRelayUrl: string): string => t('relay.switch.cost', { relayUrl: currentRelayUrl }),
  /** ...the way out, named after what it keeps rather than what it abandons. */
  keep: (currentRelayUrl: string): string => t('relay.switch.keep', { relayUrl: currentRelayUrl }),
  /** The pre-filled link is the one they pasted, and codes are single-use. */
  reusedLink: (): string => t('relay.switch.reusedLink'),
} as const

/**
 * Failures of the COMMIT step (`changeRelayUrl`). With the probe running first
 * these are near-unreachable: they fire when the world changed between the check
 * and the click (the relay restarted on an empty database, say). Kept short: the
 * panel above them already carries the context, and nothing was changed.
 */
export const relayChangeCopy = {
  unreachable: (relayUrl: string): string => t('relay.change.unreachable', { relayUrl }),
  differentRelay: (): string => t('relay.change.differentRelay'),
  tokenRejected: (): string => t('relay.change.tokenRejected'),
  probeFailed: (detail: string): string => t('relay.change.probeFailed', { detail }),
} as const

/**
 * The manage screen's "this browser is alone in its group" notice.
 *
 * Shown only once the group has stopped being brand-new (policy.ts
 * `shouldWarnSoloGroup`), because being alone is the normal state for the few
 * minutes between creating a group and pairing the second device.
 *
 * Styled and worded like the options.html relay-probe verdict (same redesign,
 * dogfood 2026-07-29): one finding, one action, no standing paragraph teaching
 * same-relay-vs-different-relay up front. That distinction is exactly what the
 * "Check the relay address" button now goes and resolves for the user instead
 * of asking them to reason about it here.
 */
export const soloGroupCopy = {
  body: (relayUrl: string): string => t('relay.solo.body', { relayUrl }),
} as const

/**
 * Pick the delivery-feedback line for a completed single send — the badge
 * tooltip's one-liner. When the result carries a classified `failure` that line
 * IS the diagnosis, so the tooltip names the relay instead of blaming the wifi.
 */
export function sendFeedbackLine(result: {
  ok: boolean
  queued: boolean
  offline: boolean
  targetLabel?: string
  failure?: SendFailure
  count?: number
  rejectedCount?: number
}): string {
  const label = result.targetLabel ?? t('send.fallback.device')
  const n = result.count ?? 1
  // A partial batch outweighs its failure line: "Sent 2 of 3" carries both the
  // delivery and the refusal, where the bare rejection line would deny the 2.
  if (partiallySent(result)) {
    const rejected = result.rejectedCount ?? 0
    return t('send.partial.line', {
      headline: partialHeadline(n, rejected, label),
      detail: partialDetail(rejected, result.failure),
    })
  }
  if (result.failure) return sendFailureLine(result.failure, result.targetLabel, n)
  if (!result.ok) return feedbackCopy.hardError()
  if (result.offline) return feedbackCopy.sourceOffline()
  return result.queued
    ? t('send.sentQueued', { count: n, device: label })
    : t('send.sent', { count: n, device: label })
}

/** True when a batch send delivered some tabs and had the rest refused. */
function partiallySent(result: { ok: boolean; count?: number; rejectedCount?: number }): boolean {
  const n = result.count ?? 1
  const rejected = result.rejectedCount ?? 0
  return result.ok && n > 1 && rejected > 0 && rejected < n
}

/** "Sent 2 of 3 tabs to Arc" — the delivered half of a partial batch. */
function partialHeadline(count: number, rejected: number, label: string): string {
  return t('send.partial.headline', { count, sent: count - rejected, device: label })
}

/**
 * The refused half of a partial batch. Normally "The relay refused 1." — the
 * count is what says how many to resend.
 *
 * A cap refusal is the exception [0030]: those tabs are queued and send
 * themselves, so naming a count the user would go and resend by hand would be
 * both wrong and extra work. The cap line says what is happening instead.
 */
function partialDetail(rejected: number, failure?: SendFailure): string {
  if (failure?.kind === 'relay-rejected' && isCapRejection(failure.reason)) {
    return capHeldLine(failure.limit, rejected)
  }
  return t('send.partial.refused', { count: rejected })
}

/**
 * The full feedback banner for a send (INTERACTION_FLOWS §4, extended). Three
 * tones — and the split between them is a promise, not decoration:
 *
 *  - `success` — the relay ACCEPTED the tab. Only
 *    this tone is allowed to say "Sent".
 *  - `pending` — the tab is safe locally but nobody has accepted it yet. Says
 *    "Waiting to send", because claiming "Sent" here is the exact lie that made
 *    a dead relay invisible.
 *  - `error` — it is not going to happen without the user doing something.
 *
 * `title` is the page title, so the banner says *which* tab — the thing a bare
 * "Sent to Arc" never told you when several sends were in flight.
 */
export interface SendBanner {
  tone: 'success' | 'pending' | 'error'
  headline: string
  /**
   * The page title being sent (omitted when unknown). Rendered as an identity
   * row — favicon + title — NOT as another sentence: styled like the status
   * line below it, a title such as "Setting up a LAN relay" reads as part of
   * the explanation rather than as the name of the tab that's moving.
   */
  title?: string
  /** Favicon of the tab, shown beside `title` so the row reads as a page. */
  favicon?: string
  /** Last line: the honest caveat or the diagnosis. */
  detail?: string
  /**
   * `detail` as the in-page banner says it, when `detail` holds something a web
   * page must not read (the relay's address, L8). Absent when they are the same.
   */
  pageDetail?: string
}

export function sendBanner(result: {
  ok: boolean
  queued: boolean
  offline: boolean
  targetLabel?: string
  title?: string
  favicon?: string
  failure?: SendFailure
  count?: number
  rejectedCount?: number
}): SendBanner {
  const label = result.targetLabel ?? t('send.fallback.yourDevice')
  const n = result.count ?? 1
  // On a batch the headline counts the tabs; the title line still names the
  // first one, same pattern as the recovered-queue toast.
  const withTitle = (banner: SendBanner): SendBanner => {
    if (!result.title) return banner
    const withIt: SendBanner = { ...banner, title: result.title }
    if (result.favicon) withIt.favicon = result.favicon
    return withIt
  }

  // A partial batch first: "Sent 2 of 3" is neither the failure line (which
  // would deny the 2) nor a clean success (which would deny the refusal). Error
  // tone, because the refused tabs will NOT retry themselves — resending is on
  // the user, and amber would promise otherwise.
  //
  // Unless the refusal was a cap [0030], which IS retried: those tabs are in the
  // outbound queue and the next drain sends them, so the tone stays pending and
  // nobody is told to do work the client is already doing.
  if (partiallySent(result)) {
    const rejected = result.rejectedCount ?? 0
    const held = result.failure !== undefined && isRecoverableFailure(result.failure)
    return withTitle({
      tone: held ? 'pending' : 'error',
      headline: partialHeadline(n, rejected, label),
      detail: partialDetail(rejected, result.failure),
    })
  }
  if (result.failure) {
    const recoverable = isRecoverableFailure(result.failure)
    const waiting = t('send.banner.waiting', { count: n, device: label })
    const failed = t('send.banner.failed', { count: n, device: label })
    const detail = sendFailureLine(result.failure, result.targetLabel, n)
    const pageDetail = pageFailureLine(result.failure, result.targetLabel, n)
    return withTitle({
      tone: recoverable ? 'pending' : 'error',
      headline: recoverable ? waiting : failed,
      detail,
      ...(pageDetail === detail ? {} : { pageDetail }),
    })
  }
  if (!result.ok) {
    return withTitle({
      tone: 'error',
      headline: t('send.banner.failed', { count: n, device: label }),
      detail: feedbackCopy.hardError(),
    })
  }
  const sent = t('send.sent', { count: n, device: label })
  if (result.queued) {
    return withTitle({
      tone: 'success',
      headline: sent,
      detail: t('send.sentQueued.detail', { count: n }),
    })
  }
  return withTitle({ tone: 'success', headline: sent })
}

/**
 * "You were told this was sent, and it never got there" [ADR-0028 §8].
 *
 * The one outcome no surface could report before group history existed: the
 * relay accepted the tab, so the send genuinely succeeded by ADR-0008's
 * definition, and then its TTL ran out with the target never acking it. Error
 * tone, because it will not fix itself and re-sending is the user's move.
 *
 * The detail names WHERE the tab still is, because it is the only reassuring
 * part of the sentence: nothing is lost, the record is on the history page and
 * the tab can go again from there.
 */
export function neverArrivedBanner(count: number, targetLabel: string, title?: string): SendBanner {
  const banner: SendBanner = {
    tone: 'error',
    headline: t('send.neverArrived.headline', { count, device: targetLabel }),
    detail: t('send.neverArrived.detail', { count }),
  }
  // Only when a single tab is named. On a batch the headline counts them and a
  // lone title would read as if that one tab were the whole story.
  if (count === 1 && title) banner.title = title
  return banner
}

/** The optimistic banner shown during the quick-send undo window. */
export function sendingBanner(
  targetLabel: string,
  title?: string,
  favicon?: string,
  count = 1,
): SendBanner {
  const banner: SendBanner = {
    tone: 'pending',
    headline: t('send.sending', { count, device: targetLabel }),
  }
  if (!title) return banner
  return { ...banner, title, ...(favicon ? { favicon } : {}) }
}

/**
 * The chooser's variant-A strip when several tabs are highlighted: no new
 * controls, every device row sends the whole selection, and this line is the
 * only thing that says so — so it must say it plainly.
 */
export function multiSelectionLine(count: number): string {
  return t('chooser.multi', { count })
}

/**
 * A held tab whose device was removed from the group (PLANS.md P-15 item 3).
 * Its own block so it stays clear of the other P-15 copy. Said the same way by
 * Android (`GoneTargetCopy.kt`) and iOS (`GoneTargetCopy.swift`).
 *
 * The tab is not lost: it is still held here, and the user picks where it goes
 * next. So the words say what happened and what to do, never "failed".
 */
export const goneTargetCopy = {
  /**
   * The line under the held tab, in place of "→ <device>". "Was removed" only
   * when this browser removed it: otherwise all it knows is that the device is
   * not in the group it accepts, which a relay can arrange (SECURITY_REVIEW L3).
   */
  removedLine(targetLabel: string | undefined, removedHere: boolean): string {
    return t('send.gone.removed', {
      device: targetLabel ?? t('send.gone.fallbackDevice', { count: 1 }),
      removedHere: removedHere ? 'yes' : 'no',
    })
  },
  /** Before the device buttons, or as the first option of the menu. */
  get sendTo(): string {
    return t('send.gone.sendTo')
  },
  get sendToMenu(): string {
    return t('send.gone.sendToMenu')
  },
  /** No other device the tab can go to: this one, or devices still waiting for an answer. */
  get noOtherDevice(): string {
    return t('send.gone.noOtherDevice')
  },
  /** Spoken name of one device button. */
  sendToAria(tabLabel: string, deviceLabel: string): string {
    return t('send.gone.sendToAria', { tab: tabLabel, device: deviceLabel })
  },
  /**
   * The drain found the device gone. The tab was promised to send itself, and
   * now it will not, so this is said once, out loud, like any withdrawn promise.
   * `removedHere` is judged on the first tab, the one the banner names.
   */
  banner(
    count: number,
    firstTitle: string | undefined,
    targetLabel: string | undefined,
    removedHere: boolean,
  ): SendBanner {
    const headline = t('send.gone.headline', {
      count,
      hasTitle: firstTitle ? 'yes' : 'no',
      title: firstTitle ?? '',
    })
    const detail = t('send.gone.detail', {
      count,
      device: targetLabel ?? t('send.gone.fallbackDevice', { count }),
      removedHere: removedHere ? 'yes' : 'no',
    })
    return { tone: 'pending', headline, detail }
  },
}
