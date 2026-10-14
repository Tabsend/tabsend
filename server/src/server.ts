import { realpathSync } from 'node:fs'
import { argv } from 'node:process'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { buildApp } from './app'
import { ensureBootstrapGroup, type FirstRunPairing, mintFirstRunPairing } from './bootstrap'
import { deriveBrowserRelayUrl, loadConfig, readProvisioningTokenFile } from './config'
import { createDatabase, ensureRelayId, migrate } from './db'
import { GroupWriteQueue } from './group-queue'
import { Hub } from './hub'
import { assertProfile } from './profile'
import { RateLimiter } from './ratelimit'
import { RelayStats } from './stats'
import { startSweeper } from './sweep'
import { certCoversHost, ensureSelfSignedCert, lanIPv4Candidates, spkiFingerprint } from './tls'
import { ensureVapidConfig } from './vapid-config'

/** Hostname of `url`, or undefined if it will not parse — this only feeds a warning. */
function safeHostname(url: string): string | undefined {
  try {
    return new URL(url).hostname
  } catch {
    return undefined
  }
}

/** Boot the production relay: config → db → migrate → app → sweeper → listen. */
export async function start() {
  const config = loadConfig()
  // The provisioning credential [0031], when it comes from a mounted file rather than
  // the environment. Read here for the same reason TLS material and the VAPID keypair
  // are: loadConfig is env-only and pure, and it has already VALIDATED the pair, so
  // reaching this line means exactly one of the two forms was configured.
  if (config.provisioningTokenFile) {
    config.provisioningToken = readProvisioningTokenFile(config.provisioningTokenFile)
  }
  // The deployment posture, if this relay claims one [0033]. Here rather than anywhere
  // later because it must be able to refuse BEFORE the relay opens a database, migrates
  // a schema or answers a request: a relay that fails the hosted posture should never
  // have existed on the network at all. A no-op unless TABSEND_PROFILE is set, which is
  // every self-hosted relay.
  assertProfile(config)
  // Until the app (and its logger) exists, a pooled connection failing while idle is
  // reported on stderr; from then on it is a warning in the relay log.
  let reportPoolError: ((error: Error) => void) | undefined
  const db = createDatabase(config.databaseUrl, {
    onPoolError: (error) => {
      if (reportPoolError) reportPoolError(error)
      else console.error(`Tabsend relay: an idle database connection failed: ${error.message}`)
    },
  })
  await migrate(db)
  // An explicit env keypair remains authoritative. Otherwise mint one atomically into
  // the relay database on first boot and reuse it forever; this covers bare Node,
  // SQLite, Postgres, and every Docker shape without a second persistence mechanism.
  let vapidGenerated = false
  if (!config.vapid) {
    const provisioned = await ensureVapidConfig(
      db,
      process.env.VAPID_SUBJECT ?? 'mailto:dev@tabsend.local',
    )
    config.vapid = provisioned.config
    vapidGenerated = provisioned.generated
  }
  // Stable relay identity (P-4): minted once, then read forever.
  const relayId = await ensureRelayId(db)
  // This relay's one group (ADR-0023), created alongside that id so setting up a relay
  // IS setting up the group — there is no separate step, and nothing for a client to do.
  await ensureBootstrapGroup(db, config, new Date())

  // Self-signed TLS (P-3): loadConfig is pure, so the filesystem/network work of
  // resolving cert material lives here in boot code.
  let https: { key: string; cert: string } | undefined
  let certFingerprint: string | undefined
  // Deferred to after listen(), where app.log exists — both describe how the
  // relay will be REACHED, which is exactly what an operator scans boot logs for.
  let addressChoice: { chosen: string; passedOver: string[] } | undefined
  let uncoveredHost: string | undefined
  if (config.tlsSelfSigned) {
    const { keyPem, certPem, generated } = await ensureSelfSignedCert(
      config.tlsDir,
      config.tlsExtraSans,
    )
    https = { key: keyPem, cert: certPem }
    certFingerprint = spkiFingerprint(certPem)
    if (!config.publicRelayUrlExplicit) {
      // The pairing QR must carry an address a phone can actually reach, so the
      // localhost default gives way to this host's best LAN address.
      const candidates = lanIPv4Candidates()
      const chosen = candidates[0]
      config.publicRelayUrl = `https://${chosen?.address ?? 'localhost'}:${config.port}`
      if (chosen && candidates.length > 1) {
        addressChoice = {
          chosen: `${chosen.address} (${chosen.iface})`,
          passedOver: candidates.slice(1).map((c) => `${c.address} (${c.iface})`),
        }
      }
    }
    // PUBLIC_RELAY_URL may have changed from localhost to the chosen LAN address
    // above. Keep the automatically derived browser door on that same host.
    if (!config.publicBrowserRelayUrlExplicit) {
      config.publicBrowserRelayUrl = deriveBrowserRelayUrl(config.publicRelayUrl, config.httpPort)
    }
    // A reused cert's SANs were frozen the day it was minted; if the machine has
    // moved to an address it does not cover, every client dutifully connects to
    // the advertised address and fails the handshake. Regenerating is NOT the fix
    // — that would break the pin on every paired device — so say so instead.
    if (!generated) {
      const host = safeHostname(config.publicRelayUrl)
      if (host && !certCoversHost(certPem, host)) uncoveredHost = host
    }
  }

  // Shared across BOTH listeners when dual-listen is on. The hub is the live-socket
  // registry: separate hubs would mean a tab sent by a browser on the http listener
  // never wakes the phone's socket on the https one, degrading silently to polling.
  const hub = new Hub()
  // Its counters are in the database since [0030], so this object is shared for
  // tidiness rather than for correctness — a second relay process would enforce the
  // same budget without ever meeting this one (HOSTED_PLAN §4.4).
  const rateLimiter = new RateLimiter(db, config.rateLimit, () => new Date())
  // Shared for the same reason as the hub: dual-listen is ONE relay, so the counters
  // GET /admin/status reports must span both doors.
  const stats = new RelayStats()
  // Shared for the same reason as the hub: one relay, so one line per group.
  const groupWrites = new GroupWriteQueue()

  const app = await buildApp({
    db,
    config,
    relayId,
    https,
    certFingerprint,
    hub,
    rateLimiter,
    stats,
    groupWrites,
    logger: true,
  })
  // The message only: a pg error's other fields (`detail`, `where`) can quote row
  // values, and a row can hold a device token.
  reportPoolError = (error) =>
    app.log.warn(
      { dbError: error.message },
      'An idle database connection failed. The relay drops it and reconnects on the next request; until the database answers again, requests that need it are refused with a 5xx.',
    )

  // Durable-queue TTL sweeper: purges expired ciphertext + prunes dead rows.
  // Tied to the app lifecycle so `app.close()` stops it cleanly.
  const sweeper = startSweeper(db, {
    intervalMs: config.sweepIntervalMs,
    graceMs: config.sweepGraceMs,
    historyRetentionMs: config.historyRetentionMs,
    onError: (err) => {
      stats.recordSweepError(err, new Date())
      app.log.error(err as Error, 'TTL sweep failed')
    },
    onResult: (r) => {
      // Recorded on EVERY pass, including the quiet ones that log nothing: "when did
      // this last run" is the question, and a relay with nothing to purge would
      // otherwise be indistinguishable from one whose sweeper died.
      stats.recordSweep(r, new Date())
      if (
        r.purged > 0 ||
        r.deleted > 0 ||
        r.blobsDropped > 0 ||
        r.keysDropped > 0 ||
        r.pairingCodesDropped > 0
      ) {
        app.log.info(
          {
            purged: r.purged,
            deleted: r.deleted,
            blobsDropped: r.blobsDropped,
            keysDropped: r.keysDropped,
            pairingCodesDropped: r.pairingCodesDropped,
          },
          'TTL sweep',
        )
      }
    },
  })
  app.addHook('onClose', () => sweeper.stop())

  // Optional cleartext companion listener (see Config.httpPort). Same db, same hub —
  // one relay wearing two coats, not two relays. (The rate limiter is passed along too,
  // but since [0030] its counters are in the database, so it would hold either way.)
  // Built and hooked
  // up BEFORE either listen(): Fastify refuses addHook on an already-listening
  // instance, so registering the shutdown hook later throws at boot.
  let httpApp: FastifyInstance | undefined
  if (config.httpPort !== undefined) {
    // certFingerprint matters MORE here than on the https listener: the browser
    // extension lives on this port and is usually the side that mints the pairing
    // QR the phone scans. Without it the payload would carry the https address with
    // no pin, and the phone would fall back to CA validation and fail to connect.
    httpApp = await buildApp({
      db,
      config,
      relayId,
      certFingerprint,
      hub,
      rateLimiter,
      stats,
      groupWrites,
      // Cleartext, so refuse clients off the local network unless told otherwise. The
      // https listener above never gets this: pinned TLS is safe to expose.
      restrictToPrivateClients: !config.httpAllowPublic,
      logger: true,
    })
    // Closing the https app closes its cleartext twin, so one shutdown path releases
    // both sockets.
    app.addHook('onClose', async () => {
      await httpApp?.close()
    })
  }

  await app.listen({ host: config.host, port: config.port })

  if (httpApp && config.httpPort !== undefined) {
    await httpApp.listen({ host: config.host, port: config.httpPort })
    app.log.warn(
      { httpPort: config.httpPort, privateClientsOnly: !config.httpAllowPublic },
      config.httpAllowPublic
        ? 'Cleartext HTTP listener enabled alongside https, and its private-network guard is OFF (HTTP_ALLOW_PUBLIC). Device tokens are UNENCRYPTED and this port will serve ANY client that can reach it, including from the internet.'
        : 'Cleartext HTTP listener enabled alongside https — device tokens are UNENCRYPTED on this port. It refuses clients outside private network ranges, but that is not encryption: use it only on a network you trust.',
    )
  }

  if (config.profile) {
    // The assertion above passed silently, and silence is indistinguishable from a
    // variable that was never read. One line so an operator can see the gate is armed,
    // and so the checklist's "confirm it took" step has something to grep for. It names
    // the profile and nothing else: what it CHECKED is documentation, not log volume.
    app.log.info(
      { profile: config.profile },
      'Deployment profile asserted at boot. The posture this covers, including the parts the relay cannot check for itself, is docs/HOSTED_PROFILE.md in the Tabsend repo.',
    )
  }
  if (config.provisioningToken) {
    // Worth one line at boot: it is the only route on this relay that can delete a
    // group, it is invisible to anything scanning (every refusal is a 404), and an
    // operator who set it up needs to be able to see that it took.
    app.log.info(
      { source: config.provisioningTokenFile ? 'PROVISIONING_TOKEN_FILE' : 'PROVISIONING_TOKEN' },
      'Provisioning API enabled at /admin/provisioning. It answers only calls made from this host, directly (not through a proxy), carrying the configured credential; anything else gets an ordinary 404.',
    )
  }
  if (certFingerprint) {
    app.log.info(
      { certFingerprint, publicRelayUrl: config.publicRelayUrl },
      'Self-signed TLS enabled — pairing links carry this SPKI pin',
    )
  }
  if (addressChoice) {
    app.log.warn(
      { ...addressChoice, publicRelayUrl: config.publicRelayUrl },
      'This host has several LAN addresses; pairing links will advertise the one ranked best. ' +
        'If devices cannot reach it, set PUBLIC_RELAY_URL to the right address explicitly.',
    )
  }
  if (uncoveredHost) {
    app.log.warn(
      { host: uncoveredHost, tlsDir: config.tlsDir },
      `The existing certificate does not cover ${uncoveredHost}, but pairing links advertise it — ` +
        'clients will fail the TLS handshake. Add it with TLS_EXTRA_SANS and delete the cert ONLY ' +
        'if you accept that every paired device must re-pair (the pin changes with the key).',
    )
  }
  if (vapidGenerated) {
    app.log.info(
      'Generated this relay’s Web Push identity and stored it in the relay database. Back up the database to preserve push subscriptions.',
    )
  }

  // LAST, so it is the thing an operator sees at the bottom of a fresh relay's boot
  // log: how to get the first device in (ADR-0023). Nothing is printed once anyone has
  // joined — from then on, devices pair each other.
  let firstRun: FirstRunPairing | null = null
  try {
    firstRun = await mintFirstRunPairing(db, config, certFingerprint, new Date())
  } catch (err) {
    // A relay that boots without this is still a working relay; the operator can pair
    // from any device that is already in the group. Never let it stop startup.
    app.log.warn({ err }, 'Could not mint the first-run pairing link.')
  }
  if (firstRun) {
    app.log.info(
      {
        pairingLink: firstRun.link,
        phonePairingLink: firstRun.qrLink,
        expiresAt: firstRun.expiresAt,
      },
      'This relay has no devices yet. The default link is for a browser extension; use the phone link for a native app. Both contain the same one-time credential. Restart the relay to print fresh links.',
    )
  }
  return app
}

// Auto-start only when run as the entry module (not when imported by tests/barrel).
// Compare real paths so a repo path with spaces/symlinks doesn't defeat the check
// (import.meta.url percent-encodes; argv[1] does not).
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
  start().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
