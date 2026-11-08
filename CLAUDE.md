# CLAUDE.md

Chrome extension (Manifest V3, plain JS, no build step). Forces another time zone on chosen websites.
See README.md for features, files and the release steps.

## Key facts

- `src/inject.js` exports `tzcPatch(cfg)`. It is serialized with `toString()` and run in the page MAIN world
  (user script code, or `chrome.scripting.executeScript({ func })`). Keep it self-contained: no imports,
  no outer variables. `cfg = { tz, rx }` where `rx` are RegExp source strings from `src/match.js`.
- Injection mode: `chrome.userScripts` when the user turned on "Allow User Scripts" (reliable, runs first).
  Otherwise fallback on `webNavigation.onCommitted` + `executeScript({ injectImmediately: true })`,
  which often loses the race against inline `<head>` scripts.
- Debugger mode: `chrome.debugger` + `Emulation.setTimezoneOverride`. If the attach finishes after the
  page committed, the tab is reloaded once.
- Settings live in `chrome.storage.local` (`enabled`, `timezone`, `domains`, `mode`).
- The developer's PC is in Asia/Tehran: tests must use other zones to see a difference.
  Port 8765 is used by another local app; the e2e test uses 18765.

## Tests

- `npm test` – compares patched `Date`/`Intl` against Node running with the real `TZ` (many zones, DST cases).
- `npm run e2e` – real Chromium (Playwright build) with the extension loaded; covers fallback,
  user scripts (it clicks "Allow User Scripts" on chrome://extensions), disabled state and debugger mode.

## Deploy

"Deploy" = GitHub Release with the zip from `npm run zip` (`git archive`; `.gitattributes` export-ignore
keeps `*.md`, `reference-docs/`, `tools/`, `screenshots/` and `.claude/` out of the zip).
There is no server deploy. The Chrome Web Store upload is manual (owner's developer account).
