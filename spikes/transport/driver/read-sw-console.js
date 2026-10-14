'use strict';
// Attach to the live extension SW on :9222 and stream its console for ~20s to
// capture the exact subscribe() error, plus dump chrome://gcm-internals state.
const PORT = 9222;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl); let id = 0; const pending = new Map();
  ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    else if (m.method === 'Runtime.consoleAPICalled') { const t = (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '); console.log('[sw]', t); }
    else if (m.method === 'Runtime.exceptionThrown') { console.log('[sw:exc]', JSON.stringify(m.params.exceptionDetails.exception || m.params.exceptionDetails.text)); }
  });
  const ready = new Promise((res) => ws.addEventListener('open', res));
  const cmd = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  return { ready, cmd };
}
(async () => {
  const list = await (await fetch(`http://localhost:${PORT}/json/list`)).json();
  const sw = list.find((t) => t.type === 'service_worker' && /sw\.js/.test(t.url));
  if (!sw) { console.log('no SW target'); process.exit(1); }
  console.log('attached to', sw.url);
  const c = cdp(sw.webSocketDebuggerUrl); await c.ready;
  await c.cmd('Runtime.enable');
  // force a fresh subscribe attempt right now and capture the precise error
  const expr = `(async () => {
    try {
      const key=(await (await fetch('http://localhost:8080/config')).json()).vapidPublicKey;
      function u2a(b){const p='='.repeat((4-b.length%4)%4);const s=(b+p).replace(/-/g,'+').replace(/_/g,'/');const r=atob(s);const a=new Uint8Array(r.length);for(let i=0;i<r.length;i++)a[i]=r.charCodeAt(i);return a;}
      const perm = await self.registration.pushManager.permissionState({userVisibleOnly:false}).catch(e=>'permErr');
      const existing = await self.registration.pushManager.getSubscription();
      if (existing) return {alreadySubscribed:true, endpoint:existing.endpoint, perm};
      const sub = await self.registration.pushManager.subscribe({userVisibleOnly:false, applicationServerKey:u2a(key)});
      return {ok:true, endpoint:sub.endpoint, perm};
    } catch(e){ return {error:(e&&e.name)+': '+(e&&e.message), perm: 'n/a'}; }
  })()`;
  const r = await c.cmd('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  console.log('DIRECT SUBSCRIBE RESULT:', JSON.stringify(r.result && r.result.value));
  await sleep(8000); // catch any ongoing retry logs
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
