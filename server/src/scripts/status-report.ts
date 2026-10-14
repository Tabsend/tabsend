/**
 * Print GET /admin/status as a readable report. Runs INSIDE the relay container:
 *
 *   docker exec tabsend-relay server/node_modules/.bin/tsx server/src/scripts/status-report.ts
 *
 * scripts/relay-doctor.sh is what actually invokes this; run it by hand only when
 * debugging the report itself.
 *
 * Why from inside rather than from the host: /admin/status only answers loopback
 * callers (routes/status.ts). Under bridge networking a call from the host arrives
 * from the docker gateway address and is refused, so "from inside" is the one form
 * that works under every compose file in this repo. It also proves the relay's HTTP
 * layer is actually serving, which reading the database directly would not.
 *
 * Flags:
 *   --json   emit the raw response instead of the report (for piping/archiving)
 */
import type { RelayStatus } from '../routes/status'

const wantsJson = process.argv.includes('--json')

const tlsOn = process.env.TLS_SELF_SIGNED === '1' || process.env.TLS_SELF_SIGNED === 'true'
const scheme = tlsOn ? 'https' : 'http'
const port = process.env.PORT ?? '8787'
const url = `${scheme}://127.0.0.1:${port}/admin/status`

// Loopback call to ourselves against a cert that is self-signed BY DESIGN (ADR-0019):
// clients pin it instead of validating a chain, and there is no chain to validate here.
if (tlsOn) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

/** Seconds as the coarse, human phrasing a report wants ("3 days 4 hours"). */
function duration(seconds: number): string {
  if (seconds < 60) return plural(Math.round(seconds), 'second')
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return plural(minutes, 'minute')
  const hours = Math.floor(minutes / 60)
  if (hours < 48) {
    const restMinutes = minutes % 60
    return restMinutes > 0
      ? `${plural(hours, 'hour')} ${plural(restMinutes, 'minute')}`
      : plural(hours, 'hour')
  }
  const days = Math.floor(hours / 24)
  const restHours = hours % 24
  return restHours > 0 ? `${plural(days, 'day')} ${plural(restHours, 'hour')}` : plural(days, 'day')
}

function bytes(n: number | undefined): string {
  if (n === undefined) return 'size unknown'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

/** ISO → "2026-08-16 21:20 UTC". Reports are read by people, not parsers. */
function stamp(isoString: string | undefined): string {
  if (!isoString) return 'never'
  return `${isoString.slice(0, 16).replace('T', ' ')} UTC`
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length)
}

function render(status: RelayStatus): string {
  const out: string[] = []
  const line = (text = '') => out.push(text)

  line('Tabsend relay status')
  line('====================')
  line(`  Version       ${status.relay.version ?? 'unknown'} (node ${status.relay.node})`)
  line(
    `  Running for   ${duration(status.relay.uptimeSeconds)} (since ${stamp(status.relay.startedAt)})`,
  )
  line(`  Relay id      ${status.relay.relayId}`)
  line(`  Phones reach  ${status.listeners.publicRelayUrl}`)
  line(`  Browsers use  ${status.listeners.publicBrowserRelayUrl}`)
  if (status.listeners.certFingerprint) {
    line(`  Cert pin      ${status.listeners.certFingerprint}`)
  }
  const dbSize = status.database.backend === 'sqlite' ? `, ${bytes(status.database.fileBytes)}` : ''
  line(
    `  Database      ${status.database.backend}${dbSize}, ${
      status.database.reachable ? 'reachable' : `UNREACHABLE (${status.database.error ?? '?'})`
    }`,
  )
  if (status.groups.count !== 1) {
    line(`  Groups        ${status.groups.count}`)
  }

  line()
  line(`Devices (${status.devices.total} paired, ${status.devices.online} reachable right now)`)
  if (status.devices.list.length === 0) {
    line('  none')
  }
  for (const device of status.devices.list) {
    const notes: string[] = []
    if (device.liveSockets > 0) notes.push(plural(device.liveSockets, 'live connection'))
    if (device.pushDead) notes.push(`wake-ups failing (${device.pushFailures}x)`)
    else if (device.pushFailures > 0) notes.push(`${device.pushFailures} failed wake-up(s)`)
    if (device.pushTransport === 'none') notes.push('no push, polls instead')
    line(
      `  ${pad(device.online ? 'online' : 'offline', 8)}${pad(device.label, 22)}${pad(device.kind, 11)}${pad(
        device.platform,
        9,
      )}seen ${pad(`${duration(device.secondsSinceSeen)} ago`, 20)}${notes.join(', ')}`.trimEnd(),
    )
  }
  if (status.devices.total > status.devices.list.length) {
    line(`  (${status.devices.total - status.devices.list.length} more not listed)`)
  }

  line()
  line('Tabs in transit')
  const oldest =
    status.messages.oldestWaitingSeconds === null
      ? ''
      : `  (oldest ${duration(status.messages.oldestWaitingSeconds)})`
  line(`  Waiting to be picked up   ${status.messages.waiting}${oldest}`)
  // Split out, because "waiting" on a busy relay is mostly tabs in flight. This is the
  // subset old enough that nobody is coming for them.
  line(`  Of those, stuck for hours ${status.messages.stuck}`)
  line(`  Picked up, not confirmed  ${status.messages.deliveredNotAcked}`)
  const overdue =
    status.messages.oldestExpiredSeconds === null
      ? ''
      : `  (oldest overdue by ${duration(status.messages.oldestExpiredSeconds)})`
  line(`  Expired, not yet erased   ${status.messages.expiredNotSwept}${overdue}`)
  line(`  Rows in the queue table   ${status.messages.totalRows}`)

  line()
  line(`Since startup (${duration(status.relay.uptimeSeconds)} ago)`)
  line(
    `  Cleanup job     ${status.sweeper.runs} run(s), last ${stamp(status.sweeper.lastRunAt)}, erased ${status.sweeper.totalPurged}, deleted ${status.sweeper.totalDeleted}${
      status.sweeper.errors > 0 ? `, FAILED ${status.sweeper.errors}x` : ''
    }`,
  )
  line(
    `  Refused         ${status.refusals.rateLimited} rate-limited, ${status.refusals.nonPrivateClient} from outside the network, ${status.refusals.unauthorized} unknown token, ${status.refusals.endpointRemoved} removed device`,
  )
  line(`  Internal errors ${status.refusals.internalError}`)
  line(
    `  Live sockets    ${status.stream.reservedSockets} of ${status.stream.maxConnections} allowed`,
  )
  if (status.lastError) {
    line(`  Last error      ${stamp(status.lastError.at)}: ${status.lastError.message}`)
  }

  line()
  if (status.warnings.length === 0) {
    line('Problems found: none')
  } else {
    line(`Problems found (${status.warnings.length})`)
    for (const warning of status.warnings) {
      line(`  [${warning.code}] ${warning.message}`)
    }
    line()
    line('What to do about each one: docs/RUNBOOK.md in the Tabsend repo.')
  }

  return out.join('\n')
}

async function main(): Promise<void> {
  let response: Response
  try {
    response = await fetch(url)
  } catch (err) {
    process.stderr.write(
      `Could not reach the relay at ${url} from inside its own container: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    )
    process.exit(1)
  }

  if (response.status === 404) {
    // The single most likely cause, and the one worth naming: an image built before
    // /admin/status existed answers 404 for it while serving everything else fine.
    process.stderr.write(
      'The relay answered, but has no /admin/status route. This container is running a build from before diagnostics existed. Rebuild and restart it, then run this again.\n',
    )
    process.exit(1)
  }
  if (!response.ok) {
    process.stderr.write(`The relay answered ${response.status} for ${url}.\n`)
    process.exit(1)
  }

  const raw = await response.text()
  if (wantsJson) {
    process.stdout.write(`${raw}\n`)
    return
  }
  const status = JSON.parse(raw) as RelayStatus
  process.stdout.write(`${render(status)}\n`)
  // Exit code carries the verdict so relay-doctor.sh (and any cron) can branch on it
  // without parsing the text.
  if (status.warnings.length > 0) process.exit(3)
}

await main()
