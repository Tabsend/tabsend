import { ext } from '../lib/ext'
import { IS_FIREFOX } from '../lib/platform'
/**
 * alarms wiring. Two alarms:
 *  - POLL: the receive backstop → pending + drain outbound + keep presence fresh
 *    (any authenticated call bumps last_seen, well under the 90s window). On
 *    Firefox it's ALSO the WS-reconnect wake (spike §3b).
 *  - RETRY: a short one-shot kick to drain the outbound queue promptly after a
 *    send hit an outage (the POLL alarm is the durable backstop).
 */

export const POLL_ALARM = 'tabsend:poll'
export const RETRY_ALARM = 'tabsend:retry'

/**
 * Chrome enforces a 30s alarm floor (0.5 min); Firefox enforces a 1-min floor
 * (spike §3b — shorter is silently clamped), which is also its suspend-recovery
 * ceiling. Pick each platform's fastest legal period.
 */
const POLL_PERIOD_MINUTES = IS_FIREFOX ? 1 : 0.5

export async function ensurePollAlarm(): Promise<void> {
  const existing = await ext.alarms.get(POLL_ALARM)
  if (!existing) {
    await ext.alarms.create(POLL_ALARM, { periodInMinutes: POLL_PERIOD_MINUTES })
  }
}

export async function ensureRetryAlarm(): Promise<void> {
  const existing = await ext.alarms.get(RETRY_ALARM)
  if (!existing) {
    await ext.alarms.create(RETRY_ALARM, { delayInMinutes: POLL_PERIOD_MINUTES })
  }
}

export async function clearRetryAlarm(): Promise<void> {
  await ext.alarms.clear(RETRY_ALARM)
}
