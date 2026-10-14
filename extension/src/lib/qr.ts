import qrcode from 'qrcode-generator'

/**
 * Render a string as a self-contained QR SVG (qrcode-generator, MIT). Used for
 * the pairing payload so a phone can scan an already-paired browser
 * (INTERACTION_FLOWS §6.2). We build the SVG from the module matrix ourselves —
 * always dark-on-light with a quiet-zone margin regardless of page theme, since
 * a scanner needs high contrast and a light background (a QR must not invert in
 * dark mode).
 */
interface QrLayout {
  cell: number
  size: number
  darkModules: Array<{ x: number; y: number }>
}

function qrLayout(text: string, opts: { cellSize?: number; margin?: number } = {}): QrLayout {
  const cell = opts.cellSize ?? 4
  const margin = opts.margin ?? 4

  // Error-correction 'M' is the pairing-QR sweet spot; type 0 auto-sizes to fit.
  const qr = qrcode(0, 'M')
  qr.addData(text)
  qr.make()

  const count = qr.getModuleCount()
  const size = (count + margin * 2) * cell

  const darkModules: QrLayout['darkModules'] = []
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) {
      if (!qr.isDark(row, col)) continue
      darkModules.push({ x: (col + margin) * cell, y: (row + margin) * cell })
    }
  }

  return { cell, size, darkModules }
}

export function qrSvg(text: string, opts: { cellSize?: number; margin?: number } = {}): string {
  const { cell, size, darkModules } = qrLayout(text, opts)
  const rects = darkModules
    .map(({ x, y }) => `<rect x="${x}" y="${y}" width="${cell}" height="${cell}"/>`)
    .join('')

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" ` +
    `viewBox="0 0 ${size} ${size}" role="img" aria-label="Pairing QR code">` +
    `<rect width="${size}" height="${size}" fill="#ffffff"/>` +
    `<g fill="#000000">${rects}</g></svg>`
  )
}

/** Build the same QR as DOM nodes so extension pages never need `innerHTML`. */
export function qrElement(
  text: string,
  opts: { cellSize?: number; margin?: number } = {},
): SVGSVGElement {
  const { cell, size, darkModules } = qrLayout(text, opts)
  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`)
  svg.setAttribute('role', 'img')
  svg.setAttribute('aria-label', 'Pairing QR code')

  const background = document.createElementNS(ns, 'rect')
  background.setAttribute('width', String(size))
  background.setAttribute('height', String(size))
  background.setAttribute('fill', '#ffffff')
  svg.append(background)

  const modules = document.createElementNS(ns, 'g')
  modules.setAttribute('fill', '#000000')
  for (const { x, y } of darkModules) {
    const rect = document.createElementNS(ns, 'rect')
    rect.setAttribute('x', String(x))
    rect.setAttribute('y', String(y))
    rect.setAttribute('width', String(cell))
    rect.setAttribute('height', String(cell))
    modules.append(rect)
  }
  svg.append(modules)
  return svg
}
