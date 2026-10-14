import type {
  EncryptedEnvelope,
  Endpoint,
  EndpointId,
  HistoryEntry as GroupHistoryRow,
  GroupKeyDelivery,
  GroupKeyRecord,
  GroupSealed,
  HistoryRecord,
  IsoTimestamp,
  Message,
  MessageId,
  SendPayload,
} from '@tabsend/shared'
import sodium from 'libsodium-wrappers'
import { groupKeyId, keyId } from './crypto'

/**
 * Test fixtures shared by the console unit tests. Not shipped (only imported by
 * *.test.ts; the Vite build never pulls it in). Seals with real libsodium exactly
 * as a sender (extension) would, so the console's verify/open path is exercised for
 * real — the relay would only ever see this ciphertext.
 */

let counter = 0

export function makeEndpoint(over: Partial<Endpoint> = {}): Endpoint {
  counter += 1
  return {
    id: (over.id ?? `ep-${counter}`) as EndpointId,
    groupId: (over.groupId ?? 'group-1') as Endpoint['groupId'],
    kind: over.kind ?? 'extension',
    browser: over.browser ?? 'chrome',
    platform: over.platform ?? 'macos',
    label: over.label ?? `Device ${counter}`,
    e2ePubkey: over.e2ePubkey ?? 'pubkey-placeholder',
    presence: over.presence ?? 'online',
    lastSeenAt: (over.lastSeenAt ?? new Date().toISOString()) as IsoTimestamp,
    createdAt: (over.createdAt ?? new Date().toISOString()) as IsoTimestamp,
  }
}

export interface SealedMessageOptions {
  id?: string
  sourceEndpointId: string
  /** Sealed to this pubkey (the console's). */
  targetPubkeyB64: string
  /** Authenticated with this sender private key. */
  senderPrivkeyB64: string
  senderPubkeyB64: string
  payload: SendPayload
  /** Override the senderKeyId on the wire (to simulate an unknown/forged sender). */
  senderKeyIdOverride?: string
}

/** Build a Message whose envelope is a real crypto_box sealed to the console. */
export async function sealedMessage(opts: SealedMessageOptions): Promise<Message> {
  await sodium.ready
  const envelope = await sealEnvelope(
    JSON.stringify(opts.payload),
    opts.targetPubkeyB64,
    opts.senderPrivkeyB64,
    opts.senderPubkeyB64,
    opts.senderKeyIdOverride,
  )
  const now = new Date().toISOString() as IsoTimestamp
  counter += 1
  return {
    id: (opts.id ?? `msg-${counter}`) as MessageId,
    groupId: 'group-1' as Message['groupId'],
    sourceEndpointId: opts.sourceEndpointId as EndpointId,
    targetEndpointId: 'console-1' as EndpointId,
    envelope,
    createdAt: now,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString() as IsoTimestamp,
    deliveredAt: null,
    ackedAt: null,
  }
}

/** One real crypto_box envelope, shared by tab copies and group key deliveries. */
async function sealEnvelope(
  plaintext: string,
  targetPubkeyB64: string,
  senderPrivkeyB64: string,
  senderPubkeyB64: string,
  senderKeyIdOverride?: string,
): Promise<EncryptedEnvelope> {
  await sodium.ready
  const nonce = sodium.randombytes_buf(sodium.crypto_box_NONCEBYTES)
  const ciphertext = sodium.crypto_box_easy(
    sodium.from_string(plaintext),
    nonce,
    sodium.from_base64(targetPubkeyB64, sodium.base64_variants.ORIGINAL),
    sodium.from_base64(senderPrivkeyB64, sodium.base64_variants.ORIGINAL),
  )
  return {
    alg: 'x25519-xsalsa20-poly1305/box',
    senderKeyId: senderKeyIdOverride ?? (await keyId(senderPubkeyB64)),
    targetKeyId: await keyId(targetPubkeyB64),
    nonce: sodium.to_base64(nonce, sodium.base64_variants.ORIGINAL),
    ciphertext: sodium.to_base64(ciphertext, sodium.base64_variants.ORIGINAL),
  }
}

// --- group history [ADR-0028] ----------------------------------------------

/** A 32-byte group history key with the fingerprint the wire uses to name it. */
export async function makeGroupKey(createdAt: string): Promise<GroupKeyRecord> {
  await sodium.ready
  const key = sodium.to_base64(
    sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES),
    sodium.base64_variants.ORIGINAL,
  )
  return { key, keyId: await groupKeyId(key), createdAt: createdAt as IsoTimestamp }
}

export interface KeyDeliveryOptions {
  id?: string
  sourceEndpointId: string
  record: GroupKeyRecord
  /** Sealed to this pubkey (the console's). */
  targetPubkeyB64: string
  senderPrivkeyB64: string
  senderPubkeyB64: string
  /** Override the senderKeyId on the wire (an unknown or forged sender). */
  senderKeyIdOverride?: string
}

/** One copy of the group key, sealed to the console exactly as a member would. */
export async function sealedKeyDelivery(opts: KeyDeliveryOptions): Promise<GroupKeyDelivery> {
  const envelope = await sealEnvelope(
    JSON.stringify(opts.record),
    opts.targetPubkeyB64,
    opts.senderPrivkeyB64,
    opts.senderPubkeyB64,
    opts.senderKeyIdOverride,
  )
  counter += 1
  return {
    id: opts.id ?? `gk-${counter}`,
    sourceEndpointId: opts.sourceEndpointId as EndpointId,
    envelope,
    createdAt: new Date().toISOString() as IsoTimestamp,
  }
}

/** A real `crypto_secretbox` blob under a group key, as a sender would write it. */
export async function sealedGroupBlob(
  record: HistoryRecord,
  key: GroupKeyRecord,
): Promise<GroupSealed> {
  await sodium.ready
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES)
  const ciphertext = sodium.crypto_secretbox_easy(
    sodium.from_string(JSON.stringify(record)),
    nonce,
    sodium.from_base64(key.key, sodium.base64_variants.ORIGINAL),
  )
  return {
    alg: 'xsalsa20-poly1305/secretbox',
    keyId: key.keyId,
    nonce: sodium.to_base64(nonce, sodium.base64_variants.ORIGINAL),
    ciphertext: sodium.to_base64(ciphertext, sodium.base64_variants.ORIGINAL),
  }
}

/** One row of `GET /v1/messages?history=1`, with the relay's routing facts. */
export function groupHistoryRow(
  over: Partial<GroupHistoryRow> & { blob: GroupSealed },
): GroupHistoryRow {
  counter += 1
  const now = new Date().toISOString() as IsoTimestamp
  return {
    id: (over.id ?? `hist-${counter}`) as MessageId,
    sourceEndpointId: (over.sourceEndpointId ?? 'sender-1') as EndpointId,
    targetEndpointId: (over.targetEndpointId ?? 'target-1') as EndpointId,
    createdAt: over.createdAt ?? now,
    expiresAt: over.expiresAt ?? (new Date(Date.now() + 86_400_000).toISOString() as IsoTimestamp),
    deliveredAt: over.deliveredAt ?? null,
    ackedAt: over.ackedAt ?? null,
    blob: over.blob,
  }
}
