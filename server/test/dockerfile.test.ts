import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * Guards on the relay image's package-manager setup. The Dockerfile lives at the repo
 * root but builds only the server, so its regressions belong with the server suite.
 *
 * These are file assertions, not a build — CI's `docker` job runs the real
 * `docker build` and boots the container. What a build cannot catch cheaply is drift:
 * the image pinning a different pnpm than the repo does, or corepack creeping back in
 * (Node 26's images dropped it, which is what broke the build in the first place).
 */

const repoRoot = new URL('../../', import.meta.url)
const dockerfile = readFileSync(new URL('Dockerfile', repoRoot), 'utf8')
const rootPackageJson = JSON.parse(readFileSync(new URL('package.json', repoRoot), 'utf8')) as {
  packageManager?: string
}

// Comments in the Dockerfile explain the corepack history on purpose, so match against
// instructions only — otherwise the explanation would trip the assertion it documents.
const instructions = dockerfile
  .split('\n')
  .filter((line) => !/^\s*#/.test(line))
  .join('\n')

describe('Dockerfile package manager', () => {
  it('does not use corepack, which the Node 26 base image no longer ships', () => {
    expect(instructions).not.toMatch(/corepack/)
  })

  it('installs the exact pnpm version package.json pins', () => {
    const [name, version] = (rootPackageJson.packageManager ?? '').split('@')
    expect(name).toBe('pnpm')
    expect(version).toMatch(/^\d+\.\d+\.\d+$/)

    const pinned = instructions.match(/^ARG PNPM_VERSION=(\S+)$/m)?.[1]
    expect(pinned).toBe(version)
  })

  it('installs pnpm from that pin rather than a floating tag', () => {
    expect(instructions).toMatch(/npm install --global pnpm@\$\{PNPM_VERSION\}/)
    expect(instructions).not.toMatch(/pnpm@latest/)
  })
})

describe('Dockerfile healthcheck', () => {
  // Every deploy command in the docs uses `docker compose up --wait`, which has nothing
  // to wait ON unless the image declares a healthcheck: with none, Compose calls a
  // merely-created container ready and the next line races the relay's startup — the
  // "connection refused on a healthy deployment" the LAN deploy used to hit.
  const healthcheck = instructions.match(/^HEALTHCHECK ([^\n]*)/m)?.[1]

  it('declares one, since `docker compose up --wait` gates on it', () => {
    expect(healthcheck).toBeDefined()
  })

  it('polls often enough that --wait does not stall a deploy', () => {
    // Docker runs the first check one interval after start, so the interval is the
    // floor on how long a deploy waits after the relay is already serving.
    const interval = Number(healthcheck?.match(/--interval=(\d+)s/)?.[1])
    expect(interval).toBeLessThanOrEqual(10)
  })
})
