import { MAX_DEPARTED, MAX_DEPARTED_ID_LENGTH } from './keyrecord'
import type { Endpoint, IsoTimestamp } from './types'

// Ids are plain strings here: clients hold their own id as a string (it comes
// from their stored registration), and the record is device-local, not wire.

/**
 * The "new device joined" notice (PLANS.md P-10) — the rule every client runs.
 *
 * With signed membership parked (HOSTED_PLAN.md §9.11), the relay is trusted to
 * keep each group's device list honest. Someone who broke into it could add a
 * device, and existing devices would hand that device the history key
 * (ADR-0028). The owner accepted that risk on the condition that an added device
 * gets NOTICED. This is how.
 *
 * The rule never trusts the `endpoint_added` stream event — a compromised relay
 * would simply not send it. Each client remembers the device ids in the last
 * list it fetched and compares every new fetch against them, so a device
 * inserted straight into the database is caught on the next fetch.
 *
 * Calm by design, because a notice that cries wolf gets ignored:
 *  - The first list a client sees is the baseline. No alert is raised for anything
 *    in it, but the user is asked about it once (see `review` below): on a fresh pairing
 *    those are the devices the user just joined, on an upgrade devices they have been
 *    living with, and either way the relay chose them.
 *  - This device never announces itself.
 *  - A rename keeps the id, so it announces nothing (the pending notice picks up
 *    the new name).
 *  - A list that does not contain this device is ignored entirely. It means
 *    this device was just removed, or the fetch was wrong; treating it as the
 *    new baseline would make the next good fetch announce every device.
 *  - A device that leaves the list drops its pending notice: nothing is left to
 *    confirm or remove. It does leave a rotation owed (`rotateOwedAt`), against
 *    the key that was current at that moment (`rotateFrom`): whatever left may
 *    hold it, so the next device able to mint replaces it unless a newer key has
 *    already arrived (ADR-0028 §7). Removal and a device the relay showed once and
 *    then hid are the same event here, which is the point: both are covered.
 *  - A known id whose published key has changed is announced as new, and owes a
 *    rotation like a departure. An honest relay never changes an endpoint's key
 *    (there is no route that does), so a changed key under a known id is a
 *    different device wearing an old name.
 *  - A removal this device made is recorded at once (`removeDevice`), not left to
 *    the relay's next list: "Remove it" is only a REQUEST, and a relay that
 *    answers it and keeps listing the device would otherwise trigger no departure
 *    and no rotation (X13). The id goes on `removed`, which keeps it out of
 *    `endpointsKnownTo` for good, and if the list ever shows it again it is
 *    announced like any new device.
 *  - The first list is looked at ONCE, by the user (GH6, `review`): a card lists the
 *    other devices in it, with "All of these are mine" and a way to remove any. On
 *    pairing that list is the one the relay just served, and the relay could have put
 *    a device of its own in it. On the first run of a build with the notice it is the
 *    list the previous build cached when one exists (the baseline, so what appeared
 *    since is announced), else the fresh one. Nothing is held back from the key while
 *    the card waits: a genuine new device still gets its history at once.
 *  - A device announced as new, never answered, and then gone from the list without
 *    this device removing it is kept in `vanished` until dismissed (GH7). A relay can
 *    show a device once and hide it; the one-time alert is easy to miss, and the
 *    device read what was sent while it was listed.
 *  - The device that showed the pairing link vouches for the first list (P-23): the
 *    link carries a short tag of each device that device has accepted (`vouchTags`),
 *    and a device the new one finds in its first list under a vouched key is not put
 *    on the first look. The link travels from the user's hand to the new device, so
 *    the relay cannot add to it. Only what does not match is asked about; a link
 *    from an older client carries no tags and everything is asked about, as before.
 *  - A rotation is owed FOR named devices (`rotateFor`), and the key that pays it
 *    must name them (`GroupKeyRecord.departed`). A newer key that does not is not
 *    a rotation for them: a relay that holds key copies back can otherwise make a
 *    device stand down on a key the departed device already holds (X14).
 *
 * A client must never use, cache or hand a key to a list this rule ignored (one
 * without this device). The rule is only a notice if the list it judged is the
 * list the rest of the client acts on.
 *
 * Android (`logic/NewDevices.kt`) and iOS (`TabsendKit/NewDevices.swift`) mirror
 * this function. All three run the same cases from
 * `shared/vectors/new-devices.json`, so they cannot drift apart silently.
 */

/** One device that joined since the baseline and that the user has not answered yet. */
export interface NewDeviceNotice {
  id: string
  label: string
  createdAt: IsoTimestamp
}

/** What a client stores between fetches. Device-local; never sent anywhere. */
export interface NewDeviceWatch {
  /** The endpoint this record belongs to. A different one (re-pair, new relay) starts a fresh baseline. */
  selfId: string
  /** Every device id in the last list that was accepted. */
  known: string[]
  /** Joined since the baseline, not yet answered with "Yes, it's mine" or removed. Oldest first. */
  unconfirmed: NewDeviceNotice[]
  /**
   * Each known device's published key (`e2ePubkey`), by id. Optional only because
   * records written before 2026-10-13 lack it; such a record learns the keys on
   * its next list without announcing anything.
   */
  keys?: Record<string, string>
  /**
   * Set when a device left the list: the group key must be replaced. Cleared by
   * `rotationDone`. Also what `rotationDone` matches on, so a departure that
   * arrives while a rotation is being minted is not lost.
   */
  rotateOwedAt?: IsoTimestamp
  /**
   * The `createdAt` of the key that was current when that device left: the key to
   * replace. Compared with a KEY, not with a clock, because a key dated ahead of
   * the clock (allowed by up to a day, `keyrecord.ts`) would otherwise look like a
   * rotation that already happened, and a device about to be removed could hand
   * one out to keep the group on a key it holds (verification pass 2026-10-13).
   * Absent when the ring was empty then: any key that turns up is replaced once.
   */
  rotateFrom?: string
  /**
   * The ids behind the owed rotation: every device that left, was removed here, or
   * had its key swapped since the last rotation this device settled. The key that
   * settles the debt must name all of them (`GroupKeyRecord.departed`); the key
   * this device mints names exactly these. Oldest first, at most `MAX_DEPARTED`
   * (the newest are kept). Absent when nothing is owed.
   */
  rotateFor?: string[]
  /**
   * The devices THIS device removed, by id, for as long as this pairing lasts.
   * Left out of `endpointsKnownTo` whatever the relay's list says, so a relay that
   * keeps one listed cannot get a key or a trusted key copy through it, and
   * announced if the list shows one again. By id: an id never comes back honestly.
   */
  removed?: string[]
  /**
   * The published keys (`e2ePubkey`) of the devices THIS device removed, where it
   * knew them. A device carrying one of these under a NEW id stays out of
   * `endpointsKnownTo` until the user answers its notice ("Yes, it's mine"): a relay
   * can otherwise re-list a removed device under a fresh id and be handed the next
   * key before anyone looks. Held back only until answered, not for good, because
   * the extension keeps its device key when it re-pairs, so an honest re-paired
   * device does come back under a new id with the same key: one tap lets it in.
   */
  removedKeys?: string[]
  /**
   * The first look (GH6): the other devices in the first list this device accepted,
   * waiting for ONE answer ("All of these are mine") or for each to be removed.
   * Absent once answered, and on a record written before this existed.
   */
  review?: NewDeviceNotice[]
  /**
   * Devices that were announced as new, never answered, and then left the list
   * without this device removing them (GH7). Shown until dismissed. Newest last, at
   * most `MAX_VANISHED`.
   */
  vanished?: NewDeviceNotice[]
}

/** The most "joined, then disappeared" notices kept; a relay that flaps ids cannot grow the record. */
export const MAX_VANISHED = 20

/** The most devices a pairing link vouches for. A larger group's link vouches for the first ones; the rest are asked about. */
export const MAX_VOUCHED = 50

/** Characters of a published key a pairing link carries per device: 96 bits, too many to grind a key for. */
export const VOUCH_TAG_LENGTH = 16

export interface WatchResult {
  /** What to store next. Null only when there was nothing before and the list could not be used. */
  watch: NewDeviceWatch | null
  /** Devices that joined since the previous fetch: announce these once, as a system alert. */
  joined: NewDeviceNotice[]
}

/**
 * A device list that does not contain this device. The shared rule ignores such
 * a list, so nothing in it is announced; it must therefore not be used for
 * anything else either. Before 2026-10-13 it was cached anyway (every client did),
 * and the key sync read it: a relay could serve one list without the device in it and
 * get the group key sealed to a device nobody was ever told about.
 */
export class ListWithoutSelfError extends Error {
  constructor() {
    super('The relay returned a device list without this device')
    this.name = 'ListWithoutSelfError'
  }
}

/** True when a list may be used at all: it has to contain this device. */
export function listIncludesSelf(list: readonly Endpoint[], selfId: string): boolean {
  return list.some((e) => e.id === selfId)
}

/**
 * Compare a freshly fetched device list with what this client saw last. Pure.
 * When a device has left, `now` stamps `rotateOwedAt` and `currentKeyCreatedAt`
 * (the `createdAt` of this device's current group key, if it has one) becomes
 * `rotateFrom`.
 *
 * `seed` is the device list a build from before this rule cached, if any. With no
 * record yet it is the baseline, so a device that appeared after it was cached is
 * announced instead of being taken on trust. It counts only if it contains this
 * device, so a cache left by another pairing is ignored.
 *
 * `vouched` is the tags the pairing link carried (`parseVouch`), if any. It is used
 * only when this list becomes the baseline: a device in it whose key has a vouched tag
 * is not put on the first look. Once a record exists it is never consulted again.
 */
export function watchDevices(
  prevRecord: NewDeviceWatch | null | undefined,
  rawList: readonly Endpoint[],
  selfId: string,
  now: string = new Date().toISOString(),
  currentKeyCreatedAt?: string,
  seed?: readonly Endpoint[],
  vouched?: readonly string[],
): WatchResult {
  if (!listIncludesSelf(rawList, selfId)) {
    return { watch: prevRecord ?? null, joined: [] }
  }
  // A list that names one id twice (a relay can) counts it once, so no card or banner is doubled.
  const list = firstById(rawList)
  let prev = prevRecord
  if (!prev || prev.selfId !== selfId || !Array.isArray(prev.known)) {
    if (!seed || !listIncludesSelf(seed, selfId)) {
      return { watch: baseline(list, selfId, vouched), joined: [] }
    }
    prev = baseline(seed, selfId)
  }

  const known = new Set(prev.known)
  const prevKeys = prev.keys
  const byId = new Map<string, Endpoint>(list.map((e) => [e.id, e]))
  const rekeyed = (e: Endpoint): boolean =>
    prevKeys !== undefined && prevKeys[e.id] !== undefined && prevKeys[e.id] !== e.e2ePubkey
  const joined = list
    .filter((e) => e.id !== selfId && (!known.has(e.id) || rekeyed(e)))
    .map((e) => ({ id: e.id, label: e.label, createdAt: e.createdAt }))

  const joinedIds = new Set<string>(joined.map((j) => j.id))
  const refreshed = (n: NewDeviceNotice): NewDeviceNotice => ({
    ...n,
    label: byId.get(n.id)?.label ?? n.label,
  })
  const unconfirmed = prev.unconfirmed
    .filter((n) => byId.has(n.id) && !joinedIds.has(n.id))
    .map(refreshed)
    .concat(joined)
  const removedIds = new Set(prev.removed)
  const review = (prev.review ?? [])
    .filter((n) => byId.has(n.id) && !joinedIds.has(n.id))
    .map(refreshed)
  // Shown to the user and never answered (a pending banner, or a device on the first-look
  // card), then gone without this device removing it: the relay may be hiding it (GH7).
  // That holds for a device on the card too: it was shown once and cannot be allowed to
  // drop off without a trace. One that is back is a pending notice again, not both. One
  // whose key is still on screen as another unanswered device (a browser that re-paired:
  // new id, same key, old id deleted) is not hidden, only renamed, and is not reported.
  const onScreenKeys = new Set<string>()
  for (const n of [...unconfirmed, ...review]) {
    const key = byId.get(n.id)?.e2ePubkey
    if (key !== undefined) onScreenKeys.add(key)
  }
  const vanished = (prev.vanished ?? [])
    .filter((n) => !joinedIds.has(n.id))
    .concat(
      [...prev.unconfirmed, ...(prev.review ?? [])].filter((n) => {
        if (byId.has(n.id) || removedIds.has(n.id)) return false
        const key = prevKeys?.[n.id]
        return key === undefined || !onScreenKeys.has(key)
      }),
    )
    .slice(-MAX_VANISHED)

  // A changed key counts as leaving too: whoever held the old key may hold the
  // group key, and a key swapped in and back out again must not keep it.
  // A device this one removed owes nothing when it leaves again: it was left out of
  // key handoff the whole time it was listed, and its removal already owed (and
  // settled, or still owes) the rotation. Without this a stale list that shows it
  // for a moment costs a second rotation.
  const departed = [
    ...prev.known.filter((id) => id !== selfId && !byId.has(id)),
    ...list.filter((e) => e.id !== selfId && known.has(e.id) && rekeyed(e)).map((e) => e.id),
  ].filter((id) => !removedIds.has(id))
  const watch: NewDeviceWatch = {
    selfId,
    known: list.map((e) => e.id),
    unconfirmed,
    keys: keysOf(list),
  }
  if (departed.length > 0) {
    watch.rotateOwedAt = now as IsoTimestamp
    if (currentKeyCreatedAt !== undefined) watch.rotateFrom = currentKeyCreatedAt
    watch.rotateFor = owedIds(prev.rotateFor, departed, prev.removed)
  } else {
    if (prev.rotateOwedAt !== undefined) watch.rotateOwedAt = prev.rotateOwedAt
    if (prev.rotateFrom !== undefined) watch.rotateFrom = prev.rotateFrom
    if (prev.rotateFor !== undefined) watch.rotateFor = prev.rotateFor
  }
  if (prev.removed !== undefined) watch.removed = prev.removed
  if (prev.removedKeys !== undefined) watch.removedKeys = prev.removedKeys
  if (review.length > 0) watch.review = review
  if (vanished.length > 0) watch.vanished = vanished
  return { watch, joined }
}

/**
 * This device removed `id` and the relay accepted the request. Record it NOW, in
 * the watch, rather than waiting for a list to confirm it: the relay is the one
 * party that can say the removal did not happen, and a relay that answers the
 * DELETE and keeps listing the device would otherwise cost the attacker nothing.
 * The device leaves `known`, `keys` and the pending notices, goes on `removed`,
 * and a rotation is owed at once against the key current now, named for it.
 *
 * Whether the relay then stops listing it does not matter: if it does, the
 * ordinary departure finds nothing new to owe (the id is already gone from
 * `known`); if it does not, the next list announces the device as new and
 * `endpointsKnownTo` still leaves it out. Pure. A device never removes itself
 * here (`Unpair` is the way out). The caller passes the watch of the pairing it
 * is in; a record for another pairing is not its to change.
 */
export function removeDevice(
  watch: NewDeviceWatch,
  id: string,
  now: string = new Date().toISOString(),
  currentKeyCreatedAt?: string,
): NewDeviceWatch {
  if (id === watch.selfId) return watch
  const { rotateFrom: _from, keys, ...rest } = watch
  const removed = watch.removed?.includes(id) ? watch.removed : [...(watch.removed ?? []), id]
  const next: NewDeviceWatch = {
    ...rest,
    known: watch.known.filter((k) => k !== id),
    unconfirmed: watch.unconfirmed.filter((n) => n.id !== id),
    vanished: watch.vanished?.filter((n) => n.id !== id),
    review: watch.review?.filter((n) => n.id !== id),
    removed,
    rotateOwedAt: now as IsoTimestamp,
    rotateFor: owedIds(watch.rotateFor, [id], removed),
  }
  if (keys !== undefined) {
    next.keys = Object.fromEntries(Object.entries(keys).filter(([k]) => k !== id))
  }
  // An empty list is no list: a record never carries one, so a card or banner with
  // nothing in it cannot linger.
  if (next.vanished?.length === 0) next.vanished = undefined
  if (next.review?.length === 0) next.review = undefined
  if (next.vanished === undefined) delete next.vanished
  if (next.review === undefined) delete next.review
  const key = keys?.[id]
  if (key !== undefined && !watch.removedKeys?.includes(key)) {
    next.removedKeys = [...(watch.removedKeys ?? []), key]
  }
  if (currentKeyCreatedAt !== undefined) next.rotateFrom = currentKeyCreatedAt
  return next
}

/**
 * The owed ids after adding `more`: unique, oldest first, at most `MAX_DEPARTED`. An
 * id a key record could not carry (empty, or over `MAX_DEPARTED_ID_LENGTH`) is not
 * owed: the relay mints UUIDs, and a record naming such an id would be refused by
 * every other client, leaving this device writing under a key nobody shares. Over
 * the cap the oldest ids go first, but never one the user removed while another
 * can go instead, so a flood of invented ids cannot push a real removal out.
 */
function owedIds(
  prev: readonly string[] | undefined,
  more: readonly string[],
  removed: readonly string[] = [],
): string[] {
  const add = [...new Set(more)].filter((id) => id.length > 0 && id.length <= MAX_DEPARTED_ID_LENGTH)
  const all = [...(prev ?? []).filter((id) => !add.includes(id)), ...add]
  let excess = all.length - MAX_DEPARTED
  if (excess <= 0) return all
  const kept = all.filter((id) => {
    if (excess > 0 && !removed.includes(id)) {
      excess -= 1
      return false
    }
    return true
  })
  return kept.slice(Math.max(0, kept.length - MAX_DEPARTED))
}

/** The ids a key minted for this debt names: sorted, so every client writes the same record. */
export function rotationDeparted(watch: NewDeviceWatch | null | undefined): string[] {
  return [...(watch?.rotateFor ?? [])].sort()
}

/**
 * The devices in `list` this watch has accepted: id in `known`, with the same
 * published key it recorded, never one this device removed, and not one that carries
 * the key of a device this device removed until its notice is answered. The key sync hands
 * keys only to these and trusts key copies only from these, so a list read before
 * the watch moved on (a removed device still in it), or a relay that keeps a
 * removed device listed, cannot carry a new key to the device that was removed.
 */
export function endpointsKnownTo(
  watch: NewDeviceWatch | null | undefined,
  list: readonly Endpoint[],
): Endpoint[] {
  if (!watch) return []
  const known = new Set(watch.known)
  const removed = new Set(watch.removed)
  const heldKeys = new Set(watch.removedKeys)
  const unanswered = new Set(watch.unconfirmed.map((n) => n.id))
  return list.filter(
    (e) =>
      known.has(e.id) &&
      !removed.has(e.id) &&
      !(unanswered.has(e.id) && heldKeys.has(e.e2ePubkey)) &&
      (watch.keys === undefined || watch.keys[e.id] === e.e2ePubkey),
  )
}

/**
 * The devices a held tab whose device is gone may be moved to (P-15 item 3,
 * SECURITY_REVIEW L3): those this watch has accepted (`endpointsKnownTo`, so never
 * one this device removed), never this device or a console, and none the user has
 * not answered yet, a pending "new device" notice or the first-look card. The relay
 * decides when a held tab asks for a new device, so it must not also decide what
 * is offered. The device the tab was for is not left out: once accepted again it
 * is a fair choice. In list order; each client sorts for its own screen. A watch
 * that belongs to another pairing offers nothing.
 */
export function heldTabChoices(
  watch: NewDeviceWatch | null | undefined,
  list: readonly Endpoint[],
  selfId: string,
): Endpoint[] {
  if (!watch || watch.selfId !== selfId) return []
  const unanswered = new Set([...watch.unconfirmed, ...(watch.review ?? [])].map((n) => n.id))
  return endpointsKnownTo(watch, list).filter(
    (e) => e.id !== selfId && e.kind !== 'console' && !unanswered.has(e.id),
  )
}

/**
 * The user said "It's mine" on one device: drop its pending notice, or its place on
 * the first look. The rest of the first look stays.
 */
export function confirmNewDevice(watch: NewDeviceWatch, id: string): NewDeviceWatch {
  const { review: _review, ...rest } = watch
  const next: NewDeviceWatch = { ...rest, unconfirmed: watch.unconfirmed.filter((n) => n.id !== id) }
  const review = watch.review?.filter((n) => n.id !== id)
  if (review !== undefined && review.length > 0) next.review = review
  return next
}

/** "All of these are mine": the first look is answered; its card goes on this device only. */
export function confirmReview(watch: NewDeviceWatch): NewDeviceWatch {
  const { review: _review, ...rest } = watch
  return rest
}

/** Dismiss one "joined, then disappeared" notice on this device. */
export function dismissVanished(watch: NewDeviceWatch, id: string): NewDeviceWatch {
  const left = (watch.vanished ?? []).filter((n) => n.id !== id)
  const { vanished: _vanished, ...rest } = watch
  return left.length > 0 ? { ...rest, vanished: left } : rest
}

/**
 * Should this device replace the group key now? Only when a rotation is owed and
 * the ring's newest key does not already pay it. It pays it when it is newer than
 * the key that was current when the device left (`rotateFrom`) AND names every
 * device owed for (`rotateFor`, against the key's `departed`). A key that is
 * merely newer proves nothing: it may have been minted before the departure by the
 * departed device itself, and held back by the relay until now (X14). A key that
 * names the debt was minted after the departure by a device that knew of it, and
 * was never sealed to the departed device. The caller clears the debt
 * (`rotationDone`) either way once its ring holds a key: minted here, or found.
 *
 * A debt with no ids (`rotateFor` absent) is paid by any newer key, as before.
 */
export function rotationDue(
  watch: NewDeviceWatch | null | undefined,
  newestKeyCreatedAt: string | undefined,
  newestKeyDeparted?: readonly string[],
): boolean {
  if (watch?.rotateOwedAt === undefined || newestKeyCreatedAt === undefined) return false
  if (watch.rotateFrom === undefined || newestKeyCreatedAt <= watch.rotateFrom) return true
  const named = new Set(newestKeyDeparted)
  return !(watch.rotateFor ?? []).every((id) => named.has(id))
}

/**
 * Clear an owed rotation, but only the one that was read: a device that left
 * while the rotation was being minted owes another.
 */
export function rotationDone(watch: NewDeviceWatch, owedAt: string): NewDeviceWatch {
  if (watch.rotateOwedAt !== owedAt) return watch
  const { rotateOwedAt: _owed, rotateFrom: _from, rotateFor: _for, ...rest } = watch
  return rest
}

/** A phone not seen for this long no longer counts as the one that tells the user (P-23). */
export const ANNOUNCER_STALE_MS = 30 * 24 * 60 * 60 * 1000

/**
 * Should THIS device tell the user that a device joined (P-23; owner, 2026-10-30: "show
 * that warning once", information only)? A phone always does. A browser does only when the
 * group has no phone this device had accepted before this list and has seen in the last 30
 * days, so a user without a phone still hears, and one with a phone hears it once. A
 * console never does: it has no notifications.
 *
 * Only a phone from the record BEFORE this list counts (`prev`): a phone that arrives in
 * the same list as the newcomer, or is the newcomer, silences nobody, so a relay cannot hush
 * the browsers by adding a phone along with its device. A time that cannot be read counts
 * as not seen. Pure.
 */
export function announcesNewDevices(
  prev: NewDeviceWatch | null | undefined,
  list: readonly Endpoint[],
  selfId: string,
  now: number,
): boolean {
  const self = list.find((e) => e.id === selfId)
  if (!self) return false
  if (self.kind === 'mobile') return true
  if (self.kind !== 'extension') return false
  const before = prev && prev.selfId === selfId ? prev : null
  return !endpointsKnownTo(before, firstById(list)).some((e) => {
    if (e.id === selfId || e.kind !== 'mobile') return false
    const seen = Date.parse(e.lastSeenAt)
    return Number.isFinite(seen) && now - seen <= ANNOUNCER_STALE_MS
  })
}

/**
 * The notices, once told (P-23): a joined device is reported once, as information, and
 * nothing waits for an answer, so nothing is kept on the first look (`review`) or pending
 * (`unconfirmed`), with one exception: a device carrying the published key of a device
 * THIS device removed stays pending, so `endpointsKnownTo` keeps it out of key handoff. A
 * relay could otherwise list a removed device again under a fresh id and have it handed
 * the next key a moment after one notification. Everything else in the record stays.
 */
export function settleNotices(watch: NewDeviceWatch): NewDeviceWatch {
  const { review: _review, ...rest } = watch
  const held = new Set(watch.removedKeys)
  const unconfirmed = watch.unconfirmed.filter((n) => {
    const key = watch.keys?.[n.id]
    return key !== undefined && held.has(key)
  })
  return { ...rest, unconfirmed }
}

/**
 * A device's tag in a pairing link: the first `VOUCH_TAG_LENGTH` characters of its
 * published key, in the URL-safe alphabet so the link needs no escaping.
 */
export function vouchTag(e2ePubkey: string): string {
  return e2ePubkey
    .slice(0, VOUCH_TAG_LENGTH)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')
}

/**
 * The tags a pairing link this device shows vouches for (P-23): every device it has
 * accepted (`endpointsKnownTo`, this device included), never one it has not answered
 * yet, a pending notice or one on its own first look. Unique, in list order, at most
 * `MAX_VOUCHED`. Empty when the watch belongs to another pairing or the list is not
 * one this device may use; the link then vouches for nothing.
 */
export function vouchTags(
  watch: NewDeviceWatch | null | undefined,
  list: readonly Endpoint[],
  selfId: string,
): string[] {
  if (!watch || watch.selfId !== selfId || !listIncludesSelf(list, selfId)) return []
  const unanswered = new Set([...watch.unconfirmed, ...(watch.review ?? [])].map((n) => n.id))
  const tags = endpointsKnownTo(watch, firstById(list))
    .filter((e) => !unanswered.has(e.id))
    .map((e) => vouchTag(e.e2ePubkey))
    .filter((t) => t.length === VOUCH_TAG_LENGTH)
  return [...new Set(tags)].slice(0, MAX_VOUCHED)
}

/**
 * A pairing link with the tags appended to its fragment as `&v=tag.tag`. The relay makes
 * the base link, so any `v` already in its fragment is removed first, tags or not: only
 * this device may vouch, and a relay's own tag would make its planted device look
 * accepted (v0.9.0 review, finding 1).
 */
export function withVouch(link: string, tags: readonly string[]): string {
  const hash = link.indexOf('#')
  if (hash < 0) return link
  const kept = link
    .slice(hash + 1)
    .split('&')
    .filter((p) => !p.startsWith('v='))
  const base = `${link.slice(0, hash + 1)}${kept.join('&')}`
  return tags.length === 0 ? base : `${base}&v=${tags.join('.')}`
}

/**
 * The tags a pairing link carries, or undefined when it carries none (a link from an
 * older client, one whose `v` held nothing usable, or one with more than one `v`). A tag that is not exactly
 * `VOUCH_TAG_LENGTH` URL-safe characters is dropped: a shorter one would match more keys.
 */
export function parseVouch(link: string): string[] | undefined {
  const hash = link.indexOf('#')
  if (hash < 0) return undefined
  const params = link
    .slice(hash + 1)
    .split('&')
    .filter((p) => p.startsWith('v='))
  // More than one `v` means something other than the showing device wrote one: trust none.
  if (params.length !== 1) return undefined
  const param = params[0] as string
  const pattern = new RegExp(`^[A-Za-z0-9_-]{${VOUCH_TAG_LENGTH}}$`)
  const tags = [...new Set(param.slice(2).trim().split('.'))]
    .filter((t) => pattern.test(t))
    .slice(0, MAX_VOUCHED)
  return tags.length > 0 ? tags : undefined
}

/** The list with each id once, in order of first appearance. */
function firstById(list: readonly Endpoint[]): Endpoint[] {
  const seen = new Set<string>()
  const out: Endpoint[] = []
  for (const e of list) {
    if (seen.has(e.id)) continue
    seen.add(e.id)
    out.push(e)
  }
  return out
}

function baseline(
  raw: readonly Endpoint[],
  selfId: string,
  vouched?: readonly string[],
): NewDeviceWatch {
  const list = firstById(raw)
  const vouchedTags = new Set(vouched)
  const others = list
    .filter((e) => e.id !== selfId && !vouchedTags.has(vouchTag(e.e2ePubkey)))
    .map((e) => ({ id: e.id, label: e.label, createdAt: e.createdAt }))
  const watch: NewDeviceWatch = {
    selfId,
    known: list.map((e) => e.id),
    unconfirmed: [],
    keys: keysOf(list),
  }
  // The first look: asked once, when anyone the pairing link did not vouch for is there.
  if (others.length > 0) watch.review = others
  return watch
}

function keysOf(list: readonly Endpoint[]): Record<string, string> {
  const keys: Record<string, string> = {}
  for (const e of list) keys[e.id] = e.e2ePubkey
  return keys
}
