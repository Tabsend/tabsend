import type { ApiErrorCode, GroupLimit, SendResponse } from '@tabsend/shared'
import type { InboxItem } from './model'
import { OUTBOUND_MAX_AGE_DAYS, OUTBOUND_MAX_ITEMS } from './outbound'

/** The relay's per-item refusal reasons [shared SendResponse.rejected]. */
export type SendRejectionReason = SendResponse['rejected'][number]['reason']

/**
 * Feedback copy — the exact strings from INTERACTION_FLOWS §4's copy table.
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
  sentOnline: (label: string): string => `Sent to ${label}`,
  /** Sent, target offline/asleep — the honest "queued" toast. */
  sentOffline: (label: string): string => `Sent to ${label} — opens when it wakes`,
  /** Multi-target, all online (P1; strings ready for Chunk 5). */
  sentMultiAll: (n: number): string => `Sent to ${n} devices`,
  /** Multi-target, some offline (P1). */
  sentMultiSome: (n: number, offline: number): string =>
    `Sent to ${n} devices — ${offline} opens when it wakes`,
  /** Source offline — held in the outbound queue, will send on reconnect. */
  sourceOffline: (): string => "No connection — will send when you're back online",
  /** No devices paired yet (blind-fire/hotkey) → routes to onboarding. */
  noDevices: (): string => 'No devices yet — pair one to start sending',
  /** Hard error (unlinked/rejected) → routes to console. */
  hardError: (): string => "Couldn't send — check Tabsend is still linked",
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
  const device = targetLabel ?? 'that device'
  // `count` > 1 means the send was a multi-tab batch, so the held/refused thing
  // is "these tabs", not "this tab". Only the lines that name the tab change.
  const several = count > 1
  switch (failure.kind) {
    case 'browser-offline':
      return several
        ? "You're offline. These tabs send themselves as soon as you're back."
        : "You're offline. This tab sends itself as soon as you're back."
    case 'relay-unreachable':
      return several
        ? `Can't reach your relay at ${failure.relayUrl}. The tabs are held here and send themselves once the relay answers again.`
        : `Can't reach your relay at ${failure.relayUrl}. The tab is held here and sends itself once the relay answers again.`
    case 'relay-rejected':
      return rejectionLine(failure.reason, device, several, failure.limit)
    case 'relay-error':
      return relayErrorLine(failure.code, device)
    case 'relay-busy':
      return several
        ? 'Your relay is having trouble right now. The tabs are held here and send themselves once the relay is answering properly again.'
        : 'Your relay is having trouble right now. The tab is held here and sends itself once the relay is answering properly again.'
    case 'relay-unauthorized':
      return `Your relay doesn't recognise this browser any more. Set Tabsend up again here to start sending.`
    case 'given-up':
      return givenUpLine(failure.reason, several)
    case 'no-target':
      return `Tabsend can't find ${device} in your list of devices any more.`
    case 'no-tab':
      return "There's nothing to send from this tab."
  }
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
function givenUpLine(reason: 'too-old' | 'queue-full', several: boolean): string {
  if (reason === 'too-old') {
    return several
      ? `These tabs waited ${OUTBOUND_MAX_AGE_DAYS} days for your relay and were never taken, so Tabsend has stopped holding them. Send them again once the relay is answering.`
      : `This tab waited ${OUTBOUND_MAX_AGE_DAYS} days for your relay and was never taken, so Tabsend has stopped holding it. Send it again once the relay is answering.`
  }
  return several
    ? `Tabsend holds at most ${OUTBOUND_MAX_ITEMS} tabs while your relay isn't taking them, and these were the oldest. Send them again once the relay is answering.`
    : `Tabsend holds at most ${OUTBOUND_MAX_ITEMS} tabs while your relay isn't taking them, and this one was the oldest. Send it again once the relay is answering.`
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
  several = false,
  limit?: GroupLimit,
): string {
  switch (reason) {
    case 'unknown_target':
      return `Your relay doesn't know ${device} any more. Pair it again, then send ${several ? 'these tabs' : 'this tab'} a second time.`
    case 'expired_key':
      return `The keys on ${device} have changed since this browser last saw them. Open the Tabsend list once to pick up the new ones, then send again.`
    case 'not_in_group':
      return `Your relay says ${device} has left your group of devices.`
    case 'limit_reached':
      return capHeldLine(limit, several)
    default:
      return UNEXPLAINED_LINE
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
function capHeldLine(limit: GroupLimit | undefined, several: boolean): string {
  switch (limit) {
    case 'sends_per_window':
      return several
        ? 'Your relay is pacing sends for your group right now. These tabs are queued and will send themselves shortly.'
        : 'Your relay is pacing sends for your group right now. This tab is queued and will send itself shortly.'
    case 'queued_messages':
    case 'queued_bytes':
      return several
        ? "Your relay is holding as much as your group's limit allows. These tabs are queued and will send once the receiving device catches up."
        : "Your relay is holding as much as your group's limit allows. This tab is queued and will send once the receiving device catches up."
    default:
      return several
        ? 'Your relay has reached a limit for your group. These tabs are queued and will send themselves once there is room.'
        : 'Your relay has reached a limit for your group. This tab is queued and will send itself once there is room.'
  }
}

/** Said when the relay's answer is one this build has no sentence for. */
const UNEXPLAINED_LINE =
  'Something went wrong inside your relay. It may be worth checking that it is healthy.'

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
export const DEVICE_LIMIT_LINE =
  'Your relay has reached its device limit for your group. Remove a device you are not using, then pair this one again.'

/** Whole-request errors [ApiError.code]. The relay answered, and said no. */
function relayErrorLine(code: ApiErrorCode, device: string): string {
  switch (code) {
    case 'not_found':
      return `Your relay couldn't find ${device}.`
    case 'forbidden':
      return `Your relay wouldn't let this browser send to ${device}.`
    case 'invalid_request':
      return "Your relay didn't understand this send. It's most likely running an older version than this browser. Updating it should fix this."
    // classifySendFailure routes a 429 to `relay-busy`, which DOES retry itself,
    // so this is belt-and-braces for a relay that sends the code with some other
    // status. Asking for the retry is still the right instruction there: nothing
    // was queued, because nothing recognised the answer as "not now".
    case 'rate_limited':
      return 'Your relay is busy right now. Give it a moment and send again.'
    case 'internal':
      return UNEXPLAINED_LINE
    // Both mean "your token is no good"; classifySendFailure routes them to
    // `relay-unauthorized` before they ever get here, so this is belt-and-braces.
    case 'unauthorized':
    case 'endpoint_removed':
      return `Your relay doesn't recognise this browser any more. Set Tabsend up again here to start sending.`
    case 'invalid_pairing_code':
      return 'That pairing link is no longer valid.'
    // Only ever answered to a register/create call [ADR-0022], never to a send;
    // it exists here so the switch stays exhaustive as the wire set grows.
    case 'group_exists':
      return 'Your relay already hosts a group of devices.'
    // Not reachable on a send either: of the per-group caps, only the endpoint one
    // can refuse a whole call, and it does that to a join [0030]. Unlike the caps
    // that hold a send, this one does NOT clear itself — a device stays paired
    // until somebody removes it — so the line asks for the action instead of
    // promising a retry. The pairing mint can also answer `limit_reached` since
    // [0031 amended], and does NOT come through here: `classifyMintFailure` shows
    // the relay's own message verbatim, which is the one that names that limit.
    case 'limit_reached':
      return DEVICE_LIMIT_LINE
    // Same fallback as rejectionLine, and it should never be reached: health.ts
    // folds a code this build does not know down to `internal` before a failure is
    // built. It is here because the wire set grows (`limit_reached`, [0030]) and a
    // build that cannot compile is worse than one that says something general.
    default:
      return UNEXPLAINED_LINE
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
 */
export function relayDownLine(relayUrl: string, sinceMinutes: number): string {
  const ago =
    sinceMinutes < 1
      ? 'just now'
      : sinceMinutes < 60
        ? `${sinceMinutes}m ago`
        : `${Math.round(sinceMinutes / 60)}h ago`
  return `Can't reach your relay at ${relayUrl}. It last answered ${ago}, and sends are being held until it's back.`
}

/** "just now", "5m ago", "3h ago", "2d ago": the short relative time the device list uses. */
export function agoLine(iso: string, now: number): string {
  // A time the relay sent that cannot be read says "recently", like the phones do.
  if (Number.isNaN(Date.parse(iso))) return 'recently'
  const mins = Math.max(0, Math.round((now - Date.parse(iso)) / 60000))
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

/**
 * The "new device joined" notice (PLANS.md P-10). The same words on every
 * client; change them there first. The alert is posted once when a device is
 * spotted; the banner stays until the user answers it.
 */
export const newDeviceCopy = {
  alert(
    joined: readonly { label: string; createdAt: string }[],
    now: number,
  ): {
    title: string
    message: string
  } {
    const [first] = joined
    if (joined.length === 1 && first) {
      return {
        title: `New device: ${first.label}`,
        message: `Joined your Tabsend devices ${agoLine(first.createdAt, now)}. Was this you? If not, remove it.`,
      }
    }
    return {
      title: `${joined.length} new devices joined`,
      message: `${listOfLabels(joined.map((j) => j.label))}. Were these you? If not, remove them.`,
    }
  },
  bannerTitle: (label: string): string => `New device: ${label}`,
  bannerBody: (createdAt: string, now: number): string =>
    `Joined ${agoLine(createdAt, now)}. Was this you? If it isn't yours, remove it. It could read the links you send.`,
  confirm: "Yes, it's mine",
  remove: 'Remove it',
  // The first look (GH6): one card, asked once, when this browser first sees the group.
  reviewTitle: 'Check your devices',
  reviewBody:
    "Your group has these devices. A device you don't know could read the links you send, so remove it.",
  reviewRemove: 'Remove',
  /** The accessible name of one row's Remove, so a screen reader does not say "Remove, Remove". */
  reviewRemoveLabel: (label: string): string => `Remove ${label}`,
  reviewConfirm: 'All of these are mine',
  // A device announced as new and then hidden from the list (GH7).
  vanishedTitle: (label: string): string => `${label} joined, then disappeared`,
  vanishedBody: (createdAt: string, now: number): string =>
    `It joined ${agoLine(createdAt, now)} and is no longer in your list. Your relay may be hiding it. It could have read the links sent while it was listed. If you removed it yourself, you can dismiss this.`,
  vanishedDismiss: 'Dismiss',
} as const

/** "A", "A and B", "A, B and C". */
function listOfLabels(labels: string[]): string {
  if (labels.length <= 1) return labels.join('')
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`
}

/** The chooser-only ⏳ pending row (INTERACTION_FLOWS §3.1). */
export function pendingRow(count: number, label: string): string {
  return `⏳ ${count} waiting for ${label}`
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
export const SETUP_DOCS_URL = 'https://github.com/tabsend/tabsend/blob/main/docs/DEPLOY.md'

/**
 * Heading for the list of tabs still sitting on THIS browser because the relay
 * hasn't taken them. Distinct from the ⏳ row above, which counts tabs the relay
 * already HAS and is holding for a sleeping target — that's a different promise,
 * and merging them would make an outage look like a normal sleeping device.
 */
export function heldTabsHeading(count: number): string {
  return count === 1 ? 'Waiting on this browser' : `${count} tabs waiting on this browser`
}

/**
 * What to call a held tab in a list. The title is what the user recognises; the
 * site is the fallback when a tab had no title, because a bare URL path tells
 * nobody anything.
 */
export function heldTabLabel(item: { title?: string; url?: string }): string {
  if (item.title && item.title.trim() !== '') return item.title
  if (!item.url) return 'Untitled tab'
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
    const label = items[0]?.sourceLabel ?? 'a device'
    return n === 1 ? `Tab received from ${label}` : `${n} tabs received from ${label}`
  }
  return `${n} tabs received from ${senders.size} devices`
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
  const what = n === 1 && first ? shortTitle(heldTabLabel(first), ARRIVAL_TITLE_MAX) : `${n} tabs`
  const click = n === 1 ? 'Click to show it.' : 'Click to show the first.'
  switch (place.kind) {
    case 'window':
      return `${what} — opened in the window with “${shortTitle(place.activeTitle, WINDOW_TITLE_MAX)}”. ${click}`
    case 'only-window':
      return `${what} — opened in ${n === 1 ? 'a background tab' : 'background tabs'}. ${click}`
    case 'unknown':
      return `${what} — opened in ${n === 1 ? 'a new tab' : 'new tabs'}. ${click}`
  }
}

/** Confirmation that the queue drained, naming the tab when there's just one. */
export function recoveredLine(count: number, firstTitle?: string): string {
  if (count === 1) return firstTitle ? `Sent “${firstTitle}”` : 'Sent the tab that was waiting'
  return `Sent ${count} tabs that were waiting`
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
  if (count === 1) {
    return firstTitle ? `Couldn't send “${firstTitle}”` : "Couldn't send the tab that was waiting"
  }
  return `Couldn't send ${count} tabs that were waiting`
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
      return 'Set Tabsend up on this browser first, then you can pair other devices.'
    case 'unreachable':
      return `Couldn't reach the relay at ${cause.relayUrl} — check it's running, then try again.`
    case 'unauthorized':
      return 'This browser is no longer in the group — set it up again to pair other devices.'
    case 'relay':
      return `The relay couldn't issue a pairing link: ${cause.detail}`
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
  return (
    `This code points at ${relayUrl}, which only works for another browser on this same computer — ` +
    'a phone or another device cannot use it. To pair those, the relay needs to be reachable on your ' +
    'network, and this browser connected to it at that address.'
  )
}

/** Explain the two deliberate doors on a self-signed LAN relay. */
export function pairingRoutesLine(browserRelayUrl: string, nativeRelayUrl: string): string {
  return (
    `The copied link pairs browser extensions through ${browserRelayUrl}. The QR pairs phones through ${nativeRelayUrl}. ` +
    'Each device saves its route to this same relay; it can be changed later under Connection.'
  )
}

/**
 * Thrown by every background path that needs a registration and hasn't got one.
 * A constant rather than a repeated literal because the pages MATCH on it: a
 * settings tab that was registered when it loaded has to tell this apart from a
 * relay-side refusal, and re-render itself instead of printing an internal
 * sentence at a user who can do nothing with it (dogfood 2026-08-05).
 */
export const NOT_REGISTERED_ERROR = 'Tabsend is not registered yet.'

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
 * Each line leaves the word its button already carries ("address", "here") to
 * the button, so the pair doesn't repeat itself. No em dashes: short sentences
 * instead, so the fix is legible split across the icon + text row in a boxed
 * callout rather than one long run-on line.
 */
export const relayProbeCopy = {
  /** Our relay, new URL. The reassurance IS the message. */
  same: (): string => 'Same relay. Your devices stay paired.',
  /** Same, but one side predates relayId — say so rather than imply proof. */
  sameUnverified: (): string =>
    "Probably the same relay. It's too old to confirm, but it accepted this browser's login.",
  /** A relay that has never heard of us. Name the cost, don't moralise about it. */
  different: (): string => 'Different relay. No record of your devices, so every one re-pairs.',
  /** Nothing answered. */
  unreachable: (relayUrl: string): string =>
    `Couldn't reach a relay at ${relayUrl}. Check the address and that it's running.`,
  /** Answered, unusable (protocol mismatch or a relay-side error). */
  error: (detail: string): string => detail,
  /** Committed the address change. */
  updated: (relayUrl: string): string => `Now using ${relayUrl}.`,
  /**
   * The panel was asked to move an address this browser no longer has. Reachable
   * on a settings tab left open while the pairing ended somewhere else (another
   * tab finished a move, or another device removed this one). It used to surface
   * the raw internal "Tabsend is not registered yet.", which named no cause and
   * offered no way out (dogfood 2026-08-05), so it names both.
   */
  notPaired: (): string =>
    'This browser is not paired to a relay any more, so there is no address to move. Set it up again to start sending.',
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
  pending: (relayUrl: string): string => `Setup on ${relayUrl} isn't finished.`,
  /** ...and the reassurance that matters: nothing has been given up yet. */
  pendingSafe: (currentRelayUrl: string): string =>
    `This browser still sends and receives on ${currentRelayUrl} until you finish.`,
  /** ...when there is no current relay to fall back on (an older interrupted move). */
  pendingUnpaired: (): string =>
    'This browser is not paired to any relay, so it cannot send or receive until you finish.',
  /** Onboarding, arriving from settings with a relay already chosen. */
  target: (relayUrl: string): string => `Setting up on ${relayUrl}.`,
  /** ...spelling out the one-way step, at the screen where it is about to happen. */
  cost: (currentRelayUrl: string): string =>
    `You stay paired to ${currentRelayUrl} until this browser is accepted. After that it leaves that group, and any device you want to keep pairs again here.`,
  /** ...the way out, named after what it keeps rather than what it abandons. */
  keep: (currentRelayUrl: string): string => `Keep ${currentRelayUrl} instead`,
  /** The pre-filled link is the one they pasted, and codes are single-use. */
  reusedLink: (): string =>
    'This is the link you pasted in settings. Pairing links are single-use and expire, so mint a fresh one if the relay refuses it.',
} as const

/**
 * Failures of the COMMIT step (`changeRelayUrl`). With the probe running first
 * these are near-unreachable: they fire when the world changed between the check
 * and the click (the relay restarted on an empty database, say). Kept short: the
 * panel above them already carries the context, and nothing was changed.
 */
export const relayChangeCopy = {
  unreachable: (relayUrl: string): string =>
    `Couldn't reach a relay at ${relayUrl} any more. Nothing was changed.`,
  differentRelay: (): string =>
    'That address answers as a different relay now. Nothing was changed. Check it again.',
  tokenRejected: (): string =>
    'That relay stopped recognising this browser. Nothing was changed. Check the address again.',
  probeFailed: (detail: string): string =>
    `The relay refused the check: ${detail} Nothing was changed.`,
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
  body: (relayUrl: string): string =>
    `No other devices are set up on ${relayUrl}. They may be on a different relay address.`,
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
  const label = result.targetLabel ?? 'device'
  const n = result.count ?? 1
  // A partial batch outweighs its failure line: "Sent 2 of 3" carries both the
  // delivery and the refusal, where the bare rejection line would deny the 2.
  if (partiallySent(result)) {
    const rejected = result.rejectedCount ?? 0
    return `${partialHeadline(n, rejected, label)}. ${partialDetail(rejected, result.failure)}`
  }
  if (result.failure) return sendFailureLine(result.failure, result.targetLabel, n)
  if (!result.ok) return feedbackCopy.hardError()
  if (result.offline) return feedbackCopy.sourceOffline()
  if (n > 1) {
    return result.queued
      ? `Sent ${n} tabs to ${label}. They open when it wakes.`
      : `Sent ${n} tabs to ${label}`
  }
  if (result.queued) return feedbackCopy.sentOffline(label)
  return feedbackCopy.sentOnline(label)
}

/** True when a batch send delivered some tabs and had the rest refused. */
function partiallySent(result: { ok: boolean; count?: number; rejectedCount?: number }): boolean {
  const n = result.count ?? 1
  const rejected = result.rejectedCount ?? 0
  return result.ok && n > 1 && rejected > 0 && rejected < n
}

/** "Sent 2 of 3 tabs to Arc" — the delivered half of a partial batch. */
function partialHeadline(count: number, rejected: number, label: string): string {
  return `Sent ${count - rejected} of ${count} tabs to ${label}`
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
    return capHeldLine(failure.limit, rejected > 1)
  }
  return `The relay refused ${rejected}.`
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
  const label = result.targetLabel ?? 'your device'
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
    const waiting = n > 1 ? `Waiting to send ${n} tabs to ${label}` : `Waiting to send to ${label}`
    const failed = n > 1 ? `Couldn't send ${n} tabs to ${label}` : `Couldn't send to ${label}`
    return withTitle({
      tone: recoverable ? 'pending' : 'error',
      headline: recoverable ? waiting : failed,
      detail: sendFailureLine(result.failure, result.targetLabel, n),
    })
  }
  if (!result.ok) {
    return withTitle({
      tone: 'error',
      headline: n > 1 ? `Couldn't send ${n} tabs to ${label}` : `Couldn't send to ${label}`,
      detail: feedbackCopy.hardError(),
    })
  }
  const sent = n > 1 ? `Sent ${n} tabs to ${label}` : `Sent to ${label}`
  if (result.queued) {
    return withTitle({
      tone: 'success',
      headline: sent,
      detail: n > 1 ? 'They open when it wakes' : 'Opens when it wakes',
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
    headline:
      count > 1
        ? `${count} tabs never reached ${targetLabel}`
        : `A tab never reached ${targetLabel}`,
    detail:
      count > 1
        ? 'They waited at your relay until they expired. Tabsend history has them, and can send them again.'
        : 'It waited at your relay until it expired. Tabsend history has it, and can send it again.',
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
    headline: count > 1 ? `Sending ${count} tabs to ${targetLabel}` : `Sending to ${targetLabel}`,
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
  return `${count} tabs selected. A click sends all ${count}.`
}
