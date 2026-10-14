import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * This relay's build id, surfaced as `relayVersion` on GET /v1/config.
 *
 * Read from the monorepo ROOT package.json, the single version source the extension
 * build and `scripts/pack.mjs` already use — so a relay, a Chrome zip and an APK built
 * from the same commit all say the same number. The Dockerfile copies the whole tree,
 * so the root manifest is present at runtime in the image too.
 *
 * The field is deliberately opaque: `@tabsend/shared` documents it as human-facing and
 * never parsed. Compatibility is decided by the protocol numbers next to it, which move
 * on their own schedule. This exists so an operator can answer "is the relay I am
 * running the one I think I deployed?" without shelling into the box.
 */
function readRootVersion(): string | undefined {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const raw = readFileSync(join(here, '..', '..', 'package.json'), 'utf8')
    const version: unknown = JSON.parse(raw).version
    return typeof version === 'string' && version.length > 0 ? version : undefined
  } catch {
    // A relay that cannot read its own manifest still serves fine; the field is
    // optional in the contract and absent simply means "unknown build".
    return undefined
  }
}

export const RELAY_VERSION = readRootVersion()
