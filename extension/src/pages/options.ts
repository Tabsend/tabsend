import type { ClientSettings } from '@tabsend/shared'
import { ext } from '../lib/ext'
import { isRelayDown } from '../lib/health'
import type { ChooserView, RelayChangeResult, RelayProbe, StateView } from '../lib/model'
import { parsePairingInput } from '../lib/pairing'
import { IS_FIREFOX } from '../lib/platform'
import { browserTlsHint, normalizeRelayUrl } from '../lib/relay-url'
import {
  NOT_REGISTERED_ERROR,
  relayDownLine,
  relayProbeCopy,
  relaySwitchCopy,
} from '../lib/strings'
import { wirePairingBox } from './pairing-box'
import { rpcOk } from './rpc-client'

/**
 * Settings surface (ADR-0008 §7): toolbar click mode, per-source primary target
 * (view / change / pin, ADR-0002), confirmation toggles, context-menu
 * visibility, and pairing (mirrors the chooser/first-run pairing box — added so
 * the code stays reachable when quick-send mode removes the chooser popup).
 * Every control writes through the SW so there's one source of truth.
 */

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id)
  if (!el) throw new Error(`missing #${id}`)
  return el as T
}

const savedEl = $('saved')
function flashSaved(): void {
  savedEl.textContent = 'Saved ✓'
  window.setTimeout(() => {
    savedEl.textContent = ''
  }, 1200)
}

async function patch(settings: Partial<ClientSettings>): Promise<void> {
  await rpcOk({ type: 'setSettings', settings })
  flashSaved()
}

function renderSettings(s: ClientSettings): void {
  for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="toolbar"]')) {
    radio.checked = radio.value === s.toolbarClickMode
    radio.addEventListener('change', () => {
      if (radio.checked)
        void patch({ toolbarClickMode: radio.value as ClientSettings['toolbarClickMode'] })
    })
  }

  const bind = (
    id: string,
    key: 'showSuccessToast' | 'showPendingRow' | 'contextMenusVisible' | 'notifyOnReceive',
  ) => {
    const box = $<HTMLInputElement>(id)
    box.checked = s[key]
    box.addEventListener('change', () => void patch({ [key]: box.checked }))
  }
  bind('success-toast', 'showSuccessToast')
  bind('pending-row', 'showPendingRow')
  bind('context-menus', 'contextMenusVisible')
  bind('notify-receive', 'notifyOnReceive')
}

function openFirstRun(): void {
  void ext.tabs.create({ url: ext.runtime.getURL('firstrun.html') })
}

function secondaryButton(label: string, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'btn-secondary'
  btn.textContent = label
  btn.addEventListener('click', onClick)
  return btn
}

/**
 * Repaint the Connection panel from a fresh snapshot. Split from the wiring
 * below (`wireConnection`, run exactly once) because this page's state can
 * change WITHOUT it: setup finishes in another tab, another device removes this
 * browser, a move is completed or abandoned. It used to render once at load and
 * then insist on that picture forever, so a settings tab could sit there
 * offering to move the address of a group it had already left, and answer the
 * click with the internal "Tabsend is not registered yet." (dogfood 2026-08-05).
 */
function paintConnection(state: StateView): void {
  $('current-relay').textContent = state.registered
    ? state.relayUrl
    : state.removedNotice
      ? 'Removed from your group by another device'
      : 'Not set up yet'
  $('move-form').style.display = state.registered ? 'block' : 'none'
  $('setup-line').style.display = state.registered ? 'none' : 'block'
  paintRelayStatus(state)
  paintPendingSwitch(state)
  paintPairing(state)
}

/** Re-read the state and repaint. The page's one route back to the truth. */
async function refreshConnection(): Promise<StateView> {
  const res = await rpcOk<{ ok: true; state: StateView }>({ type: 'getState' })
  paintConnection(res.state)
  return res.state
}

/**
 * Say whether the relay named above is actually answering. This page is where a
 * self-hoster lands when sends stop arriving, and it used to print the address
 * identically whether the relay was healthy or had been down all afternoon.
 */
function paintRelayStatus(state: StateView): void {
  const el = $('relay-status')
  const now = Date.now()
  if (!state.registered || !state.relay || !isRelayDown(state.relay, now)) {
    el.classList.remove('down')
    // Only claim health when a call has actually succeeded; an unknown state
    // says nothing rather than reassuring the user on no evidence.
    el.textContent = state.registered && state.relay?.lastOkAt ? 'Answering' : ''
    return
  }
  const minutes = Math.max(
    0,
    Math.round((now - Date.parse(state.relay.lastOkAt ?? state.relay.since)) / 60000),
  )
  el.classList.add('down')
  el.textContent = relayDownLine(state.relay.relayUrl, minutes)
}

/**
 * An unfinished move to another relay. The two facts it has to carry are where
 * the user was heading and what they still have in the meantime — because the
 * answer to the second one is now "everything", and the whole reason this state
 * is safe to leave sitting there is that finishing it is still their choice.
 */
function paintPendingSwitch(state: StateView): void {
  const box = $('pending-switch')
  const actions = $('pending-actions')
  const pending = state.pendingSwitch
  actions.replaceChildren()
  if (!pending) {
    box.classList.remove('visible')
    return
  }
  box.classList.add('visible')
  $('pending-note').textContent = relaySwitchCopy.pending(pending.relayUrl)
  $('pending-sub').textContent = state.registered
    ? relaySwitchCopy.pendingSafe(state.relayUrl)
    : relaySwitchCopy.pendingUnpaired()
  actions.append(
    secondaryButton('Continue setup', openFirstRun),
    secondaryButton('Cancel this move', () => void cancelPendingSwitch()),
  )
}

async function cancelPendingSwitch(): Promise<void> {
  const res = await rpcOk<{ ok: true; state: StateView }>({ type: 'cancelSwitch' })
  paintConnection(res.state)
  flashSaved()
}

/**
 * Stroke-style icon paths (matches chooser.html's settings-gear convention: 24×24
 * viewBox, currentColor, 2px stroke, set on the `<svg>` markup itself, not here).
 * One per verdict tone, so the result reads at a glance without relying on the
 * border colour alone.
 */
function probeIconNodes(tone: 'same' | 'different' | 'bad' | ''): SVGElement[] {
  const ns = 'http://www.w3.org/2000/svg'
  const shape = (name: 'path' | 'circle', attrs: Record<string, string>): SVGElement => {
    const element = document.createElementNS(ns, name)
    for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, value)
    return element
  }
  switch (tone) {
    case 'same':
      return [shape('path', { d: 'M20 6 9 17l-5-5' })]
    case 'different':
      return [
        shape('path', { d: 'M12 9v4' }),
        shape('path', { d: 'M12 17h.01' }),
        shape('path', {
          d: 'M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z',
        }),
      ]
    case 'bad':
      return [
        shape('circle', { cx: '12', cy: '12', r: '10' }),
        shape('path', { d: 'm15 9-6 6' }),
        shape('path', { d: 'm9 9 6 6' }),
      ]
    case '':
      return []
  }
}

/**
 * The merged relay flow: one address in, one verdict out.
 *
 * This panel used to be two buttons, "Change address…" and "Connect to a
 * different relay…", over a paragraph explaining which was which. That made the
 * user classify their own situation up front and then punished a wrong guess with
 * an error, even though the extension can tell the two apart itself (`probeRelay`:
 * relayId, plus an authenticated call the wrong relay cannot fake). So instead:
 * ask where the relay is, detect, and offer only the action that fits what was
 * found. The verdict renders as a bordered box the width of the input above it
 * (an icon plus one line, action below), not a stray line under the Check
 * button (dogfood 2026-07-29).
 *
 * Nothing here commits on its own. `probeRelay` touches no storage, and each
 * action is a separate, labelled click:
 *   same      → changeRelayUrl (re-verifies, then swaps the URL; devices stay paired)
 *   different → switchToRelay (records the destination and opens setup; the
 *               current pairing is kept until the new relay accepts this browser)
 */

/**
 * The complete pairing link the user pasted, when what they pasted was one.
 * `normalizeRelayUrl` reduces it to a base URL and the input is rewritten with
 * that, so the `#c=` secret exists only in the moment before the check runs.
 * Held here to hand on to setup: losing it meant the next screen asked for the
 * one thing this field had just destroyed (dogfood 2026-08-05).
 */
let pastedPairingLink: string | null = null

function showProbe(tone: 'same' | 'different' | 'bad' | '', text: string): void {
  $('probe-result').className = `visible${tone ? ` ${tone}` : ''}`
  $('probe-icon').replaceChildren(...probeIconNodes(tone))
  $('probe-note').textContent = text
  $('probe-actions').replaceChildren()
}

function addProbeAction(label: string, onClick: () => void): HTMLButtonElement {
  const btn = secondaryButton(label, onClick)
  $('probe-actions').append(btn)
  return btn
}

/**
 * Every call in this panel needs a registration, and the page cannot assume it
 * still has one. Turn that single failure into the recovery it implies: repaint
 * from the truth, then offer setup on the address that was just typed rather
 * than an internal sentence and a dead end.
 */
async function handleUnpaired(err: unknown, relayUrl: string): Promise<boolean> {
  if (!(err instanceof Error) || err.message !== NOT_REGISTERED_ERROR) return false
  await refreshConnection()
  showProbe('bad', relayProbeCopy.notPaired())
  addProbeAction('Set up on this relay', () => void beginSwitch(relayUrl))
  return true
}

/**
 * Record the destination (plus the link, if one was pasted) and open setup. The
 * current pairing is untouched: the browser only leaves its group once the new
 * relay has accepted it, so closing that tab costs nothing.
 */
async function beginSwitch(relayUrl: string): Promise<void> {
  const res = await rpcOk<{ ok: true; state: StateView }>({
    type: 'switchToRelay',
    relayUrl,
    ...(pastedPairingLink ? { pairingLink: pastedPairingLink } : {}),
  })
  paintConnection(res.state)
  openFirstRun()
}

function wireRelayMove(): void {
  const input = $<HTMLInputElement>('new-address')
  const check = $<HTMLButtonElement>('relay-check')

  const clearResult = (): void => {
    $('probe-result').className = ''
    $('probe-icon').replaceChildren()
    $('probe-note').textContent = ''
    $('probe-actions').replaceChildren()
    pastedPairingLink = null
  }

  /** Commit the address swap: same relay, so the group survives untouched. */
  const commitAddress = async (relayUrl: string, btn: HTMLButtonElement): Promise<void> => {
    btn.disabled = true
    try {
      const res = await rpcOk<{ ok: true; relayChange: RelayChangeResult }>({
        type: 'changeRelayUrl',
        relayUrl,
      })
      $('current-relay').textContent = res.relayChange.relayUrl
      showProbe('same', relayProbeCopy.updated(res.relayChange.relayUrl))
      input.value = ''
      flashSaved()
    } catch (err) {
      // Between probe and click the world moved (relay restarted empty, say).
      if (await handleUnpaired(err, relayUrl)) return
      showProbe('bad', err instanceof Error ? err.message : String(err))
    }
  }

  const probe = async (): Promise<void> => {
    const raw = input.value
    let relayUrl: string
    try {
      relayUrl = normalizeRelayUrl(raw)
      // Capture the credentials BEFORE the field is rewritten with the base URL
      // they were carried on.
      pastedPairingLink = parsePairingInput(raw) ? raw.trim() : null
      input.value = relayUrl
    } catch (err) {
      showProbe('bad', err instanceof Error ? err.message : String(err))
      return
    }
    check.disabled = true
    showProbe('', 'Checking…')
    try {
      const res = await rpcOk<{ ok: true; probe: RelayProbe }>({ type: 'probeRelay', relayUrl })
      const p = res.probe
      switch (p.verdict) {
        case 'same': {
          showProbe('same', p.verified ? relayProbeCopy.same() : relayProbeCopy.sameUnverified())
          const btn: HTMLButtonElement = addProbeAction(
            'Switch to this address',
            () => void commitAddress(p.relayUrl, btn),
          )
          break
        }
        case 'different':
          showProbe('different', relayProbeCopy.different())
          addProbeAction('Set up here', () => void beginSwitch(p.relayUrl))
          break
        case 'unreachable':
          showProbe(
            'bad',
            [relayProbeCopy.unreachable(p.relayUrl), browserTlsHint(p.relayUrl)]
              .filter(Boolean)
              .join(' '),
          )
          break
        case 'error':
          showProbe('bad', relayProbeCopy.error(p.detail))
          break
      }
    } catch (err) {
      if (await handleUnpaired(err, relayUrl)) return
      showProbe('bad', err instanceof Error ? err.message : String(err))
    } finally {
      check.disabled = false
    }
  }

  check.addEventListener('click', () => void probe())
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') void probe()
  })
  // A verdict describes the address that was checked, not the one being typed.
  input.addEventListener('input', clearResult)
}

/**
 * Connection-panel wiring, run once. Everything here survives a repaint, so it
 * must never be attached from `paintConnection` — that ran on every refresh and
 * would stack a fresh listener on each one.
 */
function wireConnection(): void {
  $('change-relay').addEventListener('click', openFirstRun)
  wireRelayMove()
}

/**
 * Wired BEFORE any state loads: a failed getState/getChooser must never leave
 * the pair button looking dead — that failure mode is exactly what made pairing
 * unusable everywhere at once (dogfood 2026-07-24).
 */
function wirePairing(): void {
  wirePairingBox({
    trigger: $<HTMLButtonElement>('pair-device'),
    box: $('pairing-box'),
    qr: $('pairing-qr'),
    link: $<HTMLInputElement>('pairing-link'),
    note: $('pairing-note'),
    localOnly: $('pairing-local-only'),
    copy: $<HTMLButtonElement>('copy-link'),
    copyNote: $('copy-note'),
  })
  $('pairing-setup-link').addEventListener('click', () => {
    void ext.tabs.create({ url: ext.runtime.getURL('firstrun.html') })
  })
}

/** Registered browsers get the button; unregistered ones get the "set up first" note. */
function paintPairing(state: StateView): void {
  $('pairing-unregistered').style.display = state.registered ? 'none' : 'block'
  $('pair-device').style.display = state.registered ? 'inline-block' : 'none'
}

function renderPrimary(view: ChooserView): void {
  const select = $<HTMLSelectElement>('primary')
  const pinned = $<HTMLInputElement>('primary-pinned')
  select.replaceChildren()

  if (view.targets.length === 0) {
    const opt = document.createElement('option')
    opt.textContent = 'No other devices yet — pair one first'
    opt.disabled = true
    opt.selected = true
    select.append(opt)
    select.disabled = true
    pinned.disabled = true
    return
  }

  for (const row of view.targets) {
    const opt = document.createElement('option')
    opt.value = row.endpoint.id
    opt.textContent = row.endpoint.label
    if (row.endpoint.id === view.primaryTargetId) opt.selected = true
    select.append(opt)
  }
  pinned.checked = view.primaryPinned

  const apply = (): void => {
    void rpcOk({ type: 'setPrimary', targetEndpointId: select.value, pinned: pinned.checked }).then(
      flashSaved,
    )
  }
  select.addEventListener('change', apply)
  pinned.addEventListener('change', apply)
}

function openShortcutSettings(): void {
  const url = IS_FIREFOX ? 'about:addons' : 'chrome://extensions/shortcuts'
  void ext.tabs.create({ url })
}

async function main(): Promise<void> {
  // Controls that need no loaded state go on first, so the page is never fully
  // inert just because the service worker was slow or asleep.
  $('open-shortcuts').addEventListener('click', openShortcutSettings)
  $('open-history').addEventListener('click', () => {
    void ext.tabs.create({ url: ext.runtime.getURL('history.html') })
  })
  wirePairing()
  wireConnection()

  // Settings pages get left open for days. Setup finishing in another tab, a
  // move being abandoned, or another device removing this browser all happen
  // somewhere else entirely, so re-read on every return to the tab rather than
  // trusting a picture painted at load time.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void refreshConnection().catch(() => undefined)
  })

  try {
    const [stateRes, settingsRes, chooserRes] = await Promise.all([
      rpcOk<{ ok: true; state: StateView }>({ type: 'getState' }),
      rpcOk<{ ok: true; settings: ClientSettings }>({ type: 'getSettings' }),
      rpcOk<{ ok: true; chooser: ChooserView }>({ type: 'getChooser' }),
    ])
    paintConnection(stateRes.state)
    renderSettings(settingsRes.settings)
    renderPrimary(chooserRes.chooser)
  } catch (err) {
    const pageError = $('page-error')
    pageError.textContent = `Couldn't load your settings: ${err instanceof Error ? err.message : String(err)}`
    pageError.classList.add('visible')
  }
}

void main()
