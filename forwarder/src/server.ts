import { realpathSync } from 'node:fs'
import { argv } from 'node:process'
import { fileURLToPath } from 'node:url'
import { buildApp } from './app'
import { type Config, loadConfig } from './config'
import { DeviceStore } from './store'
import { loadDeviceTokenKey } from './token-box'
import { FORWARDER_VERSION } from './version'

/**
 * Production boot: read env, open the store, listen.
 *
 * Invariant: every validation that can fail has already failed in `loadConfig` by the
 * time anything is opened or bound. A forwarder either starts able to ring phones or
 * does not start, because ringing is the only thing it does (PROTOCOL.md §10).
 */
export async function start(config: Config = loadConfig()): Promise<void> {
  // Late-bound: the store is opened before the app that owns the logger, and only calls
  // this from its flush timer, long after both exist.
  let report: (err: unknown) => void = () => undefined
  const store = new DeviceStore(config.databasePath, loadDeviceTokenKey(config), {
    onFlushError: (err) => report(err),
  })
  const app = buildApp({
    config,
    store,
    logger: { level: config.logLevel },
  })
  report = (err) =>
    app.log.error(
      { err },
      'Could not write the wake tallies, or finish tidying the database after its upgrade. Both are tried again at the next flush; rings are not affected.',
    )
  if (store.scrubPending) {
    app.log.warn(
      'The database upgrade has not finished tidying the file yet, because something else has it open or the disk is full. The old copy of each phone address was cleared when it was dropped; this tries again every minute.',
    )
  }

  const shutdown = async (): Promise<void> => {
    await app.close()
    store.close()
  }
  process.once('SIGINT', () => void shutdown().then(() => process.exit(0)))
  process.once('SIGTERM', () => void shutdown().then(() => process.exit(0)))

  await app.listen({ host: config.host, port: config.port })
  app.log.info(
    {
      version: FORWARDER_VERSION,
      topic: config.apns?.topic,
      environment: config.apns?.defaultEnvironment,
      dryRun: config.apnsDryRun,
      devices: store.count(),
    },
    config.apnsDryRun
      ? 'Wake-up forwarder listening in dry-run mode. No Apple key is loaded, so every wake is accepted and no phone is rung.'
      : 'Wake-up forwarder listening',
  )
}

// Auto-start only when run as the entry module (not when imported by tests/barrel).
// Real paths on both sides, so a repo path with spaces or symlinks doesn't defeat the
// check — import.meta.url percent-encodes, argv[1] does not.
function isEntryModule(): boolean {
  const entry = argv[1]
  if (!entry) return false
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entry)
  } catch {
    return false
  }
}

if (isEntryModule()) {
  start().catch((err: unknown) => {
    console.error(err)
    process.exit(1)
  })
}
