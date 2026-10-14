#!/usr/bin/env node
/**
 * Store-ready packaging for the Tabsend browser extension (Chunk 6b).
 *
 *   node scripts/pack.mjs chrome    # → dist-packages/tabsend-chrome-<version>.zip
 *   node scripts/pack.mjs firefox   # → dist-packages/tabsend-firefox-<version>.zip
 *   node scripts/pack.mjs all       # both
 *
 * Version comes from ONE place — the monorepo root package.json `version` — which the
 * Vite build stamps into the emitted manifest (extension/vite.config.ts). Each command
 * does a clean build (emptyOutDir) so the artifact is reproducible from source:
 *   - Chrome: zip the built `extension/dist/` with manifest.json at the archive root
 *     (what the Chrome Web Store expects).
 *   - Firefox: `web-ext build` over `extension/dist-firefox/` → a signable .zip (an .xpi
 *     is a zip); copied to dist-packages with a stable name. See docs/AMO_SOURCE.md for
 *     the AMO source-submission / reproducibility notes.
 */

import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const EXT_DIR = join(REPO_ROOT, 'extension')
const OUT_DIR = join(REPO_ROOT, 'dist-packages')
const WEB_EXT_ARTIFACTS = join(REPO_ROOT, 'web-ext-artifacts')

const VERSION = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).version

function log(msg) {
  process.stdout.write(`[pack] ${msg}\n`)
}

function run(cmd, args, cwd = REPO_ROOT) {
  execFileSync(cmd, args, { cwd, stdio: 'inherit' })
}

function ensureOutDir() {
  mkdirSync(OUT_DIR, { recursive: true })
}

/** `pnpm --filter @tabsend/extension <script>` (or build:firefox). */
function buildExtension(script) {
  log(`building extension (${script})…`)
  run('pnpm', ['--filter', '@tabsend/extension', script])
}

function packChrome() {
  ensureOutDir()
  buildExtension('build')
  const dist = join(EXT_DIR, 'dist')
  if (!existsSync(join(dist, 'manifest.json'))) {
    throw new Error('extension/dist/manifest.json missing — did the build fail?')
  }
  const zipPath = join(OUT_DIR, `tabsend-chrome-${VERSION}.zip`)
  rmSync(zipPath, { force: true })
  // Zip the CONTENTS of dist (manifest.json at the archive root), excluding dotfiles.
  // `-X` drops extra file attributes for a cleaner, more reproducible archive.
  log(`zipping → ${zipPath}`)
  run('zip', ['-r', '-X', zipPath, '.', '-x', '.*'], dist)
  log(`Chrome package ready: ${zipPath}`)
}

function packFirefox() {
  ensureOutDir()
  buildExtension('build:firefox')
  const dist = join(EXT_DIR, 'dist-firefox')
  if (!existsSync(join(dist, 'manifest.json'))) {
    throw new Error('extension/dist-firefox/manifest.json missing — did the build fail?')
  }
  rmSync(WEB_EXT_ARTIFACTS, { recursive: true, force: true })
  log('running web-ext build…')
  const webExt = join(EXT_DIR, 'node_modules', '.bin', 'web-ext')
  run(webExt, [
    'build',
    '--source-dir',
    dist,
    '--artifacts-dir',
    WEB_EXT_ARTIFACTS,
    '--overwrite-dest',
  ])
  const built = readdirSync(WEB_EXT_ARTIFACTS).find((f) => f.endsWith('.zip'))
  if (!built) throw new Error('web-ext produced no .zip in web-ext-artifacts/')
  const dest = join(OUT_DIR, `tabsend-firefox-${VERSION}.zip`)
  rmSync(dest, { force: true })
  cpSync(join(WEB_EXT_ARTIFACTS, built), dest)
  log(`Firefox package ready: ${dest}`)
}

const target = process.argv[2]
switch (target) {
  case 'chrome':
    packChrome()
    break
  case 'firefox':
    packFirefox()
    break
  case 'all':
    packChrome()
    packFirefox()
    break
  default:
    process.stderr.write('usage: node scripts/pack.mjs <chrome|firefox|all>\n')
    process.exit(1)
}
