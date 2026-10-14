'use strict';
// Experiment: does the extension SW idle-terminate with the remote-debugging port
// present? And can we force-stop it via CDP ServiceWorker.stopAllWorkers?
const { spawn } = require('child_process');
const fs = require('fs'); const path = require('path'); const os = require('os');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const EXT = path.resolve(__dirname, '..', 'extension');
const PORT = 9222;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ts = () => new Date().toISOString().slice(11, 19);

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl); let id = 0; const pending = new Map(); const events = [];
  ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } else if (m.method) events.push(m); });
  const ready = new Promise((res) => ws.addEventListener('open', res));
  const cmd = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  return { ready, cmd, close: () => ws.close(), events };
}
async function jlist() { try { return await (await fetch(`http://localhost:${PORT}/json/list`)).json(); } catch { return []; } }
async function bws() { const v = await (await fetch(`http://localhost:${PORT}/json/version`)).json(); return v.webSocketDebuggerUrl; }
async function swPresent() { return (await jlist()).some((t) => t.type === 'service_worker' && /sw\.js/.test(t.url)); }

(async () => {
  const mode = process.argv[2] || 'natural'; // natural | forcestop
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'tabsend-exp-'));
  const proc = spawn(CHROME, [`--user-data-dir=${ud}`, `--remote-debugging-port=${PORT}`,
    '--enable-unsafe-extension-debugging', '--silent-debugger-extension-api',
    '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: ['ignore', 'ignore', 'ignore'] });
  await sleep(4000);
  const c = cdp(await bws()); await c.ready;
  const r = await c.cmd('Extensions.loadUnpacked', { path: EXT });
  console.log(ts(), 'loaded', JSON.stringify(r.result || r.error));
  await sleep(3000);
  console.log(ts(), 'SW present after load:', await swPresent());

  if (mode === 'natural') {
    c.close(); // detach fully
    console.log(ts(), 'detached CDP. polling for natural idle-termination (up to 180s, no attach)...');
    const start = Date.now();
    let gone = false;
    while (Date.now() - start < 180000) {
      await sleep(5000);
      const present = await swPresent();
      console.log(ts(), `+${Math.round((Date.now() - start) / 1000)}s SW present: ${present}`);
      if (!present) { gone = true; console.log(ts(), 'SW TERMINATED naturally after ~' + Math.round((Date.now() - start) / 1000) + 's'); break; }
    }
    if (!gone) console.log(ts(), 'SW never terminated in 180s (remote-debugging likely keeps it alive)');
  }

  if (mode === 'forcestop') {
    // Try ServiceWorker.stopAllWorkers on the browser target
    await c.cmd('ServiceWorker.enable');
    await sleep(500);
    const stop = await c.cmd('ServiceWorker.stopAllWorkers');
    console.log(ts(), 'stopAllWorkers ->', JSON.stringify(stop.result || stop.error));
    await sleep(2000);
    console.log(ts(), 'SW present after stopAllWorkers:', await swPresent());
  }

  proc.kill('SIGTERM'); fs.rmSync(ud, { recursive: true, force: true }); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
