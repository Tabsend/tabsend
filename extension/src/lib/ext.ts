/**
 * The WebExtension API namespace, unified across Chrome and Firefox.
 *
 * Chrome (MV3) exposes promise-returning `chrome.*`. Firefox exposes
 * promise-returning `browser.*`; its `chrome.*` alias is CALLBACK-style, so
 * `await chrome.storage.local.get(...)` silently resolves to `undefined` on
 * Firefox. Preferring `browser` when present lets one awaited code path run on
 * both engines. Typed as `typeof chrome` — the API shapes we use
 * (storage / tabs / runtime / alarms / contextMenus / action / windows /
 * commands) match on both, and the divergent bits (offscreen, push) are gated
 * behind the platform flag, never reached on Firefox.
 */
const g = globalThis as { browser?: typeof chrome; chrome?: typeof chrome }
export const ext: typeof chrome = (g.browser ?? g.chrome) as typeof chrome
