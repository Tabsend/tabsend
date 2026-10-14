import type { ClientSettings } from '@tabsend/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The arrival notification went from off-by-default to on (2026-10-07). Before
 * that, changing ANY setting stored every setting, so a stored
 * `notifyOnReceive: false` cannot say whether someone chose it. These pin who
 * ends up with what, and that a choice made from now on is never overridden.
 */

const local: Record<string, unknown> = {}

vi.mock('./ext', () => ({
  ext: {
    storage: {
      local: {
        get: vi.fn(async (keys: string | string[]) => {
          const out: Record<string, unknown> = {}
          for (const k of Array.isArray(keys) ? keys : [keys]) if (k in local) out[k] = local[k]
          return structuredClone(out)
        }),
        set: vi.fn(async (bag: Record<string, unknown>) => {
          Object.assign(local, structuredClone(bag))
        }),
        remove: vi.fn(async () => {}),
      },
    },
    action: {},
  },
}))
vi.mock('../background/menus', () => ({ rebuildMenus: vi.fn(async () => {}) }))

const { getSettings, migrateSettingsV1, SETTINGS_VERSION } = await import('./storage')
const { updateSettings } = await import('../background/settings')

/** Exactly what the pre-2026-10-07 `updateSettings` wrote after any change. */
const v1Blob = (over: Record<string, unknown> = {}): Partial<ClientSettings> => ({
  toolbarClickMode: 'chooser' as const,
  showSuccessToast: true,
  showPendingRow: true,
  contextMenusVisible: true,
  searchThreshold: 7,
  hotkeys: { openChooser: 'Ctrl+Shift+S', sendToPrimary: null },
  notifyOnReceive: false,
  ...over,
})

beforeEach(() => {
  for (const k of Object.keys(local)) delete local[k]
})

describe('notifyOnReceive default and the settings-version migration', () => {
  it('is on for a new install, and marks the store as version 2', async () => {
    expect((await getSettings()).notifyOnReceive).toBe(true)
    expect(local.settingsVersion).toBe(SETTINGS_VERSION)
    expect(local.settings).toBeUndefined()
  })

  it('is on for an old blob that never had the key (saved before it existed)', async () => {
    const { notifyOnReceive: _, ...older } = v1Blob({ toolbarClickMode: 'quicksend' })
    local.settings = older
    const s = await getSettings()
    expect(s.notifyOnReceive).toBe(true)
    expect(s.toolbarClickMode).toBe('quicksend')
  })

  it('turns an ambiguous version-1 false on once, keeping real choices', async () => {
    local.settings = v1Blob({ showSuccessToast: false })
    const s = await getSettings()
    expect(s.notifyOnReceive).toBe(true)
    expect(s.showSuccessToast).toBe(false)
    expect(local.settings).toEqual({ showSuccessToast: false })
  })

  it('keeps an explicit on from a version-1 blob', async () => {
    local.settings = v1Blob({ notifyOnReceive: true })
    expect((await getSettings()).notifyOnReceive).toBe(true)
  })

  it('never re-runs: an off chosen after the migration stays off', async () => {
    local.settings = v1Blob()
    await getSettings()
    await updateSettings({ notifyOnReceive: false })
    expect(local.settings).toEqual({ notifyOnReceive: false })
    expect((await getSettings()).notifyOnReceive).toBe(false)
    // And a later unrelated change does not disturb it.
    await updateSettings({ showPendingRow: false })
    expect(await getSettings()).toMatchObject({ notifyOnReceive: false, showPendingRow: false })
  })

  it('stores only what the user set, so future defaults stay changeable', async () => {
    const next = await updateSettings({ toolbarClickMode: 'quicksend' })
    expect(local.settings).toEqual({ toolbarClickMode: 'quicksend' })
    expect(next.notifyOnReceive).toBe(true)
  })

  it('compares nested values by content, not identity', () => {
    expect(migrateSettingsV1(v1Blob())).toEqual({})
    expect(
      migrateSettingsV1(v1Blob({ hotkeys: { openChooser: 'Ctrl+Shift+S', sendToPrimary: 'X' } })),
    ).toEqual({ hotkeys: { openChooser: 'Ctrl+Shift+S', sendToPrimary: 'X' } })
    expect(migrateSettingsV1(undefined)).toBeUndefined()
  })
})
