import type { EndpointId, GroupId, ServerStreamEvent } from '@tabsend/shared'

/**
 * Minimal structural view of a live WebSocket — avoids a hard dependency on the
 * `ws` types while accepting exactly what @fastify/websocket hands us.
 */
export interface WsSocket {
  send(data: string): void
  readyState: number
  /** Optional so a test double is not forced to implement it; the real `ws` socket
   *  always has it, and {@link Hub.disconnectGroup} and {@link Hub.disconnectEndpoint}
   *  are its only callers. */
  close?(code?: number, reason?: string): void
}

const OPEN = 1

interface Conn {
  socket: WsSocket
  endpointId: EndpointId
  groupId: GroupId
  /** When this socket last proved it was alive: its hello, then each ping (ms). */
  lastSeenMs: number
}

/**
 * In-process registry of authenticated fast-path sockets. Latency-only: if this
 * is empty, push+queue still deliver (ADR-0001). Single-instance for Chunk 2;
 * Chunk 4 (horizontal scale) will need a shared fan-out (e.g. Postgres LISTEN or
 * Redis) so an event reaches a socket on another node.
 */
export class Hub {
  private readonly byEndpoint = new Map<string, Set<Conn>>()
  private activeConnections = 0

  /** Reserve one upgraded socket across every listener sharing this relay hub. */
  tryReserveConnection(max: number): boolean {
    if (this.activeConnections >= max) return false
    this.activeConnections += 1
    return true
  }

  releaseConnection(): void {
    if (this.activeConnections > 0) this.activeConnections -= 1
  }

  add(socket: WsSocket, endpointId: EndpointId, groupId: GroupId, nowMs = Date.now()): Conn {
    const conn: Conn = { socket, endpointId, groupId, lastSeenMs: nowMs }
    let set = this.byEndpoint.get(endpointId)
    if (!set) {
      set = new Set()
      this.byEndpoint.set(endpointId, set)
    }
    set.add(conn)
    return conn
  }

  remove(conn: Conn): void {
    const set = this.byEndpoint.get(conn.endpointId)
    if (!set) return
    set.delete(conn)
    if (set.size === 0) this.byEndpoint.delete(conn.endpointId)
  }

  /** True while any live socket for this endpoint is registered. */
  isOnline(endpointId: EndpointId): boolean {
    return (this.byEndpoint.get(endpointId)?.size ?? 0) > 0
  }

  /** Record that a socket just proved it is alive (a ping). */
  touch(conn: Conn, nowMs = Date.now()): void {
    conn.lastSeenMs = nowMs
  }

  /**
   * True when this endpoint has a socket that is OPEN and proved itself alive within
   * `withinMs` [2026-10-01]: the stricter question a caller should ask before deciding
   * a message has really reached the device and something else is unnecessary.
   *
   * `isOnline` is not that question. A socket stays registered until its close event,
   * so one that is CLOSING (ws allows its close handshake 30 s) or half-open (the phone
   * lost signal and then went to the background, so its close never arrived) still
   * counts until the idle timeout finds it. `send` writes only to OPEN sockets, and a
   * half-open one swallows what it is sent, so trusting either would mean neither the
   * fast path nor anything else reached the device.
   */
  hasFreshSocket(endpointId: EndpointId, nowMs: number, withinMs: number): boolean {
    const set = this.byEndpoint.get(endpointId)
    if (!set) return false
    for (const conn of set) {
      if (conn.socket.readyState === OPEN && nowMs - conn.lastSeenMs <= withinMs) return true
    }
    return false
  }

  /** Number of authenticated sockets currently held for one endpoint. */
  connectionCount(endpointId: EndpointId): number {
    return this.byEndpoint.get(endpointId)?.size ?? 0
  }

  /**
   * Number of authenticated sockets currently held across one whole group: what
   * `streamMaxConnectionsPerGroup` is measured against [0031 amended 2026-10-01].
   *
   * A walk rather than a second index, because it runs once per hello, against a map
   * the process-wide cap already bounds, and a second index is a second thing the
   * add/remove/disconnect paths would all have to keep in step.
   */
  groupConnectionCount(groupId: GroupId): number {
    let n = 0
    for (const set of this.byEndpoint.values()) {
      for (const conn of set) if (conn.groupId === groupId) n += 1
    }
    return n
  }

  /**
   * Upgraded sockets reserved across every listener sharing this hub — the number
   * `streamMaxConnections` is measured against. Read-only, for the ops status route:
   * a relay sitting at its cap refuses new sockets and silently degrades to polling,
   * which otherwise looks like "delivery is just slow".
   */
  reservedConnections(): number {
    return this.activeConnections
  }

  /** Endpoints holding at least one live socket right now (the fast-path population). */
  onlineEndpointIds(): EndpointId[] {
    const ids: EndpointId[] = []
    for (const [id, set] of this.byEndpoint) {
      if (set.size > 0) ids.push(id as EndpointId)
    }
    return ids
  }

  /** Deliver an event to every live socket for one endpoint. */
  toEndpoint(endpointId: EndpointId, event: ServerStreamEvent): void {
    const set = this.byEndpoint.get(endpointId)
    if (!set) return
    const data = JSON.stringify(event)
    for (const conn of set) send(conn.socket, data)
  }

  /**
   * Close every live socket belonging to one group, and forget them. Returns how many
   * were closed.
   *
   * Exists for deleting a group [0031]. A socket authenticates ONCE, in its hello frame
   * (routes/stream.ts), and then holds its registration for as long as it stays open —
   * which is the right design for a latency fast path and the wrong one for a tenancy
   * that has just been destroyed. Nothing new could reach those sockets afterwards
   * (there is no group left to broadcast to, and every HTTP call re-authenticates
   * against a row that is gone), so this is not a hole being closed; it is the
   * difference between "deleted" and "deleted, and the devices were told".
   * `1001 going away` is the ordinary close every client already handles.
   */
  disconnectGroup(groupId: GroupId, reason = 'group deleted'): number {
    return this.disconnectWhere((conn) => conn.groupId === groupId, reason)
  }

  /**
   * Close every live socket belonging to one endpoint, and forget them. Returns how many
   * were closed.
   *
   * Exists for removing a device from its group [0031 amended 2026-10-01], and unlike a
   * group deletion that one IS a hole: the group goes on, so its broadcasts go on, and a
   * removed device holding its socket open went on receiving them (every later device's
   * label, name and public key, and presence) although its token had stopped working.
   */
  disconnectEndpoint(endpointId: EndpointId, reason = 'endpoint removed'): number {
    return this.disconnectWhere((conn) => conn.endpointId === endpointId, reason)
  }

  private disconnectWhere(match: (conn: Conn) => boolean, reason: string): number {
    let closed = 0
    for (const [endpointId, set] of [...this.byEndpoint]) {
      for (const conn of [...set]) {
        if (!match(conn)) continue
        set.delete(conn)
        closed += 1
        // The socket's own close handler releases its reservation and removes it from
        // the map; doing both here as well would double-count. Deleting the conn above
        // is what makes this safe if the handler never runs (an already-dead socket).
        try {
          conn.socket.close?.(1001, reason)
        } catch {
          // A socket that is already gone is exactly the outcome wanted.
        }
      }
      if (set.size === 0) this.byEndpoint.delete(endpointId)
    }
    return closed
  }

  /** Broadcast to every endpoint in a group, optionally skipping one. */
  toGroup(groupId: GroupId, event: ServerStreamEvent, exceptEndpointId?: EndpointId): void {
    const data = JSON.stringify(event)
    for (const set of this.byEndpoint.values()) {
      for (const conn of set) {
        if (conn.groupId !== groupId) continue
        if (exceptEndpointId && conn.endpointId === exceptEndpointId) continue
        send(conn.socket, data)
      }
    }
  }
}

function send(socket: WsSocket, data: string): void {
  if (socket.readyState === OPEN) socket.send(data)
}
