# Translating OpenFloat

This guide explains how to add or improve a language in the OpenFloat web app.
The interface uses JSON locale files; no translation library or build step is
required.

## What is translated, and where

- `locales/en-US.json` is the US English source locale and the app's default.
- `locales/pt-BR.json` contains Brazilian Portuguese.
- `app/ui/localization.js` loads the selected JSON file, applies translations,
  remembers the choice in browser `localStorage`, and translates text added or
  changed while the app is running.
- `index.html` contains the language selector in **Settings → Preferences**.
- `docs/` contains the Markdown pages shown in the in-app Guide.

The app's locale files are ordinary UTF-8 JSON. Each locale has the same
top-level keys. Most top-level strings are labels and messages used by
`data-i18n` attributes and the OBS overlays. `_text` contains exact interface
phrases, and `_patterns` contains regular-expression translations for messages
that include changing values.

## Translate an existing phrase

1. Find the English phrase in `index.html` or the relevant module in `app/`.
   Search the visible label, status message, accessible name, or confirmation
   text—not a console log or internal identifier.
2. For a static `data-i18n` label, add the same top-level key to both locale
   files. For an exact dynamic phrase, use the literal English phrase as the
   key in the translated locale's `_text` object; `en-US.json` does not need
   self-translations for those source phrases.
3. Keep the key identical to the English source, including punctuation,
   capitalization, spaces, and any symbol that is part of the same text node.
   For example, the warning icon `⚠` belongs in the key when it appears in the
   same paragraph as the sentence. HTML entities such as `&mdash;` are decoded
   by the browser; match the resulting character (`—`) in the JSON key.
4. Preserve product names, technical units, command names, and values that
   should not be localized. Keep translations concise enough for buttons,
   narrow cards, and overlay layouts.

Exact matches are case-sensitive. If HTML markup divides a sentence into
separate text nodes, translate each visible node separately, or change the
markup deliberately and test it. Do not copy English-only text into a
translation key as a shortcut.

### Static labels and accessible text

For static HTML, prefer the existing `data-i18n` pattern:

```html
<button data-i18n="resetCounter">Reset</button>
```

Add the same top-level key to both locale JSON files, for example:

In `locales/en-US.json`:

```json
{ "resetCounter": "Reset" }
```

In `locales/pt-BR.json`:

```json
{ "resetCounter": "Zerar" }
```

Use the corresponding existing attributes for accessible text:
`data-i18n-title` and `data-i18n-aria-label`. The localization observer also
translates `title`, `aria-label`, and `placeholder` values when they are
created or changed dynamically.

For a dynamic message written with `.textContent`, the observer can translate
the exact phrase after it is inserted. For `alert()`, `confirm()`, or messages
that need translation before they are shown, import and call
`translateMessage()` from `app/ui/localization.js`. Prefer adding translations
to the JSON over adding language-specific conditionals to application code.

## Translate messages with changing values

Use `_patterns` when a message contains numbers or other changing text. Patterns
are JavaScript regular expressions matched against the complete source phrase.
Use `$1`, `$2`, and so on for captured values. Use `$t1`, `$t2`, and so on when
a captured value is itself a known phrase that should be translated.

For example, the `pt-BR` locale can translate a source message such as
`Step 2 of 5` with this pattern:

```json
{
  "_patterns": [
    { "pattern": "^Step (\\d+) of (\\d+)$", "replacement": "Etapa $1 de $2" }
  ]
}
```

Escape regex punctuation (`.`, `?`, `(`, `)`, and similar characters) when it
must match literally. Anchor whole-message patterns with `^` and `$` so they do
not translate unrelated text. Order overlapping patterns from most specific
to most general. Do not add a pattern that merely repeats an existing exact
`_text` entry.

Test patterns with at least two different values. Check that punctuation,
spaces, units, and any surrounding warning or status icon are retained.

## Translate Guide pages

Guide pages are Markdown files listed by stable IDs in `docs/index.json`. Keep
the English page under `docs/`; put the translation under `docs/pt-BR/` while
preserving the same relative path and filename.

Then add the stable page ID to `_guidePages` in the translated locale:

```json
{
  "_guidePages": {
    "quick-start": "docs/pt-BR/quick-start.md"
  }
}
```

The English locale can use the default paths from `docs/index.json`. The Guide
uses the page ID for its in-app URL, so keep IDs stable when translating a page.
Use relative Markdown links and image paths that resolve from the translated
file. The Markdown renderer intentionally supports a small safe subset; raw HTML
is displayed as text.

Run `python tools/build_docs_index.py` whenever adding, renaming, or removing an
English source Guide page. Check the generated `docs/index.json` for the
expected page ID and path. Translated pages do not appear separately in the
index; add newly translated Markdown pages to `service-worker.js`'s precache
`ASSETS` list so they are available offline, and bump `CACHE_NAME` so existing
installations fetch the updated documentation.

## Add a new app language

Adding a language requires more than copying a JSON file:

1. Create `locales/<language-tag>.json` using `locales/en-US.json` as the
   top-level structure reference and `locales/pt-BR.json` as the current
   `_text`/`_patterns` inventory. `en-US.json` is the fallback locale and does
   not currently need to map its source phrases to themselves. In the new
   locale, keep English `_text` source keys and source-matching patterns;
   translate their values and replacements.
2. Add the BCP 47 language tag to `SUPPORTED_LOCALES` in
   `app/ui/localization.js`. Choose deliberately whether the default locale
   should change; English is currently the fallback.
3. Add a human-readable `<option>` to `#languageSelect` in `index.html`.
4. Translate each Guide Markdown page under `docs/<language-tag>/` and map its
   stable ID in `_guidePages`. The docs index generator omits locale folders
   from the sidebar, while the selected locale maps the same IDs to those files.
5. Add locale JSON and translated Guide pages to the service-worker precache,
   then bump its cache version.
6. Add tests for matching locale structure, Guide paths, persistence/fallback,
   and representative exact and patterned messages.
7. Check the Guide, dashboard, Settings, Steady Aim, Saved Shots, dialogs,
   accessible labels, and all four OBS views in the new language. Long phrases
   should remain understandable without clipping or overlapping nearby UI.

## Validate your work

Run the locale tests and then the full suite:

```sh
node --test test/locales.test.js
npm test
```

Also check that JSON parses, keys and patterns are not duplicated, and the diff
has no whitespace errors:

```sh
git diff --check
```

Locale tests verify that English and Portuguese have matching top-level
structure, configured Guide pages exist, the selected language persists, and
representative exact and dynamic translations produce the expected output.
When changing the service worker or Guide index, run the full suite because
offline Guide behavior is tested as well.

## Translation checklist

- [ ] Keep all top-level locale keys in sync with `en-US.json`.
- [ ] Keep source phrase keys, regex captures, and punctuation exact.
- [ ] Translate user-visible and accessible text, including dynamic messages.
- [ ] Include icons in exact keys when they share the same text node.
- [ ] Translate corresponding Guide pages and verify relative links.
- [ ] Keep the Guide index, locale page map, and offline precache consistent.
- [ ] Check the interface at narrow widths and test each OBS overlay route.
- [ ] Run locale tests, the full test suite, and `git diff --check`.
