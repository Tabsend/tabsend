# Building Tabsend for store submission (reproducibility notes)

This document is for **AMO (addons.mozilla.org) reviewers** and anyone reproducing the
store packages. AMO requires a source-code submission whenever an add-on is built from
sources or uses minification/bundling — Tabsend does both (Vite + Rollup). These are the
exact steps to reproduce the reviewed artifact byte-for-behaviour from this repository.

## What produces the packages

| Command | Output | For |
|---|---|---|
| `pnpm package:chrome` | `dist-packages/tabsend-chrome-<version>.zip` | Chrome Web Store |
| `pnpm package:firefox` | `dist-packages/tabsend-firefox-<version>.zip` | AMO (a `.zip` is a valid `.xpi`) |
| `pnpm package` | both | — |

The separately uploaded reviewer source archive is the public repository,
[github.com/Tabsend/tabsend](https://github.com/Tabsend/tabsend), at the release tag, and
nothing else. Make it, and the store packages, in a clone of that repository with the release
tag checked out, from its root:

```bash
pnpm install --frozen-lockfile
pnpm package
version=$(node -p "require('./package.json').version")
git archive --format=zip --output "dist-packages/tabsend-source-$version.zip" "v$version"
```

`git archive` takes only the files committed at the tag, so dependencies, builds, local
environment files and the store packages stay out. Building the packages from the same clone
means the reviewer rebuilds exactly what was uploaded. Never make the archive from any other
checkout: it would carry whatever else that checkout holds.

Each command does a **clean build** (`emptyOutDir`) then archives it. The Firefox package
is produced by `web-ext build` over `extension/dist-firefox/`.

## Version — one source

The add-on version comes from a single place: the **monorepo root `package.json` `version`**.
The Vite build stamps it into the emitted `manifest.json` (`extension/vite.config.ts`,
`staticAssets` plugin), so a dev build and a store package always agree. To cut a release,
bump `version` in the root `package.json` and re-run the package command — no per-manifest
edits.

## Toolchain (pin these to reproduce)

- **Node** ≥ 26 (`.nvmrc`-free; the root `package.json` `engines.node` is `>=26`).
- **pnpm** 11.13.1 (pinned by the `packageManager` field; install it with
  `npm install --global pnpm@11.13.1` — Node 26 no longer bundles corepack).
- **web-ext** 10.6.0 (pinned devDependency of `@tabsend/extension`).
- All other deps are locked in `pnpm-lock.yaml`.

## Reproduce from a clean checkout

```bash
npm install --global pnpm@11.13.1   # the pinned package manager
pnpm install --frozen-lockfile  # exact locked deps
pnpm package:firefox            # → dist-packages/tabsend-firefox-<version>.zip
```

The build is deterministic given the locked dependency tree: no network fetches happen
during the build itself (only during `pnpm install`), and no timestamps or machine-specific
data are baked into the bundle.

## Notes a reviewer will want

- **No remote code.** Everything the extension runs is bundled. There are no `<script src>`
  to remote hosts, no `eval` of remote data. The relay is contacted only for the app's own
  REST/WS API and Web Push; payloads are end-to-end-encrypted ciphertext (ADR-0005).
- **`libsodium-wrappers` is bundled from its CJS entry.** The package's 0.7.x ESM entry is
  broken (it imports a `./libsodium.mjs` that ships in a *sibling* package), so
  `extension/vite.config.ts` aliases the bare specifier to the working CJS build, which
  Rollup bundles correctly. This is why `background.js` is large (~750 kB) — it inlines
  libsodium's base64-embedded WASM/asm runtime. It is unminified-readable crypto, not
  obfuscation.
- **The QR code is generated locally** (`qrcode-generator`, MIT) from a pairing link the
  user's own device minted — never from remote or third-party data.
- **`wasm-unsafe-eval`** is required in the manifest CSP for libsodium's WebAssembly.

## Firefox data declaration and lint status

The AMO pre-submission changes were applied on 2026-08-10:

- Pairing QR SVGs and probe-state icons are created with DOM APIs; extension pages do not
  inject SVG markup through `innerHTML`.
- Firefox declares `browsingActivity` and `websiteContent` as required data categories.
  Sending a selected tab necessarily transmits its URL and, when available, its title and
  favicon to the user's relay. The payload is user-initiated and end-to-end encrypted, but
  Mozilla still treats data handled outside the browser as transmitted. Declaring `none`
  would therefore be misleading.
- Firefox's minimum version is 142 so both desktop and Android support the manifest-level
  data declaration and its built-in consent prompt. Desktop introduced the feature in 140;
  Android followed in 142. Supporting earlier releases would require a separate custom
  consent flow or disabling Tabsend's core send operation.

References: [Firefox built-in data consent](https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/)
and [the `browser_specific_settings` manifest reference](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/browser_specific_settings).

Run `pnpm --filter @tabsend/extension exec web-ext lint --source-dir dist-firefox` after a
`build:firefox` to verify the submitted package.
