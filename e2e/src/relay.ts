import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/** Repo root, resolved from this file (e2e/src/relay.ts → ../..). */
export const REPO_ROOT = resolve(import.meta.dirname, '..', '..')

export interface RelayHandle {
  /** Base URL of the live relay, e.g. http://127.0.0.1:53211 */
  url: string
  port: number
  /** First-device pairing link printed by a fresh single-group relay. */
  firstRunPairingLink: string
  stop(): Promise<void>
}

export interface RelayOptions {
  /** Real VAPID keys → the relay actually push-wakes (the push suite). */
  vapid?: { publicKey: string; privateKey: string; subject?: string }
  /** Message TTL in seconds (short values exercise expiry). */
  messageTtlSeconds?: number
  /** Sweeper cadence in seconds. */
  sweepIntervalSeconds?: number
  /** Grace before an expired tombstone is pruned, in seconds. */
  sweepGraceSeconds?: number
  /** Reuse a fixed DB path so a relay restart keeps registrations. */
  dbPath?: string
}

/**
 * Spawn the real chunk-2/4 relay (`server/src/server.ts` via tsx) on an ephemeral
 * port with a SQLite database — the same process a self-hoster runs, not an
 * in-process test double. Options configure VAPID push + TTL for the push suite.
 */
export async function startRelay(options: RelayOptions = {}): Promise<RelayHandle> {
  const dir = mkdtempSync(join(tmpdir(), 'tabsend-e2e-relay-'))
  const port = await freePort()
  const serverDir = join(REPO_ROOT, 'server')
  const tsxBin = join(serverDir, 'node_modules', '.bin', 'tsx')

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(port),
    DATABASE_URL: `sqlite:${options.dbPath ?? join(dir, 'e2e.db')}`,
    PUBLIC_RELAY_URL: `http://127.0.0.1:${port}`,
  }
  if (options.vapid) {
    env.VAPID_PUBLIC_KEY = options.vapid.publicKey
    env.VAPID_PRIVATE_KEY = options.vapid.privateKey
    env.VAPID_SUBJECT = options.vapid.subject ?? 'mailto:e2e@tabsend.local'
  }
  if (options.messageTtlSeconds !== undefined) {
    env.MESSAGE_TTL_SECONDS = String(options.messageTtlSeconds)
  }
  if (options.sweepIntervalSeconds !== undefined) {
    env.SWEEP_INTERVAL_SECONDS = String(options.sweepIntervalSeconds)
  }
  if (options.sweepGraceSeconds !== undefined) {
    env.SWEEP_GRACE_SECONDS = String(options.sweepGraceSeconds)
  }

  const child: ChildProcess = spawn(tsxBin, ['src/server.ts'], {
    cwd: serverDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write(`[relay] ${chunk}`)
  })
  // Surface WARN+ relay logs (Fastify JSON on stdout; level 40 = warn) — e.g.
  // 'push wake failed' — without flooding the rig output with request logs.
  let stdoutBuf = ''
  let firstRunPairingLink: string | undefined
  child.stdout?.on('data', (chunk: Buffer) => {
    stdoutBuf += String(chunk)
    const lines = stdoutBuf.split('\n')
    stdoutBuf = lines.pop() ?? ''
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as {
          level?: number
          msg?: string
          err?: { message?: string }
          pairingLink?: string
        }
        if (entry.pairingLink) firstRunPairingLink = entry.pairingLink
        if ((entry.level ?? 0) >= 40) {
          process.stderr.write(`[relay:warn] ${entry.msg ?? ''} ${entry.err?.message ?? ''}\n`)
        }
      } catch {
        // non-JSON boot lines — ignore
      }
    }
  })

  const url = `http://127.0.0.1:${port}`
  await waitForHttp(url, child)
  await untilFirstRunPairingLink(() => firstRunPairingLink, child)

  return {
    url,
    port,
    firstRunPairingLink: firstRunPairingLink as string,
    async stop() {
      child.kill('SIGTERM')
      await new Promise<void>((resolveExit) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL')
          resolveExit()
        }, 3000)
        child.once('exit', () => {
          clearTimeout(timer)
          resolveExit()
        })
      })
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

async function untilFirstRunPairingLink(
  read: () => string | undefined,
  child: ChildProcess,
): Promise<void> {
  const deadline = Date.now() + 3000
  while (!read()) {
    if (child.exitCode !== null)
      throw new Error('Relay exited before printing its first pairing link.')
    if (Date.now() >= deadline) throw new Error('Relay did not print its first pairing link.')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

/** Ask the OS for a free port. */
export async function freePort(): Promise<number> {
  const { createServer } = await import('node:net')
  return new Promise((resolvePort, reject) => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address()
      if (address && typeof address === 'object') {
        const { port } = address
        srv.close(() => resolvePort(port))
      } else {
        reject(new Error('no port assigned'))
      }
    })
  })
}

async function waitForHttp(url: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`relay exited early (${child.exitCode})`)
    try {
      // Any HTTP response (401 on this route) means the relay is up.
      await fetch(`${url}/v1/endpoints`)
      return
    } catch {
      await sleep(150)
    }
  }
  throw new Error('relay did not become reachable within 20s')
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
