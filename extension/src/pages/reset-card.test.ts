import type { GroupResetState, IsoTimestamp } from '@tabsend/shared'
import { describe, expect, it } from 'vitest'
import { type ResetCardState, resetNotices, runStopReset } from './newdevice-banner'

/** The reset card's page-side state (PLANS.md P-18 item 12), shared by popup and manage screen. */

const RESET: GroupResetState = {
  requestedAt: '2026-10-27T12:00:00.000Z' as IsoTimestamp,
  resetsAt: '2026-10-30T12:00:00.000Z' as IsoTimestamp,
}

describe('the reset card on a page', () => {
  it('shows the waiting reset until this page answers it', () => {
    const state: ResetCardState = { busy: false }
    expect(resetNotices(state, RESET).groupReset).toEqual(RESET)
    state.dismissedFor = RESET.requestedAt
    expect(resetNotices(state, RESET).groupReset).toBeUndefined()
    const next = { ...RESET, requestedAt: '2026-11-02T08:00:00.000Z' as IsoTimestamp }
    expect(resetNotices(state, next).groupReset).toEqual(next)
  })

  it('on a Stop that worked, hides the card and says it stopped, even if a stale view still has it', async () => {
    const state: ResetCardState = { busy: false }
    const renders: boolean[] = []
    await runStopReset(
      state,
      RESET,
      async () => undefined,
      () => renders.push(state.busy),
    )
    expect(renders).toEqual([true, false])
    const shown = resetNotices(state, RESET)
    expect(shown.groupReset).toBeUndefined()
    expect(shown.resetStopped).toBe(true)
  })

  it('on a Stop that failed, keeps the card and says why', async () => {
    const state: ResetCardState = { busy: false }
    await runStopReset(
      state,
      RESET,
      async () => {
        throw new Error('Could not reach your relay.')
      },
      () => undefined,
    )
    const shown = resetNotices(state, RESET)
    expect(shown.groupReset).toEqual(RESET)
    expect(shown.resetError).toBe('Could not reach your relay.')
    expect(shown.resetStopped).toBe(false)
  })
})
