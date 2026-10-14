/**
 * @tabsend/server — the Tabsend relay: durable queue, VAPID Web Push wake, the
 * full v1 REST contract, and a latency-only WebSocket fast path. Stores/forwards
 * ciphertext only; performs NO crypto (ADR-0005/0009).
 *
 * Public surface for embedding/testing. The runnable entry is `server.ts`.
 */
export { type BuildAppOptions, buildApp } from './app'
export { type Config, loadConfig } from './config'
export {
  createDatabase,
  dropPgSchema,
  ensurePgSchema,
  isPostgresUrl,
  migrate,
  resolveSqlitePath,
} from './db'
export type { Database } from './db/schema'
export {
  createPushSender,
  FakePushSender,
  NoopPushSender,
  type PushSender,
  WebPushSender,
} from './push'
export { start } from './server'
export { type SweepResult, startSweeper, sweepExpired } from './sweep'
export { ensureVapidConfig, type ProvisionedVapidConfig } from './vapid-config'
