import { ext } from '../lib/ext'
import type { InboxItem } from '../lib/model'
import { getSettings, getUnreadReceived, setUnreadReceived } from '../lib/storage'
import { type ArrivalPlace, arrivalPlaceLine, receivedNotificationLine } from '../lib/strings'
import { handleNewDeviceNotificationClick } from './newdevices'

/**
 * The receive-side indicator [P-7 addendum, 2026-08-05 dogfood report]. A
 * browser opening a received tab was assumed to BE the signal — until a tab
 * landing in an unfocused or out-of-the-way window turned out to be exactly
 * as easy to miss as a phone notification swiped away unread.
 *
 * Two layers, same split as ADR-0008's send feedback:
 *  - The badge count is the always-available signal (badge.ts `setUnreadBadge`,
 *    driven off storage so it survives this service worker dying between
 *    arrivals).
 *  - The pop-up (`ClientSettings.notifyOnReceive`, ON by default since
 *    2026-10-07, see storage.ts) says what arrived and which window it went
 *    to, and a click goes straight to the tab.
 *
 * Called once per deliver pass (receive.ts), never per message: a five-tab
 * batch is one arrival, not five.
 */

const NOTIFICATION_ID_PREFIX = 'tabsend-received-'

/** A tab a deliver pass opened, as `tabs.create` reported it. */
export interface ArrivedTab {
  tabId: number
  windowId: number
}

/** What a click on one notification goes to, and how many arrivals it covered. */
interface NotificationTarget extends ArrivedTab {
  count: number
  at: number
}

/**
 * notification id → target. Kept in `storage.session` (Chrome MV3, Firefox 115+)
 * because the worker that posted a notification is routinely dead by the time
 * someone clicks it; session storage outlives the worker and is cleared with
 * the browser session, which is also when tab ids stop meaning anything. The
 * in-memory copy is the fallback where that area is missing, and only lasts as
 * long as this worker: a click it cannot resolve falls back to history.html.
 */
const TARGETS_KEY = 'notificationTargets'
const TARGETS_MAX = 20
const memoryTargets = new Map<string, NotificationTarget>()

type Targets = Record<string, NotificationTarget>

function sessionArea(): chrome.storage.StorageArea | undefined {
  return ext.storage?.session
}

async function readTargets(): Promise<Targets> {
  const area = sessionArea()
  if (area) {
    try {
      const bag = await area.get(TARGETS_KEY)
      return { ...Object.fromEntries(memoryTargets), ...((bag[TARGETS_KEY] as Targets) ?? {}) }
    } catch {
      // fall through to memory
    }
  }
  return Object.fromEntries(memoryTargets)
}

async function writeTargets(targets: Targets): Promise<void> {
  const area = sessionArea()
  if (!area) return
  try {
    await area.set({ [TARGETS_KEY]: targets })
  } catch {
    // memory still has it for as long as this worker lives
  }
}

async function rememberTarget(id: string, target: NotificationTarget): Promise<void> {
  memoryTargets.set(id, target)
  const all = { ...(await readTargets()), [id]: target }
  // Newest TARGETS_MAX only: an unclicked notification is not worth keeping a
  // tab id for all session, and this must never grow without bound.
  const kept = Object.entries(all)
    .sort(([, a], [, b]) => b.at - a.at)
    .slice(0, TARGETS_MAX)
  for (const key of memoryTargets.keys()) {
    if (!kept.some(([k]) => k === key)) memoryTargets.delete(key)
  }
  await writeTargets(Object.fromEntries(kept))
}

/** Read and forget: a notification is clicked once. */
async function takeTarget(id: string): Promise<NotificationTarget | undefined> {
  const all = await readTargets()
  const target = all[id]
  memoryTargets.delete(id)
  if (target) {
    delete all[id]
    await writeTargets(all)
  }
  return target
}

function hostname(url: string | undefined): string {
  if (!url) return ''
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

/**
 * Where the batch landed, worded by `arrivalPlaceLine`. Any doubt reads as
 * `unknown`, which still says it opened in a new tab: an incognito window, a
 * window whose showing tab IS one of the arrivals (nothing else to name it by),
 * a tab with no title or host, or any lookup failing.
 */
export async function describeArrival(arrived: ArrivedTab[]): Promise<ArrivalPlace> {
  const first = arrived[0]
  if (!first) return { kind: 'unknown' }
  try {
    const win = await ext.windows.get(first.windowId)
    if (win.incognito) return { kind: 'unknown' }
    const normal = await ext.windows.getAll({ windowTypes: ['normal'] })
    if (normal.length <= 1) return { kind: 'only-window' }
    const [showing] = await ext.tabs.query({ active: true, windowId: first.windowId })
    if (!showing || arrived.some((a) => a.tabId === showing.id)) return { kind: 'unknown' }
    const title = showing.title?.trim() || hostname(showing.url)
    return title ? { kind: 'window', activeTitle: title } : { kind: 'unknown' }
  } catch {
    return { kind: 'unknown' }
  }
}

/** Never throws — a notification failure must not cost the delivery it describes. */
export async function notifyDelivered(
  items: InboxItem[],
  arrived: ArrivedTab[] = [],
): Promise<void> {
  if (items.length === 0) return

  try {
    const unread = (await getUnreadReceived()) + items.length
    // badge.ts's storage listener (registerUnreadBadgeSync) picks this up and
    // repaints the toolbar icon — this file doesn't touch the badge directly.
    await setUnreadReceived(unread)
  } catch {
    // The tabs are open and recorded; only the unread count missed a beat.
  }

  try {
    const settings = await getSettings()
    if (!settings.notifyOnReceive || !ext.notifications?.create) return
    const id = `${NOTIFICATION_ID_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const first = arrived[0]
    // Recorded BEFORE the pop-up exists, so even an instant click finds it.
    if (first) await rememberTarget(id, { ...first, count: items.length, at: Date.now() })
    const place = await describeArrival(arrived)
    await ext.notifications.create(id, {
      type: 'basic',
      iconUrl: ext.runtime.getURL('icons/tabsend-128.png'),
      title: receivedNotificationLine(items),
      message: arrivalPlaceLine(items, place),
    })
  } catch {
    // Notifications permission/API unavailable — the badge already carried it.
  }
}

/** Bring the tab forward in its CURRENT window (it may have been dragged out). */
async function showTab(target: NotificationTarget): Promise<boolean> {
  try {
    const tab = await ext.tabs.get(target.tabId)
    await ext.windows.update(tab.windowId ?? target.windowId, { focused: true })
    await ext.tabs.update(target.tabId, { active: true })
    return true
  } catch {
    // Closed since (tabs.get rejects on a dead id) — the caller falls back.
    return false
  }
}

/**
 * Clicking the pop-up goes to the tab it announced: focus that window, show
 * that tab (the first one, for a batch). If the tab is gone, or the worker that
 * remembered it is too and session storage was unavailable, it opens the
 * history page instead — the same destination the chooser and the options
 * page use for "show me what arrived."
 *
 * Going to the tab is looking at those arrivals, so the click takes them off
 * the unread badge the same way viewing the history page does (history.ts
 * `markSeenIfVisible`), but only the ones this notification covered. The
 * history fallback needs nothing here: that page clears the count itself.
 *
 * Exported for tests; never throws.
 */
export async function handleNotificationClick(notificationId: string): Promise<void> {
  if (!notificationId.startsWith(NOTIFICATION_ID_PREFIX)) return
  // Already-gone is fine; never let it surface as an unhandled rejection.
  void Promise.resolve()
    .then(() => ext.notifications.clear(notificationId))
    .catch(() => {})
  try {
    const target = await takeTarget(notificationId)
    if (target && (await showTab(target))) {
      try {
        const unread = await getUnreadReceived()
        await setUnreadReceived(Math.max(0, unread - target.count))
      } catch {
        // the badge just stays as it was
      }
      return
    }
    await ext.tabs.create({ url: ext.runtime.getURL('history.html') })
  } catch {
    // nothing more to fall back to
  }
}

/** Registered synchronously at SW top level (MV3 requirement). */
export function registerNotificationClickHandler(): void {
  ext.notifications?.onClicked?.addListener((notificationId) => {
    void handleNotificationClick(notificationId)
    void handleNewDeviceNotificationClick(notificationId)
  })
}
