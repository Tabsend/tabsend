# Tabsend browser extension

The Chrome and Firefox extension: one codebase, two builds.

```bash
pnpm --filter @tabsend/extension build            # extension/dist (Chrome)
pnpm --filter @tabsend/extension build:firefox    # extension/dist-firefox
pnpm --filter @tabsend/extension test
```

After a rebuild, reload the extension in `chrome://extensions`. Chromium keeps the old service
worker running otherwise, and the popup and the worker end up being different builds.

## Text and languages

Every sentence a person reads lives in a message catalog, so a language can be added by
translating catalogs and changing no code. English is the only language shipped today
(owner ruling 2026-11-03). Rules shared with the other apps: `docs/L10N.md`.

### Why our own catalog (and not only `chrome.i18n`)

Chosen: **a hybrid with one source.** The browser's own `_locales/` mechanism for the few
strings only the browser can read (the extension's name and description, the toolbar tooltip,
the two shortcut names), and our own small message formatter for everything else. Both come
from the same catalog files, so a translator works in one place.

| | `chrome.i18n` only | Own catalog only | **Hybrid (chosen)** |
|---|---|---|---|
| Plurals (45 of the 313 messages change with a count) | No. One key per form and hand-written selection code in every caller. | Yes, `Intl.PluralRules`, written in the message | Yes |
| Named placeholders a translator can move | Numbered `$1`, named only through a side table | `{device}` in the sentence | Yes |
| Localized name and description in the store and the extensions list | Yes | No: the browser cannot read them | Yes, generated into `_locales/` |
| Works in the service worker (no DOM) | Yes | Yes, plain code | Yes |
| Follows the browser's language | Yes | Yes, `getUILanguage()` | Yes |
| Pseudo-locale for testing | No (needs a browser started in another language) | Yes, a build switch | Yes |
| Testable in plain Node | Needs mocks | Yes | Yes |
| Size | Nothing | About 4.5 kB of formatter (2.2 kB gzipped), no library | Same; with all 313 messages the extension's JavaScript grows by 30 kB, 3.4 percent |

Not chosen: a message-format library. Those either generate code with `new Function`, which
this extension's content security policy forbids, or weigh many times what this needs. The
formatter and the language chooser are `shared/src/i18n.ts`, about 350 lines with tests, so
the web console can use them too.

### Where things are

| What | Where |
|---|---|
| Messages, one folder per language, small files by area | `src/locales/en/*.json` |
| `t()`, loading the folders | `src/lib/i18n.ts` |
| Choosing the language, fallbacks, the formatter (plurals, placeholders, en-XA) | `../shared/src/i18n.ts` |
| Page text from `data-i18n` attributes | `src/lib/i18n-dom.ts`, `../shared/tools/i18n-html.ts` |
| Build plugins (strip notes, fill HTML, write `_locales/`) | `tools/i18n-vite.ts` (the shared part is `../shared/tools/i18n-catalog.ts`; the web console uses it too) |
| Functions that choose a message and hand it names and counts | `src/lib/strings.ts` |
| Checks | `src/lib/i18n-catalog.test.ts`, `src/lib/strings.*.test.ts`, `tools/*.test.ts` |

A catalog file is `{ "area.group.name": { "message": "...", "description": "..." } }`. The
description is for the translator and is dropped from the build. Messages use ICU syntax:
`Sent to {device}`, `{count, plural, one {# tab} other {# tabs}}`,
`{kind, select, tab {...} other {...}}`. `#` is the number inside a plural.

### Add a string

1. Pick the area file (`chooser.json`, `options.json`, ...) and a key `area.group.name` that
   says where and why, never the English text.
2. Add `{ "message": "...", "description": "..." }`. The description says where it shows,
   what each `{placeholder}` is, and any length limit.
3. Use it: `t('area.group.name', { device: label })` in code, or `data-i18n="area.group.name"`
   (also `data-i18n-attrs="title:key;aria-label:key"` and `data-i18n-rich` for a sentence
   with a link in it) in an HTML page.
4. A count that changes the wording goes into the message as a `plural`, never into code as
   `count === 1`. Write whole sentences; never join pieces ("Sent to " + name).
5. Run `pnpm --filter @tabsend/extension test`. It fails if a key is missing, unused,
   misspelled, given the wrong placeholder names, or if a sentence is typed into the code.
   If a line is right as it is (CSS, an internal error), say why with `// i18n-ignore: reason`.

### Add a language

1. Copy `src/locales/en/` to `src/locales/<id>/` (BCP 47: `de`, `pt-BR`, `zh-Hant`).
2. Translate the `message` of each entry. Keep the keys and the `{placeholders}`. Use the
   plural forms the language needs (`one`, `few`, `many`, `other`). `other` is required.
   `manifest.json` is the name, description and shortcut names the browser itself shows.
3. Run the tests. A missing key, an unknown key or a changed placeholder is reported.
4. Build. No code changes: every folder under `src/locales/` is bundled, and the browser
   picks `de-AT` to `de` to `en` from its own language setting.
5. Look at it in the real browser, with long words (German) and tall scripts, then ship.
   The store listing text is separate (`docs/STORE_LISTING.md`).

### See what is not translated

```bash
TABSEND_LOCALE=en-XA pnpm --filter @tabsend/extension build            # extension/dist-pseudo
TABSEND_LOCALE=en-XA pnpm --filter @tabsend/extension build:firefox    # extension/dist-firefox-pseudo
```

Load that folder like the normal build. Every message shows accented, about 40 percent
longer, in brackets (`[Šéñţ ţö Pixel 9~~~~]`). Anything without brackets never reached a
catalog; anything that no longer fits is a layout that will break in German. This build goes
to its own folder, so it cannot be packaged for a store by mistake.

### Things to know

- A language other than English shows English for a message it lacks or breaks; never a key.
- Dates and numbers are formatted for the language of the text shown (`Intl`). The short
  relative times (`5m ago`) are catalog messages on purpose: the shipped English is an
  abbreviation that `Intl.RelativeTimeFormat` does not produce.
- The names filled into the setup page's boxes (`firstrun.device.nameSeed`,
  `firstrun.name.unknownBrowser`) are catalog messages. `shared/src/naming.ts` keeps its English
  defaults for the relay, and `src/lib/strings.seeds.test.ts` keeps both the same in English.
- Where a device's name is unknown, a stand-in phrase goes in its place (`send.fallback.*`,
  "that device"). It sits mid-sentence, so a translator may need to reword the sentence around
  it; the descriptions say so.
- Every language folder is bundled into the service worker (it cannot load more code later).
  A few languages cost little. At about ten, move to fetching the language file at start-up.
- A relay refusal is worded from its `code`, never from the relay's English `message`:
  `relayErrorLine(code, during)` in `src/lib/relay-errors.ts` (`during` is what the person was doing:
  join, rename, remove, setup link, stop a reset, check an address). `failureText(err)` in
  `src/lib/failure-text.ts` is the one place that turns a thrown error into text for a page: a
  relay refusal by its code, a `UserFacingError` as the catalog sentence it carries, anything else
  as `errors.generic`. The background does this before an answer crosses to a page (`rpc.ts`), so a
  page never sees an exception's text. A test fails on `err.message` or `String(err)` in shipped
  code (`shared/tools/i18n-relay-text.ts`); a line that is right as it is says why with
  `// relay-text-ignore: reason`.
- Not translated on purpose: the name Tabsend, logs and developer errors, `offscreen.html` (a
  hidden page).
