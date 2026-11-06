/**
 * Test support for the pseudo-locale (en-XA): decides whether a piece of text came through the
 * catalog. In en-XA every catalog message is accented and wrapped in brackets, so once the
 * bracketed parts are taken out, only words a person supplied (a device name, a page title) may
 * be left. A sentence that was typed into the code shows up as plain words.
 */

/** Text with every `[...]` removed, innermost first (messages can sit inside messages). */
export function withoutPseudoText(text: string): string {
  let out = text
  for (let previous = ''; previous !== out; ) {
    previous = out
    out = out.replace(/\[[^[\]]*\]/g, ' ')
  }
  return out
}

/** The words in `text` that are not inside a pseudo-locale message and not in `allowed`. */
export function unlocalizedWords(text: string, allowed: readonly string[]): string[] {
  const known = new Set(allowed.flatMap((value) => value.match(/\p{L}+/gu) ?? []))
  return (withoutPseudoText(text).match(/\p{L}+/gu) ?? []).filter((word) => !known.has(word))
}
