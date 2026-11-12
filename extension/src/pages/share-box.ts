import {
  FEEDBACK_MAILTO,
  rateUrl,
  SHARE_PAGE_URL,
  type ShareVariant,
  shareBoxVariant,
  shareVariant,
} from '@tabsend/shared'
import { ext } from '../lib/ext'
import { t } from '../lib/i18n'
import {
  getShareDismissedAt,
  getShareFirstHomeAt,
  setShareDismissedAt,
  setShareFirstHomeAt,
} from '../lib/storage'

/**
 * P-22: the "Know someone who'd like Tabsend?" box in the popup, and the "Help Tabsend"
 * rows in Settings. The rules (who sees the box, when) are `shareBoxVariant` in
 * @tabsend/shared; this file is the part that touches the page and storage. The browser
 * cannot read the group's plan, so the relay's address picks the wording.
 */

/** Everything the box needs from outside the page, so a test can stand in for it. */
export interface ShareEnv {
  now(): number
  getFirstHomeAt(): Promise<number | undefined>
  setFirstHomeAt(v: number): Promise<void>
  getDismissedAt(): Promise<number | undefined>
  setDismissedAt(v: number): Promise<void>
  copy(text: string): Promise<void>
  openTab(url: string): void
}

export const liveShareEnv: ShareEnv = {
  now: () => Date.now(),
  getFirstHomeAt: async () => getShareFirstHomeAt(),
  setFirstHomeAt: setShareFirstHomeAt,
  getDismissedAt: async () => getShareDismissedAt(),
  setDismissedAt: setShareDismissedAt,
  copy: (text) => navigator.clipboard.writeText(text),
  openTab: (url) => {
    void ext.tabs.create({ url })
  },
}

/** What Share does: the account site's Share page, or a sentence copied to the clipboard. */
export async function doShare(
  variant: ShareVariant,
  env: ShareEnv,
  note: HTMLElement,
): Promise<void> {
  if (variant === 'credit') {
    env.openTab(SHARE_PAGE_URL)
    note.textContent = ''
    return
  }
  try {
    await env.copy(t('share.text'))
    note.textContent = t('share.copied')
  } catch {
    note.textContent = t('share.copy.failed')
  }
}

export interface ShareBoxEls {
  box: HTMLElement
  body: HTMLElement
  go: HTMLElement
  more: HTMLElement
  dismiss: HTMLElement
  note: HTMLElement
}

let expanded = false

function bodyText(variant: ShareVariant, open: boolean): string {
  if (variant === 'credit') return open ? t('share.expanded.credit') : t('share.body.credit')
  return open ? t('share.expanded.plain') : t('share.body.plain')
}

function toggleText(open: boolean): string {
  if (open) return t('share.less')
  return t('share.more')
}

function fill(els: ShareBoxEls, variant: ShareVariant): void {
  els.body.textContent = bodyText(variant, expanded)
  els.more.textContent = toggleText(expanded)
  els.more.setAttribute('aria-expanded', String(expanded))
}

/**
 * Draw (or hide) the box. Called each time the paired Home is drawn, so it also records
 * the first time that happened. Never throws: a storage failure just leaves the box hidden.
 */
export async function paintShareBox(
  els: ShareBoxEls,
  ctx: { relayUrl: string | undefined; deviceCount: number },
  env: ShareEnv = liveShareEnv,
): Promise<void> {
  try {
    let firstHomeAt = await env.getFirstHomeAt()
    if (firstHomeAt === undefined) {
      firstHomeAt = env.now()
      await env.setFirstHomeAt(firstHomeAt)
    }
    const variant = shareBoxVariant({
      relayUrl: ctx.relayUrl,
      deviceCount: ctx.deviceCount,
      firstHomeAt,
      dismissedAt: await env.getDismissedAt(),
      now: env.now(),
    })
    if (variant === null) {
      els.box.classList.add('hidden')
      return
    }
    fill(els, variant)
    els.more.onclick = () => {
      expanded = !expanded
      fill(els, variant)
    }
    const close = async (): Promise<void> => {
      await env.setDismissedAt(env.now())
      els.box.classList.add('hidden')
    }
    els.dismiss.onclick = () => void close()
    els.go.onclick = () => {
      // Tapping Share counts as an answer: the box rests for a year either way.
      void env.setDismissedAt(env.now())
      void doShare(variant, env, els.note)
    }
    els.box.classList.remove('hidden')
  } catch {
    els.box.classList.add('hidden')
  }
}

export interface HelpRowEls {
  share: HTMLElement
  rate: HTMLElement
  feedback: HTMLElement
  note: HTMLElement
}

/** Settings "Help Tabsend": Share always, Rate only once a link is set, and the feedback email. */
export function wireHelpRows(
  els: HelpRowEls,
  relayUrl: string | undefined,
  env: ShareEnv = liveShareEnv,
): void {
  els.share.onclick = () => void doShare(shareVariant(relayUrl), env, els.note)
  const rate = rateUrl()
  els.rate.classList.toggle('hidden', rate === null)
  if (rate !== null) els.rate.setAttribute('href', rate)
  els.feedback.setAttribute('href', FEEDBACK_MAILTO)
}
