import { createRequire } from 'node:module'
import { defineConfig } from 'vitest/config'

// Same workaround as vite.config.ts: libsodium-wrappers' ESM entry is broken
// (imports a ./libsodium.mjs it doesn't ship); use the CJS build.
const require = createRequire(import.meta.url)

export default defineConfig({
  resolve: {
    alias: { 'libsodium-wrappers': require.resolve('libsodium-wrappers') },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
