import qrcode from 'qrcode-generator'

/**
 * Render a string as a self-contained QR SVG (qrcode-generator, MIT) — mirrors the
 * extension's qr helper. Always dark-on-light with a quiet-zone margin regardless
 * of page theme: a scanner needs high contrast, so the QR must not invert in dark
 * mode. Used for the "add a device" pairing payload (INTERACTION_FLOWS §6.2).
 */
export function qrSvg(text: string, opts: { cellSize?: number; margin?: number } = {}): string {
  const cell = opts.cellSize ?? 4
  const margin = opts.margin ?? 4

  const qr = qrcode(0, 'M')
  qr.addData(text)
  qr.make()

  const count = qr.getModuleCount()
  const size = (count + margin * 2) * cell

  let rects = ''
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) {
      if (!qr.isDark(row, col)) continue
      const x = (col + margin) * cell
      const y = (row + margin) * cell
      rects += `<rect x="${x}" y="${y}" width="${cell}" height="${cell}"/>`
    }
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" ` +
    `viewBox="0 0 ${size} ${size}" role="img" aria-label="Pairing QR code">` +
    `<rect width="${size}" height="${size}" fill="#ffffff"/>` +
    `<g fill="#000000">${rects}</g></svg>`
  )
}
