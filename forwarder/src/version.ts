import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * This forwarder's build id, surfaced on GET /healthz.
 *
 * Read from the monorepo ROOT package.json, the same single version source the relay
 * uses, so a relay and a forwarder built from one commit say the same number. Opaque and
 * never parsed: it exists so an operator can answer "is the service I am running the one
 * I think I deployed?" without shelling into the box.
 */
function readRootVersion(): string | undefined {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const raw = readFileSync(join(here, '..', '..', 'package.json'), 'utf8')
    const version: unknown = JSON.parse(raw).version
    return typeof version === 'string' && version.length > 0 ? version : undefined
  } catch {
    // A service that cannot read its own manifest still rings phones fine.
    return undefined
  }
}

export const FORWARDER_VERSION = readRootVersion()
