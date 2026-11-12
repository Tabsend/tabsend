/**
 * P-22: the "Know someone who'd like Tabsend?" box and the Settings "Help Tabsend" rows,
 * for the browser extension and the web console. Pure on purpose: the clock and every
 * stored timestamp come in as arguments, so the rules are tested without a browser.
 *
 * Neither client can read the group's service plan, so the relay's address stands in:
 * Tabsend's own hosted address means the CREDIT wording and the account site's Share page;
 * any other relay means the PLAIN wording and a copied sentence.
 */

/**
 * The one place the review link is set. Empty on purpose: the "Rate Tabsend" row is hidden
 * until the owner puts a store link here. Never invent a link.
 */
export const RATE_TABSEND_URL = ''

/** Where the account site's Share page lives (CREDIT variant). The apps never see a personal link. */
export const SHARE_PAGE_URL = 'https://account.tabsend.org/share'

/** The feedback link: contact@tabsend.org with a fixed subject. */
export const FEEDBACK_MAILTO = 'mailto:contact@tabsend.org?subject=Tabsend%20feedback'

/** Hosts of Tabsend's own service. The demo relay is Tabsend's too. */
export const HOSTED_RELAY_HOSTS: readonly string[] = ['app.tabsend.org', 'demo.tabsend.org']

const DAY_MS = 24 * 60 * 60 * 1000

/** Hidden for a year after a dismissal or a tap on Share. */
export const SHARE_BOX_DISMISS_DAYS = 365
/** The box waits this long after the first time the paired Home was drawn. */
export const SHARE_BOX_MIN_AGE_DAYS = 30
/** The box needs another device in the group, so two or more in all. */
export const SHARE_BOX_MIN_DEVICES = 2

export type ShareVariant = 'credit' | 'plain'

/** True when the relay address is Tabsend's own hosted service. */
export function isHostedRelay(relayUrl: string | undefined | null): boolean {
  if (!relayUrl) return false
  const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^/?#@]*@)?([^/?#:]+)/i.exec(relayUrl.trim())
  return m?.[1] ? HOSTED_RELAY_HOSTS.includes(m[1].toLowerCase()) : false
}

/** Which wording and which Share action this relay gets. Settings uses this too. */
export function shareVariant(relayUrl: string | undefined | null): ShareVariant {
  return isHostedRelay(relayUrl) ? 'credit' : 'plain'
}

export interface ShareBoxInput {
  relayUrl: string | undefined | null
  /** Devices in the group, this one included. */
  deviceCount: number
  /** Epoch ms of the first time the paired Home was drawn, if recorded. */
  firstHomeAt: number | undefined
  /** Epoch ms of the last dismissal or tap on Share, if any. */
  dismissedAt: number | undefined
  /** The injected clock, epoch ms. */
  now: number
}

/** The variant to show, or null when the box stays hidden. */
export function shareBoxVariant(input: ShareBoxInput): ShareVariant | null {
  const { now, firstHomeAt, dismissedAt, deviceCount } = input
  if (dismissedAt !== undefined && now - dismissedAt < SHARE_BOX_DISMISS_DAYS * DAY_MS) return null
  if (firstHomeAt === undefined) return null
  if (now - firstHomeAt < SHARE_BOX_MIN_AGE_DAYS * DAY_MS) return null
  if (deviceCount < SHARE_BOX_MIN_DEVICES) return null
  return shareVariant(input.relayUrl)
}

/** The Rate row's link, or null while none is set. */
export function rateUrl(configured: string = RATE_TABSEND_URL): string | null {
  const url = configured.trim()
  return url === '' ? null : url
}
