import type { GroupLimit } from '@tabsend/shared'
import { HOME_NETWORK_HINT } from '@tabsend/shared'
import { describe, expect, it } from 'vitest'
import type { InboxItem } from './model'
import {
  arrivalPlaceLine,
  droppedLine,
  feedbackCopy,
  heldTabLabel,
  heldTabsHeading,
  isCapRejection,
  isRecoverableFailure,
  multiSelectionLine,
  pairingErrorLine,
  pendingRow,
  receivedNotificationLine,
  recoveredLine,
  relayDownLine,
  type SendFailure,
  sendBanner,
  sendFailureLine,
  sendFeedbackLine,
  sendingBanner,
  shortTitle,
  soloGroupCopy,
} from './strings'

function item(id: string, sourceLabel: string): InboxItem {
  return {
    id,
    url: `https://example.com/${id}`,
    sourceLabel,
    sentAt: '2026-08-05T10:00:00.000Z',
    receivedAt: 1000,
  }
}

describe('feedback copy (INTERACTION_FLOWS §4 table)', () => {
  it('matches the exact strings', () => {
    expect(feedbackCopy.sentOnline('Chrome · Work')).toBe('Sent to Chrome · Work')
    expect(feedbackCopy.sentOffline('Chrome · Work')).toBe(
      'Sent to Chrome · Work — opens when it wakes',
    )
    expect(feedbackCopy.sourceOffline()).toBe("No connection — will send when you're back online")
    expect(feedbackCopy.noDevices()).toBe('No devices yet — pair one to start sending')
    expect(feedbackCopy.hardError()).toBe("Couldn't send — check Tabsend is still linked")
  })

  it('pendingRow reads "N waiting for <label>"', () => {
    expect(pendingRow(1, 'Pixel · Phone')).toBe('⏳ 1 waiting for Pixel · Phone')
  })
})

describe('pairingErrorLine', () => {
  // Minting is the one pairing step that needs a live relay, so an unreachable
  // relay must name the URL — the user is self-hosting and has to go start it.
  it('names the relay when it is unreachable', () => {
    expect(pairingErrorLine({ kind: 'unreachable', relayUrl: 'http://localhost:8787' })).toBe(
      "Couldn't reach the relay at http://localhost:8787 — check it's running, then try again.",
    )
  })
  it('explains an unregistered browser instead of failing blankly', () => {
    expect(pairingErrorLine({ kind: 'unregistered' })).toBe(
      'Set Tabsend up on this browser first, then you can pair other devices.',
    )
  })
  it('tells a removed browser to set itself up again', () => {
    expect(pairingErrorLine({ kind: 'unauthorized' })).toBe(
      'This browser is no longer in the group — set it up again to pair other devices.',
    )
  })
  it('passes a relay-side refusal through', () => {
    expect(pairingErrorLine({ kind: 'relay', detail: 'Rate limited.' })).toBe(
      "The relay couldn't issue a pairing link: Rate limited.",
    )
  })
  it('never returns an empty line — the silent failure this replaced', () => {
    const cases = [
      { kind: 'unreachable', relayUrl: 'https://relay.example' },
      { kind: 'unregistered' },
      { kind: 'unauthorized' },
      { kind: 'relay', detail: 'boom' },
    ] as const
    for (const cause of cases) expect(pairingErrorLine(cause).length).toBeGreaterThan(0)
  })
})

describe('sendFeedbackLine', () => {
  const label = 'Firefox · Laptop'
  it('online → sent', () => {
    expect(sendFeedbackLine({ ok: true, queued: false, offline: false, targetLabel: label })).toBe(
      'Sent to Firefox · Laptop',
    )
  })
  it('target offline → opens when it wakes', () => {
    expect(sendFeedbackLine({ ok: true, queued: true, offline: false, targetLabel: label })).toBe(
      'Sent to Firefox · Laptop — opens when it wakes',
    )
  })
  it('source offline → will send when back online', () => {
    expect(sendFeedbackLine({ ok: true, queued: false, offline: true, targetLabel: label })).toBe(
      "No connection — will send when you're back online",
    )
  })
  it('failure → hard error', () => {
    expect(sendFeedbackLine({ ok: false, queued: false, offline: false, targetLabel: label })).toBe(
      "Couldn't send — check Tabsend is still linked",
    )
  })

  // The tooltip is the one signal that survives a closed tab, so it has to carry
  // the diagnosis too — not the generic "check Tabsend is still linked".
  it('prefers a classified failure over the generic lines', () => {
    expect(
      sendFeedbackLine({
        ok: true,
        queued: false,
        offline: true,
        targetLabel: label,
        failure: { kind: 'relay-unreachable', relayUrl: 'http://192.168.1.50:8787' },
      }),
    ).toContain('http://192.168.1.50:8787')
  })
})

// Owner preference: no em dashes in shipped copy. The §4 table predates the rule
// and is locked, so this covers the lines added since.
describe('copy style', () => {
  it('uses no em dashes in the newer failure copy', () => {
    const cases: SendFailure[] = [
      { kind: 'browser-offline' },
      { kind: 'relay-unreachable', relayUrl: 'http://x' },
      { kind: 'relay-rejected', reason: 'unknown_target' },
      { kind: 'relay-rejected', reason: 'expired_key' },
      { kind: 'relay-rejected', reason: 'not_in_group' },
      { kind: 'relay-error', code: 'invalid_request' },
      { kind: 'relay-error', code: 'internal' },
      { kind: 'relay-busy' },
      { kind: 'relay-unauthorized' },
      { kind: 'given-up', reason: 'too-old' },
      { kind: 'given-up', reason: 'queue-full' },
      { kind: 'no-target' },
      { kind: 'no-tab' },
    ]
    for (const failure of cases) expect(sendFailureLine(failure, 'Arc')).not.toContain('—')
    expect(relayDownLine('http://x', 12)).not.toContain('—')
    expect(heldTabsHeading(3)).not.toContain('—')
    expect(recoveredLine(2)).not.toContain('—')
  })
})

describe('sendFailureLine', () => {
  it('names the relay address a self-hoster has to go and fix', () => {
    expect(
      sendFailureLine({ kind: 'relay-unreachable', relayUrl: 'http://192.168.1.50:8787' }),
    ).toContain('http://192.168.1.50:8787')
  })

  it('never blames the connection for a relay outage', () => {
    const line = sendFailureLine({ kind: 'relay-unreachable', relayUrl: 'http://mini-pc:8787' })
    expect(line).not.toMatch(/you'?re offline|no connection/i)
  })

  it('covers every kind — a silent failure is the bug this replaced', () => {
    const cases: SendFailure[] = [
      { kind: 'browser-offline' },
      { kind: 'relay-unreachable', relayUrl: 'http://x' },
      { kind: 'relay-rejected', reason: 'unknown_target' },
      { kind: 'relay-rejected', reason: 'expired_key' },
      { kind: 'relay-rejected', reason: 'not_in_group' },
      { kind: 'relay-error', code: 'not_found' },
      { kind: 'relay-error', code: 'forbidden' },
      { kind: 'relay-error', code: 'invalid_request' },
      { kind: 'relay-error', code: 'rate_limited' },
      { kind: 'relay-error', code: 'internal' },
      { kind: 'relay-error', code: 'unauthorized' },
      { kind: 'relay-error', code: 'endpoint_removed' },
      { kind: 'relay-error', code: 'invalid_pairing_code' },
      { kind: 'relay-busy' },
      { kind: 'relay-unauthorized' },
      // Tabsend's own two verdicts. Not wire codes, and the only failures the
      // client decides by itself, but a person still has to be told in words.
      { kind: 'given-up', reason: 'too-old' },
      { kind: 'given-up', reason: 'queue-full' },
      { kind: 'no-target' },
      { kind: 'no-tab' },
    ]
    for (const failure of cases) expect(sendFailureLine(failure).length).toBeGreaterThan(0)
  })

  // The copy is the whole point: a person reading a banner must never be shown
  // a wire code. "Your relay refused the send: Unknown target." was the bug.
  it('never leaks a machine code into user-facing copy', () => {
    const wireCodes =
      /unknown_target|expired_key|not_in_group|invalid_request|rate_limited|endpoint_removed|invalid_pairing_code|not_found|forbidden|internal|unauthorized/
    const cases: SendFailure[] = [
      { kind: 'relay-rejected', reason: 'unknown_target' },
      { kind: 'relay-rejected', reason: 'expired_key' },
      { kind: 'relay-rejected', reason: 'not_in_group' },
      { kind: 'relay-error', code: 'not_found' },
      { kind: 'relay-error', code: 'invalid_request' },
      { kind: 'relay-error', code: 'internal' },
    ]
    for (const failure of cases) {
      expect(sendFailureLine(failure, 'Arc · Mac mini')).not.toMatch(wireCodes)
    }
  })

  it('names the device rather than the code it was rejected with', () => {
    expect(sendFailureLine({ kind: 'relay-rejected', reason: 'unknown_target' }, 'Arc')).toBe(
      "Your relay doesn't know Arc any more. Pair it again, then send this tab a second time.",
    )
  })

  // The no-label fallback ("that device") is not a proper noun, so no line may
  // start with it — that reads as a lowercase sentence.
  it('never opens a sentence with the device name', () => {
    const cases: SendFailure[] = [
      { kind: 'relay-rejected', reason: 'unknown_target' },
      { kind: 'relay-rejected', reason: 'expired_key' },
      { kind: 'relay-rejected', reason: 'not_in_group' },
      { kind: 'relay-error', code: 'not_found' },
      { kind: 'relay-error', code: 'forbidden' },
      { kind: 'given-up', reason: 'too-old' },
      { kind: 'given-up', reason: 'queue-full' },
      { kind: 'no-target' },
    ]
    for (const failure of cases) {
      expect(sendFailureLine(failure)).not.toMatch(/^that device/)
      expect(sendFailureLine(failure)).toMatch(/^[A-Z]/)
    }
  })
})

/**
 * The one failure Tabsend decides by itself (INTERACTION_FLOWS §4f). Everything
 * else in this union is the relay's verdict or the network's; this is the client
 * saying it has stopped holding a tab, so the sentence has to carry the number
 * that decided it — "seven days" tells a self-hoster their relay has been down
 * for a week, and it is the only thing in the line they can act on.
 */
describe('given up on', () => {
  it('says how long it waited, and that nothing was sent', () => {
    const line = sendFailureLine({ kind: 'given-up', reason: 'too-old' })
    expect(line).toContain('7 days')
    expect(line).toContain('Send it again')
  })

  it('says what the cap is when newer sends pushed a tab out', () => {
    const line = sendFailureLine({ kind: 'given-up', reason: 'queue-full' })
    expect(line).toContain('200')
    expect(line).toContain('oldest')
  })

  /** Both are FINAL. The queue kept the tab through every 429, every 5xx and
   *  every silence; giving up is what ends that, so it can't be a retry state. */
  it('is never recoverable — it is what ends the retrying', () => {
    expect(isRecoverableFailure({ kind: 'given-up', reason: 'too-old' })).toBe(false)
    expect(isRecoverableFailure({ kind: 'given-up', reason: 'queue-full' })).toBe(false)
  })

  it('reads as an error, not as a tab that is still on its way', () => {
    const banner = sendBanner({
      ok: false,
      queued: false,
      offline: false,
      targetLabel: 'Arc · Mac mini',
      failure: { kind: 'given-up', reason: 'too-old' },
    })
    expect(banner.tone).toBe('error')
  })
})

/**
 * A relay that answers "not now" (429, any 5xx) is not a relay that said no.
 * Mirrors SendFeedbackTest.kt / SendFeedbackTests.swift — the three clients are
 * hand-mirrored, so the rule has to read the same in all three suites.
 */
describe('a busy relay is held, not refused', () => {
  it('promises the retry it is actually going to make', () => {
    expect(sendFailureLine({ kind: 'relay-busy' }, 'Arc · Mac mini')).toBe(
      'Your relay is having trouble right now. The tab is held here and sends itself once the relay is answering properly again.',
    )
    expect(sendFailureLine({ kind: 'relay-busy' }, 'Arc · Mac mini', 3)).toContain(
      'The tabs are held here and send themselves',
    )
  })

  it('is recoverable, and the definite answers are not', () => {
    // Treating a 429 or a 5xx as a refusal DISCARDED the tab, and in one drain
    // of the outbound queue discarded every tab it was holding.
    expect(isRecoverableFailure({ kind: 'relay-busy' })).toBe(true)
    expect(isRecoverableFailure({ kind: 'browser-offline' })).toBe(true)
    expect(isRecoverableFailure({ kind: 'relay-unreachable', relayUrl: 'http://x' })).toBe(true)
    expect(isRecoverableFailure({ kind: 'relay-rejected', reason: 'unknown_target' })).toBe(false)
    expect(isRecoverableFailure({ kind: 'relay-error', code: 'internal' })).toBe(false)
    expect(isRecoverableFailure({ kind: 'relay-unauthorized' })).toBe(false)
    expect(isRecoverableFailure({ kind: 'no-target' })).toBe(false)
  })

  it('reads as pending, so nothing tells the user to send it again by hand', () => {
    const banner = sendBanner({
      ok: true,
      queued: false,
      offline: true,
      targetLabel: 'Arc · Mac mini',
      failure: { kind: 'relay-busy' },
    })
    expect(banner.tone).toBe('pending')
    expect(banner.headline).toBe('Waiting to send to Arc · Mac mini')
    expect(banner.detail).toContain('sends itself')
  })
})

/**
 * A per-group cap [0030] refuses one item at a time, inside a 200. Every one of
 * these caps clears itself, so the refusal is a WAIT, not a verdict — and the
 * copy has to say so, because the client is already holding the tab and
 * retrying it. Before this, every cap refusal rendered "Something went wrong
 * inside your relay", which named no cause and asked for the wrong action.
 *
 * Mirrors SendFeedbackTest.kt / SendFeedbackTests.swift — the three clients are
 * hand-mirrored, so the rule reads the same in all three suites.
 */
describe('a cap refusal is a wait, not a refusal', () => {
  const limits: GroupLimit[] = ['sends_per_window', 'queued_messages', 'queued_bytes', 'endpoints']

  it('is recoverable, whether or not the relay named the cap', () => {
    expect(isCapRejection('limit_reached')).toBe(true)
    expect(isCapRejection('unknown_target')).toBe(false)
    expect(isRecoverableFailure({ kind: 'relay-rejected', reason: 'limit_reached' })).toBe(true)
    for (const limit of limits) {
      expect(isRecoverableFailure({ kind: 'relay-rejected', reason: 'limit_reached', limit })).toBe(
        true,
      )
    }
  })

  it('names the pacing cap and promises the retry it is going to make', () => {
    expect(
      sendFailureLine({
        kind: 'relay-rejected',
        reason: 'limit_reached',
        limit: 'sends_per_window',
      }),
    ).toBe(
      'Your relay is pacing sends for your group right now. This tab is queued and will send itself shortly.',
    )
  })

  it('says what ends the wait when the relay is full, which is the target reading', () => {
    for (const limit of ['queued_messages', 'queued_bytes'] as GroupLimit[]) {
      expect(sendFailureLine({ kind: 'relay-rejected', reason: 'limit_reached', limit })).toBe(
        "Your relay is holding as much as your group's limit allows. This tab is queued and will send once the receiving device catches up.",
      )
    }
  })

  // A relay that names no cap, or names a fifth one this build has never heard
  // of, still gets a true sentence rather than the internal-error line.
  it('has a general line for an unnamed cap', () => {
    expect(sendFailureLine({ kind: 'relay-rejected', reason: 'limit_reached' })).toBe(
      'Your relay has reached a limit for your group. This tab is queued and will send itself once there is room.',
    )
    expect(sendFailureLine({ kind: 'relay-rejected', reason: 'limit_reached' })).not.toContain(
      'went wrong',
    )
  })

  it('counts the tabs of a batch', () => {
    expect(
      sendFailureLine(
        { kind: 'relay-rejected', reason: 'limit_reached', limit: 'sends_per_window' },
        'Arc',
        3,
      ),
    ).toContain('These tabs are queued')
  })

  it('reads as pending, so nothing tells the user to send it again by hand', () => {
    const banner = sendBanner({
      ok: true,
      queued: false,
      offline: false,
      targetLabel: 'Arc · Mac mini',
      failure: { kind: 'relay-rejected', reason: 'limit_reached', limit: 'sends_per_window' },
    })
    expect(banner.tone).toBe('pending')
    expect(banner.headline).toBe('Waiting to send to Arc · Mac mini')
    expect(banner.detail).toContain('will send itself shortly')
  })

  // "Sent 2 of 3" plus a count of refusals would send the user off to resend a
  // tab the client is already resending.
  it('a partial batch names the cap instead of counting refusals', () => {
    const banner = sendBanner({
      ok: true,
      queued: false,
      offline: false,
      targetLabel: 'Pixel · Phone',
      count: 3,
      rejectedCount: 1,
      failure: { kind: 'relay-rejected', reason: 'limit_reached', limit: 'queued_bytes' },
    })
    expect(banner.tone).toBe('pending')
    expect(banner.headline).toBe('Sent 2 of 3 tabs to Pixel · Phone')
    expect(banner.detail).toBe(
      "Your relay is holding as much as your group's limit allows. This tab is queued and will send once the receiving device catches up.",
    )
  })

  it('keeps the house copy rules', () => {
    const lines = limits
      .map((limit) => sendFailureLine({ kind: 'relay-rejected', reason: 'limit_reached', limit }))
      .concat(
        sendFailureLine({ kind: 'relay-rejected', reason: 'limit_reached' }),
        sendFailureLine({ kind: 'relay-rejected', reason: 'limit_reached' }, 'Arc', 3),
      )
    for (const line of lines) {
      expect(line).not.toContain('—')
      expect(line).not.toMatch(/limit_reached|sends_per_window|queued_messages|queued_bytes/)
      expect(line).toMatch(/^[A-Z]/)
    }
  })
})

/**
 * The OTHER half of [0030], and the opposite kind of answer: the endpoint cap
 * refuses a whole register call, and a group that is full stays full until a
 * person removes a device. So this line asks for an action where the send-side
 * cap lines promise a retry, and it must never fold to the internal-error line.
 *
 * Word-for-word the same sentence in `SendFeedback.kt` and `SendFeedback.swift`.
 */
describe('the device cap turning a browser away', () => {
  it('names the action rather than blaming the relay', () => {
    expect(sendFailureLine({ kind: 'relay-error', code: 'limit_reached' })).toBe(
      'Your relay has reached its device limit for your group. Remove a device you are not using, then pair this one again.',
    )
    expect(sendFailureLine({ kind: 'relay-error', code: 'limit_reached' })).not.toContain(
      'went wrong',
    )
  })

  // A join is not a send: nothing was queued, so nothing may read as pending.
  it('is final, and reads as one', () => {
    expect(isRecoverableFailure({ kind: 'relay-error', code: 'limit_reached' })).toBe(false)
    const banner = sendBanner({
      ok: false,
      queued: false,
      offline: false,
      targetLabel: 'Arc · Mac mini',
      failure: { kind: 'relay-error', code: 'limit_reached' },
    })
    expect(banner.tone).toBe('error')
  })

  it('keeps the house copy rules', () => {
    const line = sendFailureLine({ kind: 'relay-error', code: 'limit_reached' })
    expect(line).not.toContain('—')
    expect(line).not.toMatch(/limit_reached|endpoints/)
    expect(line).toMatch(/^[A-Z]/)
  })
})

describe('sendBanner', () => {
  const label = 'Arc · Mac mini'
  const title = 'Setting up a LAN relay'

  it('says "Sent" only when the relay actually took it', () => {
    const banner = sendBanner({
      ok: true,
      queued: false,
      offline: false,
      targetLabel: label,
      title,
    })
    expect(banner).toEqual({ tone: 'success', headline: 'Sent to Arc · Mac mini', title })
  })

  it('an asleep target is still a success — the relay has it', () => {
    const banner = sendBanner({ ok: true, queued: true, offline: false, targetLabel: label })
    expect(banner.tone).toBe('success')
    expect(banner.detail).toBe('Opens when it wakes')
  })

  // THE regression: a dead relay used to return ok:true and render as "Sent".
  it('a tab merely held locally is pending, never "Sent"', () => {
    const banner = sendBanner({
      ok: true,
      queued: false,
      offline: true,
      targetLabel: label,
      title,
      failure: { kind: 'relay-unreachable', relayUrl: 'http://192.168.1.50:8787' },
    })
    expect(banner.tone).toBe('pending')
    expect(banner.headline).toBe('Waiting to send to Arc · Mac mini')
    expect(banner.headline).not.toMatch(/^Sent/)
    expect(banner.detail).toContain('http://192.168.1.50:8787')
  })

  it('a refusal needs the user, so it reads as an error', () => {
    const banner = sendBanner({
      ok: false,
      queued: false,
      offline: false,
      targetLabel: label,
      failure: { kind: 'relay-rejected', reason: 'unknown_target' },
    })
    expect(banner.tone).toBe('error')
    expect(banner.headline).toBe("Couldn't send to Arc · Mac mini")
    // The device name reaches the status line, not just the headline.
    expect(banner.detail).toContain('Arc · Mac mini')
  })

  it('carries the tab title so the user knows WHICH tab it means', () => {
    expect(sendBanner({ ok: true, queued: false, offline: false, title }).title).toBe(title)
    expect(sendBanner({ ok: true, queued: false, offline: false }).title).toBeUndefined()
  })

  it('the undo-window banner promises nothing — nothing has been sent yet', () => {
    expect(sendingBanner(label, title)).toEqual({
      tone: 'pending',
      headline: 'Sending to Arc · Mac mini',
      title,
    })
  })
})

describe('multi-tab copy', () => {
  const label = 'Pixel · Phone'

  it('counts the batch when it all went', () => {
    const banner = sendBanner({
      ok: true,
      queued: false,
      offline: false,
      targetLabel: label,
      count: 3,
    })
    expect(banner).toEqual({ tone: 'success', headline: 'Sent 3 tabs to Pixel · Phone' })
  })

  it('an asleep target pluralizes the caveat', () => {
    const banner = sendBanner({
      ok: true,
      queued: true,
      offline: false,
      targetLabel: label,
      count: 3,
    })
    expect(banner.tone).toBe('success')
    expect(banner.headline).toBe('Sent 3 tabs to Pixel · Phone')
    expect(banner.detail).toBe('They open when it wakes')
  })

  it('a partial delivery says both halves and never rounds up to "Sent 3"', () => {
    const banner = sendBanner({
      ok: true,
      queued: false,
      offline: false,
      targetLabel: label,
      count: 3,
      rejectedCount: 1,
      failure: { kind: 'relay-rejected', reason: 'expired_key' },
    })
    expect(banner.tone).toBe('error') // the refused tab will not retry itself
    expect(banner.headline).toBe('Sent 2 of 3 tabs to Pixel · Phone')
    expect(banner.detail).toBe('The relay refused 1.')
  })

  it('a batch held locally counts the tabs and pluralizes the promise', () => {
    const banner = sendBanner({
      ok: true,
      queued: false,
      offline: true,
      targetLabel: label,
      count: 3,
      failure: { kind: 'relay-unreachable', relayUrl: 'http://192.168.1.50:8787' },
    })
    expect(banner.tone).toBe('pending')
    expect(banner.headline).toBe('Waiting to send 3 tabs to Pixel · Phone')
    expect(banner.detail).toBe(
      "Can't reach your relay at http://192.168.1.50:8787. The tabs are held here and send themselves once the relay answers again.",
    )
  })

  it('a full-batch refusal counts the tabs in the error headline', () => {
    const banner = sendBanner({
      ok: false,
      queued: false,
      offline: false,
      targetLabel: label,
      count: 3,
      rejectedCount: 3,
      failure: { kind: 'relay-rejected', reason: 'unknown_target' },
    })
    expect(banner.tone).toBe('error')
    expect(banner.headline).toBe("Couldn't send 3 tabs to Pixel · Phone")
    expect(banner.detail).toContain('these tabs')
  })

  it('the badge tooltip carries the same counts', () => {
    expect(
      sendFeedbackLine({ ok: true, queued: false, offline: false, targetLabel: label, count: 3 }),
    ).toBe('Sent 3 tabs to Pixel · Phone')
    expect(
      sendFeedbackLine({
        ok: true,
        queued: false,
        offline: false,
        targetLabel: label,
        count: 3,
        rejectedCount: 1,
        failure: { kind: 'relay-rejected', reason: 'expired_key' },
      }),
    ).toBe('Sent 2 of 3 tabs to Pixel · Phone. The relay refused 1.')
  })

  it('the quick-send optimistic banner counts too, still never claiming "Sent"', () => {
    const banner = sendingBanner('Arc · Mac mini', 'One', undefined, 3)
    expect(banner.headline).toBe('Sending 3 tabs to Arc · Mac mini')
    expect(banner.headline).not.toMatch(/^Sent\b/)
  })

  it('the chooser strip says what a click will do', () => {
    expect(multiSelectionLine(3)).toBe('3 tabs selected. A click sends all 3.')
  })

  it('a count of one changes NOTHING — single sends read exactly as before', () => {
    const single = sendBanner({ ok: true, queued: false, offline: false, targetLabel: label })
    expect(single.headline).toBe('Sent to Pixel · Phone')
    expect(sendFailureLine({ kind: 'browser-offline' }, undefined, 1)).toBe(
      "You're offline. This tab sends itself as soon as you're back.",
    )
  })

  it('uses no em dashes in any of the plural lines', () => {
    const lines = [
      sendBanner({ ok: true, queued: true, offline: false, targetLabel: label, count: 3 }),
      sendBanner({
        ok: true,
        queued: false,
        offline: false,
        targetLabel: label,
        count: 3,
        rejectedCount: 1,
        failure: { kind: 'relay-rejected', reason: 'expired_key' } as SendFailure,
      }),
    ].flatMap((b) => [b.headline, b.detail ?? ''])
    lines.push(
      multiSelectionLine(3),
      sendFailureLine({ kind: 'browser-offline' }, undefined, 3),
      sendFailureLine({ kind: 'relay-unreachable', relayUrl: 'http://x' }, undefined, 3),
      sendFailureLine({ kind: 'relay-rejected', reason: 'unknown_target' }, 'Arc', 3),
    )
    for (const line of lines) expect(line).not.toContain('—')
  })
})

describe('held-tab list', () => {
  it('prefers the page title', () => {
    expect(heldTabLabel({ title: 'An article', url: 'https://example.com/a' })).toBe('An article')
  })

  // A bare path tells nobody anything; the site at least places the tab.
  it('falls back to the site when a tab had no title', () => {
    expect(heldTabLabel({ url: 'https://developer.mozilla.org/en-US/docs/Web' })).toBe(
      'developer.mozilla.org',
    )
    expect(heldTabLabel({ title: '   ', url: 'https://example.com/x' })).toBe('example.com')
  })

  it('survives a url it cannot parse, and one that is missing', () => {
    expect(heldTabLabel({ url: 'not a url' })).toBe('not a url')
    expect(heldTabLabel({})).toBe('Untitled tab')
  })

  it('heading counts, and reads naturally at one', () => {
    expect(heldTabsHeading(1)).toBe('Waiting on this browser')
    expect(heldTabsHeading(3)).toBe('3 tabs waiting on this browser')
  })

  it('names the tab when exactly one drained', () => {
    expect(recoveredLine(1, 'An article')).toBe('Sent “An article”')
    expect(recoveredLine(1)).toBe('Sent the tab that was waiting')
    expect(recoveredLine(4)).toBe('Sent 4 tabs that were waiting')
  })

  // The other half of the same promise: a held tab the relay finally refuses
  // used to leave the queue in silence, after the user had been told it was
  // waiting and had walked away.
  it('says so when a held tab was refused instead of sent', () => {
    expect(droppedLine(1, 'An article')).toBe("Couldn't send “An article”")
    expect(droppedLine(1)).toBe("Couldn't send the tab that was waiting")
    expect(droppedLine(4)).toBe("Couldn't send 4 tabs that were waiting")
    expect(droppedLine(4)).not.toContain('—')
  })
})

describe('receivedNotificationLine', () => {
  it('names the sender for a single tab', () => {
    expect(receivedNotificationLine([item('a', 'Pixel 8')])).toBe('Tab received from Pixel 8')
  })

  it('counts several tabs from the same sender', () => {
    const items = [item('a', 'Pixel 8'), item('b', 'Pixel 8'), item('c', 'Pixel 8')]
    expect(receivedNotificationLine(items)).toBe('3 tabs received from Pixel 8')
  })

  // A poll can deliver a genuinely mixed batch — two different devices each
  // sent something in the same pass. Naming one of them would misattribute
  // the other's tab, so this counts devices instead of picking one.
  it('counts devices instead of naming one when senders differ', () => {
    const items = [item('a', 'Pixel 8'), item('b', 'Chrome · Work')]
    expect(receivedNotificationLine(items)).toBe('2 tabs received from 2 devices')
  })
})

describe('arrivalPlaceLine', () => {
  const titled = (id: string, title: string): InboxItem => ({ ...item(id, 'Pixel 8'), title })

  it('names the tab and the window it went to', () => {
    expect(
      arrivalPlaceLine([titled('a', 'Lemon pasta with peas')], {
        kind: 'window',
        activeTitle: 'Inbox – Gmail',
      }),
    ).toBe('Lemon pasta with peas — opened in the window with “Inbox – Gmail”. Click to show it.')
  })

  it('needs no window name when there is only one window', () => {
    expect(arrivalPlaceLine([titled('a', 'Lemon')], { kind: 'only-window' })).toBe(
      'Lemon — opened in a background tab. Click to show it.',
    )
  })

  it('still says it opened when it cannot tell where', () => {
    expect(arrivalPlaceLine([titled('a', 'Lemon')], { kind: 'unknown' })).toBe(
      'Lemon — opened in a new tab. Click to show it.',
    )
  })

  it('falls back to the host for an untitled tab', () => {
    expect(arrivalPlaceLine([item('a', 'Pixel 8')], { kind: 'unknown' })).toBe(
      'example.com — opened in a new tab. Click to show it.',
    )
  })

  it('counts a batch, like the title line, and the click goes to the first', () => {
    const items = [titled('a', 'One'), titled('b', 'Two'), titled('c', 'Three')]
    expect(arrivalPlaceLine(items, { kind: 'window', activeTitle: 'Docs' })).toBe(
      '3 tabs — opened in the window with “Docs”. Click to show the first.',
    )
    expect(arrivalPlaceLine(items, { kind: 'only-window' })).toBe(
      '3 tabs — opened in background tabs. Click to show the first.',
    )
  })

  it('truncates long titles on both sides', () => {
    const line = arrivalPlaceLine([titled('a', 'A'.repeat(80))], {
      kind: 'window',
      activeTitle: 'B'.repeat(80),
    })
    expect(line).toBe(
      `${'A'.repeat(47)}… — opened in the window with “${'B'.repeat(39)}…”. Click to show it.`,
    )
  })
})

describe('shortTitle', () => {
  it('leaves a short title alone and collapses whitespace', () => {
    expect(shortTitle('  Inbox\n  – Gmail ', 40)).toBe('Inbox – Gmail')
  })

  it('cuts at the limit, ellipsis included, without a dangling space', () => {
    expect(shortTitle('Lemon pasta with peas', 7)).toBe('Lemon…')
  })
})

describe('relayDownLine', () => {
  it('names the address and how long it has been quiet', () => {
    const line = relayDownLine('http://192.168.1.50:8787', 12)
    expect(line).toContain('http://192.168.1.50:8787')
    expect(line).toContain('12m ago')
  })

  it('rolls over to hours', () => {
    expect(relayDownLine('http://x', 125)).toContain('2h ago')
  })

  it('reads sensibly at zero', () => {
    expect(relayDownLine('http://x', 0)).toContain('just now')
  })

  // P-15 item 4: away from home, a home-network relay is silent for a reason the
  // bare outage line did not give, and it read as a refresh bug.
  it('says why a home-network relay is out of reach, and what to do', () => {
    const line = relayDownLine('http://192.168.1.20:8786', 19)
    expect(line).toContain('19m ago')
    expect(line).toContain(HOME_NETWORK_HINT)
    expect(line.endsWith(HOME_NETWORK_HINT)).toBe(true)
    expect(line).not.toContain('—')
    expect(relayDownLine('http://minipc.local:8786', 5)).toContain(HOME_NETWORK_HINT)
  })

  it('adds no home-network line for a public, hosted, Tailscale or same-machine relay', () => {
    for (const url of [
      'https://app.tabsend.org',
      'https://relay.example.com',
      'http://100.101.102.103:8787',
      'http://localhost:8787',
      'http://127.0.0.1:8787',
    ]) {
      expect(relayDownLine(url, 19)).not.toContain(HOME_NETWORK_HINT)
    }
  })
})

describe('soloGroupCopy', () => {
  // The whole point of the notice is telling the user WHERE they are alone —
  // the relay address is what differs when a group has quietly split in two.
  it('names the relay address the browser is alone on', () => {
    expect(soloGroupCopy.body('http://192.168.1.50:8787')).toContain('http://192.168.1.50:8787')
  })
  // The redesign moved the same-relay/different-relay reasoning into the
  // options.html probe verdict itself; this line stays a single finding, not a
  // standing explanation of what to do about it.
  it('is one sentence pair, not a walkthrough', () => {
    expect(soloGroupCopy.body('http://192.168.1.50:8787').split('. ').length).toBeLessThanOrEqual(2)
  })
})
