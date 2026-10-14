import type { ClientSettings } from '@tabsend/shared'
import { ext } from '../lib/ext'
import {
  EXTENSION_DEFAULT_SETTINGS,
  getSettings,
  getStoredSettings,
  setStoredSettings,
} from '../lib/storage'
import { rebuildMenus } from './menus'

/**
 * Client settings + the toolbar-click mode wiring (ADR-0008 §2.2/§7). The mode
 * is applied by flipping the action popup at runtime — no reinstall, no manifest
 * change: Chooser mode sets `action.setPopup('chooser.html')` (click opens the
 * rich chooser, [0001] verbatim); Quick-send clears the popup so the click fires
 * `action.onClicked` → send to primary.
 */

export async function applyToolbarMode(settings?: ClientSettings): Promise<void> {
  const s = settings ?? (await getSettings())
  const action = ext.action
  if (!action?.setPopup) return
  try {
    await action.setPopup({ popup: s.toolbarClickMode === 'quicksend' ? '' : 'chooser.html' })
  } catch {
    // action API unavailable in this context — harmless; default_popup stands.
  }
}

/**
 * Merge a partial settings patch, persist, and re-apply anything mode-sensitive.
 * Only the keys the user has set are stored, so a default can change later
 * without overriding anyone's choice (storage.ts SETTINGS_VERSION).
 */
export async function updateSettings(patch: Partial<ClientSettings>): Promise<ClientSettings> {
  const stored = { ...(await getStoredSettings()), ...patch }
  await setStoredSettings(stored)
  const next = { ...EXTENSION_DEFAULT_SETTINGS, ...stored }
  await applyToolbarMode(next)
  // The context-menu visibility toggle + toolbar mode both change the menus.
  await rebuildMenus()
  return next
}
