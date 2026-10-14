/**
 * Spike A — UnifiedPush latency feel via a public ntfy instance.
 * Subscribes to a random topic (JSON stream), publishes a message, and measures
 * publish -> receipt latency. ntfy is a UnifiedPush distributor; UnifiedPush 3.0
 * endpoints are standard Web Push, so the relay's VAPID sender reuses on Android.
 * This is a transport latency *feel* only — not the extension path.
 */
'use strict';
const BASE = process.env.NTFY_BASE || 'https://ntfy.sh';
const topic = 'tabsend-spike-' + Math.random().toString(36).slice(2, 10);
const N = Number(process.env.NTFY_N || 5);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pending = new Map(); // id -> sentAt
const samples = [];

(async () => {
  console.log(`[ntfy] instance=${BASE} topic=${topic}`);
  const ctrl = new AbortController();
  const res = await fetch(`${BASE}/${topic}/json`, { signal: ctrl.signal });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.event === 'message' && msg.message) {
          const recvAt = Date.now();
          const id = msg.message;
          if (pending.has(id)) { const d = recvAt - pending.get(id); samples.push(d); pending.delete(id); console.log(`[ntfy] recv ${id} latency=${d}ms`); }
        }
      }
    }
  })().catch(() => {});

  await sleep(1500); // let the stream attach

  for (let i = 0; i < N; i++) {
    const id = `m${i}-${Date.now()}`;
    pending.set(id, Date.now());
    await fetch(`${BASE}/${topic}`, { method: 'POST', body: id });
    await sleep(1500);
  }
  await sleep(2000);
  ctrl.abort();

  const a = samples.sort((x, y) => x - y);
  const med = a.length ? a[Math.floor((a.length - 1) / 2)] : null;
  console.log(`[ntfy] samples=${JSON.stringify(a)} median=${med}ms  (n=${a.length}/${N})`);
  process.exit(0);
})().catch((e) => { console.error('[ntfy] error', e); process.exit(1); });
