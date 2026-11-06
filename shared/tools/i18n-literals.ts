/**
 * Finds words written into the code that a person would read, instead of coming from the
 * catalog. It looks where text reaches the screen, the toolbar, a menu or a notification:
 *
 *   el.textContent = '...'      el.title = ...     el.setAttribute('aria-label', '...')
 *   { title: '...', message: '...', label: '...' }     new Error('...')     confirm('...')
 *
 * A literal with at least two letters in a row, outside `${...}`, is a problem. Symbols
 * (`'×'`, `'✓'`, `''`) are not words. A line that is right as it is says why with a comment,
 * on the same line or the one above:
 *
 *   // i18n-ignore: stylesheet, not text
 *
 * The pseudo-locale (en-XA) is the main proof that nothing was missed; this is the cheap
 * check that runs in every test, and it stops the easy mistake of typing a sentence in code.
 */

const SINK_ASSIGN =
  /\.(?:textContent|innerText|title|placeholder|alt|ariaLabel|ariaDescription|label)\s*=(?!=)\s*/
const SINK_ATTRIBUTE =
  /\.setAttribute\(\s*['"](?:aria-label|aria-description|aria-roledescription|title|placeholder|alt)['"]\s*,\s*/
const SINK_PROPERTY =
  /\b(?:title|message|headline|detail|label|text|tooltip|placeholder|description)\s*:\s*(?=['"`])/
const SINK_CALL = /\b(?:new Error|confirm|alert|prompt)\(\s*/

/** The fixed text pieces of a line's string and template literals. */
function literalText(code: string): string[] {
  const pieces: string[] = []
  let i = 0
  while (i < code.length) {
    const quote = code.charAt(i)
    if (quote !== "'" && quote !== '"' && quote !== '`') {
      i++
      continue
    }
    let text = ''
    i++
    while (i < code.length && code.charAt(i) !== quote) {
      const c = code.charAt(i)
      if (c === '\\') {
        text += code.charAt(i + 1)
        i += 2
      } else if (quote === '`' && c === '$' && code.charAt(i + 1) === '{') {
        i++
        let depth = 0
        do {
          if (code.charAt(i) === '{') depth++
          if (code.charAt(i) === '}') depth--
          i++
        } while (i < code.length && depth > 0)
        text += ' '
      } else {
        text += c
        i++
      }
    }
    i++
    pieces.push(text)
  }
  return pieces
}

const CONTINUES = /(?:\?|:|\+|\|\||&&|\?\?|\(|,|=)\s*$/
const STARTS_CONTINUATION = /^\s*(?:\?|:|\+|\|\||&&|\?\?|\.)/

export interface LiteralOptions {
  /**
   * More places where text reaches the screen, for a surface that builds its page in its own
   * way. Each pattern must match just before the value starts, as the built-in ones do (the
   * scanner reads the literals after the match). The console adds its DOM helper `el(...)`.
   */
  sinks?: readonly RegExp[]
}

export function literalProblems(
  file: string,
  text: string,
  options: LiteralOptions = {},
): string[] {
  const lines = text.split('\n')
  const problems: string[] = []
  const builtIn = [SINK_ASSIGN, SINK_ATTRIBUTE, SINK_PROPERTY, SINK_CALL]
  const sinks = [...builtIn, ...(options.sinks ?? [])]
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n] ?? ''
    const trimmed = line.trim()
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue
    for (const sink of sinks) {
      const m = sink.exec(line)
      if (!m) continue
      // The value may run on to the next lines (a ternary, a long concatenation). A surface's
      // own sinks read the one line they match: the next line is the next child.
      let value = line.slice(m.index + m[0].length)
      let last = line
      for (let k = 1; k <= (builtIn.includes(sink) ? 5 : 0); k++) {
        const next = lines[n + k]
        if (next === undefined) break
        if (!CONTINUES.test(last) && !STARTS_CONTINUATION.test(next)) break
        value += `\n${next}`
        last = next
      }
      // The key in t('area.group.name') is not text.
      value = value.replace(/(?<![\w.$])(?:t|richNodes)\(\s*(['"`])[^'"`]*\1/g, 't(')
      const words = literalText(value).filter((piece) => /\p{L}{2,}/u.test(piece))
      if (words.length === 0) continue
      const ignored = /i18n-ignore:/.test(line) || /i18n-ignore:/.test(lines[n - 1] ?? '')
      if (ignored) continue
      problems.push(
        `${file}:${n + 1}: text in code, not in the catalog: ${JSON.stringify(words[0])}`,
      )
    }
  }
  return problems
}
