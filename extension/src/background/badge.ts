import { ext } from '../lib/ext'

/**
 * Action-badge feedback (ADR-0008 MVP: badge ✓/✗ is the always-available signal;
 * in-page toasts are Chunk 5). A short-lived check or cross on the toolbar icon,
 * plus the exact §4 copy on the icon TOOLTIP (title) so the honest "opens when
 * it wakes" message reaches the user even with no popup open.
 *
 * A second, PERSISTENT signal lives here too: the unread-received count [P-7
 * addendum]. It shares the same badge surface as the send flashes below, so
 * the two are layered rather than independent — a flash always wins while it's
 * showing, and "idle" means the unread count if there is one, blank otherwise.
 */

const GREEN = '#1a7f37'
const RED = '#cf222e'
const AMBER = '#9a6700'
const BLUE = '#0969da'
const CLEAR_MS = 2500
const DEFAULT_TITLE = 'Tabsend — send this tab'

let clearTimer: ReturnType<typeof setTimeout> | undefined
let titleTimer: ReturnType<typeof setTimeout> | undefined
let unreadCount = 0

/** What the badge shows when no send flash is in progress. */
function renderIdleBadge(): void {
  if (unreadCount > 0) {
    void ext.action.setBadgeBackgroundColor({ color: BLUE })
    void ext.action.setBadgeText({ text: unreadCount > 9 ? '9+' : String(unreadCount) })
  } else {
    void ext.action.setBadgeText({ text: '' })
  }
}

function flash(text: string, color: string): void {
  void ext.action.setBadgeBackgroundColor({ color })
  void ext.action.setBadgeText({ text })
  if (clearTimer) clearTimeout(clearTimer)
  clearTimer = setTimeout(() => {
    clearTimer = undefined
    renderIdleBadge()
  }, CLEAR_MS)
}

/** Surface a feedback string on the toolbar-icon tooltip, then restore default. */
export function badgeTitle(title: string): void {
  void ext.action.setTitle({ title })
  if (titleTimer) clearTimeout(titleTimer)
  titleTimer = setTimeout(() => {
    titleTimer = undefined
    void ext.action.setTitle({ title: DEFAULT_TITLE })
  }, CLEAR_MS * 2)
}

export const badgeSuccess = () => flash('✓', GREEN)
export const badgeQueued = () => flash('…', AMBER)
export const badgeError = () => flash('✗', RED)

/**
 * Reflect the unread-received count (storage.ts `unreadReceived`) on the
 * badge. Unlike the flashes above this does not self-clear — it stays until
 * `count` reaches 0. Deferred while a flash is showing so a send confirmation
 * is never cut short; the flash's own timeout calls back into
 * `renderIdleBadge` and picks up whatever count is current by then.
 */
export function setUnreadBadge(count: number): void {
  unreadCount = count
  if (!clearTimer) renderIdleBadge()
}

/**
 * Keep the badge in sync with storage from any writer — this service worker's
 * own `notify.ts`, or the received-tabs page clearing it directly (it writes
 * storage straight through rather than round-tripping the SW; see inbox.ts).
 * Registered once, synchronously, at SW top level (MV3 requirement).
 */
export function registerUnreadBadgeSync(): void {
  ext.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.unreadReceived) {
      setUnreadBadge((changes.unreadReceived.newValue as number | undefined) ?? 0)
    }
  })
}

/** Wipe any in-flight send flash and return the badge to idle (e.g. after a relay switch). */
export function clearBadge(): void {
  if (clearTimer) clearTimeout(clearTimer)
  if (titleTimer) clearTimeout(titleTimer)
  clearTimer = undefined
  titleTimer = undefined
  renderIdleBadge()
  void ext.action.setTitle({ title: DEFAULT_TITLE })
}
