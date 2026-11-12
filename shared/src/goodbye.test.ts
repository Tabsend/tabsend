import { describe, expect, it } from 'vitest';
import { goodbyeUrl, UNINSTALL_URL_MAX } from './goodbye';

describe('goodbyeUrl', () => {
  it('puts the leave token in the fragment, never the query', () => {
    const url = goodbyeUrl('https://app.tabsend.org', 'abc_DEF-123');
    expect(url).toBe('https://app.tabsend.org/goodbye#t=abc_DEF-123');
    expect(url).not.toContain('?');
  });

  it('keeps a relay that lives under a path, and drops a stored query or trailing slash', () => {
    expect(goodbyeUrl('https://example.net/tabsend/?x=1#y', 'tok')).toBe(
      'https://example.net/tabsend/goodbye#t=tok',
    );
    expect(goodbyeUrl('http://192.168.1.5:8080/', 'tok')).toBe('http://192.168.1.5:8080/goodbye#t=tok');
  });

  it('sets nothing for an empty token, a non-web address or a bad one', () => {
    expect(goodbyeUrl('https://app.tabsend.org', '')).toBeNull();
    expect(goodbyeUrl('ftp://example.net', 'tok')).toBeNull();
    expect(goodbyeUrl('not a url', 'tok')).toBeNull();
  });

  it('sets nothing rather than an address the browser would refuse', () => {
    const relay = `https://example.net/${'a'.repeat(UNINSTALL_URL_MAX)}`;
    expect(goodbyeUrl(relay, 'tok')).toBeNull();
    const fits = goodbyeUrl('https://app.tabsend.org', 'x'.repeat(43));
    expect(fits).not.toBeNull();
    expect((fits as string).length).toBeLessThanOrEqual(UNINSTALL_URL_MAX);
  });
});
