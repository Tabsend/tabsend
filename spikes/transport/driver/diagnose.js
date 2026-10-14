/**
 * Spike A diagnostic: launch Chrome with CDP, attach to the extension service
 * worker, capture its console, and run pushManager.subscribe() with retries to
 * surface the exact failure and give GCM check-in time to complete.
 *
 * CDP keeps the SW alive — fine here, we're only diagnosing subscription, not
 * measuring cold-wake.
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const EXT = path.resolve(__dirname, '..', 'extension');
const PORT = 9222;
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabsend-diag-chrome-'));

const extraFlags = (process.env.EXTRA_FLAGS || '').split(' ').filter(Boolean);
const args = [
  `--user-data-dir=${userDataDir}`,
  `--load-extension=${EXT}`,
  `--disable-extensions-except=${EXT}`,
  `--remote-debugging-port=${PORT}`,
  '--no-first-run', '--no-default-browser-check', '--no-service-autorun',
  '--disable-search-engine-choice-screen',
  ...extraFlags,
  'about:blank',
];
console.log('[diag] flags:', args.join(' '));
const proc = spawn(CHROME, args, { stdio: ['ignore', 'pipe', 'pipe'] });
const gcmLines = [];
proc.stderr.on('data', (d) => {
  const s = d.toString();
  s.split('\n').forEach((l) => { if (/gcm|registration|checkin|push|instance_id/i.test(l)) gcmLines.push(l.trim()); });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdpList() {
  const r = await fetch(`http://localhost:${PORT}/json/list`);
  return r.json();
}

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const events = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    else if (m.method) events.push(m);
  });
  const ready = new Promise((res) => ws.addEventListener('open', () => res()));
  function sendCmd(method, params = {}) {
    const myId = ++id;
    return new Promise((res) => { pending.set(myId, res); ws.send(JSON.stringify({ id: myId, method, params })); });
  }
  return { ws, ready, sendCmd, events };
}

(async () => {
  // wait for the SW target to appear
  let sw = null;
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    try {
      const list = await cdpList();
      sw = list.find((t) => t.type === 'service_worker' && /sw\.js/.test(t.url));
      if (sw) break;
    } catch { /* CDP not up yet */ }
  }
  if (!sw) { console.log('[diag] no SW target found'); proc.kill(); process.exit(1); }
  console.log('[diag] SW target:', sw.url);

  const c = cdp(sw.webSocketDebuggerUrl);
  await c.ready;
  await c.sendCmd('Runtime.enable');
  await c.sendCmd('Log.enable');
  c.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.consoleAPICalled') {
      const txt = (m.params.args || []).map((a) => a.value ?? a.description ?? JSON.stringify(a)).join(' ');
      console.log('[sw]', txt);
    }
    if (m.method === 'Log.entryAdded') console.log('[sw:log]', m.params.entry.level, m.params.entry.text);
  });

  // run a retry-subscribe loop inside the SW
  const expr = `(async () => {
    const RELAY='http://localhost:8080';
    function u2a(b){const p='='.repeat((4-b.length%4)%4);const s=(b+p).replace(/-/g,'+').replace(/_/g,'/');const r=atob(s);const a=new Uint8Array(r.length);for(let i=0;i<r.length;i++)a[i]=r.charCodeAt(i);return a;}
    let key;
    try { key=(await (await fetch(RELAY+'/config')).json()).vapidPublicKey; } catch(e){ return {stage:'config', err:String(e)}; }
    const perm = await self.registration.pushManager.permissionState({userVisibleOnly:false}).catch(e=>'permErr:'+e);
    let last=null;
    for (let i=0;i<12;i++){
      try {
        const sub = await self.registration.pushManager.subscribe({userVisibleOnly:false, applicationServerKey:u2a(key)});
        return {ok:true, attempt:i, perm, endpointHost:new URL(sub.endpoint).host, endpoint:sub.endpoint};
      } catch(e){ last={name:e.name, msg:e.message}; await new Promise(r=>setTimeout(r,4000)); }
    }
    return {ok:false, perm, last};
  })()`;
  console.log('[diag] running subscribe retry loop in SW (up to ~48s)...');
  const res = await c.sendCmd('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  console.log('[diag] RESULT:', JSON.stringify(res.result && res.result.value, null, 2));
  if (res.exceptionDetails) console.log('[diag] EXC:', JSON.stringify(res.exceptionDetails));

  console.log('\n[diag] GCM/push-related Chrome stderr lines:');
  console.log(gcmLines.slice(-40).join('\n'));

  proc.kill('SIGTERM');
  process.exit(0);
})().catch((e) => { console.error('[diag] error', e); proc.kill(); process.exit(1); });
