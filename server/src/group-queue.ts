/**
 * Group-scoped writes, one at a time per group, queued IN PROCESS before they take a
 * database connection [2026-10-01 follow-up review, R13].
 *
 * Every group-scoped write holds its group's row for its whole transaction (caps.ts,
 * `lockGroup`), which is what orders it against a deletion and makes the caps exact.
 * On Postgres a request waiting for that row waits WHILE HOLDING a pooled connection,
 * and the pool is shared by every tenant on the relay. So one group sending a burst of
 * concurrent requests parked one connection per request on its own row, and once the
 * pool was full every other tenant's requests waited behind them, down to the
 * authentication read. Measured: nine concurrent uploads from one group stalled an
 * unrelated tenant for as long as the row was held.
 *
 * Queueing here first means a group's waiting writes wait in memory, not in the pool:
 * one group can occupy at most one connection on these paths, however hard it pushes.
 * The row lock stays the authority. This only decides who gets to ask for it, and only
 * within this process; a second relay process would queue separately and still be
 * ordered by the lock.
 *
 * Never nest: a task queued for a group must not wait on another task for the same
 * group, or both wait forever. That is why only routes queue, and nothing they call
 * does.
 */
export class GroupWriteQueue {
  private readonly lines = new Map<string, { tail: Promise<void>; pending: number }>()

  /** Run `task` once every earlier task for `groupId` has settled. */
  run<T>(groupId: string, task: () => Promise<T>): Promise<T> {
    let line = this.lines.get(groupId)
    if (!line) {
      line = { tail: Promise.resolve(), pending: 0 }
      this.lines.set(groupId, line)
    }
    const current = line
    current.pending += 1
    const result = current.tail.then(task)
    // The tail never rejects, so one failed write does not fail the writes behind it.
    const tail = result.then(
      () => undefined,
      () => undefined,
    )
    current.tail = tail
    void tail.then(() => {
      current.pending -= 1
      if (current.pending === 0 && this.lines.get(groupId) === current) this.lines.delete(groupId)
    })
    return result
  }

  /** Writes queued or running for one group. Exposed so tests can see a write arrive. */
  pendingFor(groupId: string): number {
    return this.lines.get(groupId)?.pending ?? 0
  }

  /** Groups with a write queued or running. */
  get size(): number {
    return this.lines.size
  }
}
