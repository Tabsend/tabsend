import { defineConfig } from 'vitest/config'

/**
 * Shared-contracts suite. Mostly types (checked by `pnpm typecheck`), so the only
 * tests here cover the handful of real runtime helpers — currently the protocol
 * compatibility handshake, whose upgrade path has to keep legacy relays working, and the
 * message-catalog checks in tools/ that the extension and the console both run.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'tools/**/*.test.ts'],
  },
})
