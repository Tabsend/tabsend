/**
 * Tabsend Spike A — Chrome driver + orchestrator.
 *
 * Loads the throwaway extension into REAL Google Chrome and drives the latency
 * runs. Key facts learned during the spike:
 *   - Stable Chrome 150 IGNORES the --load-extension switch (abuse mitigation),
 *     even with --disable-features=DisableLoadExtensionCommandLineSwitch.
 *   - The CDP method Extensions.loadUnpacked (needs --enable-unsafe-extension-debugging)
 *     DOES load it, and only requires a BROWSER-level CDP connection — we never
 *     attach to the service-worker target, so the SW still idle-terminates and the
 *     cold-wake measurement is real. We even close the CDP socket after loading.
 *   - We use real Chrome (not Chrome for Testing / Chromium) because only branded
 *     Chrome ships the Google push-service API keys that make pushManager.subscribe
 *     actually register with FCM.
 *
 * Cold-wake runs are gated on the SW target DISAPPEARING from /json/list — a
 * definitive "the worker is terminated" signal, not a guess.
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs'); const path = require('path'); const os = require('os');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const EXT = path.resolve(__dirname, '..', 'extension');
const RELAY = 'http://localhost:8080';
const CDP_PORT = 9222;

const N_WARM = Number(process.env.N_WARM ?? 8);
const N_COLD = Number(process.env.N_COLD ?? 8);
const WARMUP_LEAD_MS = Number(process.env.WARMUP_LEAD_MS ?? 2000);
const SW_DEATH_TIMEOUT_MS = Number(process.env.SW_DEATH_TIMEOUT_MS ?? 180000);
// Extra idle AFTER the SW is confirmed terminated, before the cold push — lets us
// bracket a "deep cold" worst case where the FCM push channel has also gone idle.
const EXTRA_IDLE_MS = Number(process.env.EXTRA_IDLE_MS ?? 0);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), '[driver]', ...a);

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl); let id = 0; const pending = new Map();
  ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const ready = new Promise((res) => ws.addEventListener('open', res));
  const cmd = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  return { ready, cmd, close: () => ws.close() };
}
async function list() { try { return await (await fetch(`http://localhost:${CDP_PORT}/json/list`)).json(); } catch { return []; } }
async function browserWs() { const v = await (await fetch(`http://localhost:${CDP_PORT}/json/version`)).json(); return v.webSocketDebuggerUrl; }
async function swPresent() { return (await list()).some((t) => t.type === 'service_worker' && /sw\.js/.test(t.url)); }
async function relay(pathq, opts) { return (await fetch(RELAY + pathq, opts)).json(); }
async function trigger(phase) { return relay(`/trigger?phase=${phase}`, { method: 'POST' }); }

async function waitSwGone(timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) { if (!(await swPresent())) return Math.round((Date.now() - start) / 1000); await sleep(2000); }
  return -1; // never terminated within timeout
}
async function waitSwUp(timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) { if (await swPresent()) return true; await sleep(500); }
  return false;
}

(async () => {
  // PERSISTENT profile by default: reuse one profile across runs so Chrome's GCM
  // check-in happens once and caches in the profile's "GCM Store". Repeatedly
  // creating fresh ephemeral profiles triggers Google to reject check-ins with
  // PHONE_REGISTRATION_ERROR (rate-limited). Set PROFILE_DIR to override.
  const userDataDir = process.env.PROFILE_DIR || path.resolve(__dirname, '..', '.chrome-profile');
  fs.mkdirSync(userDataDir, { recursive: true });
  log('user-data-dir (persistent):', userDataDir);
  const args = [
    `--user-data-dir=${userDataDir}`,
    `--remote-debugging-port=${CDP_PORT}`,
    '--enable-unsafe-extension-debugging',
    '--silent-debugger-extension-api',
    '--no-first-run', '--no-default-browser-check', '--no-service-autorun',
    '--disable-search-engine-choice-screen',
    'about:blank',
  ];
  log('launching real Chrome...');
  const proc = spawn(CHROME, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  proc.stderr.on('data', (d) => { const s = d.toString(); s.split('\n').forEach((l) => { if (/gcm|PHONE_REGISTRATION|DEPRECATED_ENDPOINT|registration response/i.test(l)) log('chrome:', l.trim().slice(0, 140)); }); });
  const cleanup = () => { try { proc.kill('SIGTERM'); } catch {} };
  process.on('SIGINT', () => { cleanup(); process.exit(130); });

  // wait for CDP, load the extension
  let bws = null;
  for (let i = 0; i < 30 && !bws; i++) { await sleep(1000); try { bws = await browserWs(); } catch {} }
  if (!bws) { log('CDP never came up'); cleanup(); process.exit(1); }
  const c = cdp(bws); await c.ready;
  const r = await c.cmd('Extensions.loadUnpacked', { path: EXT });
  log('Extensions.loadUnpacked ->', JSON.stringify(r.result || r.error));
  c.close(); // detach — SW lifecycle must be natural for cold-wake to be real

  // wait for the SW to subscribe and report to the relay
  log('waiting for push subscription (retries can take up to ~90s while GCM checks in)...');
  let subscribed = false;
  for (let i = 0; i < 120; i++) { await sleep(1000); const h = await relay('/health').catch(() => ({})); if (h.hasSub) { subscribed = true; break; } }
  if (!subscribed) { log('NO SUBSCRIPTION — push registration failed. See chrome stderr above.'); cleanup(); process.exit(2); }
  log('subscribed. starting runs.');

  // ---- WARM PHASE: warmup push boots the SW; measured push 2s later hits a warm SW.
  log(`--- WARM phase (${N_WARM} runs) ---`);
  for (let i = 0; i < N_WARM; i++) {
    await trigger('warmup');
    await waitSwUp(5000);
    await sleep(WARMUP_LEAD_MS);
    const res = await trigger('warm');
    const d = res.delta;
    log(`warm[${i + 1}/${N_WARM}] ${res.runId}`, d ? `push=${d.pushLatency} fetch=${d.fetchComplete} tab=${d.tabOpen} tabSrv=${d.tabHitServer} bootΔ=${d.bootToPush} warm=${d.warmObserved}` : `(timeout ${res.timedOut})`);
    await sleep(1500);
  }

  // ---- COLD PHASE: wait until the SW target is GONE, then push a cold wake.
  log(`--- COLD phase (${N_COLD} runs) ---`);
  for (let i = 0; i < N_COLD; i++) {
    log(`cold[${i + 1}/${N_COLD}] waiting for SW to idle-terminate...`);
    const secs = await waitSwGone(SW_DEATH_TIMEOUT_MS);
    if (secs < 0) { log(`  SW never terminated within ${SW_DEATH_TIMEOUT_MS / 1000}s — recording anyway (likely warm).`); }
    else { log(`  SW terminated after ~${secs}s idle.`); }
    if (EXTRA_IDLE_MS > 0) { log(`  extra idle ${EXTRA_IDLE_MS / 1000}s (deep-cold: let the push channel go idle too)...`); await sleep(EXTRA_IDLE_MS); }
    log('  sending cold push.');
    const res = await trigger('cold');
    const d = res.delta;
    log(`cold[${i + 1}/${N_COLD}] ${res.runId}`, d ? `push=${d.pushLatency} fetch=${d.fetchComplete} tab=${d.tabOpen} tabSrv=${d.tabHitServer} bootΔ=${d.bootToPush} warm=${d.warmObserved}` : `(timeout ${res.timedOut})`);
  }

  const results = await relay('/results');
  fs.writeFileSync(path.resolve(__dirname, '..', 'results.json'), JSON.stringify(results, null, 2));
  printReport(results);
  await sleep(1000);
  cleanup();
  process.exit(0);
})().catch((e) => { console.error('[driver] fatal', e); process.exit(1); });

function fmt(s) { return s && s.n ? `n=${s.n} min=${s.min} median=${s.median} p90=${s.p90} max=${s.max}` : 'n=0'; }
function printReport(r) {
  const lines = [];
  lines.push('');
  lines.push('================= SPIKE A — CHROME RESULTS (ms, relative to relay send) =================');
  lines.push(`FOREGROUND / WARM (SW recently active)   bar < 1000 ms   [n=${r.summary.warm.n}]`);
  lines.push('  push received : ' + fmt(r.summary.warm.pushLatency));
  lines.push('  fetch complete: ' + fmt(r.summary.warm.fetchComplete));
  lines.push('  tab opened    : ' + fmt(r.summary.warm.tabOpen));
  lines.push('  bootΔ (warm should be large): ' + fmt(r.summary.warm.bootToPush));
  lines.push('');
  lines.push(`COLD-WAKE (SW idle-terminated)           bar < 5000 ms   [n=${r.summary.cold.n}]`);
  lines.push('  push received : ' + fmt(r.summary.cold.pushLatency));
  lines.push('  fetch complete: ' + fmt(r.summary.cold.fetchComplete));
  lines.push('  tab opened    : ' + fmt(r.summary.cold.tabOpen));
  lines.push('  bootΔ (cold should be small): ' + fmt(r.summary.cold.bootToPush));
  lines.push('========================================================================================');
  const text = lines.join('\n');
  console.log(text);
  fs.writeFileSync(path.resolve(__dirname, '..', 'results.txt'), text + '\n\nfull JSON in results.json\n');
}
