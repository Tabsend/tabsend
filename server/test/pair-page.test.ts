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
    expect(html).toContain('Add this device to Tabsend')
    expect(html).toContain('Copy link')
    expect(html).not.toContain('ABC123')
  })

  it('says what Tabsend is and links back to the project site', async () => {
    server = await startTestServer()
    const html = await (await fetch(`${server.baseUrl}/pair`)).text()
    expect(html).toContain('Tabsend sends a web page from one of your devices to another')
    expect(html).toContain('href="https://tabsend.org"')
    expect(html).toContain('href="https://tabsend.org/support"')
  })

  it('doubles as the install page, copying the link before it leaves', async () => {
    server = await startTestServer()
    const html = await (await fetch(`${server.baseUrl}/pair`)).text()
    expect(html).toContain(
      '<a class="install" id="install" href="https://tabsend.org/#download">Install Tabsend</a>',
    )
    // The copy has to finish before the page navigates away, or it can be lost.
    expect(html.indexOf('await copyLink()\n      location.href = install.href')).toBeGreaterThan(-1)
    expect(html).not.toContain('github.com/Tabsend/tabsend/releases')
  })

  it('keeps the policies hidden unless the page is served from the hosted address', async () => {
    server = await startTestServer()
    const html = await (await fetch(`${server.baseUrl}/pair`)).text()
    // Hidden in the markup; only a script on app.tabsend.org un-hides them.
    expect(html).toMatch(/<a id="privacy" href="https:\/\/tabsend.org\/privacy" hidden>/)
    expect(html).toMatch(/<a id="terms" href="https:\/\/tabsend.org\/terms" hidden>/)
    expect(html).toContain("location.hostname === 'app.tabsend.org'")
  })
})
