import { createECDH, createHash } from 'node:crypto'
import type { Kysely } from 'kysely'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDatabase, type Database, migrate } from '../src/db'
import { ensureVapidConfig } from '../src/vapid-config'

let db: Kysely<Database>

/** Compare generated private keys without allowing an assertion failure to print them. */
function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

beforeEach(async () => {
  db = createDatabase('sqlite::memory:')
  await migrate(db)
})

afterEach(async () => {
  await db.destroy()
})

describe('automatic VAPID provisioning', () => {
  it('generates once, persists the pair, and reuses it on restart', async () => {
    const first = await ensureVapidConfig(db, 'mailto:first@example.com')
    const second = await ensureVapidConfig(db, 'https://example.com/push-contact')

    expect(first.generated).toBe(true)
    expect(second.generated).toBe(false)
    expect(second.config.publicKey).toBe(first.config.publicKey)
    expect(fingerprint(second.config.privateKey)).toBe(fingerprint(first.config.privateKey))
    // The contact is configuration, not identity: operators can correct it without
    // rotating the keypair or invalidating subscriptions.
    expect(second.config.subject).toBe('https://example.com/push-contact')

    const stored = await db
      .selectFrom('meta')
      .select('value')
      .where('key', '=', 'vapid_keypair_v1')
      .executeTakeFirstOrThrow()
    const persisted = JSON.parse(stored.value) as { publicKey: string; privateKey: string }
    expect(persisted.publicKey).toBe(first.config.publicKey)
    expect(fingerprint(persisted.privateKey)).toBe(fingerprint(first.config.privateKey))
  })

  it('converges on one pair when first-boot provisioning races', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => ensureVapidConfig(db, 'mailto:ops@example.com')),
    )

    expect(results.filter((result) => result.generated)).toHaveLength(1)
    expect(new Set(results.map((result) => result.config.publicKey))).toHaveLength(1)
    expect(new Set(results.map((result) => fingerprint(result.config.privateKey)))).toHaveLength(1)
  })

  it('persists a valid P-256 keypair, not merely two well-shaped strings', async () => {
    const { config } = await ensureVapidConfig(db, 'mailto:ops@example.com')
    const ecdh = createECDH('prime256v1')
    ecdh.setPrivateKey(Buffer.from(config.privateKey, 'base64url'))

    expect(ecdh.getPublicKey('base64url')).toBe(config.publicKey)
  })

  it('refuses a damaged persisted pair instead of silently rotating it', async () => {
    await db
      .insertInto('meta')
      .values({
        key: 'vapid_keypair_v1',
        value: JSON.stringify({ publicKey: 'damaged', privateKey: 'also-damaged' }),
      })
      .execute()

    await expect(ensureVapidConfig(db, 'mailto:ops@example.com')).rejects.toThrow(
      'persisted VAPID keypair is invalid',
    )

    const stored = await db
      .selectFrom('meta')
      .select('value')
      .where('key', '=', 'vapid_keypair_v1')
      .executeTakeFirstOrThrow()
    expect(stored.value).toContain('damaged')
  })
})
