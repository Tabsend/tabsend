import { defaultDeviceName, detectPlatform, resolveBrowserName } from '@tabsend/shared'
import { ext } from '../lib/ext'
import type { DevicesView, PendingSwitch, StateView } from '../lib/model'
import { parsePairingInput } from '../lib/pairing'
import { shouldWarnSoloGroup } from '../lib/policy'
import { relaySwitchCopy, soloGroupCopy } from '../lib/strings'
import {
  askNewDeviceName,
  removeIfConfirmed,
  renderDeviceList as renderDeviceListRows,
} from './device-list'
import { renderDeviceNotices } from './newdevice-banner'
import { wirePairingBox } from './pairing-box'
import { rpcOk } from './rpc-client'

/**
 * First-run onboarding for relay-owned groups:
 *  1. Pair screen — name this browser (always prefilled: its real name when a
 *     signal gives one, else the family as an openly-flagged guess) and paste a
 *     pairing link. The link includes the secret and relay address, so no relay
 *     configuration or group choice is required here.
 *  2. Device screen — create or select the device this browser runs on.
 *  3. Manage screen — the flow ENDS on a real devices surface (list, presence,
 *     rename, remove, pair-another with copy-link), never a dead page.
 */

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id)
  if (!el) throw new Error(`missing #${id}`)
  return el as T
}

const errorEl = $('error')
const browserNameInput = $<HTMLInputElement>('browser-name')
const browserHint = $('browser-hint')
const pairingLinkInput = $<HTMLInputElement>('pairing-link-input')
const deviceNew = $<HTMLInputElement>('device-new')

type Screen = 'name' | 'device' | 'manage'

function showScreen(screen: Screen): void {
  for (const s of ['name', 'device', 'manage'] as Screen[]) {
    $(`screen-${s}`).classList.toggle('hidden', s !== screen)
  }
}

/** True while the browser-name box holds an UNVERIFIED guess (see `main`). */
let nameIsGuess = false

/**
 * Pre-select an unverified guess so one keystroke replaces it. A prefilled name
 * must never be harder to correct than an empty box was to fill.
 */
function selectBrowserName(): void {
  browserNameInput.focus()
  browserNameInput.select()
}

function showError(message: string): void {
  errorEl.textContent = message
  errorEl.classList.add('visible')
}
function clearError(): void {
  errorEl.classList.remove('visible')
}

// --- an unfinished relay move ----------------------------------------------
/**
 * Setup entered from settings, with a relay already chosen and the OLD pairing
 * still live. That combination is new: choosing a different relay used to unpair
 * on the spot, which meant this screen could only ever be reached with nothing
 * left to lose, and backing out of it left the browser stranded (dogfood
 * 2026-08-05). Now the move is only an intention until the new relay accepts
 * this browser, so the screen owes the user three things: where they are
 * heading, what they still have until they finish, and a way to keep it.
 *
 * The pairing link is pre-filled from what they pasted in settings. That field
 * normalizes a link down to a base URL, so it is the only copy left.
 */
function enterPendingSwitch(state: StateView, pending: PendingSwitch): void {
  showScreen('name')
  $('switch-note').classList.add('visible')
  $('switch-target').textContent = relaySwitchCopy.target(pending.relayUrl)

  const keep = $<HTMLButtonElement>('switch-keep')
  if (state.registered) {
    $('switch-cost').textContent = relaySwitchCopy.cost(state.relayUrl)
    keep.textContent = relaySwitchCopy.keep(state.relayUrl)
    keep.style.display = 'inline-block'
    // The browser is already named, and its own name beats a fresh guess.
    if (state.browserName) {
      browserNameInput.value = state.browserName
      nameIsGuess = false
      browserHint.classList.remove('visible')
    }
  } else {
    // No pairing to keep: an older interrupted move, or an unpair in between.
    $('switch-cost').textContent = ''
    keep.style.display = 'none'
  }

  if (pending.pairingLink && !pairingLinkInput.value.trim()) {
    pairingLinkInput.value = pending.pairingLink
    $('switch-link-note').textContent = relaySwitchCopy.reusedLink()
    $('switch-link-note').classList.add('visible')
  }
}

/**
 * Abandon the move and carry on where this browser already was. Nothing was
 * given up to start it, so there is nothing to restore; a reload lands on the
 * manage screen for the relay it never left.
 */
async function keepCurrentRelay(): Promise<void> {
  clearError()
  const keep = $<HTMLButtonElement>('switch-keep')
  keep.disabled = true
  try {
    await rpcOk({ type: 'cancelSwitch' })
    location.reload()
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err))
    keep.disabled = false
  }
}

// --- device (join) selection state -----------------------------------------
let selectedExisting: string | null = null

function renderExistingDevices(names: string[]): void {
  const box = $('existing-devices')
  box.replaceChildren()
  $('device-existing-hint').style.display = names.length > 0 ? 'block' : 'none'
  for (const name of names) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'device-choice'
    btn.textContent = name
    btn.addEventListener('click', () => {
      selectedExisting = name
      deviceNew.value = ''
      for (const el of box.querySelectorAll('.device-choice')) el.classList.remove('selected')
      btn.classList.add('selected')
    })
    box.append(btn)
  }
}

// --- manage devices ---------------------------------------------------------
/** The state this screen was entered with — needed to age the solo notice in. */
let manageState: StateView | null = null

/** The relay/group settings live on the options page; send the user straight there. */
function openConnectionSettings(): void {
  void ext.tabs.create({ url: ext.runtime.getURL('options.html#connection') })
}

function openSettings(): void {
  void ext.tabs.create({ url: ext.runtime.getURL('options.html') })
}

async function refreshManage(): Promise<DevicesView> {
  const res = await rpcOk<{ ok: true; devices: DevicesView }>({ type: 'getDevices' })
  renderDeviceList(res.devices)
  renderSoloNotice(res.devices)
  renderNewDevices(res.devices)
  return res.devices
}

/** "New device: X. Was this you?" (PLANS.md P-10). */
function renderNewDevices(view: DevicesView): void {
  const refreshAfter = (done: Promise<unknown>): void => {
    void done
      .then(() => refreshManage())
      .catch((err) => showError(err instanceof Error ? err.message : String(err)))
  }
  renderDeviceNotices(
    $('new-devices'),
    { review: view.review ?? [], vanished: view.vanished ?? [], newDevices: view.newDevices ?? [] },
    {
      confirm: (n) => refreshAfter(rpcOk({ type: 'confirmNewDevice', endpointId: n.id })),
      remove: (n) => void confirmRemove(n.id, n.label),
      confirmReview: () => refreshAfter(rpcOk({ type: 'confirmReview' })),
      dismissVanished: (n) => refreshAfter(rpcOk({ type: 'dismissVanished', endpointId: n.id })),
    },
  )
}

/**
 * The popup's "Remove it" lands here as `#remove=<id>`, because a popup cannot
 * hold a confirmation open. Asked once, then the hash is dropped so a reload
 * does not ask again.
 */
async function removeFromHash(view: DevicesView): Promise<void> {
  const match = /^#remove=(.+)$/.exec(location.hash)
  if (!match?.[1]) return
  history.replaceState(null, '', location.pathname)
  const id = decodeURIComponent(match[1])
  const dev = view.devices.find((d) => d.endpointId === id && !d.isSelf)
  if (dev) await confirmRemove(dev.endpointId, dev.label)
}

/**
 * "You are the only browser here" — the one thing the manage screen never said,
 * even though it is exactly what a half-migrated relay looks like from inside
 * (dogfood 2026-07-29). Suppressed while a group is new so a normal
 * first-pair run never sees it. Styled and worded like the options.html
 * relay-probe verdict (dogfood 2026-07-29 redesign): one finding, one action.
 */
function renderSoloNotice(view: DevicesView): void {
  const box = $('solo-notice')
  const warn = shouldWarnSoloGroup({
    deviceCount: view.devices.length,
    ...(manageState?.registeredAt ? { registeredAt: manageState.registeredAt } : {}),
    justRegistered: false,
  })
  box.classList.toggle('visible', warn)
  if (!warn) return
  $('solo-body').textContent = soloGroupCopy.body(manageState?.relayUrl ?? '')
}

function renderDeviceList(view: DevicesView): void {
  renderDeviceListRows($('device-list'), view.devices, {
    rename: (dev) => void promptRename(dev.endpointId, dev.label),
    remove: (dev) => void confirmRemove(dev.endpointId, dev.label),
  })
}

async function promptRename(endpointId: string, current: string): Promise<void> {
  const next = await askNewDeviceName(current)
  if (next === null || next.trim() === '' || next.trim() === current) return
  clearError()
  try {
    await rpcOk({ type: 'renameEndpoint', endpointId, label: next.trim() })
    await refreshManage()
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err))
  }
}

async function confirmRemove(endpointId: string, label: string): Promise<void> {
  const request = removeIfConfirmed({ endpointId, label }, (question) => window.confirm(question))
  if (!request) return
  clearError()
  try {
    await rpcOk(request)
    await refreshManage()
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err))
  }
}

function noteRename(message: string): void {
  const note = $('rename-note')
  note.textContent = message
  note.style.display = 'block'
}

async function enterManage(state: StateView): Promise<void> {
  manageState = state
  $('self-label-line').textContent = state.selfLabel ? `You are “${state.selfLabel}”.` : ''
  $('manage-relay').textContent = state.relayUrl
  showScreen('manage')
  await removeFromHash(await refreshManage())
}

async function joinGroup(): Promise<void> {
  clearError()
  const browserName = browserNameInput.value.trim()
  const parsed = parsePairingInput(pairingLinkInput.value)
  if (!browserName) return showError('Give this browser a name first.')
  if (!parsed) {
    return showError(
      'Paste the complete pairing link. It identifies and securely connects to the relay.',
    )
  }
  const btn = $<HTMLButtonElement>('join')
  btn.disabled = true
  try {
    await rpcOk<{ ok: true; state: StateView }>({
      type: 'joinGroup',
      relayUrl: parsed.relayUrl,
      code: parsed.code,
      browserName,
    })
    // Now in the group → fetch existing devices for the CREATE-or-SELECT step.
    const dv = await rpcOk<{ ok: true; devices: DevicesView }>({ type: 'getDevices' })
    renderExistingDevices(dv.devices.existingDeviceNames)
    selectedExisting = null
    deviceNew.value = defaultDeviceName(detectPlatform())
    showScreen('device')
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err))
    btn.disabled = false
  }
}

async function confirmDevice(): Promise<void> {
  clearError()
  const deviceName = deviceNew.value.trim() || selectedExisting || ''
  if (!deviceName) return showError('Pick a device or type a new one.')
  const btn = $<HTMLButtonElement>('device-confirm')
  btn.disabled = true
  const wanted = browserNameInput.value.trim()
  try {
    const res = await rpcOk<{ ok: true; state: StateView }>({ type: 'setDevice', deviceName })
    // The SW de-duplicates against the group at this point; if it had to, say so
    // plainly rather than letting the user discover a name they didn't choose.
    if (res.state.browserName && res.state.browserName !== wanted) {
      noteRename(
        `There was already a “${wanted}” on “${deviceName}”, so this one is “${res.state.browserName}”. Rename it below any time.`,
      )
    }
    await enterManage(res.state)
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err))
    btn.disabled = false
  }
}

// --- boot -------------------------------------------------------------------
/**
 * Every control is wired BEFORE the first RPC. Wiring last (as this used to)
 * meant one slow or failing SW call left the buttons — "Pair another device"
 * above all — silently doing nothing (dogfood 2026-07-24).
 */
function wireControls(): void {
  $('settings-gear').addEventListener('click', openSettings)
  $('open-connection').addEventListener('click', openConnectionSettings)
  $('solo-connection').addEventListener('click', openConnectionSettings)
  $('switch-keep').addEventListener('click', () => void keepCurrentRelay())
  $('join').addEventListener('click', () => void joinGroup())
  $('device-confirm').addEventListener('click', () => void confirmDevice())
  wirePairingBox({
    trigger: $<HTMLButtonElement>('pair-another'),
    box: $('pairing-box'),
    qr: $('pairing-qr'),
    link: $<HTMLInputElement>('pairing-link'),
    note: $('pairing-note'),
    localOnly: $('pairing-local-only'),
    copy: $<HTMLButtonElement>('copy-link'),
    copyNote: $('copy-note'),
  })
}

async function main(): Promise<void> {
  wireControls()

  // Browser-name default: ALWAYS prefill. A browser that names itself gets its
  // real name; one that hides behind Chrome (Dia, Comet, Arc) gets "Chrome" with
  // the hint saying so, pre-selected so one keystroke replaces it. Never an empty
  // box. [dogfood pass-2 #1]
  void resolveBrowserName().then((suggestion) => {
    // The user may have started typing while the probes resolved — never clobber.
    if (browserNameInput.value.trim()) return
    browserNameInput.value = suggestion.value
    nameIsGuess = !suggestion.confident
    if (nameIsGuess) {
      browserHint.textContent =
        'Some browsers (Dia, Comet, Arc) look exactly like Chrome from in here, so this is our best guess. Keep it, or type the real name.'
      browserHint.classList.add('visible')
      if (!$('screen-name').classList.contains('hidden')) selectBrowserName()
    }
  })
  try {
    const res = await rpcOk<{ ok: true; state: StateView }>({ type: 'getState' })

    // A move in flight outranks everything below: a registered browser that is
    // half-way to another relay must land on the screen that finishes (or
    // abandons) the move, not on the manage screen for the relay it is leaving.
    if (res.state.pendingSwitch) {
      enterPendingSwitch(res.state, res.state.pendingSwitch)
    } else if (res.state.registered) {
      // Already set up: a join that never finished the device step lands back on
      // it; otherwise straight to manage.
      if (!res.state.deviceName) {
        const dv = await rpcOk<{ ok: true; devices: DevicesView }>({ type: 'getDevices' })
        renderExistingDevices(dv.devices.existingDeviceNames)
        deviceNew.value = defaultDeviceName(detectPlatform())
        showScreen('device')
      } else {
        await enterManage(res.state)
      }
    } else {
      showScreen('name')
      $('hosted-offer').classList.add('visible')
      if (res.state.removedNotice) {
        showError(
          'This browser was removed from its group by another device. Set it up again below.',
        )
      }
    }
  } catch (err) {
    // Land on the pair screen rather than a blank page — pairing is the one
    // thing still worth offering when we can't read our own state.
    showScreen('name')
    showError(err instanceof Error ? err.message : String(err))
  } finally {
    // Explicit state-applied flag for end-to-end setup assertions.
    document.body.dataset.ready = '1'
  }
}

void main()
