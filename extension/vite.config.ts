import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'

/**
 * libsodium-wrappers 0.7.x ships a broken ESM entry: `modules-esm/
 * libsodium-wrappers.mjs` imports a relative `./libsodium.mjs` that the package
 * doesn't contain (it lives in the sibling `libsodium` package). Point the
 * bare specifier at the CJS build, which requires `libsodium` correctly;
 * Rollup's CommonJS handling bundles it fine.
 */
const require = createRequire(import.meta.url)
export const libsodiumCjs = require.resolve('libsodium-wrappers')

/**
 * MV3 build — no extension framework, manual manifest.
 *
 * Two variants, selected by TABSEND_TARGET (default 'chrome'):
 *  - chrome  → dist/,          public/manifest.json         (service worker + offscreen WS + Push)
 *  - firefox → dist-firefox/,  public/manifest.firefox.json (event page holds the WS; no Push)
 *
 * The platform is compiled in via `define(__TABSEND_PLATFORM__)` so the divergent
 * branches (offscreen doc + Push vs WS-in-event-page) tree-shake per variant
 * behind `src/lib/platform.ts`. A tiny plugin emits the RIGHT manifest as
 * `manifest.json` plus the icons (publicDir is off, so the other engine's
 * manifest never leaks into a build).
 */
const TARGET = process.env.TABSEND_TARGET === 'firefox' ? 'firefox' : 'chrome'
const OUT_DIR = TARGET === 'firefox' ? 'dist-firefox' : 'dist'
const MANIFEST_SRC = TARGET === 'firefox' ? 'manifest.firefox.json' : 'manifest.json'

/**
 * Single version source (Chunk 6b): the monorepo root package.json `version`. The
 * emitted manifest is stamped with it at build time, so dev builds AND the store
 * packages (scripts/pack.mjs) all carry one version — bump it in one place.
 */
const ROOT_VERSION: string = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '..', 'package.json'), 'utf8'),
).version

/** Emit the target's manifest as manifest.json + copy the icons and font licences. */
function staticAssets(): Plugin {
  const publicDir = resolve(import.meta.dirname, 'public')
  return {
    name: 'tabsend-static',
    generateBundle() {
      const manifest = JSON.parse(readFileSync(resolve(publicDir, MANIFEST_SRC), 'utf8'))
      manifest.version = ROOT_VERSION
      this.emitFile({
        type: 'asset',
        fileName: 'manifest.json',
        source: `${JSON.stringify(manifest, null, 2)}\n`,
      })
      const iconDir = resolve(publicDir, 'icons')
      for (const name of readdirSync(iconDir)) {
        this.emitFile({
          type: 'asset',
          fileName: `icons/${name}`,
          source: readFileSync(resolve(iconDir, name)),
        })
      }
      // The bundled fonts (Archivo, Courier Prime) are SIL OFL 1.1, which asks
      // that the licence travel with the font files. The woff2 files themselves
      // are pulled in (hashed) by ui.css; their licence texts sit beside them in
      // public/fonts/ and ship unhashed under fonts/.
      const fontDir = resolve(publicDir, 'fonts')
      for (const name of readdirSync(fontDir)) {
        if (!name.endsWith('.txt')) continue
        this.emitFile({
          type: 'asset',
          fileName: `fonts/${name}`,
          source: readFileSync(resolve(fontDir, name)),
        })
      }
    },
  }
}

export default defineConfig({
  root: resolve(import.meta.dirname),
  publicDir: false,
  define: {
    __TABSEND_PLATFORM__: JSON.stringify(TARGET),
  },
  resolve: {
    alias: { 'libsodium-wrappers': libsodiumCjs },
  },
  plugins: [staticAssets()],
  build: {
    outDir: resolve(import.meta.dirname, OUT_DIR),
    emptyOutDir: true,
    target: 'es2022',
    modulePreload: false,
    rollupOptions: {
      input: {
        background: resolve(import.meta.dirname, 'src/background/index.ts'),
        chooser: resolve(import.meta.dirname, 'chooser.html'),
        firstrun: resolve(import.meta.dirname, 'firstrun.html'),
        history: resolve(import.meta.dirname, 'history.html'),
        options: resolve(import.meta.dirname, 'options.html'),
        offscreen: resolve(import.meta.dirname, 'offscreen.html'),
      },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
})
