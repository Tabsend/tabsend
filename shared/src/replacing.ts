import type { Endpoint } from './types'

/**
 * "Is this browser replacing Dia?" (PLANS.md P-31 item 2).
 *
 * A reinstalled browser or app pairs as a NEW device, and the relay renames it so
 * two entries never share a label ("Dia · Mac" comes back as "Dia 2 · Mac"). The
 * old entry stays in the group, and other devices keep sending to it. So, right
 * after a device pairs, during its OWN setup, it looks for an old offline copy of
 * itself and offers to replace it. This picks that old entry, or none.
 *
 * Why this is not the withdrawn "Remove old one" (SECURITY_REVIEW.md L1, L2, L5, L6):
 *  - It runs only on the device that just paired, about ITSELF. It never answers or
 *    accepts any device (L1): replacing removes the old entry and renames this one.
 *  - It never offers this device. It skips ids on this device's removed list, which on a
 *    device that has just paired is nearly always empty: a guard, not a protection.
 *  - The wording asks and shows the old entry's full name and when it was last seen;
 *    it does not assert that the two are the same (L2). The relay's own renaming is
 *    undone before comparing, so an honest relay's dedupe does not hide the match.
 *  - Times must be exactly `YYYY-MM-DDTHH:mm:ss.sssZ` naming a real instant, the GH4
 *    rule; anything else matches nothing. Names are compared after ASCII-only
 *    lowercasing and collapsing ASCII spaces, as UTF-16 code units, so Android
 *    (`logic/Replacing.kt`) and iOS (`TabsendKit/Replacing.swift`) give the same
 *    answer on every input (L6). All three run `shared/vectors/replacing-devices.json`.
 *
 * A candidate is another entry in the list that:
 *  - is not this device and not on this device's removed list;
 *  - is the same kind (a browser replaces a browser, a phone a phone);
 *  - has the same browser or app name once the relay's counter is stripped
 *    ("Dia 2" and "Dia" are both "dia"), and the same computer name (the part after
 *    " · "; phones have none, so both are empty);
 *  - is offline, and was last seen more than a day before `nowMs`;
 *  - joined before this device did, and was last seen before this device joined.
 *
 * With several (reinstalled more than once), the one seen most recently is "the old
 * one". Ties go to the newer `createdAt`, then the larger id, so every client picks
 * the same one.
 *
 * Residual (P-31): every input comes from the relay. A relay that lies about who is
 * offline can lead the user to remove a live device by choice; that device is told
 * it was removed and can pair again.
 */
export type ReplacingCandidate = Pick<
  Endpoint,
  'id' | 'label' | 'kind' | 'presence' | 'lastSeenAt' | 'createdAt'
>

/** How long an entry must have been quiet before it is offered: a day. */
export const REPLACE_QUIET_MS = 24 * 60 * 60 * 1000

const SEP = ' · '

/** The highest counter the relay's dedupe writes (`uniqueBrowserName`, `naming.ts`). */
const MAX_COUNTER = 99

/**
 * Milliseconds for exactly `YYYY-MM-DDTHH:mm:ss.sssZ` naming a real instant, else
 * null. The same rule as `isAcceptableKeyCreatedAt` (GH4), without the "ahead of
 * the clock" part.
 */
export function strictIsoMillis(text: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(text)) return null
  const at = Date.parse(text)
  if (Number.isNaN(at)) return null
  if (new Date(at).toISOString() !== text) return null
  return at
}

/** ASCII-only lowercase, runs of ASCII spaces, tabs and line breaks as one space, none at either end. */
export function normalizeName(name: string): string {
  let out = ''
  let pendingSpace = false
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i)
    if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) {
      pendingSpace = out.length > 0
      continue
    }
    if (pendingSpace) out += ' '
    pendingSpace = false
    out += c >= 0x41 && c <= 0x5a ? String.fromCharCode(c + 0x20) : name.charAt(i)
  }
  return out
}

/**
 * A normalized name without the relay's counter: "dia 2" → "dia", "pixel 9" →
 * "pixel". Only a trailing " N" with N from 2 to 99 and no leading zero, which is
 * what the dedupe writes; "dia 1", "dia 02" and "dia 100" stay as they are.
 */
export function withoutCounter(normalized: string): string {
  const space = normalized.lastIndexOf(' ')
  if (space <= 0) return normalized
  const digits = normalized.slice(space + 1)
  if (!/^[1-9][0-9]?$/.test(digits)) return normalized
  const n = Number(digits)
  if (n < 2 || n > MAX_COUNTER) return normalized
  return normalized.slice(0, space)
}

/** The two halves a match compares: the app name without its counter, and the computer name. */
export function replacingKey(label: string): { app: string; computer: string } {
  const i = label.indexOf(SEP)
  const app = i === -1 ? label : label.slice(0, i)
  const computer = i === -1 ? '' : label.slice(i + SEP.length)
  return { app: withoutCounter(normalizeName(app)), computer: normalizeName(computer) }
}

/** The app half of a label as shown: "Dia" from "Dia · MacBook Pro". For "Replace Dia". */
export function appNameOf(label: string): string {
  const i = label.indexOf(SEP)
  return i === -1 ? label : label.slice(0, i)
}

export function findReplacedSelf<E extends ReplacingCandidate>(
  selfId: string,
  list: readonly E[],
  removed: readonly string[],
  nowMs: number,
): E | null {
  const self = list.find((e) => e.id === selfId)
  if (!self) return null
  const selfCreated = strictIsoMillis(self.createdAt)
  if (selfCreated === null) return null
  const mine = replacingKey(self.label)
  if (mine.app === '') return null

  let best: { e: E; seen: number; created: number } | null = null
  for (const e of list) {
    if (e.id === selfId || removed.includes(e.id)) continue
    if (e.kind !== self.kind) continue
    if (e.presence === 'online') continue
    const seen = strictIsoMillis(e.lastSeenAt)
    const created = strictIsoMillis(e.createdAt)
    if (seen === null || created === null) continue
    if (nowMs - seen <= REPLACE_QUIET_MS) continue
    if (created >= selfCreated || seen >= selfCreated) continue
    const theirs = replacingKey(e.label)
    if (theirs.app !== mine.app || theirs.computer !== mine.computer) continue
    if (
      !best ||
      seen > best.seen ||
      (seen === best.seen && created > best.created) ||
      (seen === best.seen && created === best.created && e.id > best.e.id)
    ) {
      best = { e, seen, created }
    }
  }
  return best?.e ?? null
}
