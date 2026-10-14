/**
 * Tabsend Spike A — Firefox fallback relay (port 8081).
 *
 * Firefox exposes NO Web Push to extensions (confirmed by the probe), so the
 * pre-specified fallback is: the extension holds a WebSocket to the relay, with
 * `alarms` driving reconnect. This relay is the WS peer + a lifecycle observer:
 *   - tracks WS connect/disconnect and the page's heartbeats (to see when Firefox
 *     suspends the event page),
 *   - can push a "message" over the live WS and measure delivery latency,
 *   - logs alarm/reconnect events the extension reports.
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.FX_PORT || 8081);
const t0 = Date.now();
const rel = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
function log(...a) { console.log(rel(), ...a); }

let ws = null;            // current live socket (event page connection)
let connectAt = null;
const heartbeats = [];    // {at, rel} each ping from the page
const events = [];        // {at, rel, kind, detail} connect/disconnect/alarm/reconnect
const runs = new Map();   // runId -> {sendAt, resolve, timing}
let seq = 0;

function record(kind, detail) { const e = { at: Date.now(), rel: rel(), kind, detail: detail || null }; events.push(e); log('EVENT', kind, detail || ''); }

function send(res, code, body, type = 'application/json') {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(code, { 'content-type': type, 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' });
  res.end(payload);
}
function readBody(req) { return new Promise((r) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => { try { r(d ? JSON.parse(d) : {}); } catch { r({}); } }); }); }

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  if (req.method === 'OPTIONS') return send(res, 204, '');

  // HTTP heartbeat (in addition to WS ping) — stops when the event page suspends.
  if (u.pathname === '/fx-heartbeat' && req.method === 'POST') {
    const b = await readBody(req); heartbeats.push({ at: Date.now(), rel: rel(), bootAt: b.bootAt });
    return send(res, 200, { ok: true });
  }
  // generic event log from the page (alarm fired, ws reconnected, boot, ...)
  if (u.pathname === '/event' && req.method === 'POST') {
    const b = await readBody(req); record(b.kind, b.detail); return send(res, 200, { ok: true });
  }
  // timing report for a delivered message (HTTP fallback path)
  if (u.pathname === '/timing' && req.method === 'POST') {
    const b = await readBody(req); const r = runs.get(b.runId);
    if (r) { r.timing = b; if (r.resolve) r.resolve(b); }
    log('timing', b.runId, 'latency=' + (b.recvAt - (r ? r.sendAt : b.recvAt)) + 'ms viaWS=' + b.viaWS);
    return send(res, 200, { ok: true });
  }
  // send a "message" over the live WS and measure delivery; if no socket, it's "queued".
  if (u.pathname === '/fx-trigger' && req.method === 'POST') {
    if (!ws || ws.readyState !== ws.OPEN) return send(res, 200, { noSocket: true });
    const runId = `fx${++seq}`; const entry = { sendAt: Date.now(), resolve: null, timing: null };
    const done = new Promise((r) => (entry.resolve = r)); runs.set(runId, entry);
    ws.send(JSON.stringify({ type: 'message', runId, sentAt: entry.sendAt }));
    const to = new Promise((r) => setTimeout(() => r({ timedOut: true }), 10000));
    await Promise.race([done, to]);
    const t = entry.timing;
    return send(res, 200, { runId, delivered: !!t, latencyMs: t ? t.recvAt - entry.sendAt : null, tabMs: t ? t.tabOpenAt - entry.sendAt : null, viaWS: t ? t.viaWS : null });
  }
  if (u.pathname === '/fx-status') {
    const lastHb = heartbeats.length ? heartbeats[heartbeats.length - 1] : null;
    return send(res, 200, {
      connected: !!(ws && ws.readyState === ws.OPEN),
      connectAt, lastHeartbeatAgoMs: lastHb ? Date.now() - lastHb.at : null,
      heartbeatCount: heartbeats.length, events,
    });
  }
  if (u.pathname === '/fx-report') {
    // heartbeat gap analysis
    const gaps = [];
    for (let i = 1; i < heartbeats.length; i++) { const g = heartbeats[i].at - heartbeats[i - 1].at; if (g > 8000) gaps.push({ afterRel: heartbeats[i - 1].rel, gapMs: g }); }
    const out = { totalHeartbeats: heartbeats.length, firstRel: heartbeats[0] && heartbeats[0].rel, lastRel: heartbeats[heartbeats.length - 1] && heartbeats[heartbeats.length - 1].rel, suspendGaps: gaps, events };
    fs.writeFileSync(path.join(__dirname, '..', 'fx-lifecycle.json'), JSON.stringify(out, null, 2));
    return send(res, 200, out);
  }
  send(res, 404, { error: 'not found' });
});

const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (sock) => {
  ws = sock; connectAt = Date.now(); record('ws_connect');
  sock.on('message', (data) => {
    let m; try { m = JSON.parse(data.toString()); } catch { return; }
    if (m.type === 'hello') record('hello', 'bootAt=' + m.bootAt);
    else if (m.type === 'ping') heartbeats.push({ at: Date.now(), rel: rel(), viaWS: true });
    else if (m.type === 'timing') { const r = runs.get(m.runId); if (r) { r.timing = m; if (r.resolve) r.resolve(m); } log('timing(ws)', m.runId, 'latency=' + (m.recvAt - (r ? r.sendAt : m.recvAt)) + 'ms'); }
  });
  sock.on('close', () => { record('ws_close'); if (ws === sock) ws = null; });
});

server.listen(PORT, () => log(`fx-relay listening on http://localhost:${PORT} (+ ws://localhost:${PORT}/ws)`));
