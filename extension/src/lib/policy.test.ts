import type { Endpoint, IsoTimestamp } from '@tabsend/shared'
import { describe, expect, it } from 'vitest'
import {
  isEmbeddedFavicon,
  isOpenableWebUrl,
  isPresenceFresh,
  isStaleEndpoint,
  PRESENCE_TRUST_MS,
  SOLO_GROUP_GRACE_MS,
  STALE_ENDPOINT_THRESHOLD_MS,
  shouldWarnSoloGroup,
} from './policy'

describe('isOpenableWebUrl', () => {
  it.each(['https://example.com/path', 'http://127.0.0.1:8786/page', 'HTTPS://example.com'])(
    'allows %s',
    (url) => {
      expect(isOpenableWebUrl(url)).toBe(true)
    },
  )

  it.each([
    'javascript:alert(1)',
    'data:text/html,hello',
    'file:///etc/passwd',
    'intent://example.com',
    'tabsend://join?c=secret',
    'https:path-without-a-host',
    '//example.com/path',
    'not a url',
    '',
  ])('rejects %s', (url) => {
    expect(isOpenableWebUrl(url)).toBe(false)
  })

  it('rejects non-string wire values', () => {
    expect(isOpenableWebUrl(undefined)).toBe(false)
    expect(isOpenableWebUrl({ url: 'https://example.com' })).toBe(false)
  })
})

function endpoint(presence: 'online' | 'offline', lastSeenMsAgo: number): Endpoint {
  return {
    id: 'e1' as Endpoint['id'],
    groupId: 'g1' as Endpoint['groupId'],
    kind: 'extension',
    browser: 'chrome',
    platform: 'macos',
    label: 'Chrome · Work',
    e2ePubkey: 'pk',
    presence,
    lastSeenAt: new Date(Date.now() - lastSeenMsAgo).toISOString() as IsoTimestamp,
    createdAt: new Date().toISOString() as IsoTimestamp,
  }
}

describe('isStaleEndpoint', () => {
  it('is never stale while online', () => {
    expect(isStaleEndpoint(endpoint('online', STALE_ENDPOINT_THRESHOLD_MS * 2))).toBe(false)
  })
  it('is stale when offline past the threshold', () => {
    expect(isStaleEndpoint(endpoint('offline', STALE_ENDPOINT_THRESHOLD_MS + 60_000))).toBe(true)
  })
  it('is not stale when offline but recent', () => {
    expect(isStaleEndpoint(endpoint('offline', 60_000))).toBe(false)
  })
})

describe('shouldWarnSoloGroup', () => {
  const old = new Date(Date.now() - SOLO_GROUP_GRACE_MS - 60_000).toISOString()

  it('warns when an established group holds only this browser', () => {
    expect(shouldWarnSoloGroup({ deviceCount: 1, registeredAt: old })).toBe(true)
  })
  it('stays quiet in the minutes after creating a group', () => {
    expect(shouldWarnSoloGroup({ deviceCount: 1, registeredAt: new Date().toISOString() })).toBe(
      false,
    )
  })
  it('stays quiet on the create-then-pair run itself, whatever the clock says', () => {
    expect(shouldWarnSoloGroup({ deviceCount: 1, registeredAt: old, justRegistered: true })).toBe(
      false,
    )
  })
  it('stays quiet once there is company', () => {
    expect(shouldWarnSoloGroup({ deviceCount: 2, registeredAt: old })).toBe(false)
  })
  // 0 devices is "we never got the list" (relay down, cold cache), not an empty
  // group — warning there would fire every time the relay is briefly away.
  it('stays quiet when the device list came back empty', () => {
    expect(shouldWarnSoloGroup({ deviceCount: 0, registeredAt: old })).toBe(false)
  })
  it('warns on a registration made before registeredAt existed', () => {
    expect(shouldWarnSoloGroup({ deviceCount: 1 })).toBe(true)
  })
})

describe('isPresenceFresh', () => {
  const now = 1_800_000_000_000

  it("trusts a snapshot taken inside the relay's own online window", () => {
    expect(isPresenceFresh(now - PRESENCE_TRUST_MS + 1_000, now)).toBe(true)
  })

  // The relay would already have flipped this endpoint to offline; repeating the
  // cached "online" here is the green dot beside a relay-down banner.
  it('stops trusting one older than that window', () => {
    expect(isPresenceFresh(now - PRESENCE_TRUST_MS - 1_000, now)).toBe(false)
  })

  it('treats an hours-old snapshot (a relay outage) as unknown', () => {
    expect(isPresenceFresh(now - 2 * 60 * 60 * 1000, now)).toBe(false)
  })

  // A cache written before the timestamp existed. Unknown is the safe reading.
  it('treats a missing timestamp as unknown', () => {
    expect(isPresenceFresh(undefined, now)).toBe(false)
  })
})

describe('isEmbeddedFavicon', () => {
  it('allows only an embedded image, never an address to fetch', () => {
    expect(isEmbeddedFavicon('data:image/png;base64,iVBORw0KGgo=')).toBe(true)
    expect(isEmbeddedFavicon('DATA:image/x-icon;base64,AAAB')).toBe(true)
    for (const v of [
      'https://tracker.example/pixel.png',
      'http://example.com/favicon.ico',
      'data:text/html,<b>x</b>',
      'chrome://favicon/https://example.com',
      '',
      undefined,
      42,
    ]) {
      expect(isEmbeddedFavicon(v)).toBe(false)
    }
  })
})
