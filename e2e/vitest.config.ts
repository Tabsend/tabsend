import { createRequire } from 'node:module'
import { defineConfig } from 'vitest/config'

// Same workaround as the extension configs: libsodium-wrappers' ESM entry is
// broken (imports a ./libsodium.mjs it doesn't ship). The push suite seals with
// it node-side, so alias the bare specifier to the CJS build.
const require = createRequire(import.meta.url)

/**
 * The e2e rig is deliberately NOT in the root `vitest.config.ts` projects list:
 * it builds the extension, downloads/launches real Chromium, and takes tens of
 * seconds — it would slow `pnpm test` (the fast gate) and needs a browser
 * install. Run it via `pnpm e2e` at the repo root; the push suite via `pnpm e2e:push`.
 */
export default defineConfig({
  resolve: {
    alias: { 'libsodium-wrappers': require.resolve('libsodium-wrappers') },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.e2e.ts'],
    testTimeout: 120_000,
    hookTimeout: 180_000,
    // One rig, one file, strictly sequential.
    fileParallelism: false,
  },
})
