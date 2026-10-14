import { describe, expect, it } from 'vitest'
import { isPublicPushAddress, publicOnlyLookup, validatePushEndpoint } from '../src/push-egress'

describe('Web Push destination policy', () => {
  it.each([
    '127.0.0.1',
    '10.0.0.1',
    '169.254.169.254',
    '192.168.1.4',
    '100.64.0.1',
    '192.0.2.1',
    '198.51.100.1',
    '203.0.113.1',
    '::1',
    'fd00::1',
    'fe80::1',
    '2001:db8::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '64:ff9b::a9fe:a9fe',
    '2002:7f00:1::',
  ])('classifies %s as non-public', (address) => {
    expect(isPublicPushAddress(address)).toBe(false)
  })

  it.each(['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111'])('classifies %s as public', (address) => {
    expect(isPublicPushAddress(address)).toBe(true)
  })

  it.each([
    'http://push.example/endpoint',
    'https://user:pass@push.example/endpoint',
    'https://localhost/endpoint',
    'https://service.internal/endpoint',
    'https://127.0.0.1/endpoint',
    'https://[::1]/endpoint',
    'https://push.example/endpoint#fragment',
  ])('rejects an unsafe endpoint: %s', (endpoint) => {
    expect(() => validatePushEndpoint(endpoint)).toThrow()
  })

  it('allows an explicit private destination only for an opted-in self-hoster', () => {
    expect(validatePushEndpoint('https://192.168.1.20:8443/push', true).hostname).toBe(
      '192.168.1.20',
    )
  })

  it('blocks a private DNS answer during the actual connection lookup', async () => {
    const error = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
      publicOnlyLookup('localhost', {}, (err) => resolve(err))
    })
    expect(error?.code).toBe('EHOSTUNREACH')
  })
})
