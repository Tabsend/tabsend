/**
 * Tabsend Spike A — throwaway MV3 service worker.
 *
 * On boot: fetch VAPID key from relay, subscribe to push (userVisibleOnly:false,
 * no user prompt in extensions), report the subscription.
 * On push: record timestamps, pull the pending "message", open a tab, report timing.
 *
 * `bootAt` is set at top-level module-eval, so (pushReceivedAt - bootAt) is tiny on a
 * cold wake (SW just booted to handle the push) and large when the SW was already warm.
 */

const RELAY = 'http://localhost:8080';
const bootAt = Date.now();           // set once per SW instance (per (re)start)
console.log('[spike] SW boot at', bootAt);

function urlB64ToUint8Array(base64) {
  const pad = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + pad).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

function bufToB64Url(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function waitForActiveWorker() {
  // pushManager.subscribe() throws "no active Service Worker" if called before the
  // SW has activated. Wait for registration.active before subscribing.
  for (let i = 0; i < 100; i++) {
    if (self.registration && self.registration.active) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !!(self.registration && self.registration.active);
}

async function subscribeWithRetry(appServerKey) {
  // subscribe() can also throw transiently (e.g. AbortError) while GCM/FCM checks in;
  // retry with backoff — the real product must do this too. ~20 tries.
  let last = null;
  for (let i = 0; i < 20; i++) {
    try {
      await waitForActiveWorker();
      let sub = await self.registration.pushManager.getSubscription();
      if (!sub) {
        sub = await self.registration.pushManager.subscribe({
          userVisibleOnly: false,        // Chrome 121+ allows this in extensions — no notification prompt
          applicationServerKey: appServerKey,
        });
      }
      console.log(`[spike] subscribed on attempt ${i}:`, sub.endpoint);
      return sub;
    } catch (e) {
      last = e;
      console.log(`[spike] subscribe attempt ${i} failed: ${e && e.name}: ${e && e.message}`);
      await new Promise((r) => setTimeout(r, i < 5 ? 2000 : 5000));
    }
  }
  throw last || new Error('subscribe exhausted retries');
}

async function ensureSubscribed() {
  try {
    const cfg = await (await fetch(`${RELAY}/config`)).json();
    const appServerKey = urlB64ToUint8Array(cfg.vapidPublicKey);
    const sub = await subscribeWithRetry(appServerKey);
    const body = {
      subscription: {
        transport: 'webpush',
        endpoint: sub.endpoint,
        keys: {
          p256dh: bufToB64Url(sub.getKey('p256dh')),
          auth: bufToB64Url(sub.getKey('auth')),
        },
      },
    };
    await fetch(`${RELAY}/subscribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    console.log('[spike] subscription reported to relay');
  } catch (e) {
    console.error('[spike] SUBSCRIBE FAILED:', e && e.message, e);
  }
}

// Single guarded subscribe pass (dedupes the activate + top-level triggers).
let subStarted = false;
function kickSubscribe() { if (subStarted) return Promise.resolve(); subStarted = true; return ensureSubscribed(); }

self.addEventListener('install', (e) => { self.skipWaiting(); });
// Subscribe after activation, when registration.active is set. waitUntil keeps the
// SW alive through the retry backoff.
self.addEventListener('activate', (e) => { e.waitUntil((async () => { await self.clients.claim(); await kickSubscribe(); })()); });
// Fallback for restarts where 'activate' doesn't fire (waitForActiveWorker guards timing).
kickSubscribe();

self.addEventListener('push', (event) => {
  const pushReceivedAt = Date.now();
  event.waitUntil((async () => {
    let runId = null;
    try {
      const data = event.data ? event.data.json() : {};
      runId = data.runId;
    } catch (e) {
      console.error('[spike] bad push payload', e);
      return;
    }
    const warm = (pushReceivedAt - bootAt) > 1500;   // >1.5s since boot => SW was already alive

    // pull the pending "message" (models GET /messages?pending=1)
    const fetchStartAt = Date.now();
    let url = `${RELAY}/opened?runId=${runId}`;
    try {
      const pend = await (await fetch(`${RELAY}/pending?runId=${runId}`)).json();
      if (pend && pend.url) url = pend.url;
    } catch (e) {
      console.error('[spike] pending fetch failed', e);
    }
    const fetchCompleteAt = Date.now();

    // "open the tab" — real background tab; the /opened load gives the relay an
    // independent tab-open timestamp. Close it right after to avoid clutter.
    let tabOpenAt = fetchCompleteAt;
    try {
      const tab = await chrome.tabs.create({ url, active: false });
      tabOpenAt = Date.now();
      if (tab && tab.id != null) {
        setTimeout(() => chrome.tabs.remove(tab.id).catch(() => {}), 800);
      }
    } catch (e) {
      console.error('[spike] tabs.create failed', e);
    }

    // report timing (models ack + telemetry)
    try {
      await fetch(`${RELAY}/timing`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          runId, bootAt, warm,
          pushReceivedAt, fetchStartAt, fetchCompleteAt, tabOpenAt,
        }),
      });
    } catch (e) {
      console.error('[spike] timing report failed', e);
    }
    console.log(`[spike] push ${runId} warm=${warm} push=${pushReceivedAt} fetch=${fetchCompleteAt} tab=${tabOpenAt}`);
  })());
});
