import type { PairingView } from '../lib/model'
import { qrElement } from '../lib/qr'
import { pairingLocalOnlyLine } from '../lib/strings'
import { rpcOk } from './rpc-client'

/**
 * The pairing box, shared by all three surfaces that can show a link: the
 * toolbar chooser, the settings page, and first-run's manage screen.
 *
 * It used to be three copies of `void showPairing()` with no catch anywhere, so
 * a failed mint — relay down, token no longer in the group — produced NOTHING:
 * no QR, no code, no message, just a button that appeared dead on every surface
 * at once (dogfood 2026-07-24). The rule now is that a click always changes the
 * screen: the box opens on the click, shows a pending line while the relay is
 * asked, and ends on either a link or a reason plus a retry.
 */

export interface PairingBoxEls {
  /** The button that opens the box — disabled while a mint is in flight. */
  trigger: HTMLButtonElement
  box: HTMLElement
  qr: HTMLElement
  link: HTMLInputElement
  /** Pending/failure line; holds the retry button when a mint fails. */
  note: HTMLElement
  /**
   * Warning shown beside the QR when the link's relay is loopback — the link is
   * real but unusable off this machine, and only this surface can say so before
   * the user walks over to the phone.
   */
  localOnly: HTMLElement
  copy: HTMLButtonElement
  copyNote: HTMLElement
}

/** Wire the trigger. Safe to call before any state has loaded — it awaits nothing. */
export function wirePairingBox(els: PairingBoxEls): void {
  els.trigger.addEventListener('click', () => void openPairingBox(els))
}

async function openPairingBox(els: PairingBoxEls): Promise<void> {
  // Open FIRST, so the click visibly does something even on a slow relay.
  els.box.classList.add('visible')
  els.box.classList.remove('failed')
  els.box.classList.add('pending')
  els.note.replaceChildren('Getting a setup link…')
  els.localOnly.classList.remove('visible')
  els.trigger.disabled = true
  els.copyNote.textContent = ''

  try {
    const res = await rpcOk<{ ok: true; pairing: PairingView }>({ type: 'mintPairing' })
    renderPairing(els, res.pairing)
  } catch (err) {
    // The SW hands back user-ready copy (see rpc.ts `mintPairing`); anything
    // else that lands here is a page<->SW failure, which is its own message.
    renderFailure(els, err instanceof Error ? err.message : String(err))
  } finally {
    els.trigger.disabled = false
  }
}

function renderPairing(els: PairingBoxEls, pairing: PairingView): void {
  // The copyable link goes up FIRST and the QR is allowed to fail behind it: the
  // two are separate credentials for separate devices, and losing the drawing
  // must not cost the user the link as well.
  els.link.value = pairing.link
  els.note.replaceChildren()
  // The QR encodes the complete pairing link, including the relay address and
  // optional TLS pin, so the joining device receives one indivisible credential.
  // `qrLink` is the native presentation; falling back to the copy link covers a
  // response minted before that field existed — a background worker one version
  // behind these pages, which Chromium will happily keep running against a
  // freshly rebuilt unpacked extension. Handing `undefined` to the QR encoder
  // instead crashed the whole box with a raw property-access message and no link
  // (dogfood 2026-08-05).
  els.qr.replaceChildren(qrElement(pairing.qrLink ?? pairing.link))
  els.box.classList.remove('pending', 'failed')

  // A loopback link isn't an error — the mint succeeded — so it sits next to the
  // QR rather than replacing it: the user may well be pairing a second browser
  // on this same machine, which still works.
  const notice = pairing.localOnly ? pairingLocalOnlyLine(pairing.relayUrl) : pairing.routeNote
  els.localOnly.textContent = notice ?? ''
  els.localOnly.classList.toggle('visible', notice !== undefined)

  els.copy.onclick = () => {
    void navigator.clipboard.writeText(pairing.link).then(
      () => {
        els.copyNote.textContent = 'Copied ✓'
      },
      () => {
        els.link.focus()
        els.link.select()
        els.copyNote.textContent = 'Copy failed — the link is selected'
      },
    )
  }
}

function renderFailure(els: PairingBoxEls, message: string): void {
  els.box.classList.remove('pending')
  els.box.classList.add('failed')
  els.localOnly.classList.remove('visible')

  const retry = document.createElement('button')
  retry.type = 'button'
  retry.className = 'linkish'
  retry.textContent = 'Try again'
  retry.addEventListener('click', () => void openPairingBox(els))

  // The common cause (relay not up yet) is transient, so keep the retry right
  // next to the reason rather than making the user hunt for the trigger again.
  els.note.replaceChildren(message, document.createElement('br'), retry)
}
