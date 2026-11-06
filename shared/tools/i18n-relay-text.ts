/**
 * Finds code that puts an error's own text in front of a person. The relay's `message` is
 * English, written for a log and free to change, and an exception's text is a developer's
 * (`Failed to fetch`, `Unexpected token <`). Neither belongs on a screen, in any language
 * (docs/L10N.md, rule 8). A screen asks the surface's `failureText` / `relayErrorText`
 * instead, which chooses a catalog sentence from the machine-readable code.
 *
 *   err.message     error.message     String(err)     String(error)
 *
 * A line that is right as it is says why with a comment, on the same line or the one above:
 *
 *   // relay-text-ignore: a sentence from our own catalog, thrown by us
 *
 * The same check, in the same spirit, runs on the iPhone app (`ios/tools/check-l10n.mjs`).
 */
const RELAY_TEXT = /(?<![.\w])(?:error|err)\.message\b|\bString\(\s*(?:error|err)\s*\)/

export function relayTextProblems(file: string, text: string): string[] {
  const lines = text.split('\n')
  const problems: string[] = []
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n] ?? ''
    const trimmed = line.trim()
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue
    if (!RELAY_TEXT.test(line)) continue
    if (/relay-text-ignore:/.test(line) || /relay-text-ignore:/.test(lines[n - 1] ?? '')) continue
    problems.push(
      `${file}:${n + 1}: shows an error's own text, which is English (the relay's, or an exception's). ` +
        'Use the surface\'s failureText / relayErrorText, or say why with "// relay-text-ignore: <reason>".',
    )
  }
  return problems
}
