import { defineConfig } from 'vitest/config'

/**
 * Shared-contracts suite. Mostly types (checked by `pnpm typecheck`), so the only
 * tests here cover the handful of real runtime helpers — currently the protocol
 * compatibility handshake, whose upgrade path has to keep legacy relays working.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
})
