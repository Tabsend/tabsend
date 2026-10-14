import { type ChildProcess, spawn } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { freePort, sleep } from './relay'

/**
 * Branded-Chrome launcher for the push/latency suite (spike §6). Stable Chrome
 * ≥137 ignores `--load-extension`, so we load the built extension over CDP with
 * `Extensions.loadUnpacked` (requires `--enable-unsafe-extension-debugging`) and
 * then DISCONNECT the CDP socket — an attached debugger keeps the service worker
 * alive and would falsify cold-wake/idle-termination measurements.
 *
 * Persistent profiles are cached OUTSIDE the repo (~/.cache/tabsend-e2e-profiles)
 * so the GCM check-in survives runs: only branded Chrome ships the Google
 * push-service keys, and rapidly minting fresh profiles trips GCM rate-limiting
 * (PHONE_REGISTRATION_ERROR). Reusing one profile = one check-in = reliable push.
 *
 * Cleanup: profiles persist by design. `pnpm e2e:push` reuses them; delete the
 * cache dir to force a fresh GCM check-in:  rm -rf ~/.cache/tabsend-e2e-profiles
 */

export const PROFILE_CACHE_ROOT =
  process.env.TABSEND_E2E_PROFILE_DIR ?? join(homedir(), '.cache', 'tabsend-e2e-profiles')

const CHROME_BIN =
  process.env.CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

/** A minimal CDP target as reported by GET /json/list. */
export interface CdpTarget {
  type: string
  url: string
  title: string
  id: string
  webSocketDebuggerUrl?: string
}

export interface BrandedChrome {
  port: number
  extensionId: string
  userDataDir: string
  /** Live targets (pages, service workers, …) via the HTTP endpoint — no attach. */
  list(): Promise<CdpTarget[]>
  /** Open a URL as a new tab. */
  openTab(url: string): Promise<void>
  /** Evaluate JS in a target's context (attaches, evaluates, detaches). */
  evaluate<T>(targetUrl: string, expression: string): Promise<T>
  /** True while the extension's service worker target is alive (spike liveness signal). */
  swAlive(): Promise<boolean>
  /** Count open tabs whose URL exactly equals `url`. */
  countTabs(url: string): Promise<number>
  /** Force-close the offscreen document (severs the fast-path WebSocket). */
  closeOffscreen(): Promise<boolean>
  /** Kill the browser process, keeping the profile dir. */
  kill(): Promise<void>
}

/** One-shot CDP request/response over a fresh WebSocket (opens, sends, closes). */
async function cdpCall(
  wsUrl: string,
  commands: Array<{ method: string; params?: unknown; sessionId?: string }>,
): Promise<unknown[]> {
  const ws = new WebSocket(wsUrl)
  const results: unknown[] = []
  const pending = new Map<number, (v: unknown) => void>()
  let nextId = 1

  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve())
    ws.addEventListener('error', () => reject(new Error('cdp ws error')))
  })

  ws.addEventListener('message', (ev: MessageEvent) => {
    const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data))
    if (msg.id && pending.has(msg.id)) {
      const resolve = pending.get(msg.id)
      pending.delete(msg.id)
      resolve?.(msg.error ? { error: msg.error } : msg.result)
    }
  })

  for (const cmd of commands) {
    const id = nextId++
    const result = await new Promise<unknown>((resolve) => {
      pending.set(id, resolve)
      ws.send(
        JSON.stringify({
          id,
          method: cmd.method,
          params: cmd.params ?? {},
          sessionId: cmd.sessionId,
        }),
      )
    })
    results.push(result)
  }

  ws.close()
  return results
}

async function httpJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  return (await res.json()) as T
}

async function browserWsUrl(port: number): Promise<string> {
  const info = await httpJson<{ webSocketDebuggerUrl: string }>(
    `http://127.0.0.1:${port}/json/version`,
  )
  return info.webSocketDebuggerUrl
}

/**
 * Launch branded Chrome with a persistent profile, load the unpacked extension
 * over CDP, then drop the CDP connection so the SW lifecycle is natural.
 */
export async function launchBrandedChrome(opts: {
  profileName: string
  extensionPath: string
}): Promise<BrandedChrome> {
  mkdirSync(PROFILE_CACHE_ROOT, { recursive: true })
  const userDataDir = join(PROFILE_CACHE_ROOT, opts.profileName)
  const port = await freePort()

  const child: ChildProcess = spawn(
    CHROME_BIN,
    [
      `--user-data-dir=${userDataDir}`,
      `--remote-debugging-port=${port}`,
      '--enable-unsafe-extension-debugging',
      '--no-first-run',
      '--no-default-browser-check',
      '--hide-crash-restore-bubble',
      '--disable-features=Translate',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  )
  child.stderr?.on('data', () => {
    // Chrome prints DEPRECATED_ENDPOINT / PHONE_REGISTRATION_ERROR even on
    // success (spike §6) — not diagnostic; swallow.
  })

  // Wait for the DevTools endpoint.
  const deadline = Date.now() + 30_000
  let wsUrl = ''
  while (Date.now() < deadline) {
    try {
      wsUrl = await browserWsUrl(port)
      if (wsUrl) break
    } catch {
      await sleep(200)
    }
  }
  if (!wsUrl) throw new Error('branded Chrome DevTools endpoint never came up')

  const list = () => httpJson<CdpTarget[]>(`http://127.0.0.1:${port}/json/list`)
  const t0 = Date.now()
  const trace = (msg: string): void => {
    if (process.env.TABSEND_E2E_TRACE) {
      process.stdout.write(`[launch +${Date.now() - t0}ms] ${msg}\n`)
    }
  }

  // SNAPSHOT pre-existing pages BEFORE loading the extension. The persistent
  // profile session-restores LAST run's tabs (stale site tabs would pollute tab
  // counts; stale extension pages are dead contexts `evaluate` could latch onto).
  // But the extension's boot poll can legitimately DELIVER a tab at any moment
  // during launch — the chunk-5a scenario-(1) bug was this cleanup closing a
  // just-delivered (already-acked, seen-set-guarded ⇒ never redelivered) tab as
  // if it were restored. Restored pages exist at DevTools-up; delivered tabs
  // cannot (the SW needs storage reads + two relay round-trips + tabs.create
  // first), so an early id snapshot separates the two deterministically.
  const preExistingPageIds = new Set(
    (await list()).filter((t) => t.type === 'page').map((t) => t.id),
  )
  trace(`page snapshot before load: ${preExistingPageIds.size} page(s)`)

  // Load the unpacked extension, capture its id, then disconnect.
  const [loaded] = await cdpCall(wsUrl, [
    { method: 'Extensions.loadUnpacked', params: { path: opts.extensionPath } },
  ])
  const extensionId = (loaded as { id?: string; error?: unknown }).id
  if (!extensionId) {
    throw new Error(`Extensions.loadUnpacked failed: ${JSON.stringify(loaded)}`)
  }
  trace(`extension loaded: ${extensionId}`)

  // FRESHNESS VERIFICATION — replaces the forced `chrome.runtime.reload()` of
  // chunks 3–5a. History (chunk 5a, hard-won): issuing the reload from a CDP
  // evaluate was doubly broken — (a) the evaluate races the SW's chrome.*
  // bindings install (~100 ms window; landing early throws and silently issues
  // NO reload → 20 s stall during which the boot poll delivers, and the old
  // cleanup then closed the delivered tab); (b) retrying until it "succeeds"
  // could WEDGE the extension outright (SW tears down and never returns). And
  // the manifest.version stamp alone proved only PROBABILISTIC at busting the
  // worker-script cache (one run updated cleanly; the next served the previous
  // run's cached worker for the new manifest).
  //
  // The rig now needs NO reload: buildExtension() rotates the worker FILENAME
  // per build, so a stale cache can never serve the new URL (see browser.ts).
  // This block only PROVES it: wait for the running worker to report this
  // build's `__tabsendBuild` tag, and fail loudly otherwise — the suite must
  // never silently test stale code. The tag probe is a plain JS global (no
  // chrome.* bindings), so the bindings window merely reads as "not evaluated
  // yet" and is absorbed by the retry; the manifest version rides along purely
  // as mismatch diagnostics.
  const expectedBuild = (
    JSON.parse(readFileSync(join(opts.extensionPath, 'manifest.json'), 'utf8')) as {
      version: string
    }
  ).version
  const swTargetOf = async (): Promise<CdpTarget | undefined> =>
    (await list()).find((t) => t.type === 'service_worker' && t.url.includes(extensionId))
  {
    const deadline = Date.now() + 20_000
    let lastSeen = ''
    while (Date.now() < deadline) {
      const sw = await swTargetOf()
      if (sw?.webSocketDebuggerUrl) {
        const [res] = await cdpCall(sw.webSocketDebuggerUrl, [
          {
            method: 'Runtime.evaluate',
            params: {
              expression:
                'JSON.stringify({build:String(globalThis.__tabsendBuild||""),manifest:(globalThis.chrome&&chrome.runtime&&chrome.runtime.getManifest)?chrome.runtime.getManifest().version:""})',
              returnByValue: true,
            },
          },
        ]).catch(() => [undefined])
        const raw = (res as { result?: { value?: string } } | undefined)?.result?.value
        if (raw) {
          lastSeen = raw
          try {
            if ((JSON.parse(raw) as { build?: string }).build === expectedBuild) break
          } catch {
            // unparsable probe — retry
          }
        }
      }
      await sleep(200)
    }
    let verified = false
    try {
      verified = (JSON.parse(lastSeen) as { build?: string }).build === expectedBuild
    } catch {
      verified = false
    }
    if (!verified) {
      throw new Error(
        `extension SW build mismatch after 20s: expected ${expectedBuild}, last probe ${lastSeen || '(no tagged worker seen)'} — stale worker or extension wedged; see e2e/src/browser.ts filename-rotation notes`,
      )
    }
    trace(`sw build verified: ${expectedBuild}`)
  }

  // Close ONLY pages from the pre-load snapshot (restored tabs), plus any stale
  // extension pages (dead contexts restored from a previous session). A tab the
  // boot poll delivered during launch matches neither and is left alone.
  {
    const browserWs = await browserWsUrl(port)
    const toClose = (await list()).filter(
      (t) =>
        t.type === 'page' &&
        t.url !== 'about:blank' &&
        (preExistingPageIds.has(t.id) || t.url.startsWith(`chrome-extension://${extensionId}/`)),
    )
    trace(`cleanup closing ${toClose.length} page(s): ${toClose.map((p) => p.url).join(' | ')}`)
    for (const page of toClose) {
      await cdpCall(browserWs, [
        { method: 'Target.closeTarget', params: { targetId: page.id } },
      ]).catch(() => undefined)
    }
  }
  trace('launch complete')

  return {
    port,
    extensionId,
    userDataDir,
    list,
    async openTab(url: string) {
      const ws = await browserWsUrl(port)
      await cdpCall(ws, [{ method: 'Target.createTarget', params: { url } }])
    },
    async evaluate<T>(targetUrl: string, expression: string): Promise<T> {
      // Extension page contexts have the same bindings-install window as the SW
      // (see the reload TIMING TRAP above): for the first ~100 ms after a page
      // target appears — and again right after a runtime.reload() recreates it —
      // `chrome.*` is undefined and any expression touching it throws. Retry
      // until the bindings are provably installed; rethrow real errors.
      // Additional trap: a crashed/interrupted previous run leaves the persistent
      // profile session-restoring a DEAD page at the SAME extension URL — dead
      // restored contexts never receive bindings. `find()` would latch onto the
      // corpse forever, so consider EVERY page matching the URL and use whichever
      // proves its bindings live; the timing window heals within ~100 ms, corpses
      // never do.
      const deadline = Date.now() + 10_000
      let lastErr = 'no page target ever appeared'
      while (Date.now() < deadline) {
        const targets = await list()
        const candidates = targets.filter((t) => t.type === 'page' && t.url === targetUrl)
        if (candidates.length === 0) {
          lastErr = `no page target for ${targetUrl}`
          await sleep(150)
          continue
        }
        for (const target of candidates) {
          if (!target.webSocketDebuggerUrl) continue
          // Probe first: attach to the PAGE target's own debugger URL (not the
          // SW's), so the service worker can still idle-terminate naturally.
          const [probe] = await cdpCall(target.webSocketDebuggerUrl, [
            {
              method: 'Runtime.evaluate',
              params: {
                expression: "typeof chrome !== 'undefined' && !!chrome.storage && !!chrome.runtime",
                returnByValue: true,
              },
            },
          ])
          if ((probe as { result?: { value?: boolean } }).result?.value !== true) {
            lastErr = `page target ${target.id} for ${targetUrl} has no live chrome bindings`
            continue
          }
          const [res] = await cdpCall(target.webSocketDebuggerUrl, [
            {
              method: 'Runtime.evaluate',
              params: { expression, awaitPromise: true, returnByValue: true },
            },
          ])
          const r = res as { result?: { value?: T }; error?: unknown; exceptionDetails?: unknown }
          if (r.error || r.exceptionDetails) {
            // Bindings were provably live ⇒ genuine failure: throw immediately.
            throw new Error(`evaluate failed: ${JSON.stringify(r.error ?? r.exceptionDetails)}`)
          }
          return r.result?.value as T
        }
        await sleep(150)
      }
      throw new Error(`${lastErr} (after 10s of bindings-not-ready retries)`)
    },
    async swAlive() {
      const targets = await list()
      return targets.some((t) => t.type === 'service_worker' && t.url.includes(extensionId))
    },
    async countTabs(url: string) {
      const targets = await list()
      return targets.filter((t) => t.type === 'page' && t.url === url).length
    },
    async closeOffscreen() {
      const targets = await list()
      const off = targets.find((t) => t.url.includes('offscreen.html'))
      if (!off) return false
      const ws = await browserWsUrl(port)
      await cdpCall(ws, [{ method: 'Target.closeTarget', params: { targetId: off.id } }])
      return true
    },
    async kill() {
      child.kill('SIGKILL')
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve()
        child.once('exit', () => resolve())
        setTimeout(resolve, 3000)
      })
    },
  }
}
