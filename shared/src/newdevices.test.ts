import { describe, expect, it } from 'vitest'
import raw from '../vectors/new-devices.json'
import {
  confirmNewDevice,
  confirmReview,
  dismissVanished,
  endpointsKnownTo,
  heldTabChoices,
  type NewDeviceWatch,
  removeDevice,
  rotationDeparted,
  rotationDone,
  rotationDue,
  watchDevices,
} from './newdevices'
import type { Endpoint, GroupId } from './types'

// The same cases run on Android and iOS; see the header of newdevices.ts.
const vectors = raw as unknown as {
  watch: {
    name: string
    selfId: string
    now: string
    currentKeyCreatedAt?: string
    prev: NewDeviceWatch | null
    seed?: (Pick<Endpoint, 'id' | 'label' | 'createdAt'> & { e2ePubkey?: string })[]
    list: (Pick<Endpoint, 'id' | 'label' | 'createdAt'> & { e2ePubkey?: string })[]
    watch: NewDeviceWatch | null
    joined: unknown[]
  }[]
  confirm: { name: string; id: string; watch: NewDeviceWatch; expect: NewDeviceWatch }[]
  confirmReview: { name: string; watch: NewDeviceWatch; expect: NewDeviceWatch }[]
  dismissVanished: { name: string; id: string; watch: NewDeviceWatch; expect: NewDeviceWatch }[]
  remove: {
    name: string
    watch: NewDeviceWatch
    id: string
    now: string
    currentKeyCreatedAt?: string
    expect: NewDeviceWatch
  }[]
  rotationDue: {
    name: string
    watch: NewDeviceWatch
    newest: string | null
    newestDeparted?: string[]
    due: boolean
  }[]
  rotationDeparted: { name: string; watch: NewDeviceWatch | null; expect: string[] }[]
  rotationDone: { name: string; owedAt: string; watch: NewDeviceWatch; expect: NewDeviceWatch }[]
  knownTo: {
    name: string
    watch: NewDeviceWatch | null
    list: (Pick<Endpoint, 'id' | 'label' | 'createdAt'> & { e2ePubkey?: string })[]
    expect: string[]
  }[]
  heldTabChoices: {
    name: string
    selfId: string
    watch: NewDeviceWatch | null
    list: (Pick<Endpoint, 'id' | 'label' | 'createdAt'> &
      Partial<Pick<Endpoint, 'kind' | 'e2ePubkey'>>)[]
    expect: string[]
  }[]
}

function endpoint(
  e: Pick<Endpoint, 'id' | 'label' | 'createdAt'> & Partial<Pick<Endpoint, 'kind' | 'e2ePubkey'>>,
): Endpoint {
  return {
    ...e,
    groupId: 'g' as GroupId,
    kind: e.kind ?? 'extension',
    browser: 'chrome',
    platform: 'macos',
    e2ePubkey: e.e2ePubkey ?? 'pk',
    presence: 'online',
    lastSeenAt: e.createdAt,
  }
}

describe('watchDevices (P-10 vectors)', () => {
  for (const c of vectors.watch) {
    it(c.name, () => {
      const result = watchDevices(
        c.prev,
        c.list.map(endpoint),
        c.selfId,
        c.now,
        c.currentKeyCreatedAt,
        c.seed?.map(endpoint),
      )
      expect(result.watch).toEqual(c.watch)
      expect(result.joined).toEqual(c.joined)
    })
  }
  for (const c of vectors.confirm) {
    it(c.name, () => {
      expect(confirmNewDevice(c.watch, c.id)).toEqual(c.expect)
    })
  }
  for (const c of vectors.confirmReview) {
    it(`confirmReview: ${c.name}`, () => {
      expect(confirmReview(c.watch)).toEqual(c.expect)
    })
  }
  for (const c of vectors.dismissVanished) {
    it(`dismissVanished: ${c.name}`, () => {
      expect(dismissVanished(c.watch, c.id)).toEqual(c.expect)
    })
  }
  for (const c of vectors.remove) {
    it(`removeDevice: ${c.name}`, () => {
      expect(removeDevice(c.watch, c.id, c.now, c.currentKeyCreatedAt)).toEqual(c.expect)
    })
  }
  for (const c of vectors.rotationDue) {
    it(`rotationDue: ${c.name}`, () => {
      expect(rotationDue(c.watch, c.newest ?? undefined, c.newestDeparted)).toBe(c.due)
    })
  }
  for (const c of vectors.rotationDeparted) {
    it(`rotationDeparted: ${c.name}`, () => {
      expect(rotationDeparted(c.watch)).toEqual(c.expect)
    })
  }
  for (const c of vectors.rotationDone) {
    it(`rotationDone: ${c.name}`, () => {
      expect(rotationDone(c.watch, c.owedAt)).toEqual(c.expect)
    })
  }
  for (const c of vectors.knownTo) {
    it(`endpointsKnownTo: ${c.name}`, () => {
      expect(endpointsKnownTo(c.watch, c.list.map(endpoint)).map((e) => e.id)).toEqual(c.expect)
    })
  }
  for (const c of vectors.heldTabChoices) {
    it(`heldTabChoices: ${c.name}`, () => {
      expect(heldTabChoices(c.watch, c.list.map(endpoint), c.selfId).map((e) => e.id)).toEqual(
        c.expect,
      )
    })
  }
})
