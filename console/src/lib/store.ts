/**
 * A minimal reactive store — the whole "framework" this console uses. Signals hold
 * values; effects re-run when signals they read change; computed derives a signal
 * from others. ~60 lines, no dependencies, synchronous, good enough for a handful
 * of panels. Justified over React/Solid/etc.: the surface is small and every KB the
 * console ships is a KB the relay has to serve.
 */

type Subscriber = () => void

/** The effect currently running, so signal reads can register a dependency. */
let activeEffect: Effect | null = null

class Effect {
  private deps = new Set<Set<Subscriber>>()
  private readonly run: () => void
  private disposed = false

  constructor(fn: () => void) {
    this.run = fn
    this.execute()
  }

  /** Called by a signal's read to record that this effect depends on it. */
  track(subs: Set<Subscriber>): void {
    subs.add(this.notify)
    this.deps.add(subs)
  }

  private notify = (): void => {
    if (!this.disposed) this.execute()
  }

  private execute(): void {
    // Drop stale dependencies before re-reading, so a branch that stops reading a
    // signal stops depending on it.
    for (const subs of this.deps) subs.delete(this.notify)
    this.deps.clear()
    const prev = activeEffect
    activeEffect = this
    try {
      this.run()
    } finally {
      activeEffect = prev
    }
  }

  dispose(): void {
    this.disposed = true
    for (const subs of this.deps) subs.delete(this.notify)
    this.deps.clear()
  }
}

export interface Signal<T> {
  get(): T
  set(next: T): void
  /** Update in place; useful for arrays/objects where you compute from the current value. */
  update(fn: (current: T) => T): void
}

export function signal<T>(initial: T): Signal<T> {
  let value = initial
  const subs = new Set<Subscriber>()
  return {
    get() {
      if (activeEffect) activeEffect.track(subs)
      return value
    },
    set(next: T) {
      if (Object.is(next, value)) return
      value = next
      // Copy so a subscriber that re-subscribes during notification doesn't loop.
      for (const notify of [...subs]) notify()
    },
    update(fn: (current: T) => T) {
      this.set(fn(value))
    },
  }
}

/** Run `fn` now and again whenever any signal it read changes. Returns a disposer. */
export function effect(fn: () => void): () => void {
  const e = new Effect(fn)
  return () => e.dispose()
}

/** A read-only signal derived from others. Recomputes lazily-eagerly on dep change. */
export function computed<T>(fn: () => T): { get(): T } {
  const out = signal<T>(undefined as unknown as T)
  effect(() => out.set(fn()))
  return { get: () => out.get() }
}
