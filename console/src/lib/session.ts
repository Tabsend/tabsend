import type { GroupKeyRecord, NewDeviceWatch } from '@tabsend/shared'
import { sortKeys } from './keyring'
import type { ConsoleSession } from './model'

/**
 * Console session persistence — the keypair + device token + registration ids, held
 * in localStorage (ADR-0003: the endpoint holds a per-endpoint device token, never
 * account credentials). Behind a tiny KeyValue interface so tests inject an
 * in-memory bag instead of a real Storage.
 *
 * The group history keyring [ADR-0028] lives here too rather than in the
 * IndexedDB history store: it is key material with the same lifetime and the same
 * blast radius as the private key two lines above it, and losing it means losing
 * the ability to read history, not losing history. Keeping the two together means
 * one place to clear on unpair, and no way to end up holding one without the other.
 */
export interface KeyValue {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

const SESSION_KEY = 'tabsend.console.session.v1'
const KEYRING_KEY = 'tabsend.console.keyring.v1'
const NEW_DEVICES_KEY = 'tabsend.console.newdevices.v1'
const PAIRING_VOUCH_KEY = 'tabsend.console.pairingvouch.v1'
const GROUP_RESET_KEY = 'tabsend.console.groupreset.v1'

/** localStorage-backed KV in a browser; an in-memory bag elsewhere (tests/SSR). */
export function defaultKv(): KeyValue {
  if (typeof localStorage !== 'undefined') return localStorage
  return new MemoryKv()
}

/** In-memory KeyValue for tests. */
export class MemoryKv implements KeyValue {
  private readonly map = new Map<string, string>()
  getItem(key: string): string | null {
    return this.map.get(key) ?? null
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value)
  }
  removeItem(key: string): void {
    this.map.delete(key)
  }
}

/** Read the stored session, or null when this browser hasn't paired a console yet. */
export function loadSession(kv: KeyValue = defaultKv()): ConsoleSession | null {
  const raw = kv.getItem(SESSION_KEY)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<ConsoleSession>
    if (
      typeof parsed.endpointId === 'string' &&
      typeof parsed.deviceToken === 'string' &&
      typeof parsed.privateKey === 'string' &&
      typeof parsed.publicKey === 'string' &&
      typeof parsed.groupId === 'string' &&
      typeof parsed.keyId === 'string'
    ) {
      return {
        relayUrl: parsed.relayUrl ?? '',
        endpointId: parsed.endpointId,
        groupId: parsed.groupId,
        deviceToken: parsed.deviceToken,
        label: parsed.label ?? 'Console',
        publicKey: parsed.publicKey,
        privateKey: parsed.privateKey,
        keyId: parsed.keyId,
      }
    }
  } catch {
    // corrupt payload — treat as unpaired
  }
  return null
}

export function saveSession(session: ConsoleSession, kv: KeyValue = defaultKv()): void {
  kv.setItem(SESSION_KEY, JSON.stringify(session))
}

/** Forget this console's pairing (local only — does NOT remove the endpoint server-side). */
export function clearSession(kv: KeyValue = defaultKv()): void {
  kv.removeItem(SESSION_KEY)
  // The ring is useless without the token that fetches blobs to open, and it is
  // group secret material; leaving it behind in an unpaired browser buys nothing.
  kv.removeItem(KEYRING_KEY)
  kv.removeItem(NEW_DEVICES_KEY)
  kv.removeItem(PAIRING_VOUCH_KEY)
  kv.removeItem(GROUP_RESET_KEY)
}

/**
 * The "new device joined" record (PLANS.md P-10): the device ids in the last
 * list this console accepted, and the joined devices not yet answered. Anything
 * unreadable reads as absent, which only means the next list is a fresh
 * baseline: no alert, but the first-look card asks about it again.
 */
export function loadNewDeviceWatch(kv: KeyValue = defaultKv()): NewDeviceWatch | null {
  const raw = kv.getItem(NEW_DEVICES_KEY)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<NewDeviceWatch>
    if (
      typeof parsed.selfId === 'string' &&
      Array.isArray(parsed.known) &&
      Array.isArray(parsed.unconfirmed)
    ) {
      return parsed as NewDeviceWatch
    }
  } catch {
    // corrupt payload: start a fresh baseline
  }
  return null
}

export function saveNewDeviceWatch(watch: NewDeviceWatch, kv: KeyValue = defaultKv()): void {
  kv.setItem(NEW_DEVICES_KEY, JSON.stringify(watch))
}

/**
 * The device tags the pairing link this console joined with carried (P-23), kept
 * until the first device list of that pairing has been judged against them.
 */
export interface PairingVouch {
  endpointId: string
  tags: string[]
}

export function loadPairingVouch(kv: KeyValue = defaultKv()): PairingVouch | null {
  const raw = kv.getItem(PAIRING_VOUCH_KEY)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<PairingVouch>
    if (
      typeof parsed.endpointId === 'string' &&
      Array.isArray(parsed.tags) &&
      parsed.tags.every((t) => typeof t === 'string')
    ) {
      return parsed as PairingVouch
    }
  } catch {
    // Unreadable: the first look asks about every device, as with an older link.
  }
  return null
}

export function savePairingVouch(vouch: PairingVouch, kv: KeyValue = defaultKv()): void {
  kv.setItem(PAIRING_VOUCH_KEY, JSON.stringify(vouch))
}

export function clearPairingVouch(kv: KeyValue = defaultKv()): void {
  kv.removeItem(PAIRING_VOUCH_KEY)
}

/**
 * The reset this console answered "It was me" to (PLANS.md P-18 item 12), by its
 * `requestedAt`, for one pairing. A new request (another `requestedAt`) shows again.
 */
export function loadDismissedGroupReset(
  selfId: string,
  kv: KeyValue = defaultKv(),
): string | undefined {
  const raw = kv.getItem(GROUP_RESET_KEY)
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw) as { selfId?: unknown; dismissedFor?: unknown }
    if (parsed.selfId === selfId && typeof parsed.dismissedFor === 'string') {
      return parsed.dismissedFor
    }
  } catch {
    // unreadable: the card shows again, which is the safe side
  }
  return undefined
}

export function saveDismissedGroupReset(
  selfId: string,
  requestedAt: string,
  kv: KeyValue = defaultKv(),
): void {
  kv.setItem(GROUP_RESET_KEY, JSON.stringify({ selfId, dismissedFor: requestedAt }))
}

/**
 * Read the stored group history keyring [ADR-0028]. An unreadable or malformed
 * store reads as empty: the ring is a cache of copies the relay still holds, so
 * the next poll refills it. Records are validated one by one, so one bad entry
 * does not cost the others.
 */
export function loadKeyring(kv: KeyValue = defaultKv()): GroupKeyRecord[] {
  const raw = kv.getItem(KEYRING_KEY)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return sortKeys(parsed.filter(isKeyRecord))
  } catch {
    return []
  }
}

export function saveKeyring(ring: readonly GroupKeyRecord[], kv: KeyValue = defaultKv()): void {
  kv.setItem(KEYRING_KEY, JSON.stringify(sortKeys(ring)))
}

function isKeyRecord(value: unknown): value is GroupKeyRecord {
  const record = value as Partial<GroupKeyRecord> | null
  return (
    typeof record?.key === 'string' &&
    typeof record.keyId === 'string' &&
    typeof record.createdAt === 'string'
  )
}

/**
 * The relay base URL to talk to. Same-origin ('' → relative `/v1/...`) is the
 * default and the tested path: the console is served by the relay in production and
 * the dev server proxies `/v1` to it. A session paired against a different origin
 * (self-hoster who pasted a cross-origin pairing link) keeps that absolute base.
 */
export function relayBaseFor(session: ConsoleSession | null): string {
  return session?.relayUrl ?? ''
}
