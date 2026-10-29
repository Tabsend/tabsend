import { spawn } from 'node:child_process'
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type BrowserContext, chromium } from 'playwright'
import { REPO_ROOT } from './relay'

/** Where `pnpm --filter @tabsend/extension build` puts the loadable extension. */
export const EXTENSION_DIST = join(REPO_ROOT, 'extension', 'dist')

/**
 * Build the extension once per rig run (fast — a second or two), then stamp a
 * unique manifest version AND rotate the service-worker FILENAME to match.
 *
 * Why both: Chromium caches an unpacked MV3 service worker's SCRIPT by URL, and
 * a persistent profile can keep executing LAST run's worker across a relaunch.
 * The chunk-4 rig bumped manifest.version to force an extension update — but
 * that proved only PROBABILISTIC (chunk 5a observed a run where the updated
 * manifest was served with the previous run's cached worker), and the
 * belt-and-braces `chrome.runtime.reload()` issued over CDP could WEDGE the
 * extension outright. Rotating the filename is deterministic by construction:
 * `background-<stamp>.js` has never existed before, so no cache can serve stale
 * code for it; a same-build relaunch reuses the same URL where cached bytes are
 * identical anyway. No CDP mutation of the extension is needed at all.
 *
 * The stamp is also baked into the worker as `globalThis.__tabsendBuild` so the
 * launcher can PROVE the running worker executes this build (cdp.ts fails
 * loudly on mismatch instead of silently testing stale code).
 */
export async function buildExtension(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('pnpm', ['--filter', '@tabsend/extension', 'build'], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr?.on('data', (c: Buffer) => {
      stderr += String(c)
    })
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`extension build failed:\n${stderr}`)),
    )
  })

  const manifestPath = join(EXTENSION_DIST, 'manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    version: string
    background?: { service_worker?: string }
    host_permissions?: string[]
  }
  const now = Date.now()
  // Four dot-separated integers, each < 65536, strictly increasing across runs.
  manifest.version = `0.1.${Math.floor(now / 60_000) % 65_535}.${Math.floor(now / 1000) % 60_000}`

  // Rotate the worker filename to the stamp (vite emptied the out dir, so there
  // is exactly one worker file) and bake the build tag into it.
  const swName = `background-${manifest.version}.js`
  renameSync(join(EXTENSION_DIST, 'background.js'), join(EXTENSION_DIST, swName))
  if (manifest.background) manifest.background.service_worker = swName
  appendFileSync(
    join(EXTENSION_DIST, swName),
    `\n;globalThis.__tabsendBuild=${JSON.stringify(manifest.version)};\n`,
  )
  // The rig's relay and test pages are on 127.0.0.1. A user grants their relay's
  // address at pairing, in a browser prompt a test can't click, so the rig's
  // build is granted it up front, as it would be after a "yes". The prompt itself
  // is covered by the unit tests (relay-access, firstrun, options).
  manifest.host_permissions = [...(manifest.host_permissions ?? []), 'http://127.0.0.1/*']
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
}

export interface Profile {
  context: BrowserContext
  extensionId: string
  userDataDir: string
  /** Close the browser but KEEP the user-data dir (for restart tests). */
  close(): Promise<void>
  /** Close and delete the profile dir. */
  dispose(): Promise<void>
}

/**
 * Launch one isolated Chrome profile with the built extension loaded.
 *
 * Chunk-3 technique: Playwright's bundled Chromium honors `--load-extension`
 * (unlike stable branded Chrome ≥137), and no Web Push is needed yet, so this is
 * the simple path. Chunk 4 (push wake) swaps THIS function for a branded-Chrome
 * launcher using CDP `Extensions.loadUnpacked` + `--enable-unsafe-extension-
 * debugging` (see docs/spikes/transport.md §6) — the rest of the rig only sees
 * the `Profile` interface.
 */
export async function launchProfile(userDataDir?: string): Promise<Profile> {
  const dir = userDataDir ?? mkdtempSync(join(tmpdir(), 'tabsend-e2e-profile-'))
  const context = await chromium.launchPersistentContext(dir, {
    // channel 'chromium' = the full browser in new-headless mode; the default
    // headless shell does not support extensions.
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${EXTENSION_DIST}`, `--load-extension=${EXTENSION_DIST}`],
  })

  // The MV3 service worker is the one chrome-extension:// worker in the context.
  let [worker] = context.serviceWorkers()
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 })
  const extensionId = new URL(worker.url()).host

  return {
    context,
    extensionId,
    userDataDir: dir,
    close: () => context.close(),
    async dispose() {
      await context.close().catch(() => undefined)
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

export function extUrl(profile: Profile, path: string): string {
  return `chrome-extension://${profile.extensionId}/${path}`
}

/** Poll until `fn` returns a truthy value (rig-wide waiting primitive). */
export async function until<T>(
  fn: () => Promise<T | undefined | false> | T | undefined | false,
  opts: { timeoutMs?: number; intervalMs?: number; what?: string } = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 15_000
  const intervalMs = opts.intervalMs ?? 200
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${opts.what ?? 'condition'} (${timeoutMs}ms)`)
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}
