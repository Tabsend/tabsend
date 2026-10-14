import { generateKeyPairSync } from 'node:crypto'
import {
  constants,
  createSecureServer,
  type Http2SecureServer,
  type IncomingHttpHeaders,
  type SecureClientSessionOptions,
  type ServerHttp2Session,
  type ServerHttp2Stream,
} from 'node:http2'
import type { AddressInfo } from 'node:net'
import { generate } from 'selfsigned'
import type { FcmConfig } from '../src/config'
import { HttpFcmSender, type HttpFcmSenderOptions } from '../src/fcm'

/**
 * A local stand-in for Google's FCM endpoint: real TLS, real HTTP/2, so the real sender
 * runs end to end — request, headers, body, error parsing, connection reuse — without
 * a network or a Firebase project.
 */

export interface FakeGoogleSend {
  path: string
  headers: IncomingHttpHeaders
  body: string
}

export interface FakeGoogleAnswer {
  status: number
  body?: unknown
  /** Never answer; the sender's own deadline is under test. */
  hang?: boolean
  /** Answer after this long, holding the stream open meanwhile. */
  delayMs?: number
  /** Reset the stream instead of answering. */
  reset?: boolean
}

export interface FakeGoogle {
  origin: string
  /** TLS connections accepted so far. One per session the sender opened. */
  readonly connections: number
  readonly sends: FakeGoogleSend[]
  /** What the next send is answered with. Defaults to a 200 with a message name. */
  answer: (send: FakeGoogleSend) => FakeGoogleAnswer
  /** Tell every open connection to go away, as Google does to an idle or old one. */
  goAway(): void
  close(): Promise<void>
}

let tls: Promise<{ key: string; cert: string }> | undefined

export function certificate(): Promise<{ key: string; cert: string }> {
  tls ??= generate([{ name: 'commonName', value: 'localhost' }], {
    algorithm: 'sha256',
    keySize: 2048,
  }).then((pems) => ({ key: pems.private, cert: pems.cert }))
  return tls
}

export async function startFakeGoogle(
  options: { maxConcurrentStreams?: number } = {},
): Promise<FakeGoogle> {
  const { key, cert } = await certificate()
  const server: Http2SecureServer = createSecureServer({
    key,
    cert,
    ...(options.maxConcurrentStreams
      ? { settings: { maxConcurrentStreams: options.maxConcurrentStreams } }
      : {}),
  })
  let connections = 0
  const sends: FakeGoogleSend[] = []
  const state = {
    answer: (_send: FakeGoogleSend): FakeGoogleAnswer => ({
      status: 200,
      body: { name: 'projects/tabsend-test/messages/0:1' },
    }),
  }
  server.on('secureConnection', () => {
    connections += 1
  })
  // Held so `close` can end them: a session the sender still holds would keep the
  // server's own close waiting for ever.
  const sessions = new Set<ServerHttp2Session>()
  server.on('session', (session) => {
    sessions.add(session)
    session.on('close', () => sessions.delete(session))
  })
  server.on('stream', (stream: ServerHttp2Stream, headers: IncomingHttpHeaders) => {
    // A stream this fake resets on purpose reports it as an error on its own side too;
    // unheard, that would end the test run.
    stream.on('error', () => undefined)
    let body = ''
    stream.setEncoding('utf8')
    stream.on('data', (chunk: string) => {
      body += chunk
    })
    stream.on('end', () => {
      const send = { path: String(headers[constants.HTTP2_HEADER_PATH]), headers, body }
      sends.push(send)
      const answer = state.answer(send)
      if (answer.hang) return
      if (answer.reset) {
        stream.close(constants.NGHTTP2_INTERNAL_ERROR)
        return
      }
      const respond = () => {
        if (stream.destroyed) return
        stream.respond({ ':status': answer.status, 'content-type': 'application/json' })
        stream.end(answer.body === undefined ? '' : JSON.stringify(answer.body))
      }
      if (answer.delayMs) setTimeout(respond, answer.delayMs)
      else respond()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const { port } = server.address() as AddressInfo
  return {
    origin: `https://localhost:${port}`,
    get connections() {
      return connections
    },
    sends,
    get answer() {
      return state.answer
    },
    set answer(fn) {
      state.answer = fn
    },
    goAway() {
      // The frame alone, as Google drains a connection: the socket stays up for now.
      for (const session of sessions) session.goaway(constants.NGHTTP2_NO_ERROR)
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        for (const session of sessions) session.destroy()
      }),
  }
}

/** Connect options for the fake: its certificate is self-signed. Tests only. */
export const FAKE_GOOGLE_TLS: SecureClientSessionOptions = { rejectUnauthorized: false }

/** A Google error body in the shape FCM v1 sends. */
export function fcmError(code: number, status: string, errorCode?: string): unknown {
  return {
    error: {
      code,
      status,
      message: 'Requested entity was not found.',
      ...(errorCode
        ? {
            details: [
              { '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode },
            ],
          }
        : {}),
    },
  }
}

/** A real service account, with a fresh key, for a sender that never meets Google. */
export function serviceAccountJson(projectId = 'tabsend-test'): string {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  return JSON.stringify({
    type: 'service_account',
    project_id: projectId,
    client_email: `wake@${projectId}.iam.gserviceaccount.com`,
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  })
}

/** The access token the stub exchange hands out. Tests assert it never escapes. */
export const FAKE_ACCESS_TOKEN = 'ya29.SECRET-ACCESS-TOKEN'

/** The real sender, pointed at the fake, with an exchange that needs no Google. */
export function senderFor(
  google: FakeGoogle,
  options: HttpFcmSenderOptions & { config?: Partial<FcmConfig> } = {},
): HttpFcmSender {
  const { config, ...rest } = options
  return new HttpFcmSender(
    { serviceAccountJson: serviceAccountJson(), timeoutMs: 2000, ...config },
    {
      exchange: async () => ({ accessToken: FAKE_ACCESS_TOKEN, expiresInSeconds: 3600 }),
      origin: google.origin,
      connectOptions: FAKE_GOOGLE_TLS,
      ...rest,
    },
  )
}
