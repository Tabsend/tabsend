import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import webpush from 'web-push'
import { buildExtension, EXTENSION_DIST } from './browser'
import { type BrandedChrome, launchBrandedChrome, PROFILE_CACHE_ROOT } from './cdp'
import { startTargetSite } from './proxy'
import { type RelayHandle, sleep, startRelay } from './relay'
import { createSender, mintPairingLink, type Sender, sendSealed, targetPubkey } from './sender'

/**
 * Reliability e2e — the push/latency suite on BRANDED Google Chrome (real Web
 * Push). Run with `pnpm e2e:push`; it pops Chrome windows (the test bench). The
 * fast Chromium suite (`pnpm e2e`) stays push-free.
 *
 * Setup: one relay with real VAPID keys, one branded-Chrome target loaded via CDP
 * `Extensions.loadUnpacked` (then CDP disconnected so the SW idles naturally), and
 * a node-side sender that seals with libsodium and POSTs over the API — no second
 * browser. Each scenario uses a UNIQUE target URL so the no-dupe assertion is
 * exact, and measures send→tab latency against the §3 bar.
 */

const RELAY_TTL_SECONDS = 30
const PROFILE = 'push-target'

/**
 * VAPID keys persist NEXT TO the cached profile: the browser's GCM subscription
 * is bound to the applicationServerKey it was created with, so reusing the keys
 * keeps the cached subscription valid across runs (one GCM check-in, stable
 * push — spike §6). The extension ALSO detects a rotated key and resubscribes,
 * so deleting vapid.json is safe, just slower on the next run.
 */
function loadOrCreateVapid(): { publicKey: string; privateKey: string } {
  mkdirSync(PROFILE_CACHE_ROOT, { recursive: true })
  const file = join(PROFILE_CACHE_ROOT, 'vapid.json')
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    const keys = webpush.generateVAPIDKeys()
    writeFileSync(file, JSON.stringify(keys))
    return keys
  }
}

let relay: RelayHandle
let chrome: BrandedChrome
let site: { url: string; stop(): Promise<void> }
let sender: Sender
let targetPk: string
let targetReg: { endpointId: string; deviceToken: string }
let pushLive = false
const results: string[] = []

const firstrunUrl = () => `chrome-extension://${chrome.extensionId}/firstrun.html`
const scenarioUrl = (name: string): string => `${site.url}?e2e=${name}`

async function evalOnFirstrun<T>(expression: string): Promise<T> {
  return chrome.evaluate<T>(firstrunUrl(), expression)
}

/** Ensure an extension page is open to evaluate storage/RPCs against. */
async function ensureFirstrunTab(): Promise<void> {
  if ((await chrome.countTabs(firstrunUrl())) === 0) {
    await chrome.openTab(firstrunUrl())
    await sleep(1200)
  }
}

async function drivePairTarget(): Promise<{ endpointId: string; deviceToken: string }> {
  await ensureFirstrunTab()
  // Clear the extension's storage first: the cached profile carries last run's
  // registration (a dead relay) — but the BROWSER-level push subscription
  // survives a storage clear, which is exactly what the persistent profile is
  // for (the extension re-adopts it because the VAPID key matches).
  const pairingLink = new URL(relay.firstRunPairingLink)
  const code = new URLSearchParams(pairingLink.hash.slice(1)).get('c')
  if (!code) throw new Error('First-run pairing link did not contain a code.')
  return evalOnFirstrun<{ endpointId: string; deviceToken: string }>(`(async () => {
    await chrome.storage.local.clear();
    await chrome.runtime.sendMessage({ type: 'joinGroup', relayUrl: ${JSON.stringify(relay.url)}, code: ${JSON.stringify(code)}, browserName: 'Chrome' });
    await chrome.runtime.sendMessage({ type: 'setDevice', deviceName: 'Push Target' });
    const bag = await chrome.storage.local.get('registration');
    return { endpointId: bag.registration.endpointId, deviceToken: bag.registration.deviceToken };
  })()`)
}

/** Poll storage for a REAL push subscription (endpoint not the register placeholder). */
async function waitForRealPush(timeoutMs: number): Promise<string | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const sub = await evalOnFirstrun<{ endpoint?: string } | null>(
      "(async () => (await chrome.storage.local.get('pushSubscription')).pushSubscription ?? null)()",
    ).catch(() => null)
    if (sub?.endpoint && !sub.endpoint.includes('placeholder')) return sub.endpoint
    await sleep(1000)
  }
  return null
}

/** Wait until a tab with `url` is open; returns elapsed ms (or throws on timeout). */
async function waitForTab(url: string, timeoutMs: number): Promise<number> {
  const start = Date.now()
  const deadline = start + timeoutMs
  while (Date.now() < deadline) {
    if ((await chrome.countTabs(url)) >= 1) return Date.now() - start
    await sleep(120)
  }
  throw new Error(`tab ${url} never opened within ${timeoutMs}ms`)
}

async function send(url: string): Promise<void> {
  await sendSealed(relay.url, sender, targetReg.endpointId, targetPk, url)
}

beforeAll(async () => {
  await buildExtension()
  const vapid = loadOrCreateVapid()
  ;[relay, site] = await Promise.all([
    startRelay({
      vapid,
      messageTtlSeconds: RELAY_TTL_SECONDS,
      sweepIntervalSeconds: 2,
      sweepGraceSeconds: 1,
    }),
    startTargetSite(),
  ])

  chrome = await launchBrandedChrome({ profileName: PROFILE, extensionPath: EXTENSION_DIST })
  targetReg = await drivePairTarget()

  // The sender joins the same group over the API and learns the target's pubkey.
  const pairingLink = await mintPairingLink(relay.url, targetReg.deviceToken)
  sender = await createSender(relay.url, pairingLink)
  targetPk = await targetPubkey(relay.url, sender.token, targetReg.endpointId)

  // Give the extension time to subscribe to real push + rotate it to the relay.
  const endpoint = await waitForRealPush(20_000)
  pushLive = endpoint !== null
  results.push(
    `push subscription: ${
      pushLive
        ? `LIVE (${endpoint?.slice(0, 40)}…)`
        : 'NOT established (delivery falls back to poll/WS)'
    }`,
  )
  await sleep(1500) // let the heartbeat rotation land server-side

  // Warm-up send establishes the offscreen WS + deliver caches, so the measured
  // foreground scenario reflects the warm fast path, not first-connection cost.
  const warm = scenarioUrl('warmup')
  await send(warm)
  await waitForTab(warm, 35_000)

  const targets = await chrome.list()
  const offscreenUp = targets.some((t) => t.url.includes('offscreen.html'))
  results.push(`offscreen WS document: ${offscreenUp ? 'present' : 'ABSENT'}`)
}, 210_000)

const RESULTS_FILE = join(tmpdir(), 'tabsend-push-results.txt')

afterAll(async () => {
  await chrome?.kill()
  await site?.stop()
  await relay?.stop()
  const summary = [
    '── push suite latency summary (bar: foreground <1s, cold-wake <5s) ──',
    ...results,
  ].join('\n')
  writeFileSync(RESULTS_FILE, `${summary}\n`)
  process.stdout.write(`\n${summary}\n(also written to ${RESULTS_FILE})\n`)
})

describe('reliability — branded Chrome push/latency', () => {
  it('(3) foreground: send → tab opens fast (WS/push fast path)', async () => {
    const url = scenarioUrl('foreground')
    const t0 = Date.now()
    await send(url)
    await waitForTab(url, 15_000)
    const total = Date.now() - t0
    results.push(`(3) foreground send→tab: ${total} ms (bar <1000 ms)`)
    await sleep(800)
    expect(await chrome.countTabs(url)).toBe(1) // no dupes
    expect(total).toBeLessThan(1000) // §3 foreground bar
  }, 60_000)

  it('(2) SW idle-terminated: send → wakes → tab opens (cold budget)', async () => {
    const url = scenarioUrl('coldwake')
    // Wait for the service worker to idle-terminate (spike liveness signal).
    const idleDeadline = Date.now() + 150_000
    let idled = false
    while (Date.now() < idleDeadline) {
      if (!(await chrome.swAlive())) {
        idled = true
        break
      }
      await sleep(2000)
    }
    const t0 = Date.now()
    await send(url)
    await waitForTab(url, 40_000)
    const total = Date.now() - t0
    results.push(
      `(2) cold-wake send→tab: ${total} ms (SW idled: ${idled}; bar <5000 ms; push ${pushLive ? 'live' : 'off'})`,
    )
    await sleep(800)
    expect(await chrome.countTabs(url)).toBe(1)
    expect(total).toBeLessThan(5000) // §3 cold-wake bar
  }, 210_000)

  it('(4) WS severed mid-flight: message still arrives via push/poll', async () => {
    const url = scenarioUrl('wsdown')
    await chrome.closeOffscreen() // sever the fast-path socket
    await sleep(300)
    await send(url)
    const elapsed = await waitForTab(url, 40_000)
    results.push(
      `(4) delivery with WS severed: ${elapsed} ms (correctness independent of the socket)`,
    )
    await sleep(800)
    expect(await chrome.countTabs(url)).toBe(1)
  }, 90_000)

  it('(1) target killed → send → relaunch → tab opens from boot poll', async () => {
    const url = scenarioUrl('killed')
    await chrome.kill()
    await sleep(500)
    await send(url) // queued server-side while the target is dead
    const t0 = Date.now()
    chrome = await launchBrandedChrome({ profileName: PROFILE, extensionPath: EXTENSION_DIST })
    await waitForTab(url, 40_000)
    results.push(`(1) killed→relaunch→boot-poll: ${Date.now() - t0} ms`)
    await sleep(800)
    expect(await chrome.countTabs(url)).toBe(1)
  }, 120_000)

  it('(6) TTL-expired message is never delivered', async () => {
    const url = scenarioUrl('expired')
    await chrome.kill() // nothing can pull the message before it expires
    await sleep(500)
    await send(url)
    await sleep((RELAY_TTL_SECONDS + 6) * 1000) // past TTL + a sweep
    chrome = await launchBrandedChrome({ profileName: PROFILE, extensionPath: EXTENSION_DIST })
    await sleep(8000) // boot poll + settle
    results.push('(6) TTL-expired: no tab opened (expired never delivered)')
    expect(await chrome.countTabs(url)).toBe(0)
  }, 120_000)
})
