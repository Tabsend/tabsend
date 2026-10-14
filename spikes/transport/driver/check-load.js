'use strict';
const { spawn } = require('child_process');
const fs = require('fs'); const path = require('path'); const os = require('os');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const EXT = path.resolve(__dirname, '..', 'extension');
const PORT = 9224;
const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'tabsend-checkload-'));
const args = [`--user-data-dir=${ud}`, `--load-extension=${EXT}`, `--disable-extensions-except=${EXT}`,
  `--remote-debugging-port=${PORT}`, '--no-first-run', '--no-default-browser-check', 'about:blank'];
const proc = spawn(CHROME, args, { stdio: ['ignore', 'ignore', 'inherit'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl); let id = 0; const pending = new Map();
  ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const ready = new Promise((res) => ws.addEventListener('open', res));
  const cmd = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  return { ready, cmd };
}

(async () => {
  await sleep(5000);
  const list = await (await fetch(`http://localhost:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  const c = cdp(page.webSocketDebuggerUrl); await c.ready;
  await c.cmd('Page.enable'); await c.cmd('Runtime.enable');
  await c.cmd('Page.navigate', { url: 'chrome://extensions/' });
  await sleep(2500);
  // pierce shadow DOM to read the extensions manager state
  const expr = `(() => {
    const mgr = document.querySelector('extensions-manager');
    if (!mgr) return 'no extensions-manager';
    const items = mgr.shadowRoot.querySelector('extensions-item-list');
    const cards = items ? items.shadowRoot.querySelectorAll('extensions-item') : [];
    const out = [];
    cards.forEach(card => {
      const sr = card.shadowRoot;
      const name = sr.querySelector('#name') ? sr.querySelector('#name').textContent.trim() : '?';
      const id = card.id;
      const err = sr.querySelector('#a11yAssociation') ? '' : '';
      out.push({name, id});
    });
    // also grab any load-error dialog text
    const bodyText = document.body.innerText.slice(0, 500);
    return JSON.stringify({count: cards.length, cards: out, bodyText});
  })()`;
  const r = await c.cmd('Runtime.evaluate', { expression: expr, returnByValue: true });
  console.log('[check] extensions page:', r.result.value);

  // Also check whether devtools/loading errors were surfaced via chrome://extensions/?errors
  await c.cmd('Page.navigate', { url: 'chrome://extensions/?id=' });
  await sleep(500);
  proc.kill('SIGTERM');
  process.exit(0);
})().catch((e) => { console.error(e); proc.kill(); process.exit(1); });
