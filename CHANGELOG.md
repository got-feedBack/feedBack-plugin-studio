# Changelog

All notable changes to the Band Studio plugin are documented here.

## [Unreleased]

### Changed

- **ES-module migration, step 1 — the bootstrap flip (R1b pilot).** `screen.js`
  is now a one-line `import './src/main.js'` and the plugin declares
  `"scriptType": "module"` + `"minHost": "0.3.0-alpha.1"` in `plugin.json`; the
  IIFE body moved verbatim to `src/main.js` (history preserved via `git mv`).
  No behaviour change — studio has no `document.currentScript` / worklet / relative
  asset URLs (every asset + API ref is an absolute `/api/plugins/studio/...` path,
  which is scope-independent), and the 20 inline HTML handlers keep working because
  they call the explicit `window.studio*` exports (unaffected by module scope).
  The `window.showScreen`-wrap re-init and the `__slopsmithStudioHooksInstalled`
  idempotency guard (constitution §V) are runtime mechanisms, preserved as-is.
  This is the R1b pilot's core validation: a plugin with inline-handler + wrap-based
  re-init edges (which stems lacked) loads and re-inits cleanly as a module. The
  body isn't split into multiple modules yet — `src/main.js` is still the whole
  IIFE; the layered `src/**` extraction follows in later steps.
