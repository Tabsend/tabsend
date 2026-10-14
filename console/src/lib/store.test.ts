import { describe, expect, it } from 'vitest'
import { computed, effect, signal } from './store'

describe('reactive store', () => {
  it('runs an effect immediately and on dependency change', () => {
    const count = signal(0)
    const seen: number[] = []
    effect(() => seen.push(count.get()))
    expect(seen).toEqual([0])
    count.set(1)
    count.set(2)
    expect(seen).toEqual([0, 1, 2])
  })

  it('does not re-run when set to an equal value', () => {
    const s = signal(5)
    let runs = 0
    effect(() => {
      s.get()
      runs += 1
    })
    s.set(5)
    expect(runs).toBe(1)
  })

  it('update() derives from the current value', () => {
    const list = signal<number[]>([])
    list.update((cur) => [...cur, 1])
    list.update((cur) => [...cur, 2])
    expect(list.get()).toEqual([1, 2])
  })

  it('computed tracks its sources', () => {
    const a = signal(2)
    const b = signal(3)
    const sum = computed(() => a.get() + b.get())
    expect(sum.get()).toBe(5)
    a.set(10)
    expect(sum.get()).toBe(13)
  })

  it('disposing an effect stops further runs', () => {
    const s = signal(0)
    const seen: number[] = []
    const dispose = effect(() => seen.push(s.get()))
    s.set(1)
    dispose()
    s.set(2)
    expect(seen).toEqual([0, 1])
  })

  it('drops stale dependencies on a changed branch', () => {
    const toggle = signal(true)
    const a = signal('a')
    const b = signal('b')
    const seen: string[] = []
    effect(() => seen.push(toggle.get() ? a.get() : b.get()))
    expect(seen).toEqual(['a'])
    toggle.set(false) // now reads b, no longer depends on a
    expect(seen).toEqual(['a', 'b'])
    a.set('a2') // must NOT re-run — the effect no longer reads a
    expect(seen).toEqual(['a', 'b'])
    b.set('b2')
    expect(seen).toEqual(['a', 'b', 'b2'])
  })
})
