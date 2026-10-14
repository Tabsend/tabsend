/*
 * Tabsend Firefox push probe (MV2 background script).
 * Determines empirically whether a Firefox WebExtension can obtain a Web Push
 * subscription. Reports the full API surface + any subscribe error to the relay
 * AND to console (web-ext streams console to stdout).
 */
(async () => {
  const RELAY = 'http://localhost:8080';
  const result = {
    ua: navigator.userAgent,
    // global constructors
    hasPushManager: typeof PushManager !== 'undefined',
    hasPushSubscription: typeof PushSubscription !== 'undefined',
    hasNotification: typeof Notification !== 'undefined',
    // service worker container on a moz-extension:// background page?
    hasNavigatorServiceWorker: 'serviceWorker' in navigator,
    // is there a ServiceWorkerRegistration on `self` (there isn't on a bg page)?
    hasSelfRegistration: typeof self !== 'undefined' && !!self.registration,
    // WebExtension push API (does not exist in Firefox)?
    hasBrowserPush: (typeof browser !== 'undefined' && !!browser.push) || (typeof chrome !== 'undefined' && !!chrome.push),
    steps: [],
    subscribed: false,
    endpoint: null,
    error: null,
  };

  // Attempt the real path: register a service worker from the extension, then subscribe.
  try {
    if ('serviceWorker' in navigator) {
      result.steps.push('navigator.serviceWorker present; attempting register(sw.js)');
      const reg = await navigator.serviceWorker.register('sw.js');
      result.steps.push('serviceWorker.register RESOLVED');
      if (reg.pushManager) {
        result.steps.push('registration.pushManager present; attempting subscribe');
        const sub = await reg.pushManager.subscribe({ userVisibleOnly: true });
        result.subscribed = true;
        result.endpoint = sub.endpoint;
        result.steps.push('subscribe RESOLVED');
      } else {
        result.steps.push('registration.pushManager MISSING');
      }
    } else {
      result.steps.push('navigator.serviceWorker NOT present on extension background page');
    }
  } catch (e) {
    result.error = (e && e.name ? e.name + ': ' : '') + (e && e.message ? e.message : String(e));
    result.steps.push('EXCEPTION during SW/push path');
  }

  console.log('[fx-probe] RESULT ' + JSON.stringify(result));
  try {
    await fetch(`${RELAY}/probe`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'firefox', result }) });
    console.log('[fx-probe] reported to relay');
  } catch (e) {
    console.log('[fx-probe] relay report failed (relay may be down): ' + e.message);
  }
})();
