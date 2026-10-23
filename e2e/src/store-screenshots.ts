import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import type { CreatePairingResponse, Endpoint, RegisterResponse } from '@tabsend/shared'
import type { Page } from 'playwright'
import { extUrl, launchProfile, type Profile, until } from './browser'
import { REPO_ROOT, sleep, startRelay } from './relay'

// libsodium-wrappers' ESM entry is broken (vitest.config.ts aliases it); this runs outside
// vitest, so take the CJS build directly.
const sodium = createRequire(import.meta.url)(
  'libsodium-wrappers',
) as typeof import('libsodium-wrappers')

interface Sender {
  endpointId: string
  token: string
  pubkey: string
  privkey: string
}

/**
 * Store screenshots from a real, paired extension (docs/STORE_LISTING.md, "Screenshots").
 *
 *   pnpm --filter @tabsend/extension build
 *   cd e2e && ../server/node_modules/.bin/tsx src/store-screenshots.ts [out-dir]
 *
 * Boots a throwaway relay, pairs the built extension in a fresh Chromium profile, adds three
 * more devices over the API (the way a phone or another browser joins), sends tabs both
 * ways, and saves 1280 × 800 PNGs. Nothing here is drawn by hand: every pixel of extension
 * UI is the extension's own page. The toolbar pop-up cannot be opened headless, so its page
 * is rendered at pop-up size and laid over the web page it was opened on.
 */

const OUT = resolve(process.argv[2] ?? join(REPO_ROOT, 'docs', 'store', 'chrome'))
const W = 1280
const H = 800

// Pages the shots are taken over. Real public pages, so the pop-up sits on something real.
const PAGES = [
  'https://en.wikipedia.org/wiki/Bread',
  'https://www.nasa.gov/',
  'https://developer.mozilla.org/en-US/docs/Web/HTML',
] as const

interface ChromeLike {
  runtime: { sendMessage(msg: unknown): Promise<unknown> }
  storage: { local: { get(key: string): Promise<Record<string, unknown>> } }
}
declare const chrome: ChromeLike

async function api<T>(method: string, url: string, token?: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {}
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (token) headers.authorization = `Bearer ${token}`
  const res = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status}: ${text}`)
  return (text ? JSON.parse(text) : undefined) as T
}

async function mintPairingLink(relayUrl: string, token: string): Promise<string> {
  return (await api<CreatePairingResponse>('POST', `${relayUrl}/v1/pairing`, token)).link
}

async function targetPubkey(relayUrl: string, token: string, id: string): Promise<string> {
  const list = await api<Endpoint[]>('GET', `${relayUrl}/v1/endpoints`, token)
  const target = list.find((e) => String(e.id) === id)
  if (!target) throw new Error(`${id} is not in the group`)
  return target.e2ePubkey
}

/** Seal a tab to the target the way the apps do (as e2e/src/sender.ts, plus a title). */
async function sendSealed(
  relayUrl: string,
  sender: Sender,
  targetId: string,
  targetKey: string,
  url: string,
  title: string,
): Promise<void> {
  await sodium.ready
  const keyId = (k: string) => createHash('sha256').update(k).digest('base64url')
  const payload = JSON.stringify({ url, title, sentAt: new Date().toISOString() })
  const nonce = sodium.randombytes_buf(sodium.crypto_box_NONCEBYTES)
  const b64 = sodium.base64_variants.ORIGINAL
  const ciphertext = sodium.crypto_box_easy(
    sodium.from_string(payload),
    nonce,
    sodium.from_base64(targetKey, b64),
    sodium.from_base64(sender.privkey, b64),
  )
  await api('POST', `${relayUrl}/v1/messages`, sender.token, {
    items: [
      {
        id: randomUUID(),
        targetEndpointId: targetId,
        envelope: {
          alg: 'x25519-xsalsa20-poly1305/box',
          senderKeyId: keyId(sender.pubkey),
          targetKeyId: keyId(targetKey),
          nonce: sodium.to_base64(nonce, b64),
          ciphertext: sodium.to_base64(ciphertext, b64),
        },
      },
    ],
  })
}

/** Join the group as another device, the way a phone or a second browser would. */
async function joinAs(
  relayUrl: string,
  link: string,
  device: {
    label: string
    deviceName: string
    kind: 'extension' | 'mobile'
    browser: string | null
    platform: string
  },
): Promise<Sender> {
  const pairingCode = new URLSearchParams(new URL(link).hash.slice(1)).get('c')
  await sodium.ready
  const kp = sodium.crypto_box_keypair()
  const pubkey = sodium.to_base64(kp.publicKey, sodium.base64_variants.ORIGINAL)
  const privkey = sodium.to_base64(kp.privateKey, sodium.base64_variants.ORIGINAL)
  const res = await api<RegisterResponse>('POST', `${relayUrl}/v1/endpoints/register`, undefined, {
    ...device,
    pushSubscription: { transport: 'none' },
    e2ePubkey: pubkey,
    pairingCode,
  })
  return { endpointId: String(res.endpointId), token: String(res.deviceToken), pubkey, privkey }
}

async function open(profile: Profile, url: string, size = { width: W, height: H }): Promise<Page> {
  const page = await profile.context.newPage()
  await page.setViewportSize(size)
  await page.goto(url)
  return page
}

async function save(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(OUT, name) })
  process.stdout.write(`saved ${join(OUT, name)}\n`)
}

/** Lay the pop-up's own rendering over the page it was opened on, top right, as Chrome shows it. */
async function composite(
  profile: Profile,
  background: Buffer,
  popup: Buffer,
  name: string,
): Promise<void> {
  const page = await profile.context.newPage()
  await page.setViewportSize({ width: W, height: H })
  const b64 = (b: Buffer) => `data:image/png;base64,${b.toString('base64')}`
  await page.setContent(`<!doctype html><body style="margin:0;width:${W}px;height:${H}px;overflow:hidden;position:relative">
    <img src="${b64(background)}" style="position:absolute;inset:0">
    <img src="${b64(popup)}" style="position:absolute;top:8px;right:16px;border-radius:8px;
      box-shadow:0 0 0 1px rgba(0,0,0,.12),0 8px 28px rgba(0,0,0,.28)">
  </body>`)
  await page.waitForFunction(() => [...document.images].every((i) => i.complete))
  await save(page, name)
  await page.close()
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true })
  const relay = await startRelay()
  const profile = await launchProfile()
  try {
    // 1. First run, before anything is typed: the shot of the first-run page.
    const firstrun = await open(profile, extUrl(profile, 'firstrun.html'))
    await firstrun.waitForSelector('body[data-ready="1"]')
    await firstrun.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await save(firstrun, '4-first-run.png')

    // Pair this browser as the group's first device.
    await firstrun.fill('#browser-name', 'Chrome')
    await firstrun.fill('#pairing-link-input', relay.firstRunPairingLink)
    await firstrun.click('#join')
    await firstrun.waitForSelector('#screen-device:not(.hidden)')
    await firstrun.fill('#device-new', 'MacBook Air')
    await firstrun.click('#device-confirm')
    await firstrun.waitForSelector('#screen-manage:not(.hidden)')
    const reg = (await firstrun.evaluate(() => chrome.storage.local.get('registration')))
      .registration as { deviceToken: string; endpointId: string }

    // Alone in the group, this browser mints the group-history key (the lowest id mints
    // it, and the devices added below never run the code that would). Without it the
    // history page shows only what arrived here.
    await until(
      async () => {
        await firstrun.evaluate(() => chrome.runtime.sendMessage({ type: 'pollNow' }))
        const bag = await firstrun.evaluate(() => chrome.storage.local.get('groupKeys'))
        return Array.isArray(bag.groupKeys) && bag.groupKeys.length > 0
      },
      { what: 'the group-history key', timeoutMs: 30_000, intervalMs: 1000 },
    )

    // 2. Three more devices join with links this browser minted.
    const others: Sender[] = []
    for (const device of [
      {
        label: 'Pixel 8',
        deviceName: 'Pixel 8',
        kind: 'mobile',
        browser: null,
        platform: 'android',
      },
      {
        label: 'Firefox · Work laptop',
        deviceName: 'Work laptop',
        kind: 'extension',
        browser: 'firefox',
        platform: 'windows',
      },
      { label: 'iPhone', deviceName: 'iPhone', kind: 'mobile', browser: null, platform: 'ios' },
    ] as const) {
      others.push(
        await joinAs(relay.url, await mintPairingLink(relay.url, reg.deviceToken), device),
      )
    }

    // This browser is told about each one; say they are ours.
    await firstrun.reload()
    await firstrun.waitForSelector('#screen-manage:not(.hidden)')
    await firstrun.waitForSelector('#new-devices .new-device')
    for (;;) {
      const button = firstrun
        .locator('#new-devices .new-device button:text("Yes, it\'s mine")')
        .first()
      if ((await button.count()) === 0) break
      await button.click()
      await sleep(500)
    }
    await firstrun.waitForSelector('#new-devices.hidden', { state: 'attached' })

    // 3. Tabs arrive from the phones (sealed exactly as the apps seal them).
    const [pixel, , iphone] = others
    if (!pixel || !iphone) throw new Error('the phones did not join')
    const myKey = await targetPubkey(relay.url, pixel.token, reg.endpointId)
    await sendSealed(
      relay.url,
      pixel,
      reg.endpointId,
      myKey,
      'https://en.wikipedia.org/wiki/Sourdough',
      'Sourdough - Wikipedia',
    )
    await sendSealed(
      relay.url,
      iphone,
      reg.endpointId,
      myKey,
      'https://www.nasa.gov/missions/',
      'Missions - NASA',
    )
    await firstrun.evaluate(() => chrome.runtime.sendMessage({ type: 'pollNow' }))
    await until(() => profile.context.pages().some((p) => p.url().includes('nasa.gov/missions')), {
      what: 'the received tabs to open',
      timeoutMs: 30_000,
    })
    for (const p of profile.context.pages())
      if (!p.url().startsWith('chrome-extension')) await p.close()

    // 4. This browser sends tabs to its devices, from the pop-up.
    for (const [i, target] of [
      [0, 'Pixel 8'],
      [1, 'iPhone'],
      [2, 'Firefox · Work laptop'],
    ] as const) {
      const site = await open(profile, PAGES[i])
      await site.bringToFront()
      const chooser = await open(profile, extUrl(profile, 'chooser.html'), {
        width: 360,
        height: 600,
      })
      await chooser.waitForSelector('#targets:not(.hidden) button')
      await chooser.click(`#targets button:has-text("${target}")`)
      await chooser.waitForSelector('#confirm.visible', { timeout: 10_000 })
      await chooser.close()
      await site.close()
    }
    // The other devices pick their tabs up, so the history shows them delivered.
    await sleep(1000)
    for (const other of others) {
      const pending = await api<{ id: string }[]>(
        'GET',
        `${relay.url}/v1/messages?pending=1`,
        other.token,
      )
      for (const m of pending)
        await api('POST', `${relay.url}/v1/messages/${m.id}/ack`, other.token)
    }
    await firstrun.evaluate(() => chrome.runtime.sendMessage({ type: 'pollNow' }))
    await sleep(1000)

    // 5. The pop-up, open over a page.
    const site = await open(profile, PAGES[0])
    await site.waitForLoadState('networkidle').catch(() => undefined)
    const background = await site.screenshot()
    const chooser = await open(profile, extUrl(profile, 'chooser.html'), {
      width: 360,
      height: 600,
    })
    await chooser.waitForSelector('#targets:not(.hidden) button')
    await sleep(500)
    const height = await chooser.evaluate(() => document.documentElement.scrollHeight)
    await chooser.setViewportSize({ width: 360, height: Math.min(height, 600) })
    const popup = await chooser.screenshot()
    await composite(profile, background, popup, '1-chooser.png')
    await chooser.close()
    await site.close()

    // 6. The history page.
    const history = await open(profile, extUrl(profile, 'history.html'))
    await history.waitForSelector('.tab')
    await sleep(500)
    await save(history, '2-history.png')

    // 7. Settings, with the group's devices.
    const options = await open(profile, extUrl(profile, 'options.html'))
    await options.waitForSelector('#devices-block:visible')
    await options.evaluate(() => document.getElementById('sec-devices')?.scrollIntoView())
    await options.evaluate(() => window.scrollBy(0, -24))
    await sleep(500)
    await save(options, '3-settings.png')
  } finally {
    await profile.dispose()
    await relay.stop()
  }
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`)
  process.exit(1)
})
