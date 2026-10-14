import { createRequire } from 'node:module'
import { defineConfig } from 'vitest/config'

/**
 * Hermetic logic tests — no browser, no server. Persistence and networking are
 * behind interfaces (`lib/persist.ts`, `lib/api.ts`) so the pure projection/crypto
 * logic is unit-tested with in-memory fakes. The live end-to-end slice (spawns a
 * real relay) is a separate config: `pnpm --filter @tabsend/console test:live`.
 */
const require = createRequire(import.meta.url)
const libsodiumCjs = require.resolve('libsodium-wrappers')

export default defineConfig({
  resolve: {
    alias: { 'libsodium-wrappers': libsodiumCjs },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
