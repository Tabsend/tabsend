import type {
  EncryptedEnvelope,
  Endpoint,
  EndpointId,
  GroupSealed,
  IsoTimestamp,
  MessageId,
  SendItem,
  SendPayload,
  SendResponse,
} from '@tabsend/shared'
import { ApiClientError, sendMessages } from '../lib/api'
import { keyId, seal } from '../lib/crypto'
import { ext } from '../lib/ext'
import { classifySendFailure } from '../lib/health'
import type { OutboundItem, SendResult } from '../lib/model'
import { cancelOutbound, type OutboundPlan, planOutbound } from '../lib/outbound'
import { getCachedEndpoints, getOutbound, getSettings, setOutbound } from '../lib/storage'
import {
  droppedLine,
  heldTabLabel,
  isCapRejection,
  isRecoverableFailure,
  recoveredLine,
  type SendBanner,
  type SendFailure,
  sendBanner,
  sendFailureLine,
} from '../lib/strings'
import { fetchEndpoints } from './endpoints'
import { feedbackBadge, showFeedback } from './feedback'
import { sealHistoryBlob } from './history'
import { recordSend } from './prefs'
import { ensureRetryAlarm } from './scheduler'
import { requireSession } from './session'

/** Skip embedding a favicon that is a data: URL larger than this (keep the box small). */
const MAX_DATA_FAVICON_BYTES = 8 * 1024

/**
 * Capture what the user has SELECTED — every highlighted tab of the focused
 * window, as one SendPayload each (url plus title/favicon context, per PRD §5A /
 * INTERACTION_FLOWS §1). With nothing cmd/ctrl-clicked that is exactly the
 * active tab, so a plain send behaves as it always has. Extension pages are
 * ignored so the popup or first-run tab is never what gets sent; when the
 * selection holds nothing sendable (chooser opened as a full tab), fall back to
 * the most recently used real page — the old single-tab semantics, kept.
 */
export async function captureSelectedTabs(): Promise<SendPayload[]> {
  const highlighted = await ext.tabs.query({ highlighted: true, lastFocusedWindow: true })
  let tabs = highlighted.filter(isSendableTab)
  if (tabs.length === 0) {
    const fallback = await mostRecentSendableTab()
    tabs = fallback ? [fallback] : []
  }
  return payloadsFromTabs(tabs)
}

/** How many tabs a send would carry right now — the chooser's variant-A banner. */
export async function selectedTabCount(): Promise<number> {
  const highlighted = await ext.tabs.query({ highlighted: true, lastFocusedWindow: true })
  return highlighted.filter(isSendableTab).length
}

/**
 * One payload per tab, stamped as a batch when there are several: the SAME
 * random id on every payload plus the count, INSIDE the ciphertext, so a
 * receiver can group them (one notification, not N) while the relay still sees
 * N unrelated items. Never stamped on a single tab — a solo send must stay
 * byte-identical to today's.
 */
export function payloadsFromTabs(tabs: chrome.tabs.Tab[]): SendPayload[] {
  const sentAt = new Date().toISOString() as IsoTimestamp
  const payloads: SendPayload[] = []
  for (const tab of tabs) {
    if (!tab.url) continue
    const payload: SendPayload = { url: tab.url, sentAt }
    if (tab.title) payload.title = tab.title
    const favicon = tab.favIconUrl
    if (favicon && !(favicon.startsWith('data:') && favicon.length > MAX_DATA_FAVICON_BYTES)) {
      payload.favicon = favicon
    }
    payloads.push(payload)
  }
  if (payloads.length > 1) {
    const batch = { id: crypto.randomUUID(), count: payloads.length }
    for (const payload of payloads) payload.batch = batch
  }
  return payloads
}

/** A tab the user would mean by "this tab" — never one of our own extension pages. */
export function isSendableTab(tab: chrome.tabs.Tab): boolean {
  return Boolean(tab.url) && !tab.url?.startsWith('chrome-extension://')
}

/**
 * Fallback when the active tab is an extension page (e.g. the chooser opened as
 * a full tab): the most recently used real page. In normal popup usage the
 * active tab is already the user's page and this never runs.
 */
async function mostRecentSendableTab(): Promise<chrome.tabs.Tab | undefined> {
  const all = await ext.tabs.query({})
  return all.filter(isSendableTab).sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0]
}

async function sealFor(
  target: Endpoint,
  senderKeyId: string,
  senderPrivkey: string,
  payload: SendPayload,
): Promise<EncryptedEnvelope> {
  const box = await seal(JSON.stringify(payload), target.e2ePubkey, senderPrivkey)
  return {
    alg: 'x25519-xsalsa20-poly1305/box',
    senderKeyId,
    targetKeyId: await keyId(target.e2ePubkey),
    nonce: box.nonce,
    ciphertext: box.ciphertext,
  }
}

/**
 * Resolve the target endpoint AND the group's console endpoints — from the
 * cache when it already knows the target, else the relay. Consoles receive an
 * E2E history copy of every send [ADR-0010 §2]; they are never send targets
 * themselves (the chooser filter excludes `kind === 'console'`).
 *
 * The order used to be the other way round, and it put a whole
 * `GET /v1/endpoints` between the click and the POST — for a list the chooser
 * had fetched seconds earlier to draw the very row that was clicked. Two round
 * trips, one of them redundant, and the user waits through both before the ✓.
 *
 * What the cache can get wrong is bounded and self-correcting:
 *
 *  - A target whose keys have rotated since. The relay refuses the item with
 *    `expired_key` rather than mis-delivering it, and the copy for that already
 *    says to send again — which now works, because the refusal refreshes the
 *    cache (see `runSend`).
 *  - A console added since. It misses this send's history copy. Console copies
 *    are best-effort by contract, and the refresh below fixes the next one.
 *
 * An unknown target still costs the round trip, because there the cache has
 * nothing to offer and guessing would just fail the send.
 */
async function resolveTargetAndConsoles(
  targetEndpointId: string,
): Promise<{ target?: Endpoint; consoles: Endpoint[] }> {
  const cached = await getCachedEndpoints()
  let list = cached
  if (cached.some((e) => e.id === targetEndpointId)) {
    void fetchEndpoints().catch(() => undefined) // freshen for next time, off the path
  } else {
    try {
      list = await fetchEndpoints()
    } catch {
      list = cached
    }
  }
  return {
    target: list.find((e) => e.id === targetEndpointId),
    consoles: list.filter((e) => e.kind === 'console'),
  }
}

/**
 * Seal one E2E HISTORY COPY per console endpoint [ADR-0010 §2]: the same payload
 * plus `historyOf: { targetEndpointId }` INSIDE the ciphertext, sealed to the
 * console's own key, addressed to the console on the wire. Best-effort by
 * contract: a copy that fails to seal is simply dropped — it must NEVER fail or
 * delay the real send, so every console is wrapped in its own try/catch.
 */
export async function buildConsoleCopies(
  consoles: Endpoint[],
  payload: SendPayload,
  realTargetId: string,
  senderKeyId: string,
  senderPrivkey: string,
): Promise<SendItem[]> {
  const items: SendItem[] = []
  for (const console of consoles) {
    try {
      const copy: SendPayload = {
        ...payload,
        historyOf: { targetEndpointId: realTargetId as EndpointId },
      }
      const envelope = await sealFor(console, senderKeyId, senderPrivkey, copy)
      items.push({
        id: crypto.randomUUID() as MessageId,
        targetEndpointId: console.id as EndpointId,
        envelope,
      })
    } catch {
      // best-effort: never let a history copy break the real send
    }
  }
  return items
}

/** Where the user should be told about this send, when it isn't the active tab. */
export interface SendFeedbackOptions {
  /** The tab the send came FROM — so a delayed outcome lands where it started. */
  feedbackTabId?: number
  /**
   * The caller is showing the outcome itself, so don't make it wait for ours.
   *
   * Set by the chooser, which renders its own confirmation panel the moment
   * this resolves. The in-page banner still goes up — it just stops sitting in
   * front of the popup's ✓, which it was doing for a `tabs.query` plus a
   * cross-process `scripting.executeScript` into the user's page, behind a
   * dimmed row and after the send had already landed.
   */
  reportAsync?: boolean
}

/**
 * The send pipeline: capture (or accept an explicit payload) → seal per target →
 * POST with a client-generated id. On a relay/network outage the sealed item is
 * held in the outbound queue and retried by an alarm (source-side queue, §5).
 *
 * EVERY caller (chooser click, context menu, quick-send dispatch, hotkey) goes
 * through here, so reporting the outcome is done here too — once. Callers used
 * to be free to report whatever they liked, which is how quick-send ended up
 * announcing "Sent to Arc" four seconds before the send it was describing had
 * even been attempted (dogfood 2026-07-29).
 */
export async function sendToTarget(
  targetEndpointId: string,
  explicitPayload?: SendPayload | SendPayload[],
  opts: SendFeedbackOptions = {},
): Promise<SendResult> {
  const result = await runSend(targetEndpointId, explicitPayload)
  if (opts.reportAsync) void reportSend(result, opts.feedbackTabId).catch(() => undefined)
  else await reportSend(result, opts.feedbackTabId)
  return result
}

/**
 * Tell the user what happened. Success can be silenced by the §7 setting;
 * anything NOT delivered always shows, because a silent failure is the one
 * outcome this product exists to avoid.
 */
async function reportSend(result: SendResult, feedbackTabId?: number): Promise<void> {
  const banner = sendBanner(result)
  if (banner.tone === 'success') {
    const settings = await getSettings()
    // The setting silences the BANNER, not the badge — the badge is the signal
    // that survives restricted pages and closed tabs [ADR-0008].
    if (!settings.showSuccessToast) {
      feedbackBadge(banner)
      return
    }
  }
  const opts = feedbackTabId === undefined ? {} : { tabId: feedbackTabId }
  await showFeedback(banner, opts)
}

async function runSend(
  targetEndpointId: string,
  explicitPayload?: SendPayload | SendPayload[],
): Promise<SendResult> {
  const session = await requireSession()
  const { identity } = session

  // One payload per tab. A plain single send is the count === 1 case of the same
  // pipeline — same sealing, same POST, same queueing — so it cannot drift.
  const payloads =
    explicitPayload === undefined
      ? await captureSelectedTabs()
      : Array.isArray(explicitPayload)
        ? explicitPayload
        : [explicitPayload]
  const first = payloads[0]
  if (!first) {
    return {
      ok: false,
      queued: false,
      offline: false,
      error: 'No active tab to send.',
      failure: { kind: 'no-tab' },
    }
  }
  const count = payloads.length
  // The first tab names the send in feedback; with several, headlines count them
  // and the title line names this one (same pattern as announceRecovered).
  const title = first.title
  const favicon = first.favicon
  /** Attach the batch size to a result — only when there IS a batch, so single
   *  sends keep producing exactly today's shape. */
  const withCount = (result: SendResult): SendResult => (count > 1 ? { ...result, count } : result)

  const { target, consoles } = await resolveTargetAndConsoles(targetEndpointId)
  if (!target) {
    return withCount(
      withTitle(
        {
          ok: false,
          queued: false,
          offline: false,
          error: 'Target endpoint not found.',
          failure: { kind: 'no-target' },
        },
        title,
        favicon,
      ),
    )
  }

  // One real item per tab; history copies ride in the SAME POST as the real
  // items — one round-trip, and per-item outcomes are independent, so a rejected
  // copy can't fail the send. [ADR-0010] Copies of a batch carry the `batch`
  // stamp too (it lives inside the payload), so the console can group them.
  const realItems: SendItem[] = []
  const payloadOf = new Map<MessageId, SendPayload>()
  const historyOfItem = new Map<MessageId, GroupSealed>()
  /** copy id → the real send it copies, so a copy can never outlive its tab. */
  const copyOfReal = new Map<MessageId, MessageId>()
  const consoleItems: SendItem[] = []
  for (const payload of payloads) {
    const envelope = await sealFor(target, identity.keyId, identity.privateKey, payload)
    // One history blob per REAL item, sealed to the group key [ADR-0028 §2].
    // Console copies deliberately get none: the real item already wrote the row,
    // and a second blob for the same send would double it on every device's
    // timeline. Absent when the group has no key yet, and the send is unchanged.
    const history = await sealHistoryBlob({
      payload,
      // Snapshots, not ids: a history row has to still read correctly after
      // either end is renamed or leaves the group.
      sourceLabelAtSend: session.registration.label,
      targetLabelAtSend: target.label,
    })
    const item: SendItem = {
      id: crypto.randomUUID() as MessageId,
      targetEndpointId: targetEndpointId as EndpointId,
      envelope,
      ...(history ? { history } : {}),
    }
    realItems.push(item)
    payloadOf.set(item.id, payload)
    if (history) historyOfItem.set(item.id, history)
    const copies = await buildConsoleCopies(
      consoles,
      payload,
      targetEndpointId,
      identity.keyId,
      identity.privateKey,
    )
    // Remember which send each copy belongs to. Nothing on the wire needs it —
    // the link is already inside the ciphertext as `historyOf` — but the QUEUE
    // needs it, so that a tab the user cancels or that Tabsend gives up on takes
    // its copies with it instead of leaving the console a history row for a tab
    // that never went anywhere (lib/outbound.ts).
    for (const copy of copies) copyOfReal.set(copy.id, item.id)
    consoleItems.push(...copies)
  }
  const items: SendItem[] = [...realItems, ...consoleItems]
  // The queue entry for every sealed item, built once. TWO paths now hold items
  // — the outage catch below, and a per-item cap refusal from a relay that DID
  // answer [0030] — and building the entry in one place is what stops the two
  // drifting over which fields ride along with an envelope.
  const outboundOf = new Map<MessageId, OutboundItem>()
  for (const item of items) {
    const payload = payloadOf.get(item.id)
    const history = historyOfItem.get(item.id)
    const copySource = copyOfReal.get(item.id)
    outboundOf.set(item.id, {
      id: item.id,
      targetEndpointId: item.targetEndpointId,
      envelope: item.envelope,
      createdAt: (payload ?? first).sentAt,
      attempts: 0,
      // The blob rides the queue with its envelope. A send held through an
      // outage still writes its history row when it finally goes; rebuilding
      // the blob at drain time would need a key and two labels that may have
      // changed in the meantime, and would date the row wrong.
      ...(history ? { groupHistory: history } : {}),
      // Keep the plaintext description on the REAL items only, so the "waiting
      // here" list can name what it's holding. History copies never surface.
      ...(payload
        ? { url: payload.url, ...(payload.title ? { title: payload.title } : {}) }
        : { history: true, ...(copySource ? { copyOf: copySource } : {}) }),
    })
  }
  const heldEntries = (ids: MessageId[]): OutboundItem[] =>
    ids.map((id) => outboundOf.get(id)).filter(isOutbound)

  try {
    const res = await postItems(items)
    const rejectedReal = res.rejected.filter((r) => payloadOf.has(r.id))
    // "The keys on <device> have changed since this browser last saw them" is
    // the one refusal our own cache can cause, and the copy for it tells the
    // user to send again. Refresh now so that second attempt seals to the new
    // key instead of repeating the same rejection.
    if (rejectedReal.some((r) => r.reason === 'expired_key')) {
      void fetchEndpoints().catch(() => undefined)
    }
    // A cap refusal is the relay saying "not this minute", not "no" [0030]: the
    // send window rolls over on its own, and the queue caps drain as the target
    // reads what is already waiting. So those items go into the SAME queue that
    // holds tabs through an outage, and the existing drain retries them. Two
    // properties come from reusing it rather than inventing a retry here: the
    // queue's own bounds still apply (7 days, 200 tabs — lib/outbound.ts), so
    // this cannot grow without limit; and the drain runs on the poll alarm
    // (scheduler.ts, 30s on Chrome / 60s on Firefox), so it cannot spin.
    const capHeld = res.rejected.filter((r) => isCapRejection(r.reason)).map((r) => r.id)
    if (capHeld.length > 0) await enqueueOutbound(heldEntries(capHeld))
    // Which refusal explains the batch. A FINAL one wins over a cap refusal: the
    // cap-held tabs are already looking after themselves, so the reason worth
    // the banner is the one that needs a person.
    const explains = rejectedReal.find((r) => !isCapRejection(r.reason)) ?? rejectedReal[0]
    const rejection: SendFailure = {
      kind: 'relay-rejected',
      reason: explains?.reason ?? 'unknown_target',
      ...(explains?.limit ? { limit: explains.limit } : {}),
    }
    if (rejectedReal.length === count) {
      // `ok` is true for a cap refusal for exactly the reason the outage path's
      // is: the tabs are queued here, so they are not lost. `isRecoverableFailure`
      // then keeps every surface off the word "Sent".
      const held = isRecoverableFailure(rejection)
      if (held) await recordSend(targetEndpointId)
      return withCount(
        withTitle(
          {
            ok: held,
            queued: false,
            offline: false,
            ...(held ? {} : { error: `Relay rejected the send (${rejection.reason}).` }),
            targetLabel: target.label,
            ...(count > 1 ? { rejectedCount: count } : {}),
            failure: rejection,
          },
          title,
          favicon,
        ),
      )
    }
    await recordSend(targetEndpointId)
    // Target-offline sends are accepted + queued server-side; the banner is honest
    // about it ("opens when it wakes") so an asleep target never reads as failure.
    const queued = target.presence === 'offline'
    if (rejectedReal.length > 0) {
      // Some of the batch went, some was refused. The result carries both counts
      // AND the refusal, so no surface can read a partial delivery as "Sent N".
      return withCount(
        withTitle(
          {
            ok: true,
            queued,
            offline: false,
            targetLabel: target.label,
            rejectedCount: rejectedReal.length,
            failure: rejection,
          },
          title,
          favicon,
        ),
      )
    }
    return withCount(
      withTitle({ ok: true, queued, offline: false, targetLabel: target.label }, title, favicon),
    )
  } catch (err) {
    const failure = classifySendFailure(err, session.registration.relayUrl)
    // A relay that ANSWERED and refused the WHOLE request is a dead end for this
    // send: the same request would be refused the same way. A 429 or a 5xx is
    // not a refusal though (`relay-busy`), and treating it as one meant a relay
    // behind a proxy that was merely restarting cost the user the tab outright.
    //
    // Whole-request errors only. A PER-ITEM cap refusal [0030] never lands here
    // — it arrives as a 200 with a `rejected` entry, handled above — and it is
    // explicitly not a dead end: the caps clear themselves, so those items are
    // queued and retried like any other held tab.
    if (err instanceof ApiClientError && !isRecoverableFailure(failure)) {
      return withCount(
        withTitle(
          {
            ok: false,
            queued: false,
            offline: false,
            error: err.message,
            targetLabel: target.label,
            failure,
          },
          title,
          favicon,
        ),
      )
    }
    // Nothing answered, or the relay said "not now" → hold every real item AND
    // every history copy in the outbound queue; each drains (and dedupes)
    // independently once the relay is back.
    await enqueueOutbound(items.map((item) => outboundOf.get(item.id)).filter(isOutbound))
    await recordSend(targetEndpointId)
    // `ok: true` still means "we have it and it will go" — the tabs are not lost —
    // but `failure` now carries WHY it hasn't gone, so no surface may call this
    // "Sent". That distinction is the whole fix.
    return withCount(
      withTitle(
        { ok: true, queued: false, offline: true, targetLabel: target.label, failure },
        title,
        favicon,
      ),
    )
  }
}

/** Narrow away the `Map.get` miss that cannot happen (every item has an entry). */
function isOutbound(entry: OutboundItem | undefined): entry is OutboundItem {
  return entry !== undefined
}

/** Attach the tab's identity to a result (exactOptionalPropertyTypes-safe). */
function withTitle(result: SendResult, title?: string, favicon?: string): SendResult {
  if (!title) return result
  return { ...result, title, ...(favicon ? { favicon } : {}) }
}

/** POST a batch of already-sealed items in one call. */
function postItems(items: SendItem[]) {
  return requireSession().then(({ registration }) =>
    sendMessages(registration.relayUrl, registration.deviceToken, { items }),
  )
}

/**
 * POST a single already-sealed item (outbound-queue drain path), answering with
 * the relay's per-item refusal when there was one.
 *
 * The refusal used to be discarded, which made a `not_in_group` on a held tab
 * indistinguishable from a delivery: the item left the queue and was announced
 * as "Sent the tab that was waiting" — a confirmation for a tab nobody has.
 *
 * Takes the whole item rather than three fields so the ADR-0028 history blob
 * rides along: a tab held through an outage still records itself when it finally
 * flushes, under the key and labels that were true when it was SENT.
 *
 * The WHOLE rejection comes back, not just its reason: `limit` names which cap
 * refused a `limit_reached` item [0030], and the drain needs it both to decide
 * that the item stays (a cap clears itself) and to say which wait it is in.
 */
async function postItem(item: OutboundItem): Promise<SendResponse['rejected'][number] | undefined> {
  const messageId = item.id as MessageId
  const res = await postItems([
    {
      id: messageId,
      targetEndpointId: item.targetEndpointId as EndpointId,
      envelope: item.envelope,
      // Queued before ADR-0028, or queued while the group had no key: either way
      // the field is simply absent and the send behaves as it always did.
      ...(item.groupHistory ? { history: item.groupHistory } : {}),
    },
  ])
  return res.rejected.find((r) => r.id === messageId)
}

/**
 * Hold sealed items for retry — and bound what is being held.
 *
 * The queue's rule for LETTING GO is unchanged and deliberate: only a definite
 * answer from the relay releases an item. What was missing is a bound on the
 * other side, so a week of outage grew this list forever. `planOutbound` decides
 * both bounds and this carries the decision out; the tabs it gives up on are
 * announced rather than quietly deleted, which is the whole lesson of §4d/§4e —
 * a promise was made ("the tab is held here and sends itself…") and this is the
 * moment it stops being kept.
 *
 * The eviction is oldest-first because the newest item is the one the user just
 * clicked for. Taking that one would be the single worst thing to drop.
 */
async function enqueueOutbound(items: OutboundItem[]): Promise<void> {
  const queue = await getOutbound()
  const known = new Set(queue.map((q) => q.id))
  const plan = planOutbound([...queue, ...items.filter((item) => !known.has(item.id))], Date.now())
  await setOutbound(plan.keep)
  const given = givenUp(plan)
  if (given.length > 0) await announceDropped(given)
  await ensureRetryAlarm()
}

/**
 * Abandon one tab the queue is holding, at the user's request.
 *
 * A pure local delete — nothing is transmitted, exactly as an undo inside the
 * quick-send window is (quicksend.ts). The honest limit, which the chooser's
 * wording has to respect too: this stops Tabsend TRYING. An item whose POST is
 * in flight at this instant can still be accepted and delivered, and a tab the
 * relay has already taken is long past anything this can reach. There is no
 * unsend, and this does not invent one.
 *
 * Silent by design. §4d's rule is that a promise must be withdrawn when it stops
 * being true, and the user withdrawing it themselves is not news to report back.
 */
export async function cancelHeldTab(id: string): Promise<void> {
  await setOutbound(cancelOutbound(await getOutbound(), id))
}

/**
 * The tabs a plan gave up on, in the shape the drop announcement wants.
 *
 * Console history copies are filtered out here and nowhere else: they are
 * best-effort by contract [ADR-0010], they are not tabs anybody sent, and a
 * single send with one console paired would otherwise be announced as two
 * abandoned tabs. Expired items come first so that when a pass manages to do
 * both, the sentence the banner shows is the one about waiting too long — the
 * cause the user can actually act on.
 */
function givenUp(
  plan: OutboundPlan<OutboundItem>,
): Array<{ item: OutboundItem; failure: SendFailure }> {
  const expired = plan.expired.map((item) => ({
    item,
    failure: { kind: 'given-up', reason: 'too-old' } as SendFailure,
  }))
  const evicted = plan.evicted.map((item) => ({
    item,
    failure: { kind: 'given-up', reason: 'queue-full' } as SendFailure,
  }))
  return [...expired, ...evicted].filter((entry) => !entry.item.history)
}

/**
 * Drain the outbound queue — retry each held send. Returns true while anything
 * remains queued.
 *
 * An item leaves the queue only on a DEFINITE answer: accepted, or refused in a
 * way that retrying cannot change. Silence, a 429, any 5xx and a per-group cap
 * refusal [0030] all keep it for the next alarm. That split is the fix for the
 * worst version of this file's original bug: every non-2xx counted as a refusal,
 * so a single pass against a relay behind a proxy serving HTML 502 for the few
 * seconds it takes to restart threw away the ENTIRE held queue, silently, after
 * the user had been told the tabs were waiting and had walked away.
 *
 * Both halves of that promise are now kept. Sends that got through on a RETRY
 * are announced (`recovered`): the user was told "waiting to send", so they are
 * owed the other half of that sentence when it finally goes. A first-attempt
 * drain (attempts === 0, i.e. it never actually failed) is silent — nothing was
 * promised. And a tab the relay finally REFUSES is announced too, whatever its
 * attempt count, because it was promised and it is not coming back.
 *
 * The bound is applied HERE as well as at enqueue, and this is the half that
 * matters for the failure the roadmap named: an envelope one particular relay
 * 5xxes forever is never competing with newer sends for the size cap, so
 * nothing but its own age would ever end it. Without this it is retried on
 * every drain and every heartbeat, for as long as the browser profile lives.
 */
export async function processOutbound(): Promise<boolean> {
  const stored = await getOutbound()
  if (stored.length === 0) return false
  const plan = planOutbound(stored, Date.now())
  const queue = plan.keep
  // Only ever used to name the address in a diagnosis. A drain with no session
  // has already failed every POST below, so there is nothing to name.
  const relayUrl = await requireSession()
    .then(({ registration }) => registration.relayUrl)
    .catch(() => '')

  const remaining: OutboundItem[] = []
  const recovered: OutboundItem[] = []
  // Given-up tabs join the relay's own refusals in ONE announcement: from the
  // user's side both are "a tab you were promised is not going", and two banners
  // fighting over the same corner of the page would settle it by clobbering.
  const dropped: Array<{ item: OutboundItem; failure: SendFailure }> = givenUp(plan)
  for (const item of queue) {
    try {
      const rejection = await postItem(item)
      // A cap refusal [0030] is the one per-item rejection that is not final:
      // the send window rolls over on its own and the queue caps drain as the
      // target reads its tabs, so the item STAYS and the next drain tries again.
      // Checked before the history test below, because a cap-refused history
      // copy has to be kept for the same reason a real one does.
      if (rejection && isCapRejection(rejection.reason)) {
        remaining.push({ ...item, attempts: item.attempts + 1 })
        continue
      }
      // Every other per-item rejection is still HTTP 200 and still final, so the
      // item leaves the queue either way — but only an acceptance is a recovery.
      // History copies are best-effort by contract [ADR-0010] and never surface,
      // so neither half of the announcement ever counts one.
      if (item.history) continue
      if (rejection) {
        dropped.push({
          item,
          failure: {
            kind: 'relay-rejected',
            reason: rejection.reason,
            ...(rejection.limit ? { limit: rejection.limit } : {}),
          },
        })
      } else if (item.attempts > 0) recovered.push(item)
    } catch (err) {
      const failure = classifySendFailure(err, relayUrl)
      if (err instanceof ApiClientError && !isRecoverableFailure(failure)) {
        // A refusal is final: retrying identical input fails identically.
        if (!item.history) dropped.push({ item, failure })
        continue
      }
      remaining.push({ ...item, attempts: item.attempts + 1 }) // no answer yet → keep
    }
  }

  await setOutbound(remaining)
  if (recovered.length > 0) await announceRecovered(recovered)
  if (dropped.length > 0) await announceDropped(dropped)
  return remaining.length > 0
}

/**
 * "Your relay is back and the tabs it was holding have gone." Names the tab when
 * there is only one — the user sent it minutes ago and may well have forgotten
 * which one was stuck.
 */
async function announceRecovered(items: OutboundItem[]): Promise<void> {
  const first = items[0]
  const banner: SendBanner = {
    tone: 'success',
    headline: recoveredLine(items.length, first?.title),
    detail: 'Your relay is reachable again.',
  }
  // With several, the headline counts them and the title line names the first —
  // enough to recognise the batch without turning a toast into a list.
  if (items.length > 1 && first) banner.title = heldTabLabel(first)
  const settings = await getSettings()
  if (!settings.showSuccessToast) {
    feedbackBadge(banner)
    return
  }
  await showFeedback(banner)
}

/**
 * "The relay answered about the tabs it was holding, and the answer was no."
 *
 * Shaped like announceRecovered because it is the same promise being settled the
 * other way, with two differences. It is never gated behind `showSuccessToast`:
 * that setting silences confirmations, and this is the opposite of one. And the
 * device label comes from the endpoint cache rather than from the queue, which
 * only stores what is needed to seal and to name the TAB — so the sentence can
 * say "Your relay says Arc · Mac mini has left your group" instead of falling
 * back to "that device".
 */
async function announceDropped(
  items: Array<{ item: OutboundItem; failure: SendFailure }>,
): Promise<void> {
  const first = items[0]
  if (!first) return
  const endpoints = await getCachedEndpoints().catch(() => [])
  const label = endpoints.find((e) => e.id === first.item.targetEndpointId)?.label
  const banner: SendBanner = {
    tone: 'error',
    headline: droppedLine(items.length, first.item.title),
    // The first refusal explains the batch. With several the reasons can differ,
    // but naming one of them beats a count with no cause, and the alternative is
    // a toast that has become a list.
    detail: sendFailureLine(first.failure, label),
  }
  if (items.length > 1) banner.title = heldTabLabel(first.item)
  await showFeedback(banner)
}
