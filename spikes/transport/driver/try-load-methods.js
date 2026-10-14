'use strict';
// Try several ways to get an unpacked extension into branded Chrome 150.
const { spawn } = require('child_process');
const fs = require('fs'); const path = require('path'); const os = require('os');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const EXT = path.resolve(__dirname, '..', 'extension');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl); let id = 0; const pending = new Map();
  ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const ready = new Promise((res) => ws.addEventListener('open', res));
  const cmd = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  return { ready, cmd, ws };
}

async function targets(port) {
  const l = await (await fetch(`http://localhost:${port}/json/list`)).json();
  return l;
}
async function browserWs(port) {
  const v = await (await fetch(`http://localhost:${port}/json/version`)).json();
  return v.webSocketDebuggerUrl;
}

async function launch(port, flags) {
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'tabsend-try-'));
  const args = [`--user-data-dir=${ud}`, `--remote-debugging-port=${port}`,
    '--no-first-run', '--no-default-browser-check', ...flags, 'about:blank'];
  const proc = spawn(CHROME, args, { stdio: ['ignore', 'ignore', 'ignore'] });
  await sleep(5000);
  return { proc, ud };
}
function hasMySW(list) { return list.some((t) => t.type === 'service_worker' && /sw\.js/.test(t.url)); }

(async () => {
  const method = process.argv[2] || 'cdp';

  if (method === 'cdp') {
    // CDP Extensions.loadUnpacked with --enable-unsafe-extension-debugging
    const port = 9301;
    const { proc, ud } = await launch(port, ['--enable-unsafe-extension-debugging', '--silent-debugger-extension-api']);
    try {
      const bws = await browserWs(port);
      const c = cdp(bws); await c.ready;
      const r = await c.cmd('Extensions.loadUnpacked', { path: EXT });
      console.log('[cdp] Extensions.loadUnpacked ->', JSON.stringify(r));
      await sleep(3000);
      const list = await targets(port);
      console.log('[cdp] my SW present:', hasMySW(list));
      list.filter(t=>t.type==='service_worker'||/extension/.test(t.url)).forEach(t=>console.log('   ',t.type,t.url.slice(0,80)));
    } catch (e) { console.log('[cdp] ERROR', e.message); }
    finally { proc.kill('SIGTERM'); fs.rmSync(ud, { recursive: true, force: true }); }
  }

  if (method === 'devmode') {
    // Pre-seed developer_mode + --load-extension
    const port = 9302;
    const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'tabsend-try-'));
    fs.mkdirSync(path.join(ud, 'Default'), { recursive: true });
    fs.writeFileSync(path.join(ud, 'Default', 'Preferences'),
      JSON.stringify({ extensions: { ui: { developer_mode: true } } }));
    const args = [`--user-data-dir=${ud}`, `--remote-debugging-port=${port}`,
      '--no-first-run', '--no-default-browser-check',
      `--load-extension=${EXT}`, `--disable-extensions-except=${EXT}`,
      '--disable-features=DisableLoadExtensionCommandLineSwitch',
      'about:blank'];
    const proc = spawn(CHROME, args, { stdio: ['ignore', 'ignore', 'ignore'] });
    await sleep(6000);
    const list = await targets(port);
    console.log('[devmode] my SW present:', hasMySW(list));
    list.forEach(t=>console.log('   ',t.type,t.url.slice(0,80)));
    proc.kill('SIGTERM'); fs.rmSync(ud, { recursive: true, force: true });
  }

  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
