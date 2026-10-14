/**
 * Build-time platform flag. Vite `define` (vite.config.ts) replaces
 * `__TABSEND_PLATFORM__` with a string literal per build variant, so the dead
 * branch tree-shakes out — the Chrome bundle drops the Firefox WS-in-event-page
 * path and vice-versa. Under Vitest (no define) it falls back to 'chrome'.
 *
 * The divergence this gates is exactly what the transport spike found: Firefox
 * has no Push API and no offscreen documents, so it runs the delivery WebSocket
 * in the event page directly and wakes on alarms + user-activity events.
 */
declare const __TABSEND_PLATFORM__: 'chrome' | 'firefox'

export const PLATFORM: 'chrome' | 'firefox' =
  typeof __TABSEND_PLATFORM__ === 'undefined' ? 'chrome' : __TABSEND_PLATFORM__

export const IS_FIREFOX = PLATFORM === 'firefox'
export const IS_CHROME = PLATFORM === 'chrome'
