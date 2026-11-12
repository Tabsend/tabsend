import { goodbyeUrl } from '@tabsend/shared'
import { getConfig, mintLeaveToken } from '../lib/api'
import { ext } from '../lib/ext'
import { getRegistration, REGISTRATION_KEY, setRegistration } from '../lib/storage'

/**
 * The page the browser opens after Tabsend is uninstalled [PLANS P-31 item 1].
 *
 * Uninstalling wipes this extension's storage, so the device it was is dead for certain,
 * yet the rest of the group would keep sending to it (owner, 2026-11-07: "Dia" stayed
 * "Waiting" for days after a reinstall). So, once paired, the browser is told to open the
 * relay's `/goodbye` page on uninstall, with this device's leave token in the fragment;
 * that page removes the device, and the other devices see it leave.
 *
 * Kept in step with the registration: set once paired, moved when the relay address
 * changes, cleared when there is no pairing (Unpair, removal). A relay without the page
 * (`goodbyePage` absent from `/v1/config`) gets no address, so an uninstall there opens
 * nothing rather than a page that cannot work. A relay out of reach is tried again at
 * the next start.
 *
 * Runs one at a time: two overlapping runs could each mint a token, and the one stored
 * must be the one the relay still holds.
 */
let queue: Promise<void> = Promise.resolve()

export function syncUninstallPage(): Promise<void> {
  const run = queue.then(syncOnce)
  queue = run.catch(() => undefined)
  return run
}

async function setUninstallUrl(url: string): Promise<void> {
  try {
    await ext.runtime.setUninstallURL(url)
  } catch {
    // An address the browser refuses: there is no page to show, which is the
    // pre-P-31 behaviour. Nothing else depends on it.
  }
}

async function syncOnce(): Promise<void> {
  const reg = await getRegistration()
  if (!reg) {
    await setUninstallUrl('')
    return
  }
  if (reg.leaveToken) {
    await setUninstallUrl(goodbyeUrl(reg.relayUrl, reg.leaveToken) ?? '')
    return
  }
  // A new pairing: whatever address an earlier one set names a device that is gone.
  await setUninstallUrl('')
  let leaveToken: string
  try {
    const config = await getConfig(reg.relayUrl)
    if (!config.goodbyePage) return
    leaveToken = (await mintLeaveToken(reg.relayUrl, reg.deviceToken, reg.endpointId)).leaveToken
  } catch {
    return // Out of reach, or refused: tried again at the next start.
  }
  // The pairing may have changed while we asked; a token for another one is no use.
  const now = await getRegistration()
  if (!now || now.endpointId !== reg.endpointId || now.deviceToken !== reg.deviceToken) return
  await setRegistration({ ...now, leaveToken })
  await setUninstallUrl(goodbyeUrl(now.relayUrl, leaveToken) ?? '')
}

/**
 * Follow the registration: every pairing, relay move, Unpair and removal writes or
 * clears it, so watching it covers them all without each path having to remember.
 */
export function registerUninstallPageSync(): void {
  ext.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && REGISTRATION_KEY in changes) void syncUninstallPage()
  })
}
