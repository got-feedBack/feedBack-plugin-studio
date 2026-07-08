import {
    _formatTime, _esc, Path_stem,
    _eqLabel, _compLabel, _describeArc, _getTrackColor,
} from './util.js';
import { S } from './state.js';
import { _loadSettings, _saveSettings } from './prefs.js';
import {
    _getAudioCtx, _play, _pause, _stopAllSources,
    _applyMixToLiveAudio, _applyAllMixToLive, configureAudioGraph,
} from './audio-graph.js';
import {
    _startAnimLoop, _stopAnimLoop, _startMasterMeter, _debounceSaveMaster,
    _drawWaveform, _drawAllCursors, _clampScroll, _initWaveformWheelZoom,
} from './viz.js';
import { _renderSessionList, _renderTracks, _renderMarkers } from './render.js';
import { _pushUndo, _captureUndoNow, _applyRestoredMixState, _debounceSaveMix } from './undo.js';
import { _populatePunchTrackSelect, _stopRecording, configureRecording } from './recording.js';

(function () {
    'use strict';

    // Idempotency: if screen.js is re-evaluated (loader cache miss, hot
    // reload, older core builds without the load-side guard), early-return
    // to avoid: re-wrapping window.showScreen (chain growth + closure leak),
    // re-adding the document-level keydown handler at the bottom of this
    // IIFE (would fire studioUndo / studioRedo twice per shortcut), and
    // overwriting the already-installed window.studio* exports. The
    // first-eval state stays alive in its closures and is still wired to
    // the DOM via window.showScreen.
    if (window.__slopsmithStudioHooksInstalled || window.__slopsmithStudioHooksInstalling) return;
    // ── State ──────────────────────────────────────────────────────────

    // Zoom & scroll state




    window.studioUndo = function () {
        if (!S.undoStack.length) return;
        // Save current state to redo
        S.redoStack.push(JSON.stringify(S.mixState));
        // Restore previous
        const snapshot = S.undoStack.pop();
        S.mixState = JSON.parse(snapshot);
        _applyRestoredMixState();
    };

    window.studioRedo = function () {
        if (!S.redoStack.length) return;
        // Save current state to undo
        S.undoStack.push(JSON.stringify(S.mixState));
        const snapshot = S.redoStack.pop();
        S.mixState = JSON.parse(snapshot);
        _applyRestoredMixState();
    };



    // Recording

    // Waveform peaks cache

    // ── Init & Settings ────────────────────────────────────────────────
    // Settings persistence (_loadSettings/_saveSettings) → src/prefs.js.
    // Wire the audio-graph engine's animation/meter seams back to this layer
    // (hoisted fn decls, so callable now). See src/audio-graph.js.
    configureAudioGraph({
        startAnimLoop: _startAnimLoop,
        stopAnimLoop: _stopAnimLoop,
        startMasterMeter: _startMasterMeter,
    });
    // recording.js reaches session reload through this seam (main owns
    // _reloadSession, which in turn calls recording's _populatePunchTrackSelect).
    configureRecording({ reloadSession: _reloadSession });

    _loadSettings();

    // ── Session List ───────────────────────────────────────────────────

    window.studioInit = async function () {
        await _loadSessionList();
        _populateDevices();
        const nameInput = document.getElementById('studio-user-name');
        if (nameInput && S.userName) nameInput.value = S.userName;
        // If we came back from the player with a session open, reload it
        // so any recordings made on the highway show up immediately
        if (S.currentSession) {
            const mixerView = document.getElementById('studio-mixer-view');
            if (mixerView && !mixerView.classList.contains('hidden')) {
                await _reloadSession();
            }
        }
    };

    function _runStudioInit() {
        Promise.resolve(window.studioInit()).catch((e) => {
            console.error('[Studio] studioInit failed:', e);
        });
    }

    async function _loadSessionList() {
        try {
            const resp = await fetch('/api/plugins/studio/sessions');
            const sessions = await resp.json();
            _renderSessionList(sessions);
        } catch (e) {
            console.error('[Studio] Failed to load sessions:', e);
        }
    }


    // ── New Session ────────────────────────────────────────────────────

    window.studioShowNewSession = function () {
        document.getElementById('studio-new-session').classList.remove('hidden');
    };

    window.studioHideNewSession = function () {
        document.getElementById('studio-new-session').classList.add('hidden');
        document.getElementById('studio-song-results').classList.add('hidden');
    };

    window.studioSearchSongs = async function (query) {
        const resultsDiv = document.getElementById('studio-song-results');
        if (!query || query.length < 2) {
            resultsDiv.classList.add('hidden');
            return;
        }
        try {
            const resp = await fetch(`/api/library?q=${encodeURIComponent(query)}&size=10`);
            const data = await resp.json();
            const songs = data.songs || [];
            if (!songs.length) {
                resultsDiv.innerHTML = '<div class="px-3 py-2 text-gray-500 text-sm">No results</div>';
                resultsDiv.classList.remove('hidden');
                return;
            }
            resultsDiv.innerHTML = songs.map((s, i) => `
                <div class="px-3 py-2 hover:bg-dark-600 cursor-pointer text-sm transition-colors"
                     data-song-idx="${i}">
                    <div class="text-white truncate">${_esc(s.title)}</div>
                    <div class="text-gray-500 text-xs">${_esc(s.artist)}</div>
                </div>
            `).join('');
            // Attach click handlers via delegation to avoid inline JS escaping issues
            resultsDiv.onclick = (e) => {
                const row = e.target.closest('[data-song-idx]');
                if (!row) return;
                const idx = parseInt(row.dataset.songIdx);
                const s = songs[idx];
                if (s) studioSelectSong(s.filename, `${s.title} - ${s.artist}`);
            };
            resultsDiv.classList.remove('hidden');
        } catch (e) {
            console.error('[Studio] Song search error:', e);
        }
    };

    window.studioSelectSong = function (filename, display) {
        document.getElementById('studio-song-filename').value = filename;
        document.getElementById('studio-song-selected').textContent = display;
        document.getElementById('studio-song-selected').classList.remove('hidden');
        document.getElementById('studio-song-results').classList.add('hidden');
        document.getElementById('studio-song-search').value = display;
    };

    window.studioCreateSession = async function () {
        const name = document.getElementById('studio-session-name').value.trim();
        const filename = document.getElementById('studio-song-filename').value;
        const userName = document.getElementById('studio-user-name').value.trim();

        if (!name || !filename) {
            alert('Please enter a session name and select a song.');
            return;
        }

        if (userName) {
            S.userName = userName;
            _saveSettings();
        }

        try {
            const resp = await fetch('/api/plugins/studio/sessions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ song_filename: filename, name, created_by: S.userName }),
            });
            const data = await resp.json();
            if (data.error) { alert(data.error); return; }
            studioHideNewSession();
            document.getElementById('studio-session-name').value = '';
            document.getElementById('studio-song-search').value = '';
            document.getElementById('studio-song-filename').value = '';
            document.getElementById('studio-song-selected').classList.add('hidden');
            studioOpenSession(data.id);
        } catch (e) {
            console.error('[Studio] Create session error:', e);
            alert('Failed to create session.');
        }
    };

    window.studioDeleteSession = async function (id) {
        if (!confirm('Delete this session and all its recordings?')) return;
        try {
            await fetch(`/api/plugins/studio/sessions/${id}`, { method: 'DELETE' });
            _loadSessionList();
        } catch (e) {
            console.error('[Studio] Delete error:', e);
        }
    };

    // ── Session Detail / Mixer ─────────────────────────────────────────

    window.studioOpenSession = async function (id) {
        _cleanup();
        try {
            const resp = await fetch(`/api/plugins/studio/sessions/${id}`);
            S.currentSession = await resp.json();
            if (S.currentSession.error) {
                alert(S.currentSession.error);
                return;
            }
        } catch (e) {
            console.error('[Studio] Load session error:', e);
            return;
        }

        // Switch views
        document.getElementById('studio-list-view').classList.add('hidden');
        document.getElementById('studio-mixer-view').classList.remove('hidden');

        // Populate header
        document.getElementById('studio-session-title').textContent = S.currentSession.name;
        const meta = S.currentSession.song_meta;
        const songLabel = meta ? `${meta.title} - ${meta.artist}` : S.currentSession.song_filename;
        document.getElementById('studio-session-song').textContent = songLabel;

        // Load mix settings
        try {
            const resp = await fetch(`/api/plugins/studio/sessions/${S.currentSession.id}/mix-settings`);
            const settings = await resp.json();
            for (const s of settings) {
                S.mixState[s.track_id] = {
                    volume: s.volume,
                    pan: s.pan,
                    muted: !!s.muted,
                    solo: !!s.solo,
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
                };
            }
        } catch (e) { /* use defaults */ }

        // Load song audio
        _loadSongAudio();

        // Reset undo/redo
        S.undoStack = [];
        S.redoStack = [];

        // Load master settings
        S.masterVolume = S.currentSession.master_volume ?? 1.0;
        S.masterLimiterOn = S.currentSession.master_limiter !== 0;

        // Reset zoom
        S.zoomLevel = 1;
        S.scrollOffset = 0;

        // Render tracks and markers
        _renderTracks();
        _renderMarkers();
        _populatePunchTrackSelect();
        _initWaveformWheelZoom();

        // Load track audio buffers
        _loadTrackAudio();
    };

    window.studioBackToList = function () {
        _cleanup();
        document.getElementById('studio-mixer-view').classList.add('hidden');
        document.getElementById('studio-list-view').classList.remove('hidden');
        _loadSessionList();
    };

    // ── Audio Loading ──────────────────────────────────────────────────



    async function _loadSongAudio() {
        try {
            const resp = await fetch(`/api/plugins/studio/sessions/${S.currentSession.id}/song-audio`);
            const data = await resp.json();
            if (!data.url) return;
            const audioResp = await fetch(data.url);
            const arrayBuf = await audioResp.arrayBuffer();
            const ctx = _getAudioCtx();
            S.songBuffer = await ctx.decodeAudioData(arrayBuf);
            S.duration = S.songBuffer.duration;
            document.getElementById('studio-time-total').textContent = _formatTime(S.duration);
            document.getElementById('studio-seek-bar').max = S.duration;
            _drawWaveform('original', S.songBuffer, document.getElementById('studio-waveform-original'));
        } catch (e) {
            console.error('[Studio] Failed to load song audio:', e);
        }
    }

    async function _loadTrackAudio() {
        if (!S.currentSession || !S.currentSession.tracks) return;
        const ctx = _getAudioCtx();
        for (const t of S.currentSession.tracks) {
            try {
                const resp = await fetch(`/api/plugins/studio/tracks/${t.id}/audio`);
                const arrayBuf = await resp.arrayBuffer();
                S.trackBuffers[t.id] = await ctx.decodeAudioData(arrayBuf);
                // Update duration if track is longer
                if (S.trackBuffers[t.id].duration > S.duration) {
                    S.duration = S.trackBuffers[t.id].duration;
                    document.getElementById('studio-time-total').textContent = _formatTime(S.duration);
                    document.getElementById('studio-seek-bar').max = S.duration;
                }
                // Draw waveform
                const canvas = document.getElementById(`studio-waveform-${t.id}`);
                if (canvas) _drawWaveform(t.id, S.trackBuffers[t.id], canvas);
            } catch (e) {
                console.error(`[Studio] Failed to load track ${t.id}:`, e);
            }
        }
    }

    // ── Track Rendering ────────────────────────────────────────────────

    // Track colours (_getTrackColor + TRACK_COLORS/INSTRUMENT_COLORS) → src/util.js.

    const COLOR_PALETTE = [
        '#4080e0', '#60a0ff', '#2060b0',
        '#e05040', '#ff6050', '#c03020',
        '#40c070', '#60e090', '#208040',
        '#c060e0', '#e080ff', '#8040b0',
        '#e0a030', '#ffc040', '#c08020',
        '#50b0d0', '#70d0f0', '#3090b0',
        '#e07090', '#ff90b0', '#c05070',
        '#80c040', '#a0e060', '#608020',
    ];



    // ── Playback (Web Audio API) ───────────────────────────────────────

    window.studioTogglePlay = function () {
        if (S.isPlaying) {
            _pause();
        } else {
            _play();
        }
    };



    window.studioStop = function () {
        _stopAllSources();
        S.isPlaying = false;
        S.pauseOffset = 0;
        document.getElementById('studio-btn-play').innerHTML = '&#9654; Play';
        document.getElementById('studio-time-current').textContent = '0:00';
        document.getElementById('studio-seek-bar').value = 0;
        _stopAnimLoop();
        _drawAllCursors(0);

        // Stop recording if active
        if (S.isRecording) {
            _stopRecording();
        }
    };


    window.studioSeek = function (val) {
        const t = parseFloat(val);
        if (S.isPlaying) {
            _stopAllSources();
            S.isPlaying = false;
            S.pauseOffset = t;
            _play();
        } else {
            S.pauseOffset = t;
            document.getElementById('studio-time-current').textContent = _formatTime(t);
            _drawAllCursors(t);
        }
    };

    window.studioSeekFromWaveform = function (event, canvas) {
        const rect = canvas.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const pct = x / rect.width;
        const visibleDur = S.duration / S.zoomLevel;
        const t = S.scrollOffset + pct * visibleDur;
        studioSeek(t);
        document.getElementById('studio-seek-bar').value = t;
    };

    // ── Animation Loop ─────────────────────────────────────────────────



    // ── Mix Controls ───────────────────────────────────────────────────

    window.studioSetVolume = function (trackKey, value) {
        _pushUndo();
        const v = Math.max(0, Math.min(1.5, parseFloat(value)));
        if (!S.mixState[trackKey]) S.mixState[trackKey] = { volume: 1.0, pan: 0.0, muted: false, solo: false, offset_ms: 0, fade_in_ms: 0, fade_out_ms: 0, eq_low: 0, eq_mid: 0, eq_high: 0, reverb_send: 0, comp_threshold: -24, comp_ratio: 1, comp_attack: 0.003, comp_release: 0.25 };
        S.mixState[trackKey].volume = v;
        _applyMixToLiveAudio(trackKey);
        _debounceSaveMix();
    };

    window.studioSetPan = function (trackKey, value) {
        _pushUndo();
        const p = Math.max(-1, Math.min(1, parseFloat(value)));
        if (!S.mixState[trackKey]) S.mixState[trackKey] = { volume: 1.0, pan: 0.0, muted: false, solo: false, offset_ms: 0, fade_in_ms: 0, fade_out_ms: 0, eq_low: 0, eq_mid: 0, eq_high: 0, reverb_send: 0, comp_threshold: -24, comp_ratio: 1, comp_attack: 0.003, comp_release: 0.25 };
        S.mixState[trackKey].pan = p;
        _applyMixToLiveAudio(trackKey);
        _debounceSaveMix();
    };

    window.studioSetOffset = function (trackKey, value) {
        _pushUndo();
        const ms = parseFloat(value) || 0;
        if (!S.mixState[trackKey]) S.mixState[trackKey] = { volume: 1.0, pan: 0.0, muted: false, solo: false, offset_ms: 0, fade_in_ms: 0, fade_out_ms: 0, eq_low: 0, eq_mid: 0, eq_high: 0, reverb_send: 0, comp_threshold: -24, comp_ratio: 1, comp_attack: 0.003, comp_release: 0.25 };
        S.mixState[trackKey].offset_ms = ms;
        _debounceSaveMix();
    };

    window.studioSetFade = function (trackKey, type, value) {
        _pushUndo();
        const ms = Math.max(0, parseFloat(value) || 0);
        if (!S.mixState[trackKey]) S.mixState[trackKey] = { volume: 1.0, pan: 0.0, muted: false, solo: false, offset_ms: 0, fade_in_ms: 0, fade_out_ms: 0, eq_low: 0, eq_mid: 0, eq_high: 0, reverb_send: 0, comp_threshold: -24, comp_ratio: 1, comp_attack: 0.003, comp_release: 0.25 };
        if (type === 'in') S.mixState[trackKey].fade_in_ms = ms;
        else S.mixState[trackKey].fade_out_ms = ms;
        _debounceSaveMix();
        // Redraw waveform to show fade overlay
        const curTime = S.isPlaying ? (_getAudioCtx().currentTime - S.startTime) : S.pauseOffset;
        _drawAllCursors(curTime);
    };

    window.studioSetEq = function (trackKey, band, value) {
        _pushUndo();
        const db = Math.max(-12, Math.min(12, parseFloat(value) || 0));
        if (!S.mixState[trackKey]) S.mixState[trackKey] = { volume: 1.0, pan: 0.0, muted: false, solo: false, offset_ms: 0, fade_in_ms: 0, fade_out_ms: 0, eq_low: 0, eq_mid: 0, eq_high: 0, reverb_send: 0, comp_threshold: -24, comp_ratio: 1, comp_attack: 0.003, comp_release: 0.25 };
        S.mixState[trackKey]['eq_' + band] = db;
        // Apply live to playing audio
        const ts = S.trackSources[trackKey];
        if (ts) {
            if (band === 'low' && ts.eqLow) ts.eqLow.gain.value = db;
            if (band === 'mid' && ts.eqMid) ts.eqMid.gain.value = db;
            if (band === 'high' && ts.eqHigh) ts.eqHigh.gain.value = db;
        }
        // Update label
        const label = document.getElementById(`studio-eq-label-${trackKey}`);
        if (label) label.textContent = _eqLabel(S.mixState[trackKey]);
        _debounceSaveMix();
    };

    window.studioSetReverbSend = function (trackKey, value) {
        _pushUndo();
        const v = Math.max(0, Math.min(1, parseFloat(value) || 0));
        const st = S.mixState[trackKey];
        if (!st) return;
        st.reverb_send = v;
        // Apply live
        const ts = S.trackSources[trackKey];
        if (ts && ts.reverbSend) {
            ts.reverbSend.gain.value = v;
        }
        const label = document.getElementById(`studio-rev-label-${trackKey}`);
        if (label) label.textContent = v > 0 ? Math.round(v * 100) + '%' : 'Off';
        _debounceSaveMix();
    };

    window.studioSetComp = function (trackKey, param, value) {
        _pushUndo();
        const v = parseFloat(value);
        const st = S.mixState[trackKey];
        if (!st) return;
        st['comp_' + param] = v;
        // Apply live
        const ts = S.trackSources[trackKey];
        if (ts && ts.comp) {
            if (param === 'threshold') ts.comp.threshold.value = v;
            if (param === 'ratio') ts.comp.ratio.value = Math.max(1, v);
            if (param === 'attack') ts.comp.attack.value = v;
            if (param === 'release') ts.comp.release.value = v;
        }
        const label = document.getElementById(`studio-comp-label-${trackKey}`);
        if (label) label.textContent = _compLabel(st);
        _debounceSaveMix();
    };

    window.studioToggleMute = function (trackKey) {
        _captureUndoNow();
        if (!S.mixState[trackKey]) S.mixState[trackKey] = { volume: 1.0, pan: 0.0, muted: false, solo: false, offset_ms: 0, fade_in_ms: 0, fade_out_ms: 0, eq_low: 0, eq_mid: 0, eq_high: 0, reverb_send: 0, comp_threshold: -24, comp_ratio: 1, comp_attack: 0.003, comp_release: 0.25 };
        S.mixState[trackKey].muted = !S.mixState[trackKey].muted;
        const btn = document.querySelector(`[data-mute="${trackKey}"]`);
        if (btn) {
            if (S.mixState[trackKey].muted) {
                btn.className = 'w-7 h-7 rounded text-xs font-bold transition-colors bg-red-600 text-white';
            } else {
                btn.className = 'w-7 h-7 rounded text-xs font-bold transition-colors bg-dark-600 hover:bg-dark-500 text-gray-400';
            }
        }
        _applyAllMixToLive();
        _debounceSaveMix();
    };

    window.studioToggleSolo = function (trackKey) {
        _captureUndoNow();
        if (!S.mixState[trackKey]) S.mixState[trackKey] = { volume: 1.0, pan: 0.0, muted: false, solo: false, offset_ms: 0, fade_in_ms: 0, fade_out_ms: 0, eq_low: 0, eq_mid: 0, eq_high: 0, reverb_send: 0, comp_threshold: -24, comp_ratio: 1, comp_attack: 0.003, comp_release: 0.25 };
        S.mixState[trackKey].solo = !S.mixState[trackKey].solo;
        const btn = document.querySelector(`[data-solo="${trackKey}"]`);
        if (btn) {
            if (S.mixState[trackKey].solo) {
                btn.className = 'w-7 h-7 rounded text-xs font-bold transition-colors bg-yellow-600 text-white';
            } else {
                btn.className = 'w-7 h-7 rounded text-xs font-bold transition-colors bg-dark-600 hover:bg-dark-500 text-gray-400';
            }
        }
        _applyAllMixToLive();
        _debounceSaveMix();
    };






    // ── Recording ──────────────────────────────────────────────────────





    // ── Punch-in Recording ───────────────────────────────────────────








    // ── Practice (open song on highway) ──────────────────────────────

    window.studioPractice = function () {
        if (!S.currentSession) return;
        const filename = encodeURIComponent(S.currentSession.song_filename);
        if (typeof playSong === 'function') {
            playSong(filename);
        } else {
            alert('Player not available.');
        }
    };

    // ── Highway Recording ──────────────────────────────────────────────
    // Records mic input while the user plays along on the highway/player.
    // Overlay waits for audio to load, then user starts recording in sync.














    // ── Track Management ───────────────────────────────────────────────

    window.studioAddTrack = async function () {
        if (!S.currentSession) return;
        const name = prompt('Track name:', 'New Track');
        if (!name) return;
        try {
            await fetch(`/api/plugins/studio/sessions/${S.currentSession.id}/add-track`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name }),
            });
            await _reloadSession();
        } catch (e) {
            console.error('[Studio] Add track error:', e);
        }
    };

    window.studioPickColor = function (trackId, btn) {
        // Show a small color palette popover
        const existing = document.getElementById('studio-color-picker');
        if (existing) existing.remove();

        const picker = document.createElement('div');
        picker.id = 'studio-color-picker';
        picker.className = 'absolute z-50 bg-dark-800 border border-gray-700 rounded-lg p-2 shadow-xl grid grid-cols-6 gap-1';
        picker.style.width = '160px';
        picker.innerHTML = COLOR_PALETTE.map(c =>
            `<button class="w-5 h-5 rounded-full hover:ring-2 hover:ring-white/50 transition-all"
                style="background:${c}" onclick="studioApplyColor(${trackId}, '${c}')"></button>`
        ).join('');

        // Position near the button
        const rect = btn.getBoundingClientRect();
        picker.style.position = 'fixed';
        picker.style.left = rect.left + 'px';
        picker.style.top = (rect.bottom + 4) + 'px';
        document.body.appendChild(picker);

        // Close on click outside
        setTimeout(() => {
            const handler = (e) => {
                if (!picker.contains(e.target)) {
                    picker.remove();
                    document.removeEventListener('click', handler);
                }
            };
            document.addEventListener('click', handler);
        }, 0);
    };

    window.studioApplyColor = async function (trackId, color) {
        const picker = document.getElementById('studio-color-picker');
        if (picker) picker.remove();
        try {
            await fetch(`/api/plugins/studio/tracks/${trackId}/color`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ color }),
            });
            // Update local state
            const t = S.currentSession.tracks.find(t => t.id === trackId);
            if (t) t.color = color;
            _renderTracks();
            // Redraw waveforms with new color
            const curTime = S.isPlaying ? (_getAudioCtx().currentTime - S.startTime) : S.pauseOffset;
            _drawAllCursors(curTime);
        } catch (e) {
            console.error('[Studio] Set color error:', e);
        }
    };

    window.studioRenameTrack = async function (trackId, el) {
        const current = el.textContent;
        const input = document.createElement('input');
        input.type = 'text';
        input.value = current;
        input.className = 'bg-dark-800 text-white text-sm rounded px-1 py-0.5 border border-accent/50 focus:outline-none w-full';

        async function save() {
            const newName = input.value.trim();
            el.textContent = newName || current;
            if (newName && newName !== current) {
                try {
                    await fetch(`/api/plugins/studio/tracks/${trackId}/rename`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ name: newName }),
                    });
                } catch (e) {
                    el.textContent = current;
                }
            }
        }

        input.onblur = save;
        input.onkeydown = (e) => { if (e.key === 'Enter') input.blur(); if (e.key === 'Escape') { input.value = current; input.blur(); } };
        el.textContent = '';
        el.appendChild(input);
        input.focus();
        input.select();
    };

    window.studioImportToTrack = async function (trackId, fileInput) {
        if (!fileInput.files.length) return;
        const file = fileInput.files[0];
        const formData = new FormData();
        formData.append('file', file);
        try {
            await fetch(`/api/plugins/studio/tracks/${trackId}/import-audio`, {
                method: 'POST',
                body: formData,
            });
            await _reloadSession();
        } catch (e) {
            console.error('[Studio] Import error:', e);
        }
    };

    window.studioImportAudioFile = async function (fileInput) {
        if (!fileInput.files.length || !S.currentSession) return;
        const file = fileInput.files[0];
        const name = Path_stem(file.name) || 'Imported';

        // Create a new track, then import audio into it
        try {
            const resp = await fetch(`/api/plugins/studio/sessions/${S.currentSession.id}/add-track`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name }),
            });
            const data = await resp.json();
            if (!data.id) { alert(data.error || 'Failed to create track'); return; }

            const formData = new FormData();
            formData.append('file', file);
            await fetch(`/api/plugins/studio/tracks/${data.id}/import-audio`, {
                method: 'POST',
                body: formData,
            });
            await _reloadSession();
        } catch (e) {
            console.error('[Studio] Import error:', e);
        }
        fileInput.value = '';
    };


    window.studioDeleteTrack = async function (trackId) {
        if (!confirm('Delete this track?')) return;
        try {
            await fetch(`/api/plugins/studio/tracks/${trackId}`, { method: 'DELETE' });
            delete S.trackBuffers[trackId];
            delete S.mixState[trackId];
            await _reloadSession();
        } catch (e) {
            console.error('[Studio] Delete track error:', e);
        }
    };

    async function _reloadSession() {
        if (!S.currentSession) return;
        const wasPlaying = S.isPlaying;
        if (wasPlaying) _pause();
        try {
            const resp = await fetch(`/api/plugins/studio/sessions/${S.currentSession.id}`);
            S.currentSession = await resp.json();
            _renderTracks();
            _populatePunchTrackSelect();
            await _loadTrackAudio();
        } catch (e) {
            console.error('[Studio] Reload session error:', e);
        }
    }

    // ── Export ──────────────────────────────────────────────────────────

    window.studioExportMix = async function () {
        if (!S.currentSession) return;
        const statusDiv = document.getElementById('studio-export-status');
        const msgSpan = document.getElementById('studio-export-msg');
        const linkEl = document.getElementById('studio-export-link');

        statusDiv.classList.remove('hidden');
        linkEl.classList.add('hidden');
        msgSpan.textContent = 'Mixing tracks on server...';

        const origState = S.mixState.original || { volume: 1.0, pan: 0.0, muted: false, solo: false, offset_ms: 0, fade_in_ms: 0, fade_out_ms: 0, eq_low: 0, eq_mid: 0, eq_high: 0, reverb_send: 0, comp_threshold: -24, comp_ratio: 1, comp_attack: 0.003, comp_release: 0.25 };

        try {
            const resp = await fetch(`/api/plugins/studio/sessions/${S.currentSession.id}/mix`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    include_original: !origState.muted,
                    original_volume: origState.volume,
                    original_pan: origState.pan,
                    original_muted: origState.muted,
                    format: 'mp3',
                }),
            });
            const data = await resp.json();
            if (data.error) {
                msgSpan.textContent = 'Export failed: ' + data.error;
                return;
            }
            msgSpan.textContent = 'Mix exported successfully!';
            linkEl.href = data.url;
            linkEl.classList.remove('hidden');
        } catch (e) {
            msgSpan.textContent = 'Export failed: ' + e.message;
        }
    };

    // ── Waveform Rendering ─────────────────────────────────────────────




    // ── Master Bus Controls ──────────────────────────────────────────


    window.studioSetMasterVolume = function (value) {
        S.masterVolume = Math.max(0, Math.min(2, parseFloat(value)));
        if (S.masterGain) S.masterGain.gain.value = S.masterVolume;
        const label = document.getElementById('studio-master-vol-label');
        if (label) label.textContent = Math.round(S.masterVolume * 100) + '%';
        _debounceSaveMaster();
    };

    window.studioToggleMasterLimiter = function () {
        S.masterLimiterOn = !S.masterLimiterOn;
        const btn = document.getElementById('studio-master-limiter-btn');
        if (btn) {
            btn.className = 'px-2 py-0.5 rounded text-xs font-medium transition-colors ' +
                (S.masterLimiterOn ? 'bg-green-600/30 text-green-400 border border-green-600/30' : 'bg-dark-800 text-gray-500 border border-gray-700');
            btn.textContent = S.masterLimiterOn ? 'Limiter ON' : 'Limiter OFF';
        }
        _debounceSaveMaster();
    };


    // ── Zoom & Scroll ───────────────────────────────────────────────────

    window.studioZoomIn = function () {
        const maxZoom = Math.max(1, S.duration / 2); // min 2 seconds visible
        S.zoomLevel = Math.min(maxZoom, S.zoomLevel * 1.5);
        _clampScroll();
        _drawAllCursors(S.pauseOffset);
    };

    window.studioZoomOut = function () {
        S.zoomLevel = Math.max(1, S.zoomLevel / 1.5);
        _clampScroll();
        _drawAllCursors(S.pauseOffset);
    };

    window.studioZoomFit = function () {
        S.zoomLevel = 1;
        S.scrollOffset = 0;
        _drawAllCursors(S.pauseOffset);
    };

    window.studioScrollTimeline = function (val) {
        S.scrollOffset = parseFloat(val);
        _clampScroll();
        const curTime = S.isPlaying ? (_getAudioCtx().currentTime - S.startTime) : S.pauseOffset;
        _drawAllCursors(curTime);
    };



    // ── Input Device Enumeration ───────────────────────────────────────

    async function _populateDevices() {
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            const sel = document.getElementById('studio-input-device');
            if (!sel) return;
            sel.innerHTML = '<option value="">Default</option>';
            for (const d of devices) {
                if (d.kind !== 'audioinput') continue;
                const opt = document.createElement('option');
                opt.value = d.deviceId;
                opt.textContent = d.label || `Input ${sel.options.length}`;
                if (d.deviceId === S.selectedDeviceId) opt.selected = true;
                sel.appendChild(opt);
            }
        } catch (e) {
            console.error('[Studio] Device enumeration failed:', e);
        }
    }

    // ── FX Popup with Gear Graphics ───────────────────────────────────

    const FX_DEFS = {
        eq: {
            image: 'gear_rack_studioeq',
            title: 'Parametric EQ',
            knobs: [
                { key: 'eq_low', label: 'Low', min: -12, max: 12, step: 1, unit: 'dB', default: 0 },
                { key: 'eq_mid', label: 'Mid', min: -12, max: 12, step: 1, unit: 'dB', default: 0 },
                { key: 'eq_high', label: 'High', min: -12, max: 12, step: 1, unit: 'dB', default: 0 },
            ],
        },
        comp: {
            image: 'gear_rack_studiocompressor',
            title: 'Studio Compressor',
            knobs: [
                { key: 'comp_threshold', label: 'Threshold', min: -60, max: 0, step: 1, unit: 'dB', default: -24 },
                { key: 'comp_ratio', label: 'Ratio', min: 1, max: 20, step: 0.5, unit: ':1', default: 1 },
                { key: 'comp_attack', label: 'Attack', min: 0.001, max: 0.1, step: 0.001, unit: 's', default: 0.003, display: v => Math.round(v * 1000) + 'ms' },
                { key: 'comp_release', label: 'Release', min: 0.01, max: 1, step: 0.01, unit: 's', default: 0.25, display: v => Math.round(v * 1000) + 'ms' },
            ],
        },
        reverb: {
            image: 'gear_rack_studioverb',
            title: 'Studio Reverb',
            knobs: [
                { key: 'reverb_send', label: 'Send', min: 0, max: 1, step: 0.05, unit: '', default: 0, display: v => Math.round(v * 100) + '%' },
            ],
        },
    };

    window.studioOpenFxPopup = function (trackId, fxType) {
        // Remove existing popup
        const existing = document.getElementById('studio-fx-popup');
        if (existing) existing.remove();

        const def = FX_DEFS[fxType];
        if (!def) return;

        const state = S.mixState[trackId];
        if (!state) return;

        const popup = document.createElement('div');
        popup.id = 'studio-fx-popup';
        popup.className = 'fixed inset-0 z-[400] flex items-center justify-center bg-black/70 backdrop-blur-sm';
        popup.onclick = (e) => { if (e.target === popup) popup.remove(); };

        const card = document.createElement('div');
        card.className = 'bg-dark-800 rounded-2xl border border-gray-700 shadow-2xl overflow-hidden max-w-lg w-full mx-4';

        // Header with gear image
        card.innerHTML = `
            <div class="relative">
                <img src="/api/plugins/studio/gear-image/${def.image}" class="w-full h-auto"
                     alt="${def.title}" style="image-rendering: auto;"
                     onerror="this.style.display='none'">
                <button onclick="document.getElementById('studio-fx-popup').remove()"
                    class="absolute top-2 right-2 w-7 h-7 rounded-full bg-black/60 text-gray-400 hover:text-white text-sm flex items-center justify-center transition-colors">&times;</button>
            </div>
            <div class="px-5 py-4">
                <h3 class="text-white text-sm font-semibold mb-4">${def.title}</h3>
                <div id="studio-fx-knobs" class="grid grid-cols-${Math.min(def.knobs.length, 4)} gap-4"></div>
            </div>
        `;

        popup.appendChild(card);
        document.body.appendChild(popup);

        // Render knobs
        const knobsContainer = card.querySelector('#studio-fx-knobs');
        for (const knob of def.knobs) {
            const currentVal = state[knob.key] ?? knob.default;
            const knobEl = _createSvgKnob(trackId, fxType, knob, currentVal);
            knobsContainer.appendChild(knobEl);
        }
    };

    function _createSvgKnob(trackId, fxType, knob, value) {
        const wrapper = document.createElement('div');
        wrapper.className = 'flex flex-col items-center gap-1';

        const size = 64;
        const cx = size / 2, cy = size / 2, r = 24;
        const startAngle = 135, endAngle = 405; // 270 degree sweep
        const range = knob.max - knob.min;
        const pct = (value - knob.min) / range;
        const angle = startAngle + pct * (endAngle - startAngle);

        const displayVal = knob.display ? knob.display(value) : (Number.isInteger(knob.step) ? Math.round(value) : value.toFixed(knob.step < 0.01 ? 3 : knob.step < 1 ? 1 : 0));

        wrapper.innerHTML = `
            <svg width="${size}" height="${size}" class="cursor-pointer" data-knob-track="${trackId}" data-knob-fx="${fxType}" data-knob-key="${knob.key}">
                <!-- Track arc (background) -->
                <path d="${_describeArc(cx, cy, r, startAngle, endAngle)}" fill="none" stroke="#333" stroke-width="4" stroke-linecap="round"/>
                <!-- Value arc -->
                <path d="${_describeArc(cx, cy, r, startAngle, angle)}" fill="none" stroke="#4080e0" stroke-width="4" stroke-linecap="round"/>
                <!-- Knob body -->
                <circle cx="${cx}" cy="${cy}" r="16" fill="#1a1a2e" stroke="#444" stroke-width="1.5"/>
                <!-- Pointer line -->
                <line x1="${cx}" y1="${cy}" x2="${cx + 12 * Math.cos((angle - 90) * Math.PI / 180)}" y2="${cy + 12 * Math.sin((angle - 90) * Math.PI / 180)}" stroke="#fff" stroke-width="2" stroke-linecap="round"/>
            </svg>
            <span class="text-white text-xs font-mono" id="studio-knob-val-${trackId}-${knob.key}">${displayVal}</span>
            <span class="text-gray-500 text-[10px]">${knob.label}</span>
        `;

        // Interaction: drag up/down to change value
        const svg = wrapper.querySelector('svg');
        let dragging = false, startY = 0, startVal = value;

        svg.addEventListener('mousedown', (e) => {
            dragging = true;
            startY = e.clientY;
            startVal = S.mixState[trackId]?.[knob.key] ?? knob.default;
            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!dragging) return;
            const dy = startY - e.clientY; // up = increase
            const sensitivity = range / 150; // full range over 150px drag
            let newVal = startVal + dy * sensitivity;
            newVal = Math.max(knob.min, Math.min(knob.max, newVal));
            // Snap to step
            newVal = Math.round(newVal / knob.step) * knob.step;
            _applyFxKnobValue(trackId, fxType, knob, newVal, wrapper);
        });

        document.addEventListener('mouseup', () => { dragging = false; });

        // Mouse wheel
        svg.addEventListener('wheel', (e) => {
            e.preventDefault();
            const currentVal = S.mixState[trackId]?.[knob.key] ?? knob.default;
            const delta = e.deltaY < 0 ? knob.step : -knob.step;
            let newVal = Math.max(knob.min, Math.min(knob.max, currentVal + delta));
            newVal = Math.round(newVal / knob.step) * knob.step;
            _applyFxKnobValue(trackId, fxType, knob, newVal, wrapper);
        }, { passive: false });

        // Double-click to reset
        svg.addEventListener('dblclick', () => {
            _applyFxKnobValue(trackId, fxType, knob, knob.default, wrapper);
        });

        return wrapper;
    }

    function _applyFxKnobValue(trackId, fxType, knob, value, wrapper) {
        // Update mix state
        if (!S.mixState[trackId]) return;
        _pushUndo();
        S.mixState[trackId][knob.key] = value;

        // Update SVG
        const size = 64, cx = size / 2, cy = size / 2, r = 24;
        const startAngle = 135, endAngle = 405;
        const range = knob.max - knob.min;
        const pct = (value - knob.min) / range;
        const angle = startAngle + pct * (endAngle - startAngle);

        const svg = wrapper.querySelector('svg');
        const paths = svg.querySelectorAll('path');
        if (paths[1]) paths[1].setAttribute('d', _describeArc(cx, cy, r, startAngle, angle));
        const line = svg.querySelector('line');
        if (line) {
            line.setAttribute('x2', cx + 12 * Math.cos((angle - 90) * Math.PI / 180));
            line.setAttribute('y2', cy + 12 * Math.sin((angle - 90) * Math.PI / 180));
        }

        // Update value label
        const displayVal = knob.display ? knob.display(value) : (Number.isInteger(knob.step) ? Math.round(value) : value.toFixed(knob.step < 0.01 ? 3 : knob.step < 1 ? 1 : 0));
        const valEl = document.getElementById(`studio-knob-val-${trackId}-${knob.key}`);
        if (valEl) valEl.textContent = displayVal;

        // Apply to live audio
        const ts = S.trackSources[trackId];
        if (ts) {
            if (knob.key === 'eq_low' && ts.eqLow) ts.eqLow.gain.value = value;
            if (knob.key === 'eq_mid' && ts.eqMid) ts.eqMid.gain.value = value;
            if (knob.key === 'eq_high' && ts.eqHigh) ts.eqHigh.gain.value = value;
            if (knob.key === 'comp_threshold' && ts.comp) ts.comp.threshold.value = value;
            if (knob.key === 'comp_ratio' && ts.comp) ts.comp.ratio.value = Math.max(1, value);
            if (knob.key === 'comp_attack' && ts.comp) ts.comp.attack.value = value;
            if (knob.key === 'comp_release' && ts.comp) ts.comp.release.value = value;
            if (knob.key === 'reverb_send' && ts.reverbSend) ts.reverbSend.gain.value = value;
        }

        _debounceSaveMix();
    }

    // SVG arc helper
    // ── Markers ────────────────────────────────────────────────────────


    window.studioAddMarker = async function () {
        if (!S.currentSession) return;
        const seekBar = document.getElementById('studio-seek-bar');
        const t = parseFloat(seekBar?.value || 0);
        const name = prompt('Marker name:', 'Marker');
        if (!name) return;
        try {
            const resp = await fetch(`/api/plugins/studio/sessions/${S.currentSession.id}/markers`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ time: t, name }),
            });
            const marker = await resp.json();
            if (!S.currentSession.markers) S.currentSession.markers = [];
            S.currentSession.markers.push(marker);
            S.currentSession.markers.sort((a, b) => a.time - b.time);
            _renderMarkers();
            const curTime = S.isPlaying ? (_getAudioCtx().currentTime - S.startTime) : S.pauseOffset;
            _drawAllCursors(curTime);
        } catch (e) {
            console.error('[Studio] Add marker error:', e);
        }
    };

    window.studioDeleteMarker = async function (id) {
        try {
            await fetch(`/api/plugins/studio/markers/${id}`, { method: 'DELETE' });
            if (S.currentSession && S.currentSession.markers) {
                S.currentSession.markers = S.currentSession.markers.filter(m => m.id !== id);
            }
            _renderMarkers();
            const curTime = S.isPlaying ? (_getAudioCtx().currentTime - S.startTime) : S.pauseOffset;
            _drawAllCursors(curTime);
        } catch (e) {
            console.error('[Studio] Delete marker error:', e);
        }
    };

    window.studioRenameMarker = async function (id, el) {
        const current = el.textContent.replace('×', '').trim();
        const newName = prompt('Rename marker:', current);
        if (!newName || newName === current) return;
        try {
            await fetch(`/api/plugins/studio/markers/${id}/rename`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: newName }),
            });
            const m = S.currentSession.markers.find(m => m.id === id);
            if (m) m.name = newName;
            _renderMarkers();
        } catch (e) {
            console.error('[Studio] Rename marker error:', e);
        }
    };

    window.studioImportSongMarkers = async function () {
        if (!S.currentSession) return;
        try {
            const resp = await fetch(`/api/plugins/studio/sessions/${S.currentSession.id}/import-markers`, {
                method: 'POST',
            });
            const data = await resp.json();
            if (data.error) { alert(data.error); return; }
            // Reload to get updated markers
            const sessionResp = await fetch(`/api/plugins/studio/sessions/${S.currentSession.id}`);
            const session = await sessionResp.json();
            S.currentSession.markers = session.markers || [];
            _renderMarkers();
            const curTime = S.isPlaying ? (_getAudioCtx().currentTime - S.startTime) : S.pauseOffset;
            _drawAllCursors(curTime);
            alert(`Imported ${data.added} markers from song sections.`);
        } catch (e) {
            console.error('[Studio] Import markers error:', e);
        }
    };

    // ── Demucs Settings & Stem Extraction ────────────────────────────

    window.studioToggleDemucsSettings = function () {
        const panel = document.getElementById('studio-demucs-settings');
        const arrow = document.getElementById('studio-demucs-arrow');
        if (panel.classList.contains('hidden')) {
            panel.classList.remove('hidden');
            arrow.innerHTML = '&#9660;';
            _loadDemucsConfig();
        } else {
            panel.classList.add('hidden');
            arrow.innerHTML = '&#9654;';
        }
    };

    async function _loadDemucsConfig() {
        try {
            const resp = await fetch('/api/plugins/studio/demucs/config');
            const cfg = await resp.json();
            const urlInput = document.getElementById('studio-demucs-url');
            const keyInput = document.getElementById('studio-demucs-apikey');
            if (urlInput && cfg.url) urlInput.value = cfg.url;
            if (keyInput && cfg.api_key) keyInput.value = cfg.api_key;
        } catch (e) { /* ignore */ }
    }

    window.studioSaveDemucsConfig = async function () {
        const url = document.getElementById('studio-demucs-url').value.trim();
        const api_key = document.getElementById('studio-demucs-apikey').value.trim();
        const status = document.getElementById('studio-demucs-status');
        try {
            await fetch('/api/plugins/studio/demucs/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url, api_key }),
            });
            status.textContent = 'Saved';
            status.className = 'text-xs ml-2 text-green-400';
            setTimeout(() => { status.textContent = ''; }, 2000);
        } catch (e) {
            status.textContent = 'Save failed';
            status.className = 'text-xs ml-2 text-red-400';
        }
    };

    window.studioTestDemucs = async function () {
        const status = document.getElementById('studio-demucs-status');
        status.textContent = 'Testing...';
        status.className = 'text-xs ml-2 text-gray-400';
        try {
            const resp = await fetch('/api/plugins/studio/demucs/test', { method: 'POST' });
            const data = await resp.json();
            if (data.ok) {
                const s = data.server;
                status.textContent = `Connected! Model: ${s.demucs_model}, GPU: ${s.gpu ? 'Yes' : 'No'}`;
                status.className = 'text-xs ml-2 text-green-400';
            } else {
                status.textContent = data.error || 'Connection failed';
                status.className = 'text-xs ml-2 text-red-400';
            }
        } catch (e) {
            status.textContent = 'Connection failed';
            status.className = 'text-xs ml-2 text-red-400';
        }
    };

    window.studioExtractDrums = function () {
        _extractStems('drums');
    };

    window.studioExtractAllStems = function () {
        _extractStems('drums,bass,vocals,other');
    };

    async function _extractStems(stems) {
        if (!S.currentSession) return;
        const statusEl = document.getElementById('studio-demucs-extract-status');
        statusEl.textContent = 'Sending to Demucs server...';
        statusEl.className = 'ml-2 text-purple-300 text-xs';

        // Build the slopsmith base URL so the demucs server can fetch audio directly
        const slopsmithUrl = window.location.origin;

        try {
            const resp = await fetch(`/api/plugins/studio/sessions/${S.currentSession.id}/extract-drums`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ stems, slopsmith_url: slopsmithUrl }),
            });
            const data = await resp.json();
            if (data.error) {
                statusEl.textContent = data.error;
                statusEl.className = 'ml-2 text-red-400 text-xs';
                return;
            }
            statusEl.textContent = `Extracted: ${data.stems.join(', ')}`;
            statusEl.className = 'ml-2 text-green-400 text-xs';
            // Reload session to show new stem tracks
            await _reloadSession();
        } catch (e) {
            statusEl.textContent = 'Extraction failed: ' + e.message;
            statusEl.className = 'ml-2 text-red-400 text-xs';
        }
    }

    // ── Cleanup ────────────────────────────────────────────────────────

    function _cleanup() {
        studioStop();
        S.currentSession = null;
        S.songBuffer = null;
        S.trackBuffers = {};
        S.waveformPeaks = {};
        S.mixState = { original: { volume: 1.0, pan: 0.0, muted: false, solo: false, offset_ms: 0, fade_in_ms: 0, fade_out_ms: 0, eq_low: 0, eq_mid: 0, eq_high: 0, reverb_send: 0, comp_threshold: -24, comp_ratio: 1, comp_attack: 0.003, comp_release: 0.25 } };
        S.duration = 0;
        S.pauseOffset = 0;
    }

    // ── Helpers ────────────────────────────────────────────────────────

    window.__slopsmithStudioHooksInstalling = true;
    try {
        // ── Keyboard shortcuts ───────────────────────────────────────────
        document.addEventListener('keydown', (e) => {
            // Only handle when studio screen is visible
            const studioRoot = document.getElementById('studio-root');
            if (!studioRoot || studioRoot.offsetParent === null) return;
            if (!S.currentSession) return;

            if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
                e.preventDefault();
                studioUndo();
            } else if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
                e.preventDefault();
                studioRedo();
            }
        });

        // ── Auto-init when screen becomes visible ──────────────────────────
        // The plugin system calls studioInit — but also hook screen navigation
        const _origShowScreen = window.showScreen;
        if (_origShowScreen) {
            window.showScreen = function (id) {
                _origShowScreen(id);
                if (id === 'plugin-studio') _runStudioInit();
            };
        }

        window.__slopsmithStudioHooksInstalled = true;
        // Init on first load
        _runStudioInit();
    } catch (e) {
        console.error('[Studio] Failed to install studio hooks:', e);
        throw e;
    } finally {
        window.__slopsmithStudioHooksInstalling = false;
    }
})();
