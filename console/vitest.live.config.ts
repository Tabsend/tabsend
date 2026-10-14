import { createRequire } from 'node:module'
import { defineConfig } from 'vitest/config'

/**
 * The live end-to-end slice. Spawns a REAL relay (server/src/server.ts via tsx) on
 * an ephemeral port with a throwaway SQLite db, pairs a console endpoint into a
 * group, seals a history copy to it (the same crypto the extension uses), then
 * drives the console's real consumption path (fetch pending → verify sender → open
 * → persist → ack) and asserts the rendered history entry.
 *
 * Kept OUT of the default `pnpm test` (which stays hermetic + fast). Never targets
 * the owner's live relay on :8787 — it always spawns its own throwaway process.
 */
const require = createRequire(import.meta.url)
const libsodiumCjs = require.resolve('libsodium-wrappers')

export default defineConfig({
  resolve: {
    alias: { 'libsodium-wrappers': libsodiumCjs },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.live.test.ts'],
    // Spawning tsx + better-sqlite3 + doing crypto: give it room.
    testTimeout: 40_000,
    hookTimeout: 40_000,
  },
})
