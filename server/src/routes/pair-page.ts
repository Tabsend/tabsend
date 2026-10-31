import type { FastifyInstance } from 'fastify'

/**
 * The page a setup link opens when Tabsend is not there to catch it: someone scanned
 * the QR with a phone's camera, or opened the link in a browser without the
 * extension. It doubles as the install page, so one code both adds a device and,
 * where Tabsend is missing, says how to install it.
 *
 * "Install Tabsend" copies the link before it leaves for the downloads, so the app
 * can offer it on first launch (Android reads it, iPhone and the extension paste
 * it). The secret remains in `location.hash`, which browsers never send to this
 * route, and the copy stays on the device; no script, font, image, or analytics
 * leave the relay.
 */
const PAIR_PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Add this device to Tabsend</title>
  <style>
    :root { color-scheme: light dark; font: 16px/1.5 system-ui, sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f5f4ef; color: #18201b; }
    main { box-sizing: border-box; width: min(92vw, 34rem); padding: 2rem; border: 1px solid #d7d4c9; border-radius: 1rem; background: #fff; box-shadow: 0 1rem 3rem #15201818; }
    h1 { margin: 0 0 .75rem; font-size: 1.6rem; line-height: 1.2; }
    p { margin: .7rem 0; }
    .muted { color: #59635d; }
    .small { font-size: .875rem; }
    footer { margin-top: 1.4rem; padding-top: 1rem; border-top: 1px solid #d7d4c9; font-size: .875rem; }
    footer a { margin-right: .9rem; text-decoration: none; }
    footer a:hover { text-decoration: underline; }
    .install { display: block; margin: 1.4rem 0 .5rem; border-radius: .6rem; padding: .85rem 1rem; font-weight: 650; text-align: center; text-decoration: none; background: #1f6f50; color: white; }
    button { border: 1px solid #1f6f50; border-radius: .6rem; padding: .5rem .9rem; font: inherit; font-weight: 600; cursor: pointer; background: transparent; color: #176344; }
    a { color: #176344; }
    #copied { min-height: 1.5em; color: #176344; }
    @media (prefers-color-scheme: dark) {
      body { background: #111512; color: #edf2ee; }
      main { background: #1b211d; border-color: #39423c; box-shadow: none; }
      .muted { color: #aeb9b1; }
      a, button, #copied { color: #8bd6b2; }
      button { border-color: #8bd6b2; }
      footer { border-color: #39423c; }
    }
  </style>
</head>
<body>
  <main>
    <h1 id="title">Add this device to Tabsend</h1>
    <p class="muted">Tabsend sends a web page from one of your devices to another, such as from your computer to your phone. This link adds this device to yours.</p>
    <a class="install" id="install" href="https://tabsend.org/#download">Install Tabsend</a>
    <p class="muted small">The button also copies this link, so Tabsend can use it once it is installed.</p>
    <p>Already installed? <button id="copy" type="button">Copy link</button> then open Tabsend.</p>
    <p id="copied" role="status"></p>
    <p class="muted small">The link works once, and not for long. If it stopped working, add this device again from one you already set up.</p>
    <footer aria-label="Tabsend website">
      <a href="https://tabsend.org">tabsend.org</a>
      <a id="privacy" href="https://tabsend.org/privacy" hidden>Privacy</a>
      <a id="terms" href="https://tabsend.org/terms" hidden>Terms</a>
      <a href="https://tabsend.org/support">Support</a>
    </footer>
  </main>
  <script>
    const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
    document.querySelector('#title').textContent = mobile
      ? 'Add this phone to Tabsend'
      : 'Add this browser to Tabsend'
    // Privacy and Terms cover the hosted service only. A relay run by someone else has
    // another operator, so its page does not point at ours.
    if (location.hostname === 'app.tabsend.org') {
      document.querySelector('#privacy').hidden = false
      document.querySelector('#terms').hidden = false
    }
    const status = document.querySelector('#copied')
    async function copyLink() {
      try {
        await navigator.clipboard.writeText(location.href)
        return true
      } catch {
        return false
      }
    }
    document.querySelector('#copy').addEventListener('click', async () => {
      status.textContent = (await copyLink())
        ? 'Link copied. Now open Tabsend.'
        : 'Copy the complete address from your browser’s address bar.'
    })
    // Copy first, then go: leaving the page before the copy settles can lose it.
    const install = document.querySelector('#install')
    install.addEventListener('click', async (event) => {
      event.preventDefault()
      await copyLink()
      location.href = install.href
    })
  </script>
</body>
</html>`

export function registerPairPageRoute(app: FastifyInstance): void {
  app.get('/pair', async (_request, reply) => {
    reply
      .header('Cache-Control', 'no-store')
      .header('Referrer-Policy', 'no-referrer')
      .header('X-Content-Type-Options', 'nosniff')
      .type('text/html; charset=utf-8')
      .send(PAIR_PAGE)
  })
}
