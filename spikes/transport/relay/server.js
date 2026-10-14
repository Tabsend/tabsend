/**
 * Tabsend Spike A — throwaway relay + push sender.
 *
 * Models the Tabsend reliability path (PRD §6.1/§6.4) at the transport layer:
 *   push wake -> extension pulls pending -> "opens tab" -> reports timing (ack).
 * One machine, one clock: all deltas are ms relative to the relay's sendAt.
 *
 * Trigger-driven: the driver (driver/run-chrome.js) owns warm/cold sequencing and
 * uses CDP /json/list to confirm SW termination; this relay just sends one VAPID
 * push per /trigger and records the round-trip. No framework — http + web-push.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const webpush = require('web-push');

const PORT = 8080;
const vapid = JSON.parse(fs.readFileSync(path.join(__dirname, 'vapid.json'), 'utf8'));
webpush.setVapidDetails('mailto:spike@tabsend.local', vapid.publicKey, vapid.privateKey);

const RUN_TIMEOUT_MS = Number(process.env.RUN_TIMEOUT_MS ?? 20000);
const TAB_URL = (runId) => `http://localhost:${PORT}/opened?runId=${runId}`;

let subscription = null;
const runs = new Map();   // runId -> { phase, sendAt, tabHitAt, timing, resolve }
let runSeq = 0;

function log(...a) { console.log(new Date().toISOString().slice(11, 23), ...a); }
function send(res, code, body, type = 'application/json') {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(code, { 'content-type': type, 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' });
  res.end(payload);
}
function readBody(req) {
  return new Promise((resolve) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch { resolve({}); } }); });
}

function stat(nums) {
  const a = nums.filter((n) => Number.isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return { n: 0 };
  const q = (p) => { const idx = (a.length - 1) * p; const lo = Math.floor(idx), hi = Math.ceil(idx); return Math.round(a[lo] + (a[hi] - a[lo]) * (idx - lo)); };
  return { n: a.length, min: a[0], median: q(0.5), p90: q(0.9), max: a[a.length - 1], all: a };
}
function deltas(entry) {
  const t = entry.timing; if (!t) return { phase: entry.phase, timedOut: true };
  return {
    phase: entry.phase,
    warmObserved: t.warm,
    pushLatency: t.pushReceivedAt - entry.sendAt,
    fetchComplete: t.fetchCompleteAt - entry.sendAt,
    tabOpen: t.tabOpenAt - entry.sendAt,
    tabHitServer: entry.tabHitAt ? entry.tabHitAt - entry.sendAt : null,
    bootToPush: t.pushReceivedAt - t.bootAt,
  };
}

async function triggerPush(phase) {
  if (!subscription) throw new Error('no subscription');
  const runId = `r${++runSeq}-${phase}`;
  const entry = { phase, sendAt: null, tabHitAt: null, timing: null, resolve: null };
  const done = new Promise((r) => (entry.resolve = r));
  runs.set(runId, entry);
  entry.sendAt = Date.now();
  try {
    await webpush.sendNotification(subscription, JSON.stringify({ runId, sentAt: entry.sendAt }), { TTL: 60, urgency: 'high' });
    log('push sent', runId);
  } catch (e) {
    log('push send FAILED', runId, e.statusCode || '', String(e.body || e.message).slice(0, 120));
    return { runId, entry, error: String(e.body || e.message) };
  }
  const timeout = new Promise((r) => setTimeout(() => r({ timedOut: true }), RUN_TIMEOUT_MS));
  await Promise.race([done, timeout]);
  return { runId, entry };
}

function buildResults() {
  const all = [...runs.values()].filter((e) => e.phase === 'warm' || e.phase === 'cold').map(deltas);
  const warm = all.filter((r) => r.phase === 'warm' && !r.timedOut);
  const cold = all.filter((r) => r.phase === 'cold' && !r.timedOut);
  const summary = {
    warm: { n: warm.length, pushLatency: stat(warm.map((r) => r.pushLatency)), fetchComplete: stat(warm.map((r) => r.fetchComplete)), tabOpen: stat(warm.map((r) => r.tabOpen)), bootToPush: stat(warm.map((r) => r.bootToPush)) },
    cold: { n: cold.length, pushLatency: stat(cold.map((r) => r.pushLatency)), fetchComplete: stat(cold.map((r) => r.fetchComplete)), tabOpen: stat(cold.map((r) => r.tabOpen)), bootToPush: stat(cold.map((r) => r.bootToPush)) },
  };
  return { generatedAt: new Date().toISOString(), warm, cold, summary };
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  if (req.method === 'OPTIONS') return send(res, 204, '');

  if (u.pathname === '/config') return send(res, 200, { vapidPublicKey: vapid.publicKey, port: PORT });

  if (u.pathname === '/subscribe' && req.method === 'POST') {
    const body = await readBody(req);
    subscription = body.subscription;
    let host = '?'; try { host = new URL(subscription.endpoint).host; } catch {}
    log('subscription received. push-service host:', host);
    return send(res, 200, { ok: true });
  }

  if (u.pathname === '/pending') {
    const runId = u.searchParams.get('runId'); const entry = runs.get(runId);
    return send(res, 200, { runId, url: TAB_URL(runId), sentAt: entry ? entry.sendAt : null });
  }

  if (u.pathname === '/opened') {
    const runId = u.searchParams.get('runId'); const entry = runs.get(runId);
    if (entry && !entry.tabHitAt) entry.tabHitAt = Date.now();
    return send(res, 200, '<!doctype html><meta charset=utf8><title>opened</title>ok', 'text/html');
  }

  if (u.pathname === '/timing' && req.method === 'POST') {
    const t = await readBody(req); const entry = runs.get(t.runId);
    log('timing recv', t.runId, 'warm=' + t.warm);
    if (entry) { entry.timing = t; if (entry.resolve) entry.resolve(t); }
    return send(res, 200, { ok: true });
  }

  // driver-driven: send one measured push
  if (u.pathname === '/trigger' && req.method === 'POST') {
    const phase = u.searchParams.get('phase') || 'warm';
    try {
      const { runId, entry, error } = await triggerPush(phase);
      return send(res, 200, { runId, error: error || null, delta: entry.timing ? deltas(entry) : null, timedOut: !entry.timing });
    } catch (e) { return send(res, 500, { error: String(e.message) }); }
  }

  if (u.pathname === '/results') {
    const r = buildResults();
    fs.writeFileSync(path.join(__dirname, '..', 'results.json'), JSON.stringify(r, null, 2));
    return send(res, 200, r);
  }

  // generic probe collector (used by the Firefox push probe)
  if (u.pathname === '/probe' && req.method === 'POST') {
    const body = await readBody(req);
    log('PROBE', body.kind, JSON.stringify(body.result));
    fs.writeFileSync(path.join(__dirname, '..', `probe-${body.kind || 'unknown'}.json`), JSON.stringify(body, null, 2));
    return send(res, 200, { ok: true });
  }

  if (u.pathname === '/health') return send(res, 200, { ok: true, hasSub: !!subscription, runs: runs.size });

  send(res, 404, { error: 'not found' });
});

server.listen(PORT, () => log(`relay listening on http://localhost:${PORT}  (VAPID pub ${vapid.publicKey.slice(0, 12)}...)`));
