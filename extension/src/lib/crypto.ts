import sodium from 'libsodium-wrappers'
import { base64ToBase64Url, base64ToBytes, bytesToBase64 } from './base64'

/**
 * E2E crypto for Tabsend link payloads — libsodium `crypto_box` (X25519 +
 * XSalsa20-Poly1305), authenticated per target (ADR-0005 / 0009). The relay only
 * ever holds the ciphertext + fingerprints; all sealing/opening happens here.
 *
 * Public keys travel as standard-base64 strings (that string IS `Endpoint.e2ePubkey`).
 * A keyId is `base64url(sha256(utf8(pubkeyString)))` — the same content
 * fingerprint the server computes in `keyIdFor()`, used for stale-key detection
 * and sender verification.
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
  /** Standard-base64 X25519 secret key — never leaves this install. */
  privateKey: string
}

/** Generate a fresh X25519 keypair (base64-encoded). */
export async function generateKeyPair(): Promise<KeyPairB64> {
  await ready()
  const kp = sodium.crypto_box_keypair()
  return { publicKey: bytesToBase64(kp.publicKey), privateKey: bytesToBase64(kp.privateKey) }
}

/**
 * Content fingerprint of a base64 public-key STRING. Must match the relay's
 * `keyIdFor()` exactly (`base64url(sha256(utf8(e2ePubkey)))`) or the server
 * rejects the send with `expired_key`.
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

/** Seal a plaintext string to `targetPubkey`, authenticated with `senderPrivkey`. */
export async function seal(
  plaintext: string,
  targetPubkeyB64: string,
  senderPrivkeyB64: string,
): Promise<SealedBox> {
  await ready()
  const nonce = sodium.randombytes_buf(sodium.crypto_box_NONCEBYTES)
  const ciphertext = sodium.crypto_box_easy(
    new TextEncoder().encode(plaintext),
    nonce,
    base64ToBytes(targetPubkeyB64),
    base64ToBytes(senderPrivkeyB64),
  )
  return { nonce: bytesToBase64(nonce), ciphertext: bytesToBase64(ciphertext) }
}

/**
 * Open a sealed box addressed to us. Throws if authentication fails (a forged or
 * corrupted message), which the caller treats as "drop it".
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
// XSalsa20-Poly1305 construction with the key supplied directly instead of
// derived from an X25519 exchange. No new primitive, and nothing here changes
// what the relay can read — it holds neither key.
//
// There is no sender fingerprint on a group-sealed blob, deliberately. Anyone
// holding the group key could have written it, and everyone holding it is by
// definition a paired device. Authenticity for a TAB still rests on its
// per-target envelope; this seals the RECORD of that send.

/** Generate a fresh 32-byte group history key (base64). */
export async function generateGroupKey(): Promise<string> {
  await ready()
  return bytesToBase64(sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES))
}

/**
 * Fingerprint of a group key, so two devices can agree WHICH key is which
 * without ever comparing the secrets, and a stored blob can name the key that
 * sealed it. Same shape as `keyId` above, over the key string.
 */
export async function groupKeyId(keyB64: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(keyB64))
  return base64ToBase64Url(bytesToBase64(new Uint8Array(digest)))
}

/** Seal a plaintext string under the group key. */
export async function sealGroup(plaintext: string, keyB64: string): Promise<SealedBox> {
  await ready()
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES)
  const ciphertext = sodium.crypto_secretbox_easy(
    new TextEncoder().encode(plaintext),
    nonce,
    base64ToBytes(keyB64),
  )
  return { nonce: bytesToBase64(nonce), ciphertext: bytesToBase64(ciphertext) }
}

/** Open a group-sealed blob. Throws when the key is wrong or the blob is corrupt. */
export async function openGroup(box: SealedBox, keyB64: string): Promise<string> {
  await ready()
  const plaintext = sodium.crypto_secretbox_open_easy(
    base64ToBytes(box.ciphertext),
    base64ToBytes(box.nonce),
    base64ToBytes(keyB64),
  )
  return new TextDecoder().decode(plaintext)
}
