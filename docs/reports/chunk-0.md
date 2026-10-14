# Chunk 0 — Scaffold + `shared/` wired

**Stage 0.1.** Done-gate green: `pnpm install`, `pnpm lint`, `pnpm typecheck`, `pnpm test` all pass.

## What was built

- **pnpm workspace monorepo.** Four real packages — `shared/` (unchanged contract), `server/`, `extension/`, `console/` — plus `helper/` and `android/` as placeholder dirs (README only, not in the workspace yet).
- **Docs moved** into `docs/` via `git mv` (BUILDER_BRIEF, BUILD_SEQUENCE, PRD, DECISIONS, INTERACTION_FLOWS). `assets/` left in place.
- **Stub entries.** `server`, `extension`, `console` each import a **type and a runtime value** from `@tabsend/shared` and have a Vitest test asserting the import resolves at runtime (5 tests, 3 files, all green).
- **Root tooling:** `package.json` (private, `packageManager: pnpm@11.13.1`), `pnpm-workspace.yaml`, `tsconfig.base.json` (strict), `biome.json` (single root config, lint+format), root `vitest.config.ts` (Vitest **projects** aggregating the three code packages; each package also has its own config), `LICENSE` (Apache-2.0, "Copyright 2026 Ben (Tabsend contributors)"), extended `.gitignore`.
- **Scripts (root):** `lint` = `biome check .`, `format` = `biome format --write .`, `typecheck` = `pnpm -r run typecheck` (per-package `tsc --noEmit`), `test` = `vitest run`.
- **CI:** `.github/workflows/ci.yml` — on push/PR, Node 26 + pnpm 11.13.1, `pnpm install --frozen-lockfile` → `pnpm lint` → `pnpm typecheck` → `pnpm test`. No remote exists yet; verified locally that `--frozen-lockfile` succeeds.

## Tool versions

pnpm 11.13.1 · Node 26.5.0 · TypeScript 7.0.2 · Biome 2.5.4 · Vitest 4.1.10 · @types/node 26.1.1.

## Deviations & judgment calls

1. **corepack is absent from this Node 26 build** → installed pnpm via `npm i -g pnpm` (the brief's stated fallback). CI uses `pnpm/action-setup@v4`, so this only affects the local machine.
2. **TypeScript 7.0.2 (the native/Go compiler) is `latest`** and is what I pinned. The whole gate is green with it (strict typecheck resolves `@tabsend/shared` via the workspace symlink + exports map). Biome and Vitest don't use the TS compiler API, so they're unaffected by the native port. **Watch-out for later chunks:** if any TS-API-dependent tool misbehaves (e.g. `ts-node`, some type-aware lint plugins, or a Vite/Fastify typegen step), the safe fallback is `typescript@5.9.3` — a one-line version change in root `devDependencies`, no config change needed.
3. **Biome excludes `shared/src/**`** (`files.includes: ["**", "!shared/src"]`). The authoritative contract (`types.ts`) is hand-formatted with aligned comments and semicolons; Biome's style (single-quote, no-semicolon, 100-col) would rewrite it, which the invariant forbids. `shared/src` is still typechecked by `tsc`; only the Biome formatter/linter leaves it alone. The workspace linter governs `server`/`extension`/`console` + root tooling.
4. **`shared/package.json` changed only additively** — added a `scripts.typecheck` and left every wire shape in `src/types.ts` byte-for-byte untouched. No build step for `shared`: it exports source (`./src/index.ts`), so bundlers/Vitest transpile it and `tsc` resolves types via the exports map.
5. **`helper/` and `android/` are not workspace members** (no `package.json`), so they don't break `pnpm install`. READMEs state helper → Chunk 6, android → Chunk 5.

## For the next chunks

- **Import the contract** as `@tabsend/shared` (declared `workspace:*`). Import types and runtime consts directly; no build to run first.
- **Adding a package:** dir + `package.json` (`@tabsend/<name>`, `private`, `license: Apache-2.0`, `type: module`, `typecheck`/`test` scripts, `@tabsend/shared: workspace:*`), `tsconfig.json` extending `../tsconfig.base.json`, a `vitest.config.ts`; then list it in `pnpm-workspace.yaml` and (if it has tests) in root `vitest.config.ts` `projects`.
- **Base tsconfig** is `strict` + `moduleResolution: bundler` + `noEmit` + `isolatedModules` + `noUncheckedIndexedAccess`. It's a typecheck-only config; when `server/` needs a real Node build (Chunk 2), give it its own `module`/`moduleResolution: nodenext` + emit settings rather than editing the base.
- **Stack locks respected:** no Fastify/Kysely/Vite/Playwright added yet — those land with their chunks.
- Keep the pinned pnpm version in `package.json` (`packageManager`) and `ci.yml` (`pnpm/action-setup` `version`) in sync.
