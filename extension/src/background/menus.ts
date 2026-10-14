import type { Endpoint, IsoTimestamp, SendPayload } from '@tabsend/shared'
import { ext } from '../lib/ext'
import { IS_FIREFOX } from '../lib/platform'
import { getCachedEndpoints, getSettings } from '../lib/storage'
import { targetEndpoints } from './endpoints'
import { isSendableTab, payloadsFromTabs, sendToTarget } from './send'
import { currentSession } from './session'

/**
 * Page + link (+ Firefox tab-strip) context menus (ADR-0001 / INTERACTION_FLOWS
 * §2.3-2.4). Native, browser-styled, rebuilt whenever the endpoint list
 * changes. Adaptive rule: n=0 → a "pair a device" item that opens first-run;
 * n=1 → a flat "Send … to <label>"; n≥2 → a submenu of targets. In Quick-send
 * toolbar mode the icon's right-click menu also carries "Open chooser…" so
 * the rich chooser stays reachable without a popup (ADR-0008 §2.2). Entries
 * hide entirely when the user turns off context-menu entries (ADR-0001 / §7).
 *
 * The "send tab" items also carry the `tab` context on Firefox — Firefox's
 * `menus` API supports right-clicking the tab strip itself (FF63+, §2.4);
 * Chrome has no such context, so it stays page-only there.
 */

const PAIR_ID = 'tabsend:pair'
const TAB_PREFIX = 'tabsend:tab:'
const LINK_PREFIX = 'tabsend:link:'
const TAB_PARENT = 'tabsend:tab-parent'
const LINK_PARENT = 'tabsend:link-parent'
const OPEN_CHOOSER_ID = 'tabsend:open-chooser'

/**
 * 'page' everywhere; Firefox adds the tab-strip surface (§2.4). `@types/chrome`
 * has no 'tab' member (Chrome doesn't support it) even though Firefox's runtime
 * does — same escape hatch as the other Firefox-only runtime shapes (native.ts).
 */
const TAB_CONTEXTS = (IS_FIREFOX
  ? ['page', 'tab']
  : ['page']) as unknown as chrome.contextMenus.ContextType[]

let lastSignature = ''

function signature(targets: Endpoint[], registered: boolean, flags: string): string {
  return `${registered ? '1' : '0'}|${flags}|${targets.map((t) => `${t.id}:${t.label}`).join(',')}`
}

/** Rebuild menus from the cached endpoint list. No-op when nothing changed. */
export async function rebuildMenus(): Promise<void> {
  const session = await currentSession()
  const settings = await getSettings()
  const targets = session ? await targetEndpoints(await getCachedEndpoints()) : []
  const flags = `${settings.contextMenusVisible ? 'c' : ''}${settings.toolbarClickMode === 'quicksend' ? 'q' : ''}`
  const sig = signature(targets, Boolean(session), flags)
  if (sig === lastSignature) return
  lastSignature = sig

  await ext.contextMenus.removeAll()

  // Quick-send mode: keep the rich chooser reachable from the icon's menu.
  if (session && settings.toolbarClickMode === 'quicksend' && ext.action) {
    ext.contextMenus.create({
      id: OPEN_CHOOSER_ID,
      title: 'Open Tabsend chooser…',
      contexts: ['action'],
    })
  }

  // Page/link entries are the user-hideable ones (§7).
  if (!settings.contextMenusVisible) return

  if (!session || targets.length === 0) {
    ext.contextMenus.create({
      id: PAIR_ID,
      title: 'Tabsend: pair a device…',
      contexts: [...TAB_CONTEXTS, 'link'],
    })
    return
  }

  if (targets.length === 1) {
    const only = targets[0]
    if (!only) return
    ext.contextMenus.create({
      id: `${TAB_PREFIX}${only.id}`,
      title: `Send tab to ${only.label}`,
      contexts: TAB_CONTEXTS,
    })
    ext.contextMenus.create({
      id: `${LINK_PREFIX}${only.id}`,
      title: `Send link to ${only.label}`,
      contexts: ['link'],
    })
    return
  }

  ext.contextMenus.create({ id: TAB_PARENT, title: 'Send tab to', contexts: TAB_CONTEXTS })
  ext.contextMenus.create({ id: LINK_PARENT, title: 'Send link to', contexts: ['link'] })
  for (const target of targets) {
    ext.contextMenus.create({
      id: `${TAB_PREFIX}${target.id}`,
      parentId: TAB_PARENT,
      title: target.label,
      contexts: TAB_CONTEXTS,
    })
    ext.contextMenus.create({
      id: `${LINK_PREFIX}${target.id}`,
      parentId: LINK_PARENT,
      title: target.label,
      contexts: ['link'],
    })
  }
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

function payloadFromTab(tab: chrome.tabs.Tab | undefined): SendPayload | undefined {
  if (!tab?.url) return undefined
  const payload: SendPayload = { url: tab.url, sentAt: new Date().toISOString() as IsoTimestamp }
  if (tab.title) payload.title = tab.title
  if (tab.favIconUrl && !tab.favIconUrl.startsWith('data:')) payload.favicon = tab.favIconUrl
  return payload
}

function payloadFromLink(info: chrome.contextMenus.OnClickData): SendPayload {
  const url = info.linkUrl ?? ''
  // Chrome's OnClickData has no linkText (that's a Firefox `menus` extra) — the
  // hostname is the honest best-effort title for a bare link (INTERACTION_FLOWS §2.3).
  return {
    url,
    title: hostnameOf(url),
    sentAt: new Date().toISOString() as IsoTimestamp,
  }
}

/**
 * The whole highlighted group, when the clicked tab is part of one (N>1). Menu
 * titles stay singular ("Send tab to …"); the handler asks the tab strip itself,
 * because rebuilding menu titles on every selection change would race the click.
 * A right-click on a tab OUTSIDE the selection sends just that tab, matching
 * what the browser's own tab-strip menus (Close, Reload) act on.
 */
async function selectionForTab(
  tab: chrome.tabs.Tab | undefined,
): Promise<SendPayload[] | undefined> {
  if (!tab?.highlighted || tab.windowId === undefined) return undefined
  const group = (await ext.tabs.query({ highlighted: true, windowId: tab.windowId })).filter(
    isSendableTab,
  )
  if (group.length < 2 || !group.some((t) => t.id === tab.id)) return undefined
  return payloadsFromTabs(group)
}

/** Wired to ext.contextMenus.onClicked in the SW entry. */
export async function handleMenuClick(
  info: chrome.contextMenus.OnClickData,
  tab: chrome.tabs.Tab | undefined,
): Promise<void> {
  const id = String(info.menuItemId)
  if (id === PAIR_ID) {
    await ext.tabs.create({ url: ext.runtime.getURL('firstrun.html') })
    return
  }
  if (id === OPEN_CHOOSER_ID) {
    await ext.windows.create({
      type: 'popup',
      url: ext.runtime.getURL('chooser.html'),
      width: 360,
      height: 500,
    })
    return
  }
  if (id.startsWith(TAB_PREFIX)) {
    const targetId = id.slice(TAB_PREFIX.length)
    await sendToTarget(targetId, (await selectionForTab(tab)) ?? payloadFromTab(tab))
    return
  }
  if (id.startsWith(LINK_PREFIX)) {
    const targetId = id.slice(LINK_PREFIX.length)
    await sendToTarget(targetId, payloadFromLink(info))
  }
}
