import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { OutboxMessagesResponse } from '@tabsend/shared'
import type { Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildExtension, extUrl, launchProfile, type Profile, until } from './browser'
import { type ProxyHandle, startAckProxy, startTargetSite } from './proxy'
import { type RelayHandle, sleep, startRelay } from './relay'

/**
 * THE done-gate rig: a real tab travels Chrome profile A → Chrome profile B
 * through the relay, and never opens twice.
 *
 * Topology:
 *   profile A ──────────────► relay (real chunk-2 server, temp SQLite)
 *   profile B ──► ack-proxy ─► relay
 *
 * B talks through a fault-injection proxy so the rig can BLOCK acks: the
 * delivered-but-unacked window is where a duplicate tab could happen, and
 * blocking acks holds the message in that window across re-polls and a full
 * browser restart. That makes the no-dupes assertions real, not vacuous.
 */

// What the pages evaluate against at runtime (extension pages have chrome.*).
interface ChromeLike {
  runtime: { sendMessage(msg: unknown): Promise<unknown> }
  storage: { local: { get(key: string): Promise<Record<string, unknown>> } }
}
declare const chrome: ChromeLike

interface StoredRegistration {
  endpointId: string
  deviceToken: string
  relayUrl: string
  label: string
}

let relay: RelayHandle
/** The relay's own SQLite file, so the P-10 test can add a device behind its back. */
const relayDbPath = join(mkdtempSync(join(tmpdir(), 'tabsend-e2e-db-')), 'e2e.db')
let proxy: ProxyHandle
let site: { url: string; stop(): Promise<void> }
let profileA: Profile
let profileB: Profile

beforeAll(async () => {
  await buildExtension()
  relay = await startRelay({ dbPath: relayDbPath })
  ;[proxy, site] = await Promise.all([startAckProxy(relay.url), startTargetSite()])
  profileA = await launchProfile()
})

afterAll(async () => {
  await profileA?.dispose()
  await profileB?.dispose()
  await site?.stop()
  await proxy?.stop()
  await relay?.stop()
})

// --- helpers ----------------------------------------------------------------

async function openPage(profile: Profile, url: string): Promise<Page> {
  const page = await profile.context.newPage()
  await page.goto(url)
  return page
}

/** Fire an RPC at a profile's service worker from one of its extension pages. */
async function rpcFrom(page: Page, message: Record<string, unknown>): Promise<unknown> {
  return page.evaluate((msg) => chrome.runtime.sendMessage(msg), message)
}

async function readRegistration(page: Page): Promise<StoredRegistration> {
  const bag = await page.evaluate(() => chrome.storage.local.get('registration'))
  return bag.registration as StoredRegistration
}

function targetTabs(profile: Profile): Page[] {
  return profile.context.pages().filter((p) => p.url() === site.url)
}

async function outboxOf(reg: StoredRegistration): Promise<OutboxMessagesResponse> {
  const res = await fetch(`${relay.url}/v1/messages?outbox=1`, {
    headers: { authorization: `Bearer ${reg.deviceToken}` },
  })
  expect(res.status).toBe(200)
  return (await res.json()) as OutboxMessagesResponse
}

// --- the story ----------------------------------------------------------------

describe('a tab travels Chrome A → Chrome B', () => {
  let pairingLink: string
  let regA: StoredRegistration
  let regB: StoredRegistration
  let firstrunB: Page

  it('A pairs with the relay-owned group, then names its device', async () => {
    const page = await openPage(profileA, extUrl(profileA, 'firstrun.html'))
    // The first screen takes the pairing link, which contains the relay address
    // and the one-time code together. No separate connection step is needed.
    await page.waitForSelector('body[data-ready="1"]')
    await page.fill('#browser-name', 'Rig A')
    await page.fill('#pairing-link-input', relay.firstRunPairingLink)
    await page.click('#join')

    await page.waitForSelector('#screen-device:not(.hidden)')
    await page.fill('#device-new', 'Mac A')
    await page.click('#device-confirm')

    // Pairing lands on the manage-devices surface — no recovery phrase step in
    // between (ADR-0021).
    await page.waitForSelector('#screen-manage:not(.hidden)')
    expect(await page.locator('#recovery').count()).toBe(0)

    regA = await readRegistration(page)
    expect(regA.deviceToken).toBeTruthy()
    // Label is now "browser · device" from the two named parts.
    expect(regA.label).toBe('Rig A · Mac A')
    await page.close()
  })

  it('A mints a pairing link from the popup (zero-target state)', async () => {
    const chooser = await openPage(profileA, extUrl(profileA, 'chooser.html'))
    await chooser.waitForSelector('#empty:not(.hidden)') // "You're the only device here."
    await chooser.click('#pair-header')
    await chooser.waitForSelector('#pairing-box.visible')
    // The box opens BEFORE the mint returns, on purpose ("Getting a pairing link…", so
    // a click on a slow relay visibly does something), so wait for the link itself
    // rather than reading the empty field in the moment between.
    await chooser.waitForFunction(
      () => (document.getElementById('pairing-link') as HTMLInputElement | null)?.value !== '',
    )
    pairingLink = await chooser.inputValue('#pairing-link')
    expect(pairingLink).toMatch(/^http:\/\/[^/]+\/pair#c=[2-9A-HJKMNP-Z]{8}$/)
    await chooser.close()
  })

  it('B pairs with the link, then create-or-selects a device (via the ack proxy)', async () => {
    profileB = await launchProfile()
    firstrunB = await openPage(profileB, extUrl(profileB, 'firstrun.html'))
    await firstrunB.waitForSelector('body[data-ready="1"]')
    await firstrunB.fill('#browser-name', 'Rig B')
    const secret = new URL(pairingLink).hash
    await firstrunB.fill('#pairing-link-input', `${proxy.url}/pair${secret}`)
    await firstrunB.click('#join')

    // Device step: A's device ("Mac A") is offered as an existing device; B adds
    // its own instead. Confirming patches the label to "browser · device".
    await firstrunB.waitForSelector('#screen-device:not(.hidden)')
    await firstrunB.waitForSelector('.device-choice')
    expect(await firstrunB.textContent('.device-choice')).toContain('Mac A')
    await firstrunB.fill('#device-new', 'Mac B')
    await firstrunB.click('#device-confirm')
    await firstrunB.waitForSelector('#screen-manage:not(.hidden)')

    regB = await readRegistration(firstrunB)
    expect(regB.relayUrl).toBe(proxy.url)
    expect(regB.endpointId).not.toBe(regA.endpointId)
    expect(regB.label).toBe('Rig B · Mac B')
  })

  it('A sends its active tab to B — one click, legible confirmation, tab OPENS in B', async () => {
    // Hold every ack from B: the message must stay in the delivered-unacked
    // window for the whole no-dupes sequence below.
    proxy.failAcks = true

    // The page A is "on" — the most recent real tab when the chooser fires.
    await openPage(profileA, site.url)

    // Open A's chooser: B is the one target, and it is CLICKED. The popup no
    // longer auto-sends at n=1 — that made a bare icon click send silently and
    // flash-closed the popup before pairing could be reached (dogfood
    // 2026-07-21, commit 204eaf2). Pass-2 #6 still holds for the result: the
    // popup must NOT flash-and-vanish, it shows "Sent to <target> ✓".
    const chooser = await openPage(profileA, extUrl(profileA, 'chooser.html'))
    await chooser.waitForSelector('#targets:not(.hidden) button')
    expect(await chooser.locator('#targets button').count()).toBe(1)
    await chooser.click('#targets button')
    await chooser.waitForSelector('#confirm.visible', { timeout: 10_000 })
    expect(await chooser.textContent('#confirm')).toContain('Sent to Rig B · Mac B')

    // A's outbox now shows the unacked send.
    const outbox = await until(
      async () => {
        const rows = await outboxOf(regA)
        return rows.length === 1 ? rows : undefined
      },
      { what: "A's outbox to show the send" },
    )
    expect(outbox[0]?.targetEndpointId).toBe(regB.endpointId)

    // B pulls (popup-open path = pollNow RPC) → the tab opens in B.
    await rpcFrom(firstrunB, { type: 'pollNow' })
    await until(() => targetTabs(profileB).length === 1, {
      what: 'the tab to open in profile B',
    })
    // ...and the ack was attempted but blocked (still pending server-side).
    expect(proxy.ackAttempts).toBeGreaterThan(0)
    expect((await outboxOf(regA)).length).toBe(1)
    await chooser.close()
  })

  it('re-polls never duplicate the tab (message still pending!)', async () => {
    for (let i = 0; i < 3; i += 1) {
      await rpcFrom(firstrunB, { type: 'pollNow' })
    }
    await sleep(750) // give a hypothetical duplicate tabs.create time to surface
    expect(targetTabs(profileB).length).toBe(1)
    // The message genuinely stayed pending through all of that (acks blocked).
    expect((await outboxOf(regA)).length).toBe(1)
  })

  it('a full browser restart of B does not re-open the tab', async () => {
    const dir = profileB.userDataDir
    await profileB.close()

    profileB = await launchProfile(dir) // same profile, fresh browser + SW boot
    firstrunB = await openPage(profileB, extUrl(profileB, 'firstrun.html'))
    await rpcFrom(firstrunB, { type: 'pollNow' })
    await sleep(1500) // boot poll + explicit poll both ran against a pending message

    // The seen-set survived the restart: the still-pending message is NOT re-opened.
    expect(targetTabs(profileB).length).toBe(0)
    expect((await outboxOf(regA)).length).toBe(1)
  })

  it("B's ack lands once allowed, and A's outbox drains", async () => {
    proxy.failAcks = false
    await rpcFrom(firstrunB, { type: 'pollNow' })

    await until(async () => (await outboxOf(regA)).length === 0, {
      what: "A's outbox to drain after ack",
    })
    // Ack-then-delete: B's pending is empty server-side too.
    const res = await fetch(`${relay.url}/v1/messages?pending=1`, {
      headers: { authorization: `Bearer ${regB.deviceToken}` },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
    // And still no duplicate tab anywhere in the story.
    expect(targetTabs(profileB).length).toBe(0)
  })

  it('B can still find the tab after closing it, on the received-tabs page [P-7]', async () => {
    // This is the whole point of P-7: by now the relay has DELETED the payload
    // (ack landed above) and B's restart closed the tab it opened. Before the
    // inbox, that link was gone for good. The page is B's only remaining copy.
    expect(targetTabs(profileB).length).toBe(0)

    const history = await openPage(profileB, extUrl(profileB, 'history.html'))
    await history.waitForSelector('.tab')
    expect(await history.locator('.tab').count()).toBe(1)
    expect(await history.locator('#empty.hidden').count()).toBe(1)

    // The row names who sent it, using the label snapshot taken at receipt.
    expect(await history.textContent('.tab-sub')).toContain('from Rig A · Mac A')
    // A single send gets no "1 tabs" heading — only real batches are grouped.
    expect(await history.locator('.group-head').count()).toBe(0)

    // Clicking it opens the tab again, which is the recovery this page exists for.
    await history.click('.tab')
    await until(() => targetTabs(profileB).length === 1, {
      what: 'the tab to re-open from the history page',
    })

    await history.close()
    for (const page of targetTabs(profileB)) await page.close()
  })

  // PLANS.md P-14 item 1: the first list a device sees is taken on trust, so the
  // user is asked about it once.
  it('B is asked once to check the devices it joined, and answering clears it on B only', async () => {
    const manageB = await openPage(profileB, extUrl(profileB, 'firstrun.html'))
    await manageB.waitForSelector('#screen-manage:not(.hidden)')
    await manageB.waitForSelector('#new-devices .new-device')
    const card = await manageB.textContent('#new-devices')
    expect(card).toContain('Check your devices')
    expect(card).toContain('Rig A · Mac A')
    await manageB.click('#new-devices .new-device button:text("All of these are mine")')
    await manageB.waitForSelector('#new-devices.hidden', { state: 'attached' })
    await manageB.reload()
    await manageB.waitForSelector('#screen-manage:not(.hidden)')
    expect(await manageB.locator('#new-devices.hidden').count()).toBe(1)
    await manageB.close()
  })

  // PLANS.md P-10, and the H4 gate in HOSTED_PLAN.md §10: an added device is
  // noticed by the devices already in the group.
  it('A is told that B joined, and "Yes, it\'s mine" clears it on A only', async () => {
    const manageA = await openPage(profileA, extUrl(profileA, 'firstrun.html'))
    await manageA.waitForSelector('#screen-manage:not(.hidden)')
    await manageA.waitForSelector('#new-devices .new-device')
    expect(await manageA.textContent('#new-devices')).toContain('New device: Rig B · Mac B')
    await manageA.click('#new-devices .new-device button:text("Yes, it\'s mine")')
    await manageA.waitForSelector('#new-devices.hidden', { state: 'attached' })
    await manageA.close()
  })

  it('a device written straight into the relay database is caught on the next fetch', async () => {
    // No pairing link, no endpoint_added event: what someone who broke into the
    // server could do. Only comparing lists can catch it.
    const db = new DatabaseSync(relayDbPath)
    try {
      const row = db
        .prepare('SELECT group_id FROM endpoints WHERE id = ?')
        .get(regA.endpointId) as { group_id: string }
      const now = new Date().toISOString()
      db.prepare(
        `INSERT INTO endpoints (id, group_id, kind, browser, platform, label, device_name,
           e2e_pubkey, push_subscription, push_failures, device_token_hash, last_seen_at, created_at)
         VALUES (?, ?, 'extension', 'firefox', 'linux', ?, NULL, ?, ?, 0, ?, ?, ?)`,
      ).run(
        'intruder-1',
        row.group_id,
        'Firefox · Linux',
        Buffer.alloc(32, 7).toString('base64'),
        JSON.stringify({ transport: 'unifiedpush', endpoint: 'https://push.invalid/x' }),
        'not-a-real-token-hash',
        now,
        now,
      )
    } finally {
      db.close()
    }

    const manageA = await openPage(profileA, extUrl(profileA, 'firstrun.html'))
    await manageA.waitForSelector('#new-devices .new-device')
    const banner = await manageA.textContent('#new-devices')
    expect(banner).toContain('New device: Firefox · Linux')
    expect(banner).not.toContain('Rig B')
    await manageA.close()

    // B sees it too: every existing device is told, not only the one that invited.
    const chooserB = await openPage(profileB, extUrl(profileB, 'chooser.html'))
    await until(
      async () => (await chooserB.textContent('#new-devices'))?.includes('Firefox · Linux'),
      { what: "B's popup to show the added device" },
    )
    await chooserB.close()
  })
  // PLANS.md P-14 item 2: a device shown once and then hidden leaves more than a
  // one-time alert.
  it('a device shown once and then hidden stays on screen as "joined, then disappeared"', async () => {
    const db = new DatabaseSync(relayDbPath)
    try {
      db.prepare('DELETE FROM endpoints WHERE id = ?').run('intruder-1')
    } finally {
      db.close()
    }

    const manageA = await openPage(profileA, extUrl(profileA, 'firstrun.html'))
    await manageA.waitForSelector('#new-devices .new-device')
    const notice = await manageA.textContent('#new-devices')
    expect(notice).toContain('Firefox · Linux joined, then disappeared')
    expect(notice).not.toContain('New device: Firefox')
    // Still there after a reload: it waits for an answer, it is not a one-time alert.
    await manageA.reload()
    await manageA.waitForSelector('#new-devices .new-device')
    await manageA.click('#new-devices .new-device button:text("Dismiss")')
    await manageA.waitForSelector('#new-devices.hidden', { state: 'attached' })
    await manageA.close()
  })
})
