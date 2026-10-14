import type { FastifyInstance } from 'fastify'

/**
 * Human landing page for pairing links opened as ordinary web pages. The secret
 * remains in `location.hash`, which browsers never send to this route. The page
 * uses it only for a local copy button; no script, font, image, or analytics leave
 * the relay.
 */
const PAIR_PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Open this link in Tabsend</title>
  <style>
    :root { color-scheme: light dark; font: 16px/1.5 system-ui, sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f5f4ef; color: #18201b; }
    main { box-sizing: border-box; width: min(92vw, 34rem); padding: 2rem; border: 1px solid #d7d4c9; border-radius: 1rem; background: #fff; box-shadow: 0 1rem 3rem #15201818; }
    h1 { margin: 0 0 .75rem; font-size: 1.6rem; line-height: 1.2; }
    p { margin: .7rem 0; }
    .muted { color: #59635d; }
    .actions { display: flex; flex-wrap: wrap; gap: .7rem; margin: 1.4rem 0 1rem; }
    button, a.button { border: 0; border-radius: .6rem; padding: .72rem 1rem; font: inherit; font-weight: 650; cursor: pointer; text-decoration: none; background: #1f6f50; color: white; }
    a { color: #176344; }
    #copied { min-height: 1.5em; color: #176344; }
    @media (prefers-color-scheme: dark) {
      body { background: #111512; color: #edf2ee; }
      main { background: #1b211d; border-color: #39423c; box-shadow: none; }
      .muted { color: #aeb9b1; }
      a { color: #8bd6b2; }
    }
  </style>
</head>
<body>
  <main>
    <h1>Open this pairing link in Tabsend</h1>
    <p id="instructions">Install or open Tabsend, then paste this complete pairing link into its pairing screen.</p>
    <p class="muted">The link works once and expires. Opening it in a normal browser does not pair the browser by itself.</p>
    <div class="actions">
      <button id="copy" type="button">Copy pairing link</button>
      <a class="button" href="https://github.com/tabsend/tabsend/releases" rel="noreferrer">Get Tabsend</a>
    </div>
    <p id="copied" role="status"></p>
    <p class="muted"><a href="https://github.com/tabsend/tabsend" rel="noreferrer">Setup help and source code</a></p>
  </main>
  <script>
    const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
    document.querySelector('#instructions').textContent = mobile
      ? 'Open the Tabsend app, then paste this complete pairing link into the pairing screen. Secure phone links normally open the app automatically when it is installed.'
      : 'Open the Tabsend browser extension, then paste this complete pairing link into its pairing screen.'
    document.querySelector('#copy').addEventListener('click', async () => {
      const status = document.querySelector('#copied')
      try {
        await navigator.clipboard.writeText(location.href)
        status.textContent = 'Pairing link copied.'
      } catch {
        status.textContent = 'Copy the complete address from your browser’s address bar.'
      }
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
