// Tests for android/tools/check-l10n.mjs: the checker must catch what it says it catches.
//   node --test android/tools/check-l10n.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  checkCatalog,
  checkTranslation,
  findCountChecks,
  findRelayMessage,
  findTypedText,
  kotlinLiterals,
  parseCatalog,
} from './check-l10n.mjs'

const collect = () => {
  const problems = []
  return { problems, fail: (where, what) => problems.push(`${where}: ${what}`) }
}

test('the lexer finds literals, resolves escapes and blanks out templates', () => {
  const lits = kotlinLiterals('val a = "Sent to $name\\n"\nval b = "x ${f("inner text")} y"\nval c = \'"\'\n// "in a comment"\n/* "and here" */\nval d = "end"')
  assert.deepEqual(
    lits.map((l) => l.text),
    ['Sent to \u0001\n', 'inner text', 'x \u0001 y', 'end'],
  )
  assert.equal(lits.at(-1).line, 6)
})

test('a typed-in sentence is found, wherever it is shown', () => {
  const code = [
    'binding.joinStatus.text = "Paste or scan a complete setup link."',
    'Toast.makeText(this, "Copied", Toast.LENGTH_SHORT).show()',
    'setPositiveButton("Unpair") { }',
    'val label = "Sent to $name"',
  ].join('\n')
  assert.deepEqual(findTypedText(code).map((p) => p.line), [1, 2, 3, 4])
})

test('text that never reaches a person is let through', () => {
  const code = [
    'Log.d(TAG, "network watch unavailable: ${e.message}")',
    'throw CertificateException(',
    '    "Relay certificate does not match the pinned key.",',
    ')',
    'val r = Request.Builder().header("Authorization", "Bearer $token")',
    'private const val TAG = "Tabsend"',
    'val type = "application/json; charset=utf-8".toMediaType()',
    'val parts = text.split(Regex("\\\\s+"))',
    'val key = "send_status"',
    'val f = "not a sentence either" // l10n-ignore: test fixture',
    '// l10n-ignore: clipboard label, never shown',
    'copy("Tabsend setup link", link)',
  ].join('\n')
  assert.deepEqual(findTypedText(code), [])
})

test('a count compared to 1 beside a string resource is English-style plural logic', () => {
  const code = 'val t = if (count == 1) getString(R.string.one_tab) else getString(R.string.many_tabs, count)'
  assert.equal(findCountChecks(code).length, 1)
  assert.equal(findCountChecks('val single = items.size == 1\nuse(single)').length, 0)
  assert.equal(findCountChecks('// l10n-ignore: not grammar\nif (count == 1) getString(R.string.x)').length, 0)
})

test("the relay's own message may not be read by a screen", () => {
  assert.equal(findRelayMessage('toastLong(e.message.orEmpty())').length, 1)
  assert.equal(findRelayMessage('val m = Protocol.message(text, check)').length, 0)
  assert.equal(findRelayMessage('Log.w(TAG, "failed: ${e.message}")').length, 0)
})

const catalog = (body) => parseCatalog(`<resources>\n${body}\n</resources>`)

test('every entry needs a comment, and the comment names each placeholder', () => {
  const { problems, fail } = collect()
  checkCatalog(
    catalog(`
    <string name="plain">Plain</string>

    <!-- Where it shows. %1$s is the device. -->
    <string name="good">Sent to %1$s</string>

    <!-- Where it shows. -->
    <string name="unexplained">From %1$s to %2$s</string>`),
    fail,
    'x',
  )
  assert.equal(problems.length, 3)
  assert.match(problems[0], /plain: no translator comment/)
  assert.match(problems.join('\n'), /unexplained: its comment does not say what %1\$s holds/)
  assert.match(problems.join('\n'), /unexplained: its comment does not say what %2\$s holds/)
})

test('a comment above a short run covers the run', () => {
  const { problems, fail } = collect()
  checkCatalog(
    catalog(`
    <!-- Tab names on the bottom bar. -->
    <string name="a">Home</string>
    <string name="b">History</string>`),
    fail,
    'x',
  )
  assert.deepEqual(problems, [])
})

test('a number is a plural, unless the comment says it is not a count', () => {
  const { problems, fail } = collect()
  checkCatalog(
    catalog(`
    <!-- %1$d is how many. -->
    <string name="count">%1$d tabs</string>

    <!-- %1$d is a version, not a count. -->
    <string name="version">v%1$d</string>

    <!-- %1$d is how many. -->
    <plurals name="ok"><item quantity="one">%1$d tab</item><item quantity="other">%1$d tabs</item></plurals>

    <!-- %1$d is how many. -->
    <plurals name="short"><item quantity="other">%1$d tabs</item></plurals>`),
    fail,
    'x',
  )
  assert.equal(problems.length, 2)
  assert.match(problems[0], /count: prints a number/)
  assert.match(problems[1], /short: a <plurals> needs a "one" form/)
})

test('new English copy has no exclamation mark and no em dash', () => {
  const { problems, fail } = collect()
  checkCatalog(
    catalog(`
    <!-- A. -->
    <string name="shout">Done!</string>

    <!-- A. -->
    <string name="dash">Sent — now</string>

    <!-- A. -->
    <string name="send_hard_error">Couldn't send — check Tabsend is still linked</string>`),
    fail,
    'x',
  )
  assert.match(problems.join('\n'), /shout: no exclamation marks/)
  assert.match(problems.join('\n'), /dash: no em dashes/)
  assert.doesNotMatch(problems.join('\n'), /send_hard_error: no em dashes/)
})

test('another language must have the same keys and placeholders as English', () => {
  const en = catalog(`
    <!-- Where. %1$s is the device. -->
    <string name="sent">Sent to %1$s</string>

    <!-- Where. %1$d is how many. -->
    <plurals name="tabs"><item quantity="one">%1$d tab</item><item quantity="other">%1$d tabs</item></plurals>

    <!-- Where. -->
    <string name="missing">Missing</string>

    <!-- Product name. -->
    <string name="app_name" translatable="false">Tabsend</string>`)
  const good = catalog(`
    <string name="sent">An %1$s gesendet</string>
    <plurals name="tabs"><item quantity="one">Ein Tab</item><item quantity="other">%1$d Tabs</item></plurals>
    <string name="missing">Fehlt</string>`)
  const ok = collect()
  checkTranslation(en, good, ok.fail, 'values-de')
  assert.deepEqual(ok.problems, [])

  const bad = catalog(`
    <string name="sent">Gesendet an %1$s und %2$s</string>
    <plurals name="tabs"><item quantity="few">%1$d Tabs</item></plurals>
    <string name="old">Alt</string>
    <string name="app_name">Tabsend</string>`)
  const err = collect()
  checkTranslation(en, bad, err.fail, 'values-de')
  const text = err.problems.join('\n')
  assert.match(text, /missing: missing/)
  assert.match(text, /sent: has %2\$s, which English does not/)
  assert.match(text, /tabs: a <plurals> needs an "other" form/)
  assert.match(text, /old: not in English/)
  assert.match(text, /app_name: marked translatable="false"/)
})

test('character literals, including escapes and a quote, do not start a string', () => {
  const lits = kotlinLiterals("val a = '\"'\nval b = '\\u00e9'\nval c = '\\''\nval d = \"after the chars\"")
  assert.deepEqual(lits.map((l) => l.text), ['after the chars'])
})
