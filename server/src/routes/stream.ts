import type { ClientStreamEvent, EndpointId, GroupId, IsoTimestamp } from '@tabsend/shared'
import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../context'
import { authenticateToken } from '../context'
import type { Hub } from '../hub'
import { iso } from '../time'

type Conn = ReturnType<Hub['add']>

/**
 * WS /v1/stream — the latency-only fast path (ADR-0001). Correctness never
 * depends on it. Lifecycle: client sends `hello{deviceToken}` first; on success
 * the socket is registered and streams ServerStreamEvents. `ping` → `pong` and
 * refreshes presence. See @tabsend/shared §11.
 */
export function registerStreamRoute(app: FastifyInstance, ctx: AppContext): void {
  app.get('/v1/stream', { websocket: true }, (socket) => {
    // The hub is shared by both listeners in dual-listen mode, so this is one
    // process-wide allowance rather than a separate allowance per Fastify app.
    if (!ctx.hub.tryReserveConnection(ctx.config.streamMaxConnections)) {
      socket.close(1013, 'relay connection limit')
      return
    }

    let conn: Conn | undefined
    let closed = false
    let pendingFrames = 0

    // An upgraded-but-silent socket is cheap individually and devastating in
    // bulk. It gets a short authentication window, then authenticated clients
    // must keep proving liveness with their normal application ping.
    let lifecycleTimer = setTimeout(() => {
      socket.close(1008, 'hello timeout')
    }, ctx.config.streamHelloTimeoutMs)

    function armIdleTimer(): void {
      clearTimeout(lifecycleTimer)
      lifecycleTimer = setTimeout(() => {
        socket.close(1001, 'idle timeout')
      }, ctx.config.streamIdleTimeoutMs)
    }

    // Serialize frame handling so a fast hello→ping can't race (ping must never
    // be processed before hello has set `conn`).
    let chain: Promise<void> = Promise.resolve()

    socket.on('message', (raw: unknown) => {
      const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw)
      pendingFrames += 1
      // Authentication and presence writes are serialized. Bound that queue too:
      // otherwise a peer can fill process memory with tiny frames while one DB
      // operation is in flight even though each individual frame is size-capped.
      if (pendingFrames > 8) {
        socket.close(1008, 'too many pending frames')
        return
      }
      chain = chain
        .then(() => handleFrame(text))
        .catch(() => {
          socket.close(1011, 'stream processing failed')
        })
        .finally(() => {
          pendingFrames -= 1
        })
    })

    async function handleFrame(text: string): Promise<void> {
      if (closed || socket.readyState !== 1) return
      let event: ClientStreamEvent
      try {
        event = JSON.parse(text)
      } catch {
        socket.close(1007, 'invalid json')
        return
      }

      if (!conn) {
        // First frame MUST be a valid hello.
        if (event.type !== 'hello') {
          socket.close(1008, 'expected hello')
          return
        }
        try {
          const endpoint = await authenticateToken(ctx, event.deviceToken)
          // Authentication touches the database. The hello deadline or peer may
          // close the socket while that await is in flight; never register a dead
          // socket after its close handler has already run.
          if (closed || socket.readyState !== 1) return
          const endpointId = endpoint.id as EndpointId
          if (ctx.hub.connectionCount(endpointId) >= ctx.config.streamMaxConnectionsPerEndpoint) {
            socket.close(1013, 'endpoint connection limit')
            return
          }
          // Per group as well [0031 amended 2026-10-01]: the process-wide allowance is
          // shared by every tenant, so one group must not be able to spend all of it.
          // Same close code as the other two caps, because it means the same thing to
          // a client: no fast path right now, so poll, and try again later.
          const groupId = endpoint.group_id as GroupId
          if (ctx.hub.groupConnectionCount(groupId) >= ctx.config.streamMaxConnectionsPerGroup) {
            socket.close(1013, 'group connection limit')
            return
          }
          conn = ctx.hub.add(socket, endpointId, groupId, ctx.now().getTime())
          armIdleTimer()
          ctx.hub.toGroup(
            endpoint.group_id as GroupId,
            {
              type: 'presence',
              endpointId: endpoint.id as EndpointId,
              presence: 'online',
              lastSeenAt: endpoint.last_seen_at as IsoTimestamp,
            },
            endpoint.id as EndpointId,
          )
        } catch {
          socket.close(1008, 'unauthorized')
        }
        return
      }

      if (event.type === 'ping') {
        armIdleTimer()
        ctx.hub.touch(conn, ctx.now().getTime())
        await ctx.db
          .updateTable('endpoints')
          .set({ last_seen_at: iso(ctx.now()) })
          .where('id', '=', conn.endpointId)
          .execute()
        socket.send(JSON.stringify({ type: 'pong' }))
        return
      }
      socket.close(1008, 'unsupported stream event')
    }

    socket.on('close', () => {
      if (!closed) {
        closed = true
        ctx.hub.releaseConnection()
      }
      clearTimeout(lifecycleTimer)
      if (!conn) return
      const closedConn = conn
      ctx.hub.remove(closedConn)
      // If no sockets remain for this endpoint, tell peers it went offline.
      if (!ctx.hub.isOnline(closedConn.endpointId)) {
        ctx.hub.toGroup(
          closedConn.groupId,
          {
            type: 'presence',
            endpointId: closedConn.endpointId,
            presence: 'offline',
            lastSeenAt: iso(ctx.now()),
          },
          closedConn.endpointId,
        )
      }
    })
  })
}
