import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'

/**
 * Tabsend web console — a small Vite + TypeScript SPA. No UI framework: the app is
 * a handful of panels driven by a ~60-line reactive store (`src/lib/store.ts`), so
 * a framework would be more machinery than the surface justifies (ADR-0010 keeps
 * this console deliberately small).
 *
 * libsodium-wrappers 0.7.x ships a broken ESM entry (same trap the extension hit):
 * its `.mjs` imports a relative `./libsodium.mjs` that lives in a sibling package.
 * Alias the bare specifier to the CJS build, which requires `libsodium` correctly;
 * Rollup's CommonJS interop bundles it fine.
 */
const require = createRequire(import.meta.url)
const libsodiumCjs = require.resolve('libsodium-wrappers')

/**
 * Where the relay lives during `pnpm --filter @tabsend/console dev`. The dev server
 * PROXIES `/v1/*` (REST) and `/v1/stream` (WebSocket) to it, so the browser always
 * talks to the console's OWN origin — no CORS anywhere, in dev or in production
 * (where the built SPA is served same-origin as the relay; see docs/reports/chunk-5b.md).
 *
 * Default targets the hosted-default dev port. Override to point dev at your own
 * relay, e.g. `TABSEND_RELAY=http://127.0.0.1:9000 pnpm --filter @tabsend/console dev`.
 */
const relayTarget = process.env.TABSEND_RELAY ?? 'http://localhost:8787'

export default defineConfig({
  root: resolve(import.meta.dirname),
  // Relative asset URLs so `dist/` is servable from any origin OR sub-path
  // (root of the relay, `/console`, a static bucket — all work unchanged).
  base: './',
  resolve: {
    alias: { 'libsodium-wrappers': libsodiumCjs },
  },
  server: {
    proxy: {
      '/v1': {
        target: relayTarget,
        changeOrigin: true,
        // /v1/stream is a WebSocket upgrade — the same proxy entry carries it.
        ws: true,
      },
    },
  },
  build: {
    outDir: resolve(import.meta.dirname, 'dist'),
    emptyOutDir: true,
    target: 'es2022',
  },
})
