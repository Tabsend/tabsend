/*
 * Tabsend Firefox fallback (event page + WebSocket + alarms).
 * No Web Push on Firefox, so: hold a WS to the relay for the live fast-path, and
 * use alarms (min ~1 min) to reconnect after the event page is suspended.
 *
 * This probe reports enough for the relay to characterize Firefox's lifecycle:
 *   - heartbeats (WS ping + HTTP) — stop when the event page suspends,
 *   - ws connect/close + alarm events,
 *   - WS message delivery latency ("open a tab" + timing).
 */
const HTTP = 'http://localhost:8081';
const WSURL = 'ws://localhost:8081/ws';
const bootAt = Date.now();
let ws = null;

function post(pathq, body) {
  return fetch(HTTP + pathq, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {});
}

function connect() {
  try {
    ws = new WebSocket(WSURL);
    ws.onopen = () => { post('/event', { kind: 'ws_open_client' }); ws.send(JSON.stringify({ type: 'hello', bootAt })); };
    ws.onclose = () => { post('/event', { kind: 'ws_close_client' }); };
    ws.onerror = () => { post('/event', { kind: 'ws_error_client' }); };
    ws.onmessage = async (ev) => {
      const recvAt = Date.now();
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === 'message') {
        // "open the tab"
        let tabOpenAt = recvAt;
        try { const tab = await browser.tabs.create({ url: `${HTTP}/event?opened=${m.runId}`, active: false }); tabOpenAt = Date.now(); if (tab && tab.id != null) setTimeout(() => browser.tabs.remove(tab.id).catch(() => {}), 600); } catch (e) {}
        const timing = { type: 'timing', runId: m.runId, recvAt, tabOpenAt, viaWS: true, bootAt };
        try { ws.send(JSON.stringify(timing)); } catch (e) {}
        post('/timing', timing); // HTTP backup
      }
    };
  } catch (e) { post('/event', { kind: 'ws_construct_error', detail: String(e) }); }
}

// heartbeats: a WS ping + an HTTP beat every 3s. Both stop the instant Firefox
// suspends the event page — that gap is how we detect suspension.
setInterval(() => {
  if (ws && ws.readyState === WebSocket.OPEN) { try { ws.send(JSON.stringify({ type: 'ping', t: Date.now() })); } catch (e) {} }
  post('/fx-heartbeat', { bootAt });
}, 3000);

// alarms: the ONLY guaranteed wake for a suspended event page. Min period ~1 min.
browser.alarms.create('reconnect', { periodInMinutes: 1 });
browser.alarms.onAlarm.addListener((a) => {
  post('/event', { kind: 'alarm', detail: a.name });
  if (!ws || ws.readyState !== WebSocket.OPEN) { post('/event', { kind: 'reconnect_on_alarm' }); connect(); }
});

post('/event', { kind: 'boot', detail: 'bootAt=' + bootAt });
connect();
