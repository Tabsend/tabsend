// Minimal SW the Firefox probe attempts to register, to reach registration.pushManager.
self.addEventListener('push', (e) => { console.log('[fx-probe-sw] push', e.data && e.data.text()); });
