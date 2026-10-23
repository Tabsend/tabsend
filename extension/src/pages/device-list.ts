import type { DeviceRow, RpcRequest } from '../lib/model'

/**
 * The group's device list, with Rename and Remove on each row. Shared by the
 * manage screen and Settings, so the two never drift apart. Before this, the
 * list only lived on the manage screen, which nothing links to once a browser
 * is paired: an uninstalled phone could not be removed from Settings (dogfood
 * 2026-10-15). The pages decide what the buttons do.
 */
export interface DeviceListActions {
  rename: (dev: DeviceRow) => void
  remove: (dev: DeviceRow) => void
}

export type DeviceRowAction = 'rename' | 'remove'

/**
 * Every device can be renamed. Never offer "Remove" for the endpoint this
 * browser runs as: it would orphan this install. Every other one is removable.
 */
export function deviceRowActions(dev: Pick<DeviceRow, 'isSelf'>): DeviceRowAction[] {
  return dev.isSelf ? ['rename'] : ['rename', 'remove']
}

/**
 * What a Remove sends once the user has said yes, or null when they said no.
 * Settings and the manage screen both remove through here: the relay's
 * `removeEndpoint` is the request that also writes the removal into this
 * browser's watch (`identity.removeEndpoint`, X13), and a page that sent anything
 * else would leave a device the relay keeps listing on the history key.
 */
export function removeIfConfirmed(
  dev: Pick<DeviceRow, 'endpointId' | 'label'>,
  confirm: (question: string) => boolean,
): Extract<RpcRequest, { type: 'removeEndpoint' }> | null {
  if (!confirm(`Remove “${dev.label}” from the group?`)) return null
  return { type: 'removeEndpoint', endpointId: dev.endpointId }
}

export function deviceSubline(dev: Pick<DeviceRow, 'isSelf' | 'presenceLabel'>): string {
  return dev.isSelf ? `This browser · ${dev.presenceLabel}` : dev.presenceLabel
}

export function renderDeviceList(
  list: HTMLElement,
  devices: readonly DeviceRow[],
  actions: DeviceListActions,
): void {
  list.replaceChildren()
  for (const dev of devices) {
    const li = document.createElement('li')

    const dot = document.createElement('span')
    dot.className = `dot ${!dev.presenceKnown ? 'unknown' : dev.online ? 'online' : 'offline'}`
    li.append(dot)

    const main = document.createElement('div')
    main.className = 'dev-main'
    const label = document.createElement('div')
    label.className = 'dev-label'
    label.textContent = dev.label
    const sub = document.createElement('div')
    sub.className = 'dev-sub'
    sub.textContent = deviceSubline(dev)
    main.append(label, sub)
    li.append(main)

    const row = document.createElement('div')
    row.className = 'dev-actions'
    for (const action of deviceRowActions(dev)) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'linkish'
      btn.textContent = action === 'rename' ? 'Rename' : 'Remove'
      btn.setAttribute('aria-label', `${btn.textContent} ${dev.label}`)
      btn.addEventListener('click', () => actions[action](dev))
      row.append(btn)
    }
    li.append(row)
    list.append(li)
  }
}

/**
 * The rename dialog. Each page that shows the list carries the same
 * `#rename-dialog` markup (input `#rename-input`, buttons `#rename-ok` and
 * `#rename-cancel`). Resolves to the new name, or null when cancelled.
 */
export function askNewDeviceName(current: string): Promise<string | null> {
  const dialog = document.getElementById('rename-dialog') as HTMLDialogElement
  const input = document.getElementById('rename-input') as HTMLInputElement
  const ok = document.getElementById('rename-ok') as HTMLButtonElement
  const cancel = document.getElementById('rename-cancel') as HTMLButtonElement
  return new Promise((resolve) => {
    input.value = current
    dialog.showModal()
    input.focus()
    input.select()

    const finish = (result: string | null) => {
      ok.removeEventListener('click', onOk)
      cancel.removeEventListener('click', onCancel)
      dialog.removeEventListener('cancel', onCancel)
      input.removeEventListener('keydown', onKeydown)
      dialog.close()
      resolve(result)
    }
    const onOk = () => finish(input.value)
    const onCancel = () => finish(null)
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key === 'Enter') onOk()
    }

    ok.addEventListener('click', onOk)
    cancel.addEventListener('click', onCancel)
    dialog.addEventListener('cancel', onCancel)
    input.addEventListener('keydown', onKeydown)
  })
}
