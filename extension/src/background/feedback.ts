import { ext } from '../lib/ext'
import type { SendBanner } from '../lib/strings'
import { badgeError, badgeQueued, badgeSuccess, badgeTitle } from './badge'

/**
 * The send feedback banner (ADR-0008 / INTERACTION_FLOWS §4, extended
 * 2026-07-29). Injected into the page by `scripting.executeScript`, so no
 * persistent content script ships. On restricted pages (chrome://, the Web
 * Store, the PDF viewer) injection throws and we degrade to the action badge —
 * the honest, documented limit.
 *
 * Three things changed from the original bottom-corner toast, all for the same
 * reason — a send that quietly failed left no trace anywhere:
 *
 *  1. It is anchored TOP-RIGHT, below the toolbar icon it belongs to, so the
 *     feedback reads as coming from the extension rather than from the page.
 *  2. It names the TAB, not just the target. "Sent to Arc" doesn't tell you
 *     which of the three tabs you fired off actually went.
 *  3. It has a failure tone at all. The old toast could only say nice things,
 *     so every relay outage was rendered as a success or as nothing.
 */

export interface FeedbackOptions {
  /** Show it on this specific tab (the tab the send came FROM), not the active one. */
  tabId?: number
  /** Present ⇒ render an "Undo" button that cancels the 4s-window send. */
  undoId?: string
  /** Override the tone's default dwell time. */
  durationMs?: number
}

/** Tone → how long it stays. Success is a glance; a failure has to be readable. */
const DWELL_MS: Record<SendBanner['tone'], number> = {
  success: 2000,
  pending: 4000,
  error: 9000,
}

/**
 * Runs IN THE PAGE (content-script world). Must be self-contained — no closure
 * capture beyond its args. Shadow-isolated so the host page's CSS can't touch
 * it, and (when undoable) wires an Undo button that messages the SW.
 */
function bannerInPage(
  tone: 'success' | 'pending' | 'error',
  headline: string,
  title: string | null,
  favicon: string | null,
  detail: string | null,
  undoId: string | null,
  durationMs: number,
): void {
  const ID = '__tabsend_feedback__'
  document.getElementById(ID)?.remove()
  const host = document.createElement('div')
  host.id = ID
  // Top-right: directly under where the toolbar icon lives. `all:initial` first,
  // then our own positioning, so nothing inherits from the page.
  host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;top:12px;right:12px;'
  const root = host.attachShadow({ mode: 'open' })

  // The app UI's "petrol tint" tokens (docs/APP_UI.md), light and dark. Inlined
  // because this runs in the page: no stylesheet of ours exists here, and the
  // shadow root can't load the extension's font without exposing it to every
  // site, so Archivo is used only where it is installed and system-ui otherwise.
  const dark = window.matchMedia?.('(prefers-color-scheme: dark)').matches
  const t = dark
    ? {
        card: '#0F3B36',
        ink: '#EAF1EF',
        muted: '#A9C2BC',
        line: 'rgba(234,241,239,.14)',
        shadow: '#041513',
        accent: '#A9C4FF',
        success: '#8FD27A',
        waiting: '#F0C463',
        danger: '#F08A6E',
      }
    : {
        card: '#FFFFFF',
        ink: '#10201E',
        muted: '#4F625E',
        line: '#CBDAD6',
        shadow: '#10201E',
        accent: '#2450A8',
        success: '#2F7A22',
        waiting: '#7A5200',
        danger: '#A4361C',
      }
  // The status colour drives the round icon (tinted fill, coloured glyph) and
  // the headline; the words carry the state too, never colour alone.
  const accent = tone === 'success' ? t.success : tone === 'pending' ? t.waiting : t.danger
  const glyph = tone === 'success' ? '✓' : tone === 'pending' ? '↑' : '!'

  const style = document.createElement('style')
  style.textContent = `
    @keyframes ts-in { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: none; } }
    .card {
      display: flex; gap: 11px; align-items: flex-start;
      box-sizing: border-box; width: max-content; min-width: 240px; max-width: 340px;
      padding: 12px 14px 12px 12px;
      border: 1.5px solid ${t.ink};
      border-radius: 14px;
      background: ${t.card};
      color: ${t.ink};
      box-shadow: 4px 4px 0 ${t.shadow};
      font: 14px/1.4 'Archivo', system-ui, -apple-system, 'Segoe UI', sans-serif;
      text-align: left;
      animation: ts-in .16s ease-out;
    }
    .glyph {
      position: relative; flex: none; display: flex; align-items: center; justify-content: center;
      width: 28px; height: 28px; border-radius: 50%; overflow: hidden;
      color: ${accent}; font-size: 14px; font-weight: 800; line-height: 1;
    }
    .glyph::before {
      content: ''; position: absolute; inset: 0; background: ${accent}; opacity: .16;
    }
    .body { min-width: 0; padding-top: 4px; }
    .headline { font-weight: 700; color: ${accent}; }
    /* The tab's IDENTITY row: favicon + title, muted. Styled deliberately unlike
       .detail below — as a page being named, not a sentence being said. Clamped
       to two lines so a long title can't stretch the card. */
    .title-row { display: flex; align-items: flex-start; gap: 6px; margin-top: 3px; }
    .favicon { flex: none; width: 14px; height: 14px; margin-top: 2px; border-radius: 3px; }
    .title {
      min-width: 0; color: ${t.muted}; font-size: 13px;
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
      overflow: hidden; overflow-wrap: anywhere;
    }
    /* The status line is separated by a hairline, so it reads as a note ABOUT
       the tab above rather than as a continuation of its title. */
    .detail {
      margin-top: 8px; padding-top: 7px; font-size: 13px;
      color: ${t.muted};
      border-top: 1.5px solid ${t.line};
    }
    .actions { display: flex; gap: 14px; margin-top: 8px; }
    button {
      all: unset; cursor: pointer; font: 700 13px/1.4 'Archivo', system-ui, sans-serif;
      color: ${t.accent}; padding: 1px 2px; border-radius: 4px;
    }
    button:hover { text-decoration: underline; text-underline-offset: 2px; }
    button:focus-visible { outline: 2px solid ${t.accent}; outline-offset: 2px; }
    .dismiss { color: ${t.muted}; }
  `

  const card = document.createElement('div')
  card.className = 'card'
  // A failure interrupts; a confirmation does not.
  card.setAttribute('role', tone === 'error' ? 'alert' : 'status')
  card.setAttribute('aria-live', tone === 'error' ? 'assertive' : 'polite')

  const badge = document.createElement('span')
  badge.className = 'glyph'
  badge.setAttribute('aria-hidden', 'true')
  badge.textContent = glyph

  const body = document.createElement('div')
  body.className = 'body'
  const headlineEl = document.createElement('div')
  headlineEl.className = 'headline'
  headlineEl.textContent = headline
  body.appendChild(headlineEl)
  if (title) {
    const row = document.createElement('div')
    row.className = 'title-row'
    if (favicon) {
      const img = document.createElement('img')
      img.className = 'favicon'
      img.src = favicon
      img.alt = ''
      // Plenty of favicons 404, are blocked, or are an extension-internal URL
      // the page can't load. A broken-image glyph beside the title would look
      // like part of the failure, so drop it silently instead.
      img.addEventListener('error', () => img.remove())
      row.appendChild(img)
    }
    const titleEl = document.createElement('div')
    titleEl.className = 'title'
    titleEl.textContent = title
    row.appendChild(titleEl)
    body.appendChild(row)
  }
  if (detail) {
    const detailEl = document.createElement('div')
    detailEl.className = 'detail'
    detailEl.textContent = detail
    body.appendChild(detailEl)
  }

  const api =
    (globalThis as { browser?: typeof chrome; chrome?: typeof chrome }).browser ??
    (globalThis as { chrome?: typeof chrome }).chrome

  // A failure sticks until dismissed if it needs the user to do something;
  // everything else self-clears. `durationMs <= 0` means "wait for a click".
  let timer = durationMs > 0 ? window.setTimeout(() => host.remove(), durationMs) : 0

  const actions = document.createElement('div')
  actions.className = 'actions'
  if (undoId) {
    const undo = document.createElement('button')
    undo.textContent = 'Undo'
    undo.addEventListener('click', () => {
      window.clearTimeout(timer)
      try {
        api?.runtime.sendMessage({ __tabsendUndo: true, id: undoId })
      } catch {
        /* SW asleep — the window's dispatch timer still fires; nothing to do */
      }
      // Keep the title row: "Send undone" + the tab's name confirms WHICH send
      // was cancelled, which matters most when two were fired in quick succession.
      headlineEl.textContent = 'Send undone'
      actions.remove()
      timer = window.setTimeout(() => host.remove(), 1500)
    })
    actions.appendChild(undo)
  }
  if (tone === 'error') {
    const dismiss = document.createElement('button')
    dismiss.className = 'dismiss'
    dismiss.textContent = 'Dismiss'
    dismiss.addEventListener('click', () => {
      window.clearTimeout(timer)
      host.remove()
    })
    actions.appendChild(dismiss)
  }
  if (actions.childElementCount > 0) body.appendChild(actions)

  card.append(badge, body)
  root.append(style, card)
  document.documentElement.appendChild(host)
}

async function activeTabId(): Promise<number | undefined> {
  const [tab] = await ext.tabs.query({ active: true, lastFocusedWindow: true })
  return tab?.id
}

/**
 * The always-available signal: badge glyph + the same words on the tooltip
 * (ADR-0008). Exported because it must fire even when the §7 "success toasts"
 * setting suppresses the banner — silencing the toast was never meant to
 * silence the badge as well.
 */
export function feedbackBadge(banner: SendBanner): void {
  if (banner.tone === 'success') badgeSuccess()
  else if (banner.tone === 'pending') badgeQueued()
  else badgeError()
  badgeTitle(banner.detail ? `${banner.headline}. ${banner.detail}` : banner.headline)
}

/**
 * Show `banner` on the send's own tab (falling back to the active one). Always
 * sets the badge too: the badge is the only signal that survives the tab being
 * closed, navigated, or restricted, and a failure must never depend on the
 * injection succeeding.
 */
export async function showFeedback(
  banner: SendBanner,
  opts: FeedbackOptions = {},
): Promise<boolean> {
  feedbackBadge(banner)

  const tabId = opts.tabId ?? (await activeTabId())
  const scripting = ext.scripting
  if (tabId === undefined || !scripting) return false
  try {
    await scripting.executeScript({
      target: { tabId },
      func: bannerInPage,
      args: [
        banner.tone,
        banner.headline,
        banner.title ?? null,
        banner.favicon ?? null,
        banner.detail ?? null,
        opts.undoId ?? null,
        opts.durationMs ?? DWELL_MS[banner.tone],
      ],
    })
    return true
  } catch {
    // Restricted page, or the tab is gone — the badge already carried it.
    return false
  }
}
