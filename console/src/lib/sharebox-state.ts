import { defaultKv, type KeyValue } from './session'

/**
 * P-22: the two timestamps the share box needs, kept in this browser's localStorage. The
 * rules that use them are `shareBoxVariant` in @tabsend/shared. Every read and write is
 * guarded: a browser with storage blocked simply never shows the box.
 */
const FIRST_HOME_KEY = 'tabsend.console.sharefirsthome.v1'
const DISMISSED_KEY = 'tabsend.console.sharedismissed.v1'

function read(kv: KeyValue, key: string): number | undefined {
  try {
    const n = Number(kv.getItem(key))
    return Number.isFinite(n) && n > 0 ? n : undefined
  } catch {
    return undefined
  }
}

function write(kv: KeyValue, key: string, value: number): void {
  try {
    kv.setItem(key, String(value))
  } catch {
    // storage blocked: nothing to remember with
  }
}

export const getFirstHomeAt = (kv: KeyValue = defaultKv()) => read(kv, FIRST_HOME_KEY)
export const setFirstHomeAt = (v: number, kv: KeyValue = defaultKv()) =>
  write(kv, FIRST_HOME_KEY, v)
export const getDismissedAt = (kv: KeyValue = defaultKv()) => read(kv, DISMISSED_KEY)
export const setDismissedAt = (v: number, kv: KeyValue = defaultKv()) => write(kv, DISMISSED_KEY, v)

/** First time the paired Home is drawn: remember it. Returns the time it was first drawn. */
export function noteHomeDrawn(now: number, kv: KeyValue = defaultKv()): number {
  const first = read(kv, FIRST_HOME_KEY)
  if (first !== undefined) return first
  write(kv, FIRST_HOME_KEY, now)
  return now
}
