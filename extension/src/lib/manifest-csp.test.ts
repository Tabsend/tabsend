import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// The extension's own pages may load pictures only from the extension, from data: and from https:
// pages. A picture on a page the sender chose can answer with a redirect to an address inside the
// reader's network; the policy is checked again at each hop, so a hop to http: is refused
// (security review v0.11.0, HP4). Chrome and Firefox read their own manifest.
describe.each(['manifest.json', 'manifest.firefox.json'])('%s content security policy', (file) => {
  const manifest = JSON.parse(
    readFileSync(new URL(`../../public/${file}`, import.meta.url), 'utf8'),
  ) as { content_security_policy: { extension_pages: string } }
  const policy = manifest.content_security_policy.extension_pages

  it('limits pictures to the extension, data: and https:', () => {
    expect(policy).toContain("img-src 'self' data: https:")
  })

  it('keeps scripts to the extension and forbids a new base address', () => {
    expect(policy).toContain("script-src 'self'")
    expect(policy).toContain("base-uri 'none'")
    expect(policy).not.toContain('unsafe-inline')
  })
})
