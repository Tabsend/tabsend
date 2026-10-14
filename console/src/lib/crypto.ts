import sodium from 'libsodium-wrappers'
import { base64ToBase64Url, base64ToBytes, bytesToBase64 } from './base64'

/**
 * E2E crypto for the console — libsodium `crypto_box` (X25519 + XSalsa20-Poly1305),
 * ADR-0005 / 0009. The console is a real endpoint: it holds its own keypair, opens
 * the group history key copies sealed to it (ADR-0028) and the older per-console
 * history copies senders seal to it (ADR-0010). It never SEALS — it is excluded
 * from every send chooser, so there is no seal path here (unlike the extension).
 * The relay only ever holds ciphertext + fingerprints.
 *
 * This mirrors extension/src/lib/crypto.ts exactly for the shared subset, so a
 * payload the extension seals to a console pubkey opens here identically.
 */

let readyPromise: Promise<void> | null = null

/** Resolve once libsodium's WASM/asm runtime is initialised. */
export async function ready(): Promise<void> {
  if (!readyPromise) readyPromise = sodium.ready.then(() => undefined)
  await readyPromise
}

export interface KeyPairB64 {
  /** Standard-base64 X25519 public key — published to the group as `e2ePubkey`. */
  publicKey: string
  /** Standard-base64 X25519 secret key — never leaves this browser (localStorage). */
  privateKey: string
}

/** Generate a fresh X25519 keypair (base64-encoded) at console pairing. */
export async function generateKeyPair(): Promise<KeyPairB64> {
  await ready()
  const kp = sodium.crypto_box_keypair()
  return { publicKey: bytesToBase64(kp.publicKey), privateKey: bytesToBase64(kp.privateKey) }
}

/**
 * Content fingerprint of a base64 public-key STRING: `base64url(sha256(utf8(pub)))`.
 * Matches the relay's `keyIdFor()` and the extension's `keyId()`, so `senderKeyId`
 * on an incoming envelope can be matched against a group endpoint's published key.
 */
export async function keyId(pubkeyB64: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pubkeyB64))
  return base64ToBase64Url(bytesToBase64(new Uint8Array(digest)))
}

export interface SealedBox {
  /** base64 24-byte per-message nonce. */
  nonce: string
  /** base64 crypto_box ciphertext. */
  ciphertext: string
}

/**
 * Open a sealed box addressed to this console, verifying it came from `senderPubkey`.
 * Throws if authentication fails (a forged/corrupted message or the wrong sender key),
 * which the caller treats as "drop it, leave it queued".
 */
export async function open(
  box: SealedBox,
  senderPubkeyB64: string,
  recipientPrivkeyB64: string,
): Promise<string> {
  await ready()
  const plaintext = sodium.crypto_box_open_easy(
    base64ToBytes(box.ciphertext),
    base64ToBytes(box.nonce),
    base64ToBytes(senderPubkeyB64),
    base64ToBytes(recipientPrivkeyB64),
  )
  return new TextDecoder().decode(plaintext)
}

// --- group history key [0028] ---------------------------------------------
//
// `crypto_secretbox` is the symmetric half of the `crypto_box` above: the same
// XSalsa20-Poly1305 construction with the key handed over directly instead of
// derived from an X25519 exchange. No new primitive enters the codebase, and
// nothing here changes what the relay can read — it holds neither key.
//
// Only the READING half lives here. `generateGroupKey` and `sealGroup` exist in
// extension/src/lib/crypto.ts and are deliberately absent from the console: a
// console cannot send, so it has nothing to seal, and it must never be the
// device that mints the group's key (lib/keyring.ts says why). A function that
// does not exist cannot be reached by a later refactor that forgets the rule.

/**
 * Fingerprint of a group key, so two devices can agree WHICH key is which
 * without ever comparing the secrets, and a stored blob can name the key that
 * sealed it. Same shape as `keyId` above, over the key string.
 *
 * The console uses it to check a delivered key against the id it arrived under:
 * a record whose `keyId` does not fingerprint its own `key` would sit in the
 * ring answering blob lookups with the wrong secret.
 */
export async function groupKeyId(keyB64: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(keyB64))
  return base64ToBase64Url(bytesToBase64(new Uint8Array(digest)))
}

/**
 * Open a group-sealed history blob. Throws when the key is wrong or the blob is
 * corrupt, which the caller treats as "keep the row, show it without content".
 *
 * There is no sender to verify here, by design: anyone holding the group key
 * could have written it, and everyone holding it is a paired device. A TAB's
 * authenticity still rests on its per-target envelope; this is the record of
 * that send, not the send itself.
 */
export async function openGroup(box: SealedBox, keyB64: string): Promise<string> {
  await ready()
  const plaintext = sodium.crypto_secretbox_open_easy(
    base64ToBytes(box.ciphertext),
    base64ToBytes(box.nonce),
    base64ToBytes(keyB64),
  )
  return new TextDecoder().decode(plaintext)
}
