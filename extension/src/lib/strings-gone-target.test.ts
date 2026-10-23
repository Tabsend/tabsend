import { describe, expect, it } from 'vitest'
import { goneTargetCopy } from './strings'

/**
 * The words for a held tab whose device is gone (PLANS.md P-15 item 3).
 * Android (`GoneTargetCopyTest.kt`) and iOS (`GoneTargetCopyTests.swift`) pin the same
 * strings, so the three clients cannot drift apart.
 */
describe('goneTargetCopy', () => {
  it('says "was removed" only for a device this browser removed', () => {
    expect(goneTargetCopy.removedLine('Galaxy S24 Ultra', true)).toBe(
      'Galaxy S24 Ultra was removed from your group.',
    )
    expect(goneTargetCopy.removedLine(undefined, true)).toBe(
      'The device it was for was removed from your group.',
    )
  })

  it('claims no removal nobody here made (L3)', () => {
    expect(goneTargetCopy.removedLine('Galaxy S24 Ultra', false)).toBe(
      'Galaxy S24 Ultra is no longer in your group.',
    )
    expect(goneTargetCopy.removedLine(undefined, false)).toBe(
      'The device it was for is no longer in your group.',
    )
  })

  it('says once, as a wait and not a failure, that a tab needs a new device', () => {
    const one = goneTargetCopy.banner(1, 'All workflows', 'Galaxy S24 Ultra', true)
    expect(one.tone).toBe('pending')
    expect(one.headline).toBe('“All workflows” is waiting for a new device')
    expect(one.detail).toBe(
      'Galaxy S24 Ultra was removed from your group. Open Tabsend to send it to another device.',
    )
    const several = goneTargetCopy.banner(3, 'All workflows', undefined, false)
    expect(several.headline).toBe('3 tabs are waiting for a new device')
    expect(several.detail).toBe(
      'The device they were for is no longer in your group. Open Tabsend to send them to another device.',
    )
    expect(goneTargetCopy.banner(1, undefined, undefined, false).headline).toBe(
      'A tab is waiting for a new device',
    )
    expect(goneTargetCopy.banner(1, 'T', 'Pixel 8', false).detail).toBe(
      'Pixel 8 is no longer in your group. Open Tabsend to send it to another device.',
    )
  })

  it('uses no em dashes', () => {
    const all = [
      goneTargetCopy.removedLine('X', true),
      goneTargetCopy.removedLine(undefined, false),
      goneTargetCopy.sendTo,
      goneTargetCopy.sendToMenu,
      goneTargetCopy.noOtherDevice,
      goneTargetCopy.sendToAria('A tab', 'X'),
      ...Object.values(goneTargetCopy.banner(2, 'T', 'X', true)),
      ...Object.values(goneTargetCopy.banner(2, 'T', 'X', false)),
    ]
    for (const line of all) expect(line).not.toContain('—')
  })
})
