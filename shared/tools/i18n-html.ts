import { splitRich } from '../src/i18n'

/**
 * Fills the pages' static text from the message catalog at build time. The HTML source
 * holds no sentences, only where each message goes:
 *
 *   <h1 data-i18n="chooser.title"></h1>                      text of the element
 *   <button data-i18n-attrs="title:chooser.settings.hint;aria-label:chooser.settings.aria">
 *   <p data-i18n-rich="options.move.hint"><a data-i18n-tag="link" href="..."></a></p>
 *
 * A `data-i18n` element may hold only text. A `data-i18n-rich` element holds the real
 * child elements its message names with `<tag>…</tag>`; they keep their address, class and
 * look and take their words from the message. The page runs the same rules again when it
 * starts, in the visitor's language (src/lib/i18n-dom.ts).
 */

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// One attribute inside a start tag: ` name`, ` name="value"`, ` name='value'` or ` name=value`.
const UNQUOTED = '[^\\s"\'<>=`]+'
const ATTR = `\\s+[^\\s"'<>/=]+(?:\\s*=\\s*(?:"[^"]*"|'[^']*'|${UNQUOTED}))?`
// Comments, script and style blocks pass through untouched; the rest are start tags.
const SCAN = new RegExp(
  `<!--[\\s\\S]*?-->|<(script|style)\\b[\\s\\S]*?</\\1>|<([a-zA-Z][\\w-]*)((?:${ATTR})*)\\s*(/?)>`,
  'g',
)

function attributeValue(attrs: string, name: string): string | undefined {
  const re = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`)
  const m = re.exec(attrs)
  return m ? (m[1] ?? m[2]) : undefined
}

function withoutAttribute(attrs: string, name: string): string {
  return attrs.replace(new RegExp(`\\s+${name}(?:\\s*=\\s*(?:"[^"]*"|'[^']*'|${UNQUOTED}))?`), '')
}

/** Index just past the closing tag that matches the open tag ending at `from`. */
function closingTag(html: string, tag: string, from: number): { start: number; end: number } {
  const re = new RegExp(`<(/?)${tag}(?=[\\s>/])[^>]*>`, 'gi')
  re.lastIndex = from
  let depth = 1
  for (let m = re.exec(html); m; m = re.exec(html)) {
    if (m[1]) depth--
    else if (!m[0].endsWith('/>')) depth++
    if (depth === 0) return { start: m.index, end: m.index + m[0].length }
  }
  throw new Error(`No closing </${tag}> for a data-i18n element`)
}

function fillRich(inner: string, message: string, key: string): string {
  const children = new Map<string, { open: string; close: string }>()
  const child =
    /<([a-zA-Z][\w-]*)((?:\s+[^>]*?)?\sdata-i18n-tag="([a-z][a-z0-9]*)"[^>]*)>[\s\S]*?<\/\1>/g
  for (const m of inner.matchAll(child)) {
    children.set(m[3] ?? '', { open: `<${m[1]}${m[2]}>`, close: `</${m[1]}>` })
  }
  return splitRich(message)
    .map((part) => {
      if (typeof part === 'string') return escapeHtml(part)
      const el = children.get(part.tag)
      if (!el)
        throw new Error(
          `"${key}" uses <${part.tag}> but the HTML has no data-i18n-tag="${part.tag}"`,
        )
      return `${el.open}${escapeHtml(part.text)}${el.close}`
    })
    .join('')
}

export function fillHtml(html: string, lookup: (key: string) => string): string {
  const re = new RegExp(SCAN.source, 'g')
  let out = ''
  let pos = 0
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const tag = m[2]
    if (tag === undefined) continue // a comment, script or style block: copied as is later
    const rawAttrs = m[3] ?? ''
    const key = attributeValue(rawAttrs, 'data-i18n')
    const richKey = attributeValue(rawAttrs, 'data-i18n-rich')
    const attrPairs = attributeValue(rawAttrs, 'data-i18n-attrs')
    if (key === undefined && richKey === undefined && attrPairs === undefined) continue

    let attrs = rawAttrs
    for (const pair of (attrPairs ?? '').split(';').filter((p) => p.trim() !== '')) {
      const [name, attrKey] = pair.split(':').map((s) => s.trim())
      if (!name || !attrKey) throw new Error(`Bad data-i18n-attrs "${attrPairs}" on <${tag}>`)
      attrs = `${withoutAttribute(attrs, name)} ${name}="${escapeHtml(lookup(attrKey))}"`
    }
    const open = `<${tag}${attrs}${m[4] ?? ''}>`
    out += html.slice(pos, m.index) + open
    pos = m.index + m[0].length
    re.lastIndex = pos

    const textKey = key ?? richKey
    if (textKey === undefined) continue
    const close = closingTag(html, tag, pos)
    const inner = html.slice(pos, close.start)
    if (key !== undefined) {
      if (inner.includes('<'))
        throw new Error(`data-i18n="${key}" holds markup; use data-i18n-rich`)
      out += escapeHtml(lookup(key))
    } else {
      out += fillRich(inner, lookup(textKey), textKey)
    }
    pos = close.start
    re.lastIndex = pos
  }
  return out + html.slice(pos)
}

const DECODE: Record<string, string> = {
  '&lt;': '<',
  '&gt;': '>',
  '&amp;': '&',
  '&quot;': '"',
  '&#39;': "'",
  '&nbsp;': ' ',
}

function decode(text: string): string {
  return text.replace(/&(?:lt|gt|amp|quot|nbsp|#39);/g, (m) => DECODE[m] ?? m)
}

/** The attributes a person can read or hear. */
const VISIBLE_ATTRS = ['title', 'aria-label', 'placeholder', 'alt', 'value', 'content']

/**
 * Everything a page shows or speaks, in reading order, as one line: the text between tags
 * and the readable attributes, spaces collapsed. Used to prove the page says exactly what it
 * said before its text moved into the catalog (tools/html-text.golden.json), and to find
 * text that never reached it: in a source page only `data-i18n` elements may hold words.
 */
export function visibleText(html: string): string {
  const out: string[] = []
  const re = new RegExp(`${SCAN.source}|</[a-zA-Z][^>]*>|<![^>]*>|([^<]+)`, 'g')
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const text = m[5]
    if (text !== undefined) {
      const t = decode(text).replace(/\s+/g, ' ').trim()
      if (t !== '') out.push(t)
      continue
    }
    const tag = m[2]
    if (tag === undefined) continue
    // <meta name=viewport content=...> is not read by anyone; <meta name=description> is.
    if (tag === 'meta' && attributeValue(m[3] ?? '', 'name') !== 'description') continue
    for (const name of VISIBLE_ATTRS) {
      const value = attributeValue(m[3] ?? '', name)
      if (value === undefined) continue
      if (name === 'value' && tag !== 'button') continue
      out.push(`[${name}=${decode(value).replace(/\s+/g, ' ').trim()}]`)
    }
  }
  return out.join(' ')
}
