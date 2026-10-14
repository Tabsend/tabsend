import type { SweepResult } from './sweep'

/**
 * Process-lifetime counters for the ops status route (routes/status.ts).
 *
 * The relay's own logs already carry all of this, but reading them means knowing
 * which container, which since-window and which pino level number means "error" —
 * and a log that has rotated has simply lost the answer. These counters are the
 * cheap, always-there version: "how many times has X happened since this process
 * started", available in one call.
 *
 * IN MEMORY ON PURPOSE. A restart resets every counter to zero, and `startedAt`
 * says so, so a reader can never mistake a fresh process for a quiet one. Persisting
 * them would mean writing to the database on every refused request — a cost paid
 * forever to answer a question that is only ever asked while the relay is running.
 *
 * Shared across listeners exactly like the Hub: in dual-listen mode both doors are one
 * relay, so a refusal on the cleartext port must show up in the same tally as one on
 * the https port. The RateLimiter used to belong in that sentence and no longer does —
 * its counters are in the database since [0030], so sharing the object is convenience
 * rather than correctness. These counters stay in memory, and are the last in-process
 * state that a second relay instance would report separately.
 */
export interface RefusalCounts {
  /** 429s from the register rate limiter. */
  rateLimited: number
  /** Requests turned away by the cleartext listener's private-network guard. */
  nonPrivateClient: number
  /** 401s: unknown or invalid device token. */
  unauthorized: number
  /** 403s from the endpoint-removed tombstone: a client that should unpair. */
  endpointRemoved: number
  /** Unhandled 500s. Any number above zero here is a bug, not a busy relay. */
  internalError: number
}

export interface SweepStats {
  /** Passes completed since boot. Zero on a relay whose sweeper never fired. */
  runs: number
  lastRunAt?: string
  lastPurged: number
  lastDeleted: number
  totalPurged: number
  totalDeleted: number
  /** Passes that threw. A sweeper erroring every minute leaks ciphertext past its TTL. */
  errors: number
}

/** The most recent unhandled failure, kept so a reader need not go to the logs first. */
export interface LastError {
  at: string
  message: string
}

const MAX_ERROR_MESSAGE = 200

export class RelayStats {
  /** Wall-clock boot time of THIS process; every counter below is relative to it. */
  readonly startedAt: Date

  private readonly refusals: RefusalCounts = {
    rateLimited: 0,
    nonPrivateClient: 0,
    unauthorized: 0,
    endpointRemoved: 0,
    internalError: 0,
  }

  private readonly sweeps: SweepStats = {
    runs: 0,
    lastPurged: 0,
    lastDeleted: 0,
    totalPurged: 0,
    totalDeleted: 0,
    errors: 0,
  }

  private lastError?: LastError

  constructor(startedAt: Date = new Date()) {
    this.startedAt = startedAt
  }

  /** Tally one refused/failed request by the contract error code it produced. */
  countRefusal(kind: keyof RefusalCounts): void {
    this.refusals[kind] += 1
  }

  recordSweep(result: SweepResult, at: Date): void {
    this.sweeps.runs += 1
    this.sweeps.lastRunAt = at.toISOString()
    this.sweeps.lastPurged = result.purged
    this.sweeps.lastDeleted = result.deleted
    this.sweeps.totalPurged += result.purged
    this.sweeps.totalDeleted += result.deleted
  }

  recordSweepError(err: unknown, at: Date): void {
    this.sweeps.errors += 1
    this.recordError(err, at)
  }

  /**
   * Remember the newest unhandled failure. Truncated, because the point is to name
   * the failure well enough to search the logs for it, not to be the log.
   */
  recordError(err: unknown, at: Date = new Date()): void {
    const raw = err instanceof Error ? err.message : String(err)
    this.lastError = {
      at: at.toISOString(),
      message: raw.length > MAX_ERROR_MESSAGE ? `${raw.slice(0, MAX_ERROR_MESSAGE)}…` : raw,
    }
  }

  snapshot(): {
    refusals: RefusalCounts
    sweeps: SweepStats
    lastError?: LastError
  } {
    return {
      refusals: { ...this.refusals },
      sweeps: { ...this.sweeps },
      ...(this.lastError ? { lastError: { ...this.lastError } } : {}),
    }
  }
}
