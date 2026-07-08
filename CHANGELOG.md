# Changelog

All notable changes to the Band Studio plugin are documented here.

## [Unreleased]

### Changed

- **ES-module migration, step 5 — extract the Web Audio engine to
  `src/audio-graph.js`.** The playback graph (`_getAudioCtx`, `_createReverbBus`,
  `_play`/`_pause`, `_stopAllSources`, `_applyMixToLiveAudio`/`_applyAllMixToLive`,
  `_hasSoloActive`) moves out of `main.js`. It's the lower audio layer — the
  per-frame playhead loop + master meter it kicks off (`_startAnimLoop`/
  `_stopAnimLoop`/`_startMasterMeter`, which live with the animation/render layer)
  are injected via `configureAudioGraph({...})` at boot, so audio-graph doesn't
  import back into `main.js` (no cycle). Bodies moved verbatim bar the hook calls.
  Move-only, no behaviour change.

- **ES-module migration, step 4 — extract settings persistence to `src/prefs.js`.**
  `_loadSettings` / `_saveSettings` (localStorage-backed user name + input device,
  now reading/writing the `S` container) move to their own module with real-import
  tests (`tests/prefs.test.mjs`, in-memory localStorage stub). `main.js` imports
  them by the same names. Move-only, no behaviour change.

- **ES-module migration, step 3 — the reassigned scalars → `S` object in
  `src/state.js`.** All 66 IIFE-scope `_foo` scalars (playback clock, audio
  graph, mix/undo state, recording, punch, highway-record, settings) move into a
  single exported `S` container — ES imports are read-only bindings, so
  `export let x` can't be reassigned from `main.js`, but `S.x = …` can. Every
  `_foo` reference becomes `S.foo` (608 sites; underscore dropped). Rewrite was
  audited safe first: no name appears as an object key or inside a string/comment
  literal (the string-adjacent hits were all `${}` template expressions or fn
  args), verified 0 bare refs + 0 double-prefix after. Move-only, no behaviour
  change. Keystone for extracting the functional modules next.

- **ES-module migration, step 2 — extract pure helpers to `src/util.js`.** Nine
  state-free helpers (`_parseTimeInput`, `_formatTime`, `_formatDate`, `_esc`,
  `Path_stem`, `_eqLabel`, `_compLabel`, `_polarToCartesian`, `_describeArc`) move
  to their own module with real-import tests (`tests/util.test.mjs`); adds
  `package.json` so the reusable CI runs `npm test`. `main.js` imports them by the
  same names — call sites unchanged. Move-only, no behaviour change.

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
