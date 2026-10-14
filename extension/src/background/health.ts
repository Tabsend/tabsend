import { setTransportHandler } from '../lib/api'
import type { RelayHealth } from '../lib/health'
import { getRelayHealth, setRelayHealth } from '../lib/storage'
import { currentSession } from './session'

/**
 * Relay reachability, recorded from ordinary traffic.
 *
 * Every non-probe API call reports whether the relay answered (api.ts's
 * transport handler). We keep the verdict in storage so a surface opened later
 * — the chooser, ten minutes into an outage — can say WHY nothing is arriving,
 * instead of rendering a healthy-looking device list while every send piles up
 * in the outbound queue (dogfood 2026-07-29).
 *
 * No probe of its own: the poll alarm already talks to the relay every 30–60s,
 * so this is fresh for free. Correctness never depends on it — it is purely
 * what the UI is allowed to claim.
 */

/** Same-state writes are throttled to this; transitions always write. */
const REFRESH_MS = 20_000

/** SW-lifetime mirror, so a burst of calls doesn't mean a burst of writes. */
let cached: RelayHealth | undefined
let lastWrite = 0

export function registerRelayHealthTracking(): void {
  setTransportHandler((relayUrl, reachable) => {
    void recordRelayContact(relayUrl, reachable)
  })
}

/**
 * Fold one call's outcome into the stored verdict. Calls aimed at a URL that
 * ISN'T our registered relay (onboarding's /v1/config against a candidate
 * address, a relay-change check) are ignored: they say nothing about the relay
 * we're actually registered to, and letting them write would make a typo in the
 * "change address" box look like an outage.
 */
export async function recordRelayContact(relayUrl: string, reachable: boolean): Promise<void> {
  const session = await currentSession()
  if (!session || session.registration.relayUrl !== relayUrl) return

  const now = Date.now()
  const prev = cached ?? (await getRelayHealth())
  const sameState = prev?.relayUrl === relayUrl && prev.reachable === reachable
  if (sameState && now - lastWrite < REFRESH_MS) {
    // Keep the in-memory copy current even when we skip the write, so a later
    // transition still compares against the truth.
    if (reachable && cached) cached = { ...cached, lastOkAt: new Date(now).toISOString() }
    return
  }

  const health: RelayHealth = {
    relayUrl,
    reachable,
    // `since` marks when THIS state began — it must survive same-state refreshes,
    // or an outage would perpetually read as "started just now" and never clear
    // the grace period that gates the outage warning.
    since: sameState && prev ? prev.since : new Date(now).toISOString(),
  }
  const lastOkAt = reachable ? new Date(now).toISOString() : prev?.lastOkAt
  if (lastOkAt) health.lastOkAt = lastOkAt

  cached = health
  lastWrite = now
  await setRelayHealth(health)
}

/** The current verdict (storage-backed, so it survives worker restarts). */
export async function relayHealth(): Promise<RelayHealth | undefined> {
  return cached ?? (await getRelayHealth())
}

/** Drop the in-memory mirror — used when the registration changes underneath us. */
export function resetRelayHealthCache(): void {
  cached = undefined
  lastWrite = 0
}
