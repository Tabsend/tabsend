# Tabsend web console

A small web page (`app.tabsend.org`, or any relay's own address) that pairs with a group as a
device of its own, lists the devices and shows the group's history. It never sends a tab. Vite
and TypeScript, no UI framework. The decisions behind it are ADR-0010 and ADR-0028.

```bash
pnpm --filter @tabsend/console dev          # dev server, proxies /v1 to a relay on :8787
pnpm --filter @tabsend/console test         # logic, screens and language checks, no browser
pnpm --filter @tabsend/console build        # console/dist, served by the relay
```

## Text and languages

Every sentence a person reads lives in a message catalog, so a language can be added by
translating catalogs and changing no code. English is the only language shipped today (owner
ruling 2026-11-03). Rules shared with the other apps: `docs/L10N.md`.

**Which language?** The browser's (`navigator.languages`, best first, `de-AT` then `de` then
English). The console has no account: it holds a pairing, never an email address or a profile, so
the browser is the only signal it has. The account language (`accounts.locale` on
account.tabsend.org) never reaches it; using it would mean the relay carrying it, which is a
separate decision, together with a language switcher (sketch options first).

### Where things are

| What | Where |
|---|---|
| Messages, one folder per language, small files by area | `src/locales/en/*.json` |
| `t()`, loading the folders, the locale for dates | `src/lib/i18n.ts` |
| Choosing the language, fallbacks, the formatter (plurals, placeholders, en-XA) | `../shared/src/i18n.ts` |
| A sentence with a link inside it (`<link>…</link>`) | `richNodes` in `src/ui/dom.ts` |
| Page title, description and no-script text (`index.html`) | `data-i18n` attributes, filled at build time |
| Reading catalogs, the build plugins, the checks (shared with the extension) | `../shared/tools/`, bound to this folder by `tools/i18n-vite.ts` |
| Checks | `src/lib/i18n-catalog.test.ts`, `i18n-parity.test.ts`, `src/ui/app.pseudo.test.ts`, `*.golden.test.ts` |

A catalog file is `{ "area.group.name": { "message": "...", "description": "..." } }`. The
description is for the translator and is dropped from the build. Messages use ICU syntax:
`Sent to {device}`, `{count, plural, one {# tab} other {# tabs}}`,
`{hasBrowser, select, yes {...} other {}}`. `#` is the number inside a plural. The file name is
the first word of its keys (`devices.json` holds `devices.*`).

### Add a string

1. Pick the area file in `src/locales/en/` and a key `area.group.name` that says where and why,
   never the English text.
2. Add `{ "message": "...", "description": "..." }`. The description says where it shows, what each
   `{placeholder}` is, and any length limit.
3. Use it: `t('area.group.name', { device: label })` in code; `data-i18n="area.group.name"` (or
   `data-i18n-attrs`, `data-i18n-rich`) in `index.html`. A sentence with a link goes through
   `richNodes('key', args, { link: (text) => el('a', {...}, text) })`.
4. A count that changes the wording goes into the message as a `plural`, never into code as
   `count === 1`. Write whole sentences; never join pieces ("Sent to " + name).
5. Run `pnpm --filter @tabsend/console test`. It fails if a key is missing, unused, misspelled or
   given the wrong placeholder names, if a sentence is typed into the code, or if a screen shows
   plain words in the pseudo-language. If a line is right as it is, say why with
   `// i18n-ignore: reason`. Never put an error's own text on the screen: a relay refusal is
   worded from its `code` (`relayErrorLine` in `src/lib/relay-errors.ts`, chosen by what the
   person was doing), and `failureText` in `src/lib/failure-text.ts` is the one place that turns a
   thrown error into the status line. A test fails on `err.message` or `String(err)` in shipped
   code; if one is right as it is, say why with `// relay-text-ignore: reason`. If the English is meant to change, refresh the golden files with
   `UPDATE_GOLDEN=1 pnpm --filter @tabsend/console test golden`.

### Add a language

1. Copy `src/locales/en/` to `src/locales/<id>/` (BCP 47: `de`, `pt-BR`, `zh-Hant`).
2. Translate the `message` of each entry. Keep the keys and the `{placeholders}`. Use the plural
   forms the language needs (`one`, `few`, `many`, `other`; `other` is required).
3. Run the tests. A missing key, an unknown key or a changed placeholder is reported.
4. Translate the same sentences the same way as the browser extension:
   `src/lib/i18n-parity.test.ts` lists the sentences both say (the reset, the history states, the
   new-device warning, the times). Look at the page in a real browser with long words (German).
5. Build. No code changes: every folder under `src/locales/` is bundled, and the page picks the
   language from the browser. `index.html`'s no-script text is the one thing a script cannot
   change (a browser with scripts off runs no code), so it stays English.

### See what is not translated

```bash
TABSEND_LOCALE=en-XA pnpm --filter @tabsend/console build   # console/dist-pseudo
TABSEND_LOCALE=en-XA pnpm --filter @tabsend/console dev     # the dev server, in the pseudo-language
```

Every message shows accented, about 40 percent longer, in brackets (`[Šéñţ ţö Pixel 9~~]`).
Anything without brackets never reached a catalog; anything that no longer fits is a layout that
will break in German. The build goes to its own folder, so it cannot be served by mistake.

### Things to know

- A language other than English shows English for a message it lacks or breaks; never a key.
- Dates and numbers go through `Intl`. "October 27" and "3:05 PM" (the reset card) use the
  language on screen, as in the extension and the apps. The longer date in a tooltip
  (`absoluteTime`) keeps the browser's own regional form of that language (`en-GB` stays
  `en-GB`), as it always did. The short relative times (`5m ago`) are catalog messages on
  purpose: the shipped English is an abbreviation that `Intl.RelativeTimeFormat` does not produce.
- Messages kept in state (the status line at the bottom, the note under the QR code, the name
  of a device whose name was never seen) are worded when they are made, in the language then on
  screen. The language does not change while the page is open, so this is only visible in a
  history entry saved earlier.
- Not translated on purpose: the name Tabsend, the names of browsers and systems (Chrome,
  macOS), addresses, and developer errors. The relay's own error text is never shown: the
  status line words each refusal itself, from its code.
- The name suggested in the name box ("Web console · Mac") is catalog text (`onboarding.name.*`,
  `docs/L10N.md` rule 12). `shared/src/naming.ts` keeps its English default for the relay and the
  apps; a test holds the two identical in English.
- The console and the extension keep separate catalogs. The sentences they share have the same
  key where possible, and the parity test holds their English to one wording.
