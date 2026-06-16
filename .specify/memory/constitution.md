# Band Studio — Constitution

## Inheritance

Slopsmith's core plugin contract governs everything in this repo (manifest,
plugin context: `config_dir` + `get_dlc_dir` + `meta_db`, navigation, asset
serving). This constitution lists Band Studio's own non-negotiables.

## Core Principles

### I. Server is the source of truth for audio files; client is the source of truth for "what the mix sounds like right now"
Recordings, imported audio, and Demucs stems live under
`{CONFIG_DIR}/studio/{session_id}/`. Every mix parameter (volume / pan / EQ /
compressor / reverb / fades / offset) is mirrored in `studio_mix_settings`
and replayed both in the browser (Web Audio) and on the export side
(ffmpeg). The two engines MUST stay numerically congruent. Drift between
them is a bug, not a stylistic choice.

### II. Drift correction lives on the server
MediaRecorder webm streams are not sample-accurate against the song's clock.
The server compares recording duration against expected duration and applies
a tempo correction with ffmpeg `atempo` for drift > 0.05%. The client MUST
NOT pre-correct; raw streams are uploaded as-is so a single decision point
can be audited.

### III. Web Audio rebuilds, never patches
Each `_play()` rebuilds the entire graph (sources, gains, panners,
biquads, compressor, reverb send, master). On `_pause()` the graph is torn
down. This avoids "stuck" parameters across plays and matches the
"recreated each play" comment in `screen.js`. Live mid-playback parameter
changes go through the existing nodes; lifecycle is bounded by play/pause.

### IV. Demucs is optional and remote
The Demucs separation service (`slopsmith-demucs-server`) runs on a host
with GPU/RAM, not inside the Slopsmith container. URL + API key are stored
in the studio's settings panel and passed in by the user. If Demucs is
unconfigured or unreachable, the rest of the studio MUST work — extraction
features simply fail loudly.

### V. Idempotent install
A second evaluation of `screen.js` MUST exit early
(`__slopsmithStudioHooksInstalled` / `…Installing`). Without this guard,
`window.showScreen` wrap chains grow unboundedly, document keydown handlers
fire `studioUndo` twice per shortcut, and the closure leak grows session
state across reloads.

### VI. Undo is debounced, deterministic, bounded
Slider drags coalesce via `_undoDebounceTimer` (~120 ms by convention);
toggles snapshot immediately. Stack depth is `MAX_UNDO = 50`. Snapshots are
JSON-stringified `_mixState`. Identical consecutive snapshots are dropped.
Behaviour MUST be reversible: applying an undo snapshot must reproduce the
same audio output.

### VII. SQLite migrations are additive only
`studio_sessions`, `studio_tracks`, `studio_mix_settings`, `studio_markers`
are migrated by adding columns with defaults. No DROPs, no destructive
renames in place. Defaults match what the client assumes for an
uninitialised mix row (1.0 volume, 0 pan, 0 dB EQ, ratio 1, etc.).

## Governance

Amendments require simultaneous changes in `routes.py`, `screen.js`, and
`README.md` so the server-side mix and client-side preview stay congruent.
The mix-equivalence promise (§I) is enforced by ear today — adding a
golden-render test on the export pipeline is a tracked TODO.

**Version**: 1.0.0 | **Ratified**: 2026-05-09 | **Last Amended**: 2026-05-09
