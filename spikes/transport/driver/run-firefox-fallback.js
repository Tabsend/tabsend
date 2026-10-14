/**
 * Spike A — Firefox fallback (WS) lifecycle + latency runner.
 * Loads the fallback event-page extension into real Firefox via web-ext, measures
 * WebSocket delivery latency (the fast path), then watches heartbeats to see if/when
 * Firefox suspends the event page and whether the 1-min alarm reconnects it.
 * Assumes relay/fx-relay.js is already listening on :8081.
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const FIREFOX = '/Applications/Firefox.app/Contents/MacOS/firefox';
const EXT = path.resolve(__dirname, '..', 'firefox', process.env.FX_EXT || 'fallback-extension');
const WEBEXT = path.resolve(__dirname, '..', 'node_modules', '.bin', 'web-ext');
const FX = 'http://localhost:8081';
const OBSERVE_MS = Number(process.env.OBSERVE_MS || 150000); // ~2.5 min
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), '[fx-run]', ...a);
const get = async (p) => (await fetch(FX + p)).json();
const post = async (p) => (await fetch(FX + p, { method: 'POST' })).json();

(async () => {
  log('launching Firefox via web-ext...');
  const proc = spawn(WEBEXT, ['run', `--source-dir=${EXT}`, `--firefox=${FIREFOX}`, '--no-reload', '--no-input'], { stdio: ['ignore', 'ignore', 'ignore'] });

  // wait for the WS to connect
  let connected = false;
  for (let i = 0; i < 40; i++) { await sleep(1000); const s = await get('/fx-status').catch(() => ({})); if (s.connected) { connected = true; break; } }
  if (!connected) { log('WS never connected — check web-ext/Firefox'); proc.kill(); process.exit(1); }
  log('WS connected. measuring fast-path (WS) delivery latency...');

  const warm = [];
  for (let i = 0; i < 5; i++) { const r = await post('/fx-trigger'); if (r.delivered) { warm.push(r.latencyMs); log(`ws deliver[${i + 1}] latency=${r.latencyMs}ms tab=${r.tabMs}ms viaWS=${r.viaWS}`); } else log(`ws deliver[${i + 1}] noSocket=${r.noSocket} timedOut=${r.timedOut}`); await sleep(1500); }

  log(`now observing event-page lifecycle for ${OBSERVE_MS / 1000}s (no WS traffic from us; heartbeats reveal suspension)...`);
  const start = Date.now();
  let lastState = null;
  while (Date.now() - start < OBSERVE_MS) {
    await sleep(5000);
    const s = await get('/fx-status').catch(() => ({}));
    const state = `${Math.round((Date.now() - start) / 1000)}s connected=${s.connected} lastHbAgo=${s.lastHeartbeatAgoMs}ms hbCount=${s.heartbeatCount}`;
    if (state !== lastState) log(state);
    lastState = state;
  }

  // after the observation window, try a delivery to show queued-vs-live behavior
  const late = await post('/fx-trigger');
  log('post-observation trigger:', JSON.stringify(late));

  const report = await get('/fx-report');
  log('LIFECYCLE REPORT:', JSON.stringify(report, null, 2));
  log('WS warm latencies:', JSON.stringify(warm), 'median=', warm.sort((a, b) => a - b)[Math.floor((warm.length - 1) / 2)]);

  proc.kill('SIGTERM');
  try { require('child_process').execSync('pkill -f "firefox.*fallback-extension" 2>/dev/null || true'); } catch {}
  process.exit(0);
})().catch((e) => { console.error('[fx-run] error', e); process.exit(1); });
