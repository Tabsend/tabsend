import {
  FEEDBACK_MAILTO,
  rateUrl,
  SHARE_PAGE_URL,
  type ShareVariant,
  shareBoxVariant,
  shareVariant,
} from '@tabsend/shared'
import { t } from '../lib/i18n'
import { defaultKv, type KeyValue } from '../lib/session'
import { getDismissedAt, noteHomeDrawn, setDismissedAt } from '../lib/sharebox-state'
import { el, svg } from './dom'

/**
 * P-22: the share box under "Add a device" on the Devices tab, and the "Help Tabsend" rows
 * on the Account tab (the console's settings area). The console cannot read the group's
 * plan, so the relay's address picks the wording (Tabsend's own address: credit; else plain).
 */

export interface ShareEnv {
  kv: KeyValue
  now(): number
  copy(text: string): Promise<void>
  openTab(url: string): void
}

export const liveShareEnv: ShareEnv = {
  kv: defaultKv(),
  now: () => Date.now(),
  copy: (text) => navigator.clipboard.writeText(text),
  openTab: (url) => {
    window.open(url, '_blank', 'noopener,noreferrer')
  },
}

/** The address the console talks to; empty means the page's own origin. */
export function relayAddress(relayUrl: string | undefined): string {
  return relayUrl && relayUrl !== '' ? relayUrl : window.location.origin
}

async function doShare(variant: ShareVariant, env: ShareEnv, note: HTMLElement): Promise<void> {
  if (variant === 'credit') {
    env.openTab(SHARE_PAGE_URL)
    return
  }
  try {
    await env.copy(t('share.text'))
    note.textContent = t('share.copied')
  } catch {
    note.textContent = t('share.copy.failed')
  }
}

const CLOSE = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>`

let expanded = false

function bodyText(variant: ShareVariant, open: boolean): string {
  if (variant === 'credit') return open ? t('share.expanded.credit') : t('share.body.credit')
  return open ? t('share.expanded.plain') : t('share.body.plain')
}

function toggleText(open: boolean): string {
  if (open) return t('share.less')
  return t('share.more')
}

/** The box, or null when the rules say it stays hidden. Records the first paired Home. */
export function renderShareBox(
  ctx: { relayUrl: string | undefined; deviceCount: number },
  env: ShareEnv = liveShareEnv,
): HTMLElement | null {
  const now = env.now()
  const variant = shareBoxVariant({
    relayUrl: relayAddress(ctx.relayUrl),
    deviceCount: ctx.deviceCount,
    firstHomeAt: noteHomeDrawn(now, env.kv),
    dismissedAt: getDismissedAt(env.kv),
    now,
  })
  if (variant === null) return null

  const body = el('p', { class: 'muted' })
  const more = el('button', { class: 'linkish', type: 'button' })
  const note = el('span', { class: 'muted', role: 'status' })
  const fill = (): void => {
    body.textContent = bodyText(variant, expanded)
    more.textContent = toggleText(expanded)
    more.setAttribute('aria-expanded', String(expanded))
  }
  fill()
  more.addEventListener('click', () => {
    expanded = !expanded
    fill()
  })

  const box = el(
    'section',
    { class: 'share-box', 'aria-labelledby': 'share-title' },
    el(
      'button',
      {
        class: 'share-dismiss',
        type: 'button',
        'aria-label': t('share.dismiss'),
        onClick: () => {
          setDismissedAt(env.now(), env.kv)
          box.setAttribute('hidden', '')
        },
      },
      svg(CLOSE),
    ),
    el('strong', { id: 'share-title' }, t('share.title')),
    body,
    el(
      'div',
      { class: 'share-actions' },
      el(
        'button',
        {
          class: 'btn',
          type: 'button',
          onClick: () => {
            // Tapping Share counts as an answer: the box rests for a year either way.
            setDismissedAt(env.now(), env.kv)
            void doShare(variant, env, note)
          },
        },
        t('share.button'),
      ),
      more,
      note,
    ),
  )
  return box
}

/** Account tab: "Help Tabsend" with Share, Rate (only when a link is set) and feedback. */
export function renderHelpSection(
  relayUrl: string | undefined,
  env: ShareEnv = liveShareEnv,
): HTMLElement {
  const note = el('span', { class: 'muted', role: 'status' })
  const rate = rateUrl()
  return el(
    'div',
    { class: 'help-tabsend' },
    el('h3', {}, t('share.help.heading')),
    el(
      'div',
      { class: 'share-actions' },
      el(
        'button',
        {
          class: 'btn',
          type: 'button',
          onClick: () => void doShare(shareVariant(relayAddress(relayUrl)), env, note),
        },
        t('share.help.share'),
      ),
      rate === null
        ? null
        : el(
            'a',
            { class: 'linkish', href: rate, target: '_blank', rel: 'noopener noreferrer' },
            t('share.help.rate'),
          ),
      el('a', { class: 'linkish', href: FEEDBACK_MAILTO }, t('share.help.feedback')),
      note,
    ),
  )
}
