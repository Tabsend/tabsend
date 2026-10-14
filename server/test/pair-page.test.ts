import { afterEach, describe, expect, it } from 'vitest'
import { startTestServer, type TestServer } from './helpers'

let server: TestServer | undefined

afterEach(async () => {
  await server?.close()
  server = undefined
})

describe('GET /pair', () => {
  it('renders a private, useful landing page instead of a JSON 404', async () => {
    server = await startTestServer()
    const res = await fetch(`${server.baseUrl}/pair`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
    const html = await res.text()
    expect(html).toContain('Open this pairing link in Tabsend')
    expect(html).toContain('Copy pairing link')
    expect(html).not.toContain('ABC123')
  })
})
