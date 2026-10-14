import type { Endpoint, SourcePrefs } from '@tabsend/shared'
import { getPrefs, setPrefs } from '../lib/storage'

const MAX_RECENTS = 12

/**
 * SourcePrefs are DEVICE-LOCAL (ADR-0009) — MRU + primary live only here, never
 * on the relay. `recentTargetIds` is refreshed on each send; `primaryTargetId`
 * tracks MRU unless the user pinned it (pinning is a Chunk-5 setting).
 */
export async function recordSend(targetEndpointId: string): Promise<void> {
  const prefs = await getPrefs()
  const recents = [
    targetEndpointId,
    ...prefs.recentTargetIds.filter((id) => id !== targetEndpointId),
  ]
  const next: SourcePrefs = {
    primaryPinned: prefs.primaryPinned,
    primaryTargetId: prefs.primaryPinned
      ? prefs.primaryTargetId
      : (targetEndpointId as SourcePrefs['primaryTargetId']),
    recentTargetIds: recents.slice(0, MAX_RECENTS) as SourcePrefs['recentTargetIds'],
  }
  await setPrefs(next)
}

/**
 * Choose the per-source primary target, optionally PINNING it (ADR-0002 §7).
 * Choosing sets `primaryTargetId`; pinning stops it tracking MRU. Unpinning
 * (pinned=false) keeps the choice but lets a later send's MRU move it again.
 */
export async function setPrimary(targetEndpointId: string, pinned: boolean): Promise<void> {
  const prefs = await getPrefs()
  await setPrefs({
    ...prefs,
    primaryTargetId: targetEndpointId as SourcePrefs['primaryTargetId'],
    primaryPinned: pinned,
  })
}

/** Order targets: primary/pinned → MRU recents → the rest alphabetically (ADR-0002). */
export function orderTargets(targets: Endpoint[], prefs: SourcePrefs): Endpoint[] {
  const rank = new Map<string, number>()
  prefs.recentTargetIds.forEach((id, i) => {
    rank.set(id, i)
  })
  return [...targets].sort((a, b) => {
    if (prefs.primaryTargetId) {
      if (a.id === prefs.primaryTargetId) return -1
      if (b.id === prefs.primaryTargetId) return 1
    }
    const ra = rank.get(a.id)
    const rb = rank.get(b.id)
    if (ra !== undefined && rb !== undefined) return ra - rb
    if (ra !== undefined) return -1
    if (rb !== undefined) return 1
    return a.label.localeCompare(b.label)
  })
}
