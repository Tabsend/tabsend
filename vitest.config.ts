import { existsSync } from 'node:fs'
import { defineConfig } from 'vitest/config'

/**
 * Workspace-level runner. `pnpm test` at the root runs every package's suite via
 * Vitest projects; each package also has its own vitest.config.ts so it can be
 * run in isolation. shared/ joined the list once it grew runtime logic (the
 * protocol handshake) rather than types alone.
 *
 * control/ (account.tabsend.org) is private: the public repo is exported without it
 * (scripts/public-allowlist.txt), and Vitest refuses a project folder that is not there.
 */
export default defineConfig({
  test: {
    projects: [
      'shared',
      'server',
      'forwarder',
      ...(existsSync('control') ? ['control'] : []),
      'extension',
      'console',
    ],
  },
})
