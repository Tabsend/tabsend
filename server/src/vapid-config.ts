import { createECDH } from 'node:crypto'
import type { Kysely } from 'kysely'
import webpush from 'web-push'
import type { VapidConfig } from './config'
import type { Database } from './db'

const VAPID_META_KEY = 'vapid_keypair_v1'

interface StoredVapidKeypair {
  publicKey: string
  privateKey: string
}

export interface ProvisionedVapidConfig {
  config: VapidConfig
  /** True only for the process that won the first-boot insert. */
  generated: boolean
}

/**
 * Parse and verify the database value without ever including it in an error.
 *
 * Checking that the public key is derived from the private key catches truncated,
 * hand-edited, or otherwise corrupt backups before the relay starts returning a public
 * key that can never authenticate a push. We deliberately do not regenerate on damage:
 * silently rotating VAPID keys would invalidate every existing push subscription.
 */
function parseStoredKeypair(value: string): StoredVapidKeypair {
  try {
    const parsed = JSON.parse(value) as Partial<StoredVapidKeypair>
    if (typeof parsed.publicKey !== 'string' || typeof parsed.privateKey !== 'string') {
      throw new Error('missing key')
    }

    const privateKey = Buffer.from(parsed.privateKey, 'base64url')
    const publicKey = Buffer.from(parsed.publicKey, 'base64url')
    if (privateKey.length !== 32 || publicKey.length !== 65) throw new Error('wrong key length')

    const ecdh = createECDH('prime256v1')
    ecdh.setPrivateKey(privateKey)
    if (!ecdh.getPublicKey().equals(publicKey)) throw new Error('keypair mismatch')

    return { publicKey: parsed.publicKey, privateKey: parsed.privateKey }
  } catch {
    throw new Error(
      'The persisted VAPID keypair is invalid. Restore the relay database from a known-good backup; do not delete the value unless you intend to rotate Web Push keys and resubscribe every client.',
    )
  }
}

/**
 * Return this relay's stable VAPID keypair, minting it on the first boot only.
 *
 * The `meta` row lives in the same SQLite/Postgres database as the relay identity and
 * pairings, so normal database backup/restore and every Docker deployment shape preserve
 * it automatically. The conflict-safe insert makes concurrent first boots converge on
 * one winner: losing processes discard their candidate and read the stored pair.
 */
export async function ensureVapidConfig(
  db: Kysely<Database>,
  subject: string,
): Promise<ProvisionedVapidConfig> {
  const candidate = webpush.generateVAPIDKeys()
  const insert = await db
    .insertInto('meta')
    .values({
      key: VAPID_META_KEY,
      value: JSON.stringify({
        publicKey: candidate.publicKey,
        privateKey: candidate.privateKey,
      } satisfies StoredVapidKeypair),
    })
    .onConflict((oc) => oc.column('key').doNothing())
    .executeTakeFirst()

  const row = await db
    .selectFrom('meta')
    .select('value')
    .where('key', '=', VAPID_META_KEY)
    .executeTakeFirstOrThrow()
  const keys = parseStoredKeypair(row.value)

  return {
    config: { ...keys, subject },
    // Kysely reports bigint rows on both SQLite and Postgres.
    generated: BigInt(insert.numInsertedOrUpdatedRows ?? 0) === 1n,
  }
}
