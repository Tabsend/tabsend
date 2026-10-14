import { describe, expect, it } from 'vitest'
import { base64ToBase64Url, base64UrlToBytes, bytesToBase64 } from './base64'

describe('base64UrlToBytes', () => {
  it('round-trips bytes → base64url → bytes', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 255, 65, 66])
    const b64url = base64ToBase64Url(bytesToBase64(bytes))
    expect(b64url).not.toContain('+')
    expect(b64url).not.toContain('/')
    expect(b64url).not.toContain('=')
    expect([...base64UrlToBytes(b64url)]).toEqual([...bytes])
  })

  it('decodes a realistic 65-byte VAPID-style key length', () => {
    const key = new Uint8Array(65).map((_, i) => (i * 7) % 256)
    const b64url = base64ToBase64Url(bytesToBase64(key))
    expect(base64UrlToBytes(b64url).length).toBe(65)
  })
})
