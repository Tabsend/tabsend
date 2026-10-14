import { describe, expect, it } from 'vitest'
import { qrSvg } from './qr'

describe('qrSvg', () => {
  it('produces a self-contained, square SVG with dark modules', () => {
    const svg = qrSvg('https://relay.example/pair#c=ABC12345')
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"')
    expect(svg).toContain('aria-label="Pairing QR code"')
    // At least one dark module rect was emitted.
    expect(svg).toContain('<rect')
    // Square viewBox.
    const m = svg.match(/viewBox="0 0 (\d+) (\d+)"/)
    expect(m).not.toBeNull()
    expect(m?.[1]).toBe(m?.[2])
  })

  it('encodes different payloads into different matrices', () => {
    expect(qrSvg('AAA11111')).not.toBe(qrSvg('BBB22222'))
  })
})
