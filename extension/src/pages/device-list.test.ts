import { describe, expect, it } from 'vitest'
import { deviceRowActions, deviceSubline, removeIfConfirmed } from './device-list'

describe('device list rows', () => {
  it('offers Rename and Remove on every other device', () => {
    expect(deviceRowActions({ isSelf: false })).toEqual(['rename', 'remove'])
  })

  it('never offers Remove on this browser, which would orphan the install', () => {
    expect(deviceRowActions({ isSelf: true })).toEqual(['rename'])
  })

  it('marks this browser in the line under its name', () => {
    expect(deviceSubline({ isSelf: true, presenceLabel: 'online' })).toBe('This browser · online')
    expect(deviceSubline({ isSelf: false, presenceLabel: 'last seen 1d ago' })).toBe(
      'last seen 1d ago',
    )
  })

  it('removes through the request that records the removal, and only once confirmed (X13)', () => {
    const asked: string[] = []
    const dev = { endpointId: 'ep-phone', label: 'Pixel 8' }
    const decline = (question: string): boolean => {
      asked.push(question)
      return false
    }
    expect(removeIfConfirmed(dev, decline)).toBeNull()
    expect(removeIfConfirmed(dev, () => true)).toEqual({
      type: 'removeEndpoint',
      endpointId: 'ep-phone',
    })
    expect(asked).toEqual(['Remove “Pixel 8” from the group?'])
  })
})
