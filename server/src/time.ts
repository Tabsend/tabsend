import type { IsoTimestamp } from '@tabsend/shared'

/** Date → branded ISO-8601 UTC string (the wire format for every timestamp). */
export function iso(date: Date): IsoTimestamp {
  return date.toISOString() as IsoTimestamp
}

/** Date + milliseconds. */
export function addMs(date: Date, ms: number): Date {
  return new Date(date.getTime() + ms)
}
