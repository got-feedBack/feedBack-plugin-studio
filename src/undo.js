// Undo/redo + debounced server mix-save. Snapshots are JSON of S.mixState;
// stack depth MAX_UNDO; slider drags coalesce, toggles snapshot immediately
// (constitution §VI). _applyRestoredMixState re-applies a snapshot to the live
// audio graph + re-renders — so this imports the lower audio/viz/render layers.
import { S } from './state.js';
import { _applyAllMixToLive, _getAudioCtx } from './audio-graph.js';
import { _drawAllCursors } from './viz.js';
import { _renderTracks } from './render.js';

const MAX_UNDO = 50;

export function _pushUndo() {
    // Debounce: don't capture every slider tick, wait for a pause
    if (S.undoDebounceTimer) clearTimeout(S.undoDebounceTimer);
    S.undoDebounceTimer = setTimeout(() => {
        const snapshot = JSON.stringify(S.mixState);
        // Don't push if identical to last
        if (S.undoStack.length && S.undoStack[S.undoStack.length - 1] === snapshot) return;
        S.undoStack.push(snapshot);
        if (S.undoStack.length > MAX_UNDO) S.undoStack.shift();
        S.redoStack = []; // new change clears redo
        _updateUndoButtons();
    }, 500);
}

export function _captureUndoNow() {
    // Immediate capture (for discrete actions like mute/solo toggles)
    if (S.undoDebounceTimer) clearTimeout(S.undoDebounceTimer);
    const snapshot = JSON.stringify(S.mixState);
    if (S.undoStack.length && S.undoStack[S.undoStack.length - 1] === snapshot) return;
    S.undoStack.push(snapshot);
    if (S.undoStack.length > MAX_UNDO) S.undoStack.shift();
    S.redoStack = [];
    _updateUndoButtons();
}

export function _applyRestoredMixState() {
    // Re-render tracks to reflect new slider values
    _renderTracks();
    // Apply to live audio if playing
    _applyAllMixToLive();
    // Save to server
    _debounceSaveMix();
    _updateUndoButtons();
    // Redraw waveforms
    const curTime = S.isPlaying ? (_getAudioCtx().currentTime - S.startTime) : S.pauseOffset;
    _drawAllCursors(curTime);
}

function _updateUndoButtons() {
    const undoBtn = document.getElementById('studio-btn-undo');
    const redoBtn = document.getElementById('studio-btn-redo');
    if (undoBtn) undoBtn.disabled = !S.undoStack.length;
    if (redoBtn) redoBtn.disabled = !S.redoStack.length;
    if (undoBtn) undoBtn.classList.toggle('opacity-30', !S.undoStack.length);
    if (redoBtn) redoBtn.classList.toggle('opacity-30', !S.redoStack.length);
}

async function _saveMixSettings() {
    if (!S.currentSession) return;
    const settings = [];
    for (const key of Object.keys(S.mixState)) {
        if (key === 'original') continue;
        const s = S.mixState[key];
        settings.push({
            track_id: parseInt(key),
            volume: s.volume,
            pan: s.pan,
            muted: s.muted ? 1 : 0,
            solo: s.solo ? 1 : 0,
            offset_ms: s.offset_ms || 0,
            fade_in_ms: s.fade_in_ms || 0,
            fade_out_ms: s.fade_out_ms || 0,
            eq_low: s.eq_low || 0,
            eq_mid: s.eq_mid || 0,
            eq_high: s.eq_high || 0,
            reverb_send: s.reverb_send || 0,
            comp_threshold: s.comp_threshold ?? -24,
            comp_ratio: s.comp_ratio ?? 1,
            comp_attack: s.comp_attack ?? 0.003,
            comp_release: s.comp_release ?? 0.25,
        });
    }
    try {
        await fetch(`/api/plugins/studio/sessions/${S.currentSession.id}/mix-settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ settings }),
        });
    } catch (e) {
        console.error('[Studio] Failed to save mix settings:', e);
    }
}

export function _debounceSaveMix() {
    if (S.saveMixTimer) clearTimeout(S.saveMixTimer);
    S.saveMixTimer = setTimeout(_saveMixSettings, 1000);
}
