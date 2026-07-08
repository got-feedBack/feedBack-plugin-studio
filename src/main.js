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
    let _currentSession = null;     // full session object from API
    let _audioCtx = null;           // Web Audio context
    let _songBuffer = null;         // decoded AudioBuffer for original song
    let _trackBuffers = {};         // track_id -> AudioBuffer
    let _isPlaying = false;
    let _startTime = 0;             // audioCtx.currentTime when play began
    let _pauseOffset = 0;           // seconds into the song when paused
    let _duration = 0;              // total duration in seconds
    let _animFrame = null;

    // Zoom & scroll state
    let _zoomLevel = 1;             // 1 = fit entire song, 2 = 2x zoom, etc.
    let _scrollOffset = 0;          // start time in seconds of the visible window

    // Source nodes (recreated each play)
    let _songSource = null;
    let _songGain = null;
    let _songPan = null;
    let _trackSources = {};         // track_id -> {source, gain, pan, ...}
    let _reverbNode = null;         // shared ConvolverNode
    let _reverbGain = null;         // master reverb wet level
    let _masterGain = null;         // master bus gain
    let _masterLimiter = null;      // master bus limiter (DynamicsCompressor)
    let _masterAnalyser = null;     // for level meter
    let _masterMeterInterval = null;
    let _masterVolume = 1.0;
    let _masterLimiterOn = true;

    // Mix state (client-side, synced to server)
    let _mixState = {
        original: { volume: 1.0, pan: 0.0, muted: false, solo: false, offset_ms: 0, fade_in_ms: 0, fade_out_ms: 0, eq_low: 0, eq_mid: 0, eq_high: 0, reverb_send: 0, comp_threshold: -24, comp_ratio: 1, comp_attack: 0.003, comp_release: 0.25 },
        // track_id -> {volume, pan, muted, solo}
    };

    // Undo/redo
    let _undoStack = [];
    let _redoStack = [];
    const MAX_UNDO = 50;
    let _undoDebounceTimer = null;

    function _pushUndo() {
        // Debounce: don't capture every slider tick, wait for a pause
        if (_undoDebounceTimer) clearTimeout(_undoDebounceTimer);
        _undoDebounceTimer = setTimeout(() => {
            const snapshot = JSON.stringify(_mixState);
            // Don't push if identical to last
            if (_undoStack.length && _undoStack[_undoStack.length - 1] === snapshot) return;
            _undoStack.push(snapshot);
            if (_undoStack.length > MAX_UNDO) _undoStack.shift();
            _redoStack = []; // new change clears redo
            _updateUndoButtons();
        }, 500);
    }

    function _captureUndoNow() {
        // Immediate capture (for discrete actions like mute/solo toggles)
        if (_undoDebounceTimer) clearTimeout(_undoDebounceTimer);
        const snapshot = JSON.stringify(_mixState);
        if (_undoStack.length && _undoStack[_undoStack.length - 1] === snapshot) return;
        _undoStack.push(snapshot);
        if (_undoStack.length > MAX_UNDO) _undoStack.shift();
        _redoStack = [];
        _updateUndoButtons();
    }

    window.studioUndo = function () {
        if (!_undoStack.length) return;
        // Save current state to redo
        _redoStack.push(JSON.stringify(_mixState));
        // Restore previous
        const snapshot = _undoStack.pop();
        _mixState = JSON.parse(snapshot);
        _applyRestoredMixState();
    };

    window.studioRedo = function () {
        if (!_redoStack.length) return;
        // Save current state to undo
        _undoStack.push(JSON.stringify(_mixState));
        const snapshot = _redoStack.pop();
        _mixState = JSON.parse(snapshot);
        _applyRestoredMixState();
    };

    function _applyRestoredMixState() {
        // Re-render tracks to reflect new slider values
        _renderTracks();
        // Apply to live audio if playing
        _applyAllMixToLive();
        // Save to server
        _debounceSaveMix();
        _updateUndoButtons();
        // Redraw waveforms
        const curTime = _isPlaying ? (_getAudioCtx().currentTime - _startTime) : _pauseOffset;
        _drawAllCursors(curTime);
    }

    function _updateUndoButtons() {
        const undoBtn = document.getElementById('studio-btn-undo');
        const redoBtn = document.getElementById('studio-btn-redo');
        if (undoBtn) undoBtn.disabled = !_undoStack.length;
        if (redoBtn) redoBtn.disabled = !_redoStack.length;
        if (undoBtn) undoBtn.classList.toggle('opacity-30', !_undoStack.length);
        if (redoBtn) redoBtn.classList.toggle('opacity-30', !_redoStack.length);
    }

    // Recording
    let _isRecording = false;
    let _mediaStream = null;
    let _mediaRecorder = null;
    let _recordedChunks = [];
    let _recStartTime = 0;
    let _recInterval = null;

    // Waveform peaks cache
    let _waveformPeaks = {};        // key -> Float32Array

    // Settings (persisted in localStorage)
    const STORAGE_KEY = 'slopsmith_studio';
    let _userName = '';
    let _selectedDeviceId = '';

    // ── Init & Settings ────────────────────────────────────────────────

    function _loadSettings() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return;
            const s = JSON.parse(raw);
            if (s.userName) _userName = s.userName;
            if (s.deviceId !== undefined) _selectedDeviceId = s.deviceId;
        } catch (e) { /* ignore */ }
    }

    function _saveSettings() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({
                userName: _userName,
                deviceId: _selectedDeviceId,
            }));
        } catch (e) { /* ignore */ }
    }

    _loadSettings();

    // ── Session List ───────────────────────────────────────────────────

    window.studioInit = async function () {
        await _loadSessionList();
        _populateDevices();
        const nameInput = document.getElementById('studio-user-name');
        if (nameInput && _userName) nameInput.value = _userName;
        // If we came back from the player with a session open, reload it
        // so any recordings made on the highway show up immediately
        if (_currentSession) {
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

    function _renderSessionList(sessions) {
        const grid = document.getElementById('studio-sessions-grid');
        if (!grid) return;
        if (!sessions.length) {
            grid.innerHTML = '<div class="text-gray-500 text-sm py-8 text-center">No sessions yet. Create one to get started.</div>';
            return;
        }
        grid.innerHTML = sessions.map(s => `
            <div class="bg-dark-700 rounded-xl px-4 py-3 border border-gray-800 hover:border-gray-700 cursor-pointer transition-colors flex items-center gap-4"
                 onclick="studioOpenSession(${s.id})">
                <div class="flex-1 min-w-0">
                    <div class="text-white font-medium truncate">${_esc(s.name)}</div>
                    <div class="text-gray-500 text-xs mt-0.5">${_esc(s.song_filename)} &middot; ${s.track_count || 0} track${s.track_count !== 1 ? 's' : ''}</div>
                </div>
                <div class="text-gray-600 text-xs flex-shrink-0">${_formatDate(s.created_at)}</div>
                <button onclick="event.stopPropagation(); studioDeleteSession(${s.id})"
                    class="text-gray-600 hover:text-red-400 text-sm px-2 transition-colors" title="Delete">&times;</button>
            </div>
        `).join('');
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
            _userName = userName;
            _saveSettings();
        }

        try {
            const resp = await fetch('/api/plugins/studio/sessions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ song_filename: filename, name, created_by: _userName }),
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
            _currentSession = await resp.json();
            if (_currentSession.error) {
                alert(_currentSession.error);
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
        document.getElementById('studio-session-title').textContent = _currentSession.name;
        const meta = _currentSession.song_meta;
        const songLabel = meta ? `${meta.title} - ${meta.artist}` : _currentSession.song_filename;
        document.getElementById('studio-session-song').textContent = songLabel;

        // Load mix settings
        try {
            const resp = await fetch(`/api/plugins/studio/sessions/${_currentSession.id}/mix-settings`);
            const settings = await resp.json();
            for (const s of settings) {
                _mixState[s.track_id] = {
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
        _undoStack = [];
        _redoStack = [];

        // Load master settings
        _masterVolume = _currentSession.master_volume ?? 1.0;
        _masterLimiterOn = _currentSession.master_limiter !== 0;

        // Reset zoom
        _zoomLevel = 1;
        _scrollOffset = 0;

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

    function _getAudioCtx() {
        if (!_audioCtx) {
            _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
        return _audioCtx;
    }

    function _createReverbBus(ctx) {
        // Generate impulse response: stereo exponential decay noise (~2s)
        const rate = ctx.sampleRate;
        const length = rate * 2;
        const impulse = ctx.createBuffer(2, length, rate);
        for (let ch = 0; ch < 2; ch++) {
            const data = impulse.getChannelData(ch);
            for (let i = 0; i < length; i++) {
                data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 2.5);
            }
        }
        _reverbNode = ctx.createConvolver();
        _reverbNode.buffer = impulse;
        _reverbGain = ctx.createGain();
        _reverbGain.gain.value = 0.7; // master wet level
        const reverbDest = _masterGain || ctx.destination;
        _reverbNode.connect(_reverbGain).connect(reverbDest);
    }

    async function _loadSongAudio() {
        try {
            const resp = await fetch(`/api/plugins/studio/sessions/${_currentSession.id}/song-audio`);
            const data = await resp.json();
            if (!data.url) return;
            const audioResp = await fetch(data.url);
            const arrayBuf = await audioResp.arrayBuffer();
            const ctx = _getAudioCtx();
            _songBuffer = await ctx.decodeAudioData(arrayBuf);
            _duration = _songBuffer.duration;
            document.getElementById('studio-time-total').textContent = _formatTime(_duration);
            document.getElementById('studio-seek-bar').max = _duration;
            _drawWaveform('original', _songBuffer, document.getElementById('studio-waveform-original'));
        } catch (e) {
            console.error('[Studio] Failed to load song audio:', e);
        }
    }

    async function _loadTrackAudio() {
        if (!_currentSession || !_currentSession.tracks) return;
        const ctx = _getAudioCtx();
        for (const t of _currentSession.tracks) {
            try {
                const resp = await fetch(`/api/plugins/studio/tracks/${t.id}/audio`);
                const arrayBuf = await resp.arrayBuffer();
                _trackBuffers[t.id] = await ctx.decodeAudioData(arrayBuf);
                // Update duration if track is longer
                if (_trackBuffers[t.id].duration > _duration) {
                    _duration = _trackBuffers[t.id].duration;
                    document.getElementById('studio-time-total').textContent = _formatTime(_duration);
                    document.getElementById('studio-seek-bar').max = _duration;
                }
                // Draw waveform
                const canvas = document.getElementById(`studio-waveform-${t.id}`);
                if (canvas) _drawWaveform(t.id, _trackBuffers[t.id], canvas);
            } catch (e) {
                console.error(`[Studio] Failed to load track ${t.id}:`, e);
            }
        }
    }

    // ── Track Rendering ────────────────────────────────────────────────

    const TRACK_COLORS = [
        '#4080e0', '#e05040', '#40c070', '#c060e0', '#e0a030',
        '#50b0d0', '#e07090', '#80c040', '#a080e0', '#d0a060',
    ];

    const INSTRUMENT_COLORS = {
        lead: '#4080e0', solo: '#4080e0',
        rhythm: '#e05040', clean: '#e07090', acoustic: '#d0a060',
        bass: '#40c070',
        drums: '#c060e0',
        vocals: '#e0a030',
        other: '#50b0d0',
    };

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

    function _getTrackColor(t) {
        if (t.color) return t.color;
        const name = (t.track_name || t.instrument || '').toLowerCase();
        for (const [key, col] of Object.entries(INSTRUMENT_COLORS)) {
            if (name.includes(key)) return col;
        }
        return TRACK_COLORS[t.id % TRACK_COLORS.length];
    }

    function _renderTracks() {
        const container = document.getElementById('studio-recorded-tracks');
        if (!container) return;
        const tracks = _currentSession.tracks || [];

        let html = '';
        for (const t of tracks) {
            const state = _mixState[t.id] || { volume: 1.0, pan: 0.0, muted: false, solo: false, offset_ms: 0, fade_in_ms: 0, fade_out_ms: 0, eq_low: 0, eq_mid: 0, eq_high: 0, reverb_send: 0, comp_threshold: -24, comp_ratio: 1, comp_attack: 0.003, comp_release: 0.25 };
            const displayName = t.track_name || t.instrument || `Track ${t.id}`;
            const color = _getTrackColor(t);
            const hasAudio = t.audio_path && t.duration > 0;

            html += `
            <div class="bg-dark-700 rounded-xl px-4 py-3 border border-gray-800 ${hasAudio ? '' : 'opacity-60'}"
                 style="border-left: 3px solid ${color}" data-track-color="${color}">
                <div class="flex items-center gap-3">
                    <div class="w-28 flex-shrink-0">
                        <div class="flex items-center gap-1.5">
                            <button onclick="studioPickColor(${t.id}, this)" class="w-3 h-3 rounded-full flex-shrink-0 cursor-pointer hover:ring-2 hover:ring-white/30 transition-all"
                                style="background:${color}" title="Change color"></button>
                            <div class="text-white text-sm font-medium truncate cursor-pointer hover:text-accent transition-colors"
                                 ondblclick="studioRenameTrack(${t.id}, this)"
                                 title="Double-click to rename">${_esc(displayName)}</div>
                        </div>
                        <div class="text-gray-500 text-xs truncate ml-4.5">${_esc(t.recorded_by || (hasAudio ? '' : 'Empty'))}</div>
                    </div>`;

            if (hasAudio) {
                html += `
                    <canvas id="studio-waveform-${t.id}" class="flex-1 h-12 rounded bg-dark-800 cursor-pointer"
                        onclick="studioSeekFromWaveform(event, this)"></canvas>`;
            } else {
                html += `
                    <div class="flex-1 h-12 rounded bg-dark-800 flex items-center justify-center">
                        <label class="text-gray-600 text-xs cursor-pointer hover:text-gray-400 transition-colors">
                            Drop audio or <span class="underline">browse</span>
                            <input type="file" accept="audio/*" class="hidden"
                                onchange="studioImportToTrack(${t.id}, this)">
                        </label>
                    </div>`;
            }

            const offsetVal = state.offset_ms || 0;
            html += `
                    <div class="flex items-center gap-2 flex-shrink-0">
                        <input type="range" min="0" max="150" value="${Math.round(state.volume * 100)}"
                            class="w-16 h-1 accent-accent"
                            oninput="studioSetVolume(${t.id}, this.value/100)"
                            title="Volume">
                        <input type="range" min="-100" max="100" value="${Math.round(state.pan * 100)}"
                            class="w-12 h-1 accent-accent"
                            oninput="studioSetPan(${t.id}, this.value/100)"
                            title="Pan">
                        <input type="number" value="${offsetVal}" step="10"
                            class="w-14 bg-dark-800 text-gray-300 text-xs rounded px-1 py-0.5 border border-gray-700 text-center"
                            onchange="studioSetOffset(${t.id}, this.value)"
                            title="Offset (ms)">
                        <span class="text-gray-700 text-xs">FI</span>
                        <input type="number" value="${state.fade_in_ms || 0}" step="100" min="0"
                            class="w-12 bg-dark-800 text-gray-300 text-xs rounded px-1 py-0.5 border border-gray-700 text-center"
                            onchange="studioSetFade(${t.id}, 'in', this.value)"
                            title="Fade in (ms)">
                        <span class="text-gray-700 text-xs">FO</span>
                        <input type="number" value="${state.fade_out_ms || 0}" step="100" min="0"
                            class="w-12 bg-dark-800 text-gray-300 text-xs rounded px-1 py-0.5 border border-gray-700 text-center"
                            onchange="studioSetFade(${t.id}, 'out', this.value)"
                            title="Fade out (ms)">
                        <button onclick="studioToggleMute(${t.id})"
                            class="w-7 h-7 rounded text-xs font-bold transition-colors ${state.muted ? 'bg-red-600 text-white' : 'bg-dark-600 hover:bg-dark-500 text-gray-400'}"
                            data-mute="${t.id}">M</button>
                        <button onclick="studioToggleSolo(${t.id})"
                            class="w-7 h-7 rounded text-xs font-bold transition-colors ${state.solo ? 'bg-yellow-600 text-white' : 'bg-dark-600 hover:bg-dark-500 text-gray-400'}"
                            data-solo="${t.id}">S</button>
                        <button onclick="studioDeleteTrack(${t.id})"
                            class="w-7 h-7 rounded text-xs font-bold bg-dark-600 hover:bg-red-600/50 text-gray-600 hover:text-red-400 transition-colors"
                            title="Delete track">&times;</button>
                    </div>
                </div>
                <div class="mt-1.5 flex items-center gap-1.5 ml-28 pl-3 border-l border-gray-800">
                    <div class="cursor-pointer hover:brightness-125 transition-all rounded overflow-hidden border border-gray-700/50 h-8"
                         onclick="studioOpenFxPopup(${t.id}, 'eq')" title="EQ — ${_eqLabel(state)}">
                        <img src="/api/plugins/studio/gear-image/gear_rack_studioeq" class="h-8 w-auto" alt="EQ"
                             onerror="this.parentElement.innerHTML='<span class=\\'text-xs text-gray-500 px-2\\'>EQ</span>'">
                    </div>
                    <div class="cursor-pointer hover:brightness-125 transition-all rounded overflow-hidden border border-gray-700/50 h-8"
                         onclick="studioOpenFxPopup(${t.id}, 'comp')" title="Compressor — ${_compLabel(state)}">
                        <img src="/api/plugins/studio/gear-image/gear_rack_studiocompressor" class="h-8 w-auto" alt="Comp"
                             onerror="this.parentElement.innerHTML='<span class=\\'text-xs text-gray-500 px-2\\'>Comp</span>'">
                    </div>
                    <div class="cursor-pointer hover:brightness-125 transition-all rounded overflow-hidden border border-gray-700/50 h-8"
                         onclick="studioOpenFxPopup(${t.id}, 'reverb')" title="Reverb — ${state.reverb_send ? Math.round(state.reverb_send * 100) + '%' : 'Off'}">
                        <img src="/api/plugins/studio/gear-image/gear_rack_studioverb" class="h-8 w-auto" alt="Reverb"
                             onerror="this.parentElement.innerHTML='<span class=\\'text-xs text-gray-500 px-2\\'>Rev</span>'">
                    </div>
                    <span class="text-gray-600 text-xs ml-1">${_eqLabel(state)} | ${_compLabel(state)} | Rev ${state.reverb_send ? Math.round(state.reverb_send * 100) + '%' : 'Off'}</span>
                </div>
            </div>`;
        }

        container.innerHTML = html;
    }

    function _eqLabel(st) {
        const l = st.eq_low || 0, m = st.eq_mid || 0, h = st.eq_high || 0;
        if (l === 0 && m === 0 && h === 0) return 'Flat';
        return `${l > 0 ? '+' : ''}${l} / ${m > 0 ? '+' : ''}${m} / ${h > 0 ? '+' : ''}${h} dB`;
    }

    function _compLabel(st) {
        const r = st.comp_ratio ?? 1;
        if (r <= 1) return 'Off';
        return `${st.comp_threshold ?? -24}dB ${r}:1`;
    }

    // ── Playback (Web Audio API) ───────────────────────────────────────

    window.studioTogglePlay = function () {
        if (_isPlaying) {
            _pause();
        } else {
            _play();
        }
    };

    function _play() {
        if (_isPlaying) return;
        const ctx = _getAudioCtx();
        if (ctx.state === 'suspended') ctx.resume();

        _isPlaying = true;
        _startTime = ctx.currentTime - _pauseOffset;

        // Create master bus: gain → limiter → analyser → destination
        _masterGain = ctx.createGain();
        _masterGain.gain.value = _masterVolume;
        _masterAnalyser = ctx.createAnalyser();
        _masterAnalyser.fftSize = 256;

        if (_masterLimiterOn) {
            _masterLimiter = ctx.createDynamicsCompressor();
            _masterLimiter.threshold.value = -1;  // limit at ~0dBFS
            _masterLimiter.knee.value = 0;
            _masterLimiter.ratio.value = 20;      // hard limiting
            _masterLimiter.attack.value = 0.003;
            _masterLimiter.release.value = 0.05;
            _masterGain.connect(_masterLimiter).connect(_masterAnalyser).connect(ctx.destination);
        } else {
            _masterGain.connect(_masterAnalyser).connect(ctx.destination);
        }

        // Create shared reverb bus (feeds into master)
        _createReverbBus(ctx);

        // Start master meter
        _startMasterMeter();

        // Determine which tracks should be audible
        const hasSolo = _hasSoloActive();

        // Play original song
        if (_songBuffer) {
            _songSource = ctx.createBufferSource();
            _songSource.buffer = _songBuffer;
            _songGain = ctx.createGain();
            _songPan = ctx.createStereoPanner();

            const origState = _mixState.original || { volume: 1.0, pan: 0.0, muted: false, solo: false, offset_ms: 0, fade_in_ms: 0, fade_out_ms: 0, eq_low: 0, eq_mid: 0, eq_high: 0, reverb_send: 0, comp_threshold: -24, comp_ratio: 1, comp_attack: 0.003, comp_release: 0.25 };
            _songGain.gain.value = origState.muted ? 0 : (hasSolo && !origState.solo ? 0 : origState.volume);
            _songPan.pan.value = origState.pan;

            _songSource.connect(_songGain).connect(_songPan).connect(_masterGain);
            _songSource.start(0, _pauseOffset);
        }

        // Play recorded tracks
        if (_currentSession && _currentSession.tracks) {
            for (const t of _currentSession.tracks) {
                const buf = _trackBuffers[t.id];
                if (!buf) continue;

                const source = ctx.createBufferSource();
                source.buffer = buf;

                const st = _mixState[t.id] || { volume: 1.0, pan: 0.0, muted: false, solo: false, offset_ms: 0, fade_in_ms: 0, fade_out_ms: 0, eq_low: 0, eq_mid: 0, eq_high: 0, reverb_send: 0, comp_threshold: -24, comp_ratio: 1, comp_attack: 0.003, comp_release: 0.25 };

                // EQ: 3-band shelving/peaking filters
                const eqLow = ctx.createBiquadFilter();
                eqLow.type = 'lowshelf';
                eqLow.frequency.value = 200;
                eqLow.gain.value = st.eq_low || 0;

                const eqMid = ctx.createBiquadFilter();
                eqMid.type = 'peaking';
                eqMid.frequency.value = 1000;
                eqMid.Q.value = 1;
                eqMid.gain.value = st.eq_mid || 0;

                const eqHigh = ctx.createBiquadFilter();
                eqHigh.type = 'highshelf';
                eqHigh.frequency.value = 4000;
                eqHigh.gain.value = st.eq_high || 0;

                // Compressor (only active when ratio > 1)
                const comp = ctx.createDynamicsCompressor();
                comp.threshold.value = st.comp_threshold ?? -24;
                comp.ratio.value = Math.max(1, st.comp_ratio ?? 1);
                comp.attack.value = st.comp_attack ?? 0.003;
                comp.release.value = st.comp_release ?? 0.25;
                comp.knee.value = 6;

                const gain = ctx.createGain();
                const pan = ctx.createStereoPanner();

                gain.gain.value = st.muted ? 0 : (hasSolo && !st.solo ? 0 : st.volume);
                pan.pan.value = st.pan;

                if ((st.comp_ratio ?? 1) > 1) {
                    source.connect(eqLow).connect(eqMid).connect(eqHigh).connect(comp).connect(gain).connect(pan).connect(_masterGain);
                } else {
                    source.connect(eqLow).connect(eqMid).connect(eqHigh).connect(gain).connect(pan).connect(_masterGain);
                }

                // Apply time offset: positive = delay (start later), negative = trim start
                const offsetSec = (st.offset_ms || 0) / 1000;
                const trackPauseOffset = _pauseOffset - offsetSec;
                let sourceStartTime = ctx.currentTime;
                if (trackPauseOffset >= 0 && trackPauseOffset < buf.duration) {
                    source.start(0, trackPauseOffset);
                } else if (trackPauseOffset < 0) {
                    sourceStartTime = ctx.currentTime + Math.abs(trackPauseOffset);
                    source.start(sourceStartTime, 0);
                }

                // Apply fades via gain automation
                const fadeInSec = (st.fade_in_ms || 0) / 1000;
                const fadeOutSec = (st.fade_out_ms || 0) / 1000;
                const baseGain = st.muted ? 0 : (hasSolo && !st.solo ? 0 : st.volume);

                if (fadeInSec > 0 && trackPauseOffset < fadeInSec) {
                    // Currently within the fade-in zone
                    const fadeRemaining = fadeInSec - Math.max(0, trackPauseOffset);
                    const fadeProgress = Math.max(0, trackPauseOffset) / fadeInSec;
                    gain.gain.setValueAtTime(baseGain * fadeProgress, sourceStartTime);
                    gain.gain.linearRampToValueAtTime(baseGain, sourceStartTime + fadeRemaining);
                }
                if (fadeOutSec > 0 && buf.duration > fadeOutSec) {
                    const fadeOutStart = buf.duration - fadeOutSec - Math.max(0, trackPauseOffset);
                    if (fadeOutStart > 0) {
                        gain.gain.setValueAtTime(baseGain, sourceStartTime + fadeOutStart);
                        gain.gain.linearRampToValueAtTime(0, sourceStartTime + fadeOutStart + fadeOutSec);
                    }
                }

                // Reverb send: tap after EQ, before compressor/gain
                let reverbSend = null;
                const sendLevel = st.reverb_send || 0;
                if (sendLevel > 0 && _reverbNode) {
                    reverbSend = ctx.createGain();
                    reverbSend.gain.value = sendLevel;
                    eqHigh.connect(reverbSend);
                    reverbSend.connect(_reverbNode);
                }

                _trackSources[t.id] = { source, gain, pan, eqLow, eqMid, eqHigh, comp, reverbSend };
            }
        }

        document.getElementById('studio-btn-play').innerHTML = '&#9646;&#9646; Pause';
        _startAnimLoop();
    }

    function _pause() {
        if (!_isPlaying) return;
        const ctx = _getAudioCtx();
        _pauseOffset = ctx.currentTime - _startTime;
        _stopAllSources();
        _isPlaying = false;
        document.getElementById('studio-btn-play').innerHTML = '&#9654; Play';
        _stopAnimLoop();
    }

    window.studioStop = function () {
        _stopAllSources();
        _isPlaying = false;
        _pauseOffset = 0;
        document.getElementById('studio-btn-play').innerHTML = '&#9654; Play';
        document.getElementById('studio-time-current').textContent = '0:00';
        document.getElementById('studio-seek-bar').value = 0;
        _stopAnimLoop();
        _drawAllCursors(0);

        // Stop recording if active
        if (_isRecording) {
            _stopRecording();
        }
    };

    function _stopAllSources() {
        try { if (_songSource) _songSource.stop(); } catch (e) { /* ignore */ }
        _songSource = null;
        for (const key of Object.keys(_trackSources)) {
            try { _trackSources[key].source.stop(); } catch (e) { /* ignore */ }
        }
        _trackSources = {};
        _reverbNode = null;
        _reverbGain = null;
        _masterGain = null;
        _masterLimiter = null;
        _masterAnalyser = null;
        if (_masterMeterInterval) { clearInterval(_masterMeterInterval); _masterMeterInterval = null; }
    }

    window.studioSeek = function (val) {
        const t = parseFloat(val);
        if (_isPlaying) {
            _stopAllSources();
            _isPlaying = false;
            _pauseOffset = t;
            _play();
        } else {
            _pauseOffset = t;
            document.getElementById('studio-time-current').textContent = _formatTime(t);
            _drawAllCursors(t);
        }
    };

    window.studioSeekFromWaveform = function (event, canvas) {
        const rect = canvas.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const pct = x / rect.width;
        const visibleDur = _duration / _zoomLevel;
        const t = _scrollOffset + pct * visibleDur;
        studioSeek(t);
        document.getElementById('studio-seek-bar').value = t;
    };

    // ── Animation Loop ─────────────────────────────────────────────────

    function _startAnimLoop() {
        _stopAnimLoop();
        function tick() {
            if (!_isPlaying) return;
            const ctx = _getAudioCtx();
            const elapsed = ctx.currentTime - _startTime;
            document.getElementById('studio-time-current').textContent = _formatTime(elapsed);
            document.getElementById('studio-seek-bar').value = elapsed;
            _drawAllCursors(elapsed);
            if (elapsed >= _duration) {
                studioStop();
                return;
            }
            _animFrame = requestAnimationFrame(tick);
        }
        _animFrame = requestAnimationFrame(tick);
    }

    function _stopAnimLoop() {
        if (_animFrame) {
            cancelAnimationFrame(_animFrame);
            _animFrame = null;
        }
    }

    // ── Mix Controls ───────────────────────────────────────────────────

    window.studioSetVolume = function (trackKey, value) {
        _pushUndo();
        const v = Math.max(0, Math.min(1.5, parseFloat(value)));
        if (!_mixState[trackKey]) _mixState[trackKey] = { volume: 1.0, pan: 0.0, muted: false, solo: false, offset_ms: 0, fade_in_ms: 0, fade_out_ms: 0, eq_low: 0, eq_mid: 0, eq_high: 0, reverb_send: 0, comp_threshold: -24, comp_ratio: 1, comp_attack: 0.003, comp_release: 0.25 };
        _mixState[trackKey].volume = v;
        _applyMixToLiveAudio(trackKey);
        _debounceSaveMix();
    };

    window.studioSetPan = function (trackKey, value) {
        _pushUndo();
        const p = Math.max(-1, Math.min(1, parseFloat(value)));
        if (!_mixState[trackKey]) _mixState[trackKey] = { volume: 1.0, pan: 0.0, muted: false, solo: false, offset_ms: 0, fade_in_ms: 0, fade_out_ms: 0, eq_low: 0, eq_mid: 0, eq_high: 0, reverb_send: 0, comp_threshold: -24, comp_ratio: 1, comp_attack: 0.003, comp_release: 0.25 };
        _mixState[trackKey].pan = p;
        _applyMixToLiveAudio(trackKey);
        _debounceSaveMix();
    };

    window.studioSetOffset = function (trackKey, value) {
        _pushUndo();
        const ms = parseFloat(value) || 0;
        if (!_mixState[trackKey]) _mixState[trackKey] = { volume: 1.0, pan: 0.0, muted: false, solo: false, offset_ms: 0, fade_in_ms: 0, fade_out_ms: 0, eq_low: 0, eq_mid: 0, eq_high: 0, reverb_send: 0, comp_threshold: -24, comp_ratio: 1, comp_attack: 0.003, comp_release: 0.25 };
        _mixState[trackKey].offset_ms = ms;
        _debounceSaveMix();
    };

    window.studioSetFade = function (trackKey, type, value) {
        _pushUndo();
        const ms = Math.max(0, parseFloat(value) || 0);
        if (!_mixState[trackKey]) _mixState[trackKey] = { volume: 1.0, pan: 0.0, muted: false, solo: false, offset_ms: 0, fade_in_ms: 0, fade_out_ms: 0, eq_low: 0, eq_mid: 0, eq_high: 0, reverb_send: 0, comp_threshold: -24, comp_ratio: 1, comp_attack: 0.003, comp_release: 0.25 };
        if (type === 'in') _mixState[trackKey].fade_in_ms = ms;
        else _mixState[trackKey].fade_out_ms = ms;
        _debounceSaveMix();
        // Redraw waveform to show fade overlay
        const curTime = _isPlaying ? (_getAudioCtx().currentTime - _startTime) : _pauseOffset;
        _drawAllCursors(curTime);
    };

    window.studioSetEq = function (trackKey, band, value) {
        _pushUndo();
        const db = Math.max(-12, Math.min(12, parseFloat(value) || 0));
        if (!_mixState[trackKey]) _mixState[trackKey] = { volume: 1.0, pan: 0.0, muted: false, solo: false, offset_ms: 0, fade_in_ms: 0, fade_out_ms: 0, eq_low: 0, eq_mid: 0, eq_high: 0, reverb_send: 0, comp_threshold: -24, comp_ratio: 1, comp_attack: 0.003, comp_release: 0.25 };
        _mixState[trackKey]['eq_' + band] = db;
        // Apply live to playing audio
        const ts = _trackSources[trackKey];
        if (ts) {
            if (band === 'low' && ts.eqLow) ts.eqLow.gain.value = db;
            if (band === 'mid' && ts.eqMid) ts.eqMid.gain.value = db;
            if (band === 'high' && ts.eqHigh) ts.eqHigh.gain.value = db;
        }
        // Update label
        const label = document.getElementById(`studio-eq-label-${trackKey}`);
        if (label) label.textContent = _eqLabel(_mixState[trackKey]);
        _debounceSaveMix();
    };

    window.studioSetReverbSend = function (trackKey, value) {
        _pushUndo();
        const v = Math.max(0, Math.min(1, parseFloat(value) || 0));
        const st = _mixState[trackKey];
        if (!st) return;
        st.reverb_send = v;
        // Apply live
        const ts = _trackSources[trackKey];
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
        const st = _mixState[trackKey];
        if (!st) return;
        st['comp_' + param] = v;
        // Apply live
        const ts = _trackSources[trackKey];
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
        if (!_mixState[trackKey]) _mixState[trackKey] = { volume: 1.0, pan: 0.0, muted: false, solo: false, offset_ms: 0, fade_in_ms: 0, fade_out_ms: 0, eq_low: 0, eq_mid: 0, eq_high: 0, reverb_send: 0, comp_threshold: -24, comp_ratio: 1, comp_attack: 0.003, comp_release: 0.25 };
        _mixState[trackKey].muted = !_mixState[trackKey].muted;
        const btn = document.querySelector(`[data-mute="${trackKey}"]`);
        if (btn) {
            if (_mixState[trackKey].muted) {
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
        if (!_mixState[trackKey]) _mixState[trackKey] = { volume: 1.0, pan: 0.0, muted: false, solo: false, offset_ms: 0, fade_in_ms: 0, fade_out_ms: 0, eq_low: 0, eq_mid: 0, eq_high: 0, reverb_send: 0, comp_threshold: -24, comp_ratio: 1, comp_attack: 0.003, comp_release: 0.25 };
        _mixState[trackKey].solo = !_mixState[trackKey].solo;
        const btn = document.querySelector(`[data-solo="${trackKey}"]`);
        if (btn) {
            if (_mixState[trackKey].solo) {
                btn.className = 'w-7 h-7 rounded text-xs font-bold transition-colors bg-yellow-600 text-white';
            } else {
                btn.className = 'w-7 h-7 rounded text-xs font-bold transition-colors bg-dark-600 hover:bg-dark-500 text-gray-400';
            }
        }
        _applyAllMixToLive();
        _debounceSaveMix();
    };

    function _hasSoloActive() {
        for (const key of Object.keys(_mixState)) {
            if (_mixState[key].solo) return true;
        }
        return false;
    }

    function _applyMixToLiveAudio(trackKey) {
        const hasSolo = _hasSoloActive();
        if (trackKey === 'original') {
            if (_songGain && _songPan) {
                const st = _mixState.original;
                _songGain.gain.value = st.muted ? 0 : (hasSolo && !st.solo ? 0 : st.volume);
                _songPan.pan.value = st.pan;
            }
        } else if (_trackSources[trackKey]) {
            const st = _mixState[trackKey] || { volume: 1.0, pan: 0.0, muted: false, solo: false, offset_ms: 0, fade_in_ms: 0, fade_out_ms: 0, eq_low: 0, eq_mid: 0, eq_high: 0, reverb_send: 0, comp_threshold: -24, comp_ratio: 1, comp_attack: 0.003, comp_release: 0.25 };
            _trackSources[trackKey].gain.gain.value = st.muted ? 0 : (hasSolo && !st.solo ? 0 : st.volume);
            _trackSources[trackKey].pan.pan.value = st.pan;
        }
    }

    function _applyAllMixToLive() {
        const hasSolo = _hasSoloActive();
        // Original
        if (_songGain && _songPan) {
            const st = _mixState.original || { volume: 1.0, pan: 0.0, muted: false, solo: false, offset_ms: 0, fade_in_ms: 0, fade_out_ms: 0, eq_low: 0, eq_mid: 0, eq_high: 0, reverb_send: 0, comp_threshold: -24, comp_ratio: 1, comp_attack: 0.003, comp_release: 0.25 };
            _songGain.gain.value = st.muted ? 0 : (hasSolo && !st.solo ? 0 : st.volume);
            _songPan.pan.value = st.pan;
        }
        // Tracks
        for (const key of Object.keys(_trackSources)) {
            const st = _mixState[key] || { volume: 1.0, pan: 0.0, muted: false, solo: false, offset_ms: 0, fade_in_ms: 0, fade_out_ms: 0, eq_low: 0, eq_mid: 0, eq_high: 0, reverb_send: 0, comp_threshold: -24, comp_ratio: 1, comp_attack: 0.003, comp_release: 0.25 };
            _trackSources[key].gain.gain.value = st.muted ? 0 : (hasSolo && !st.solo ? 0 : st.volume);
            _trackSources[key].pan.pan.value = st.pan;
        }
    }

    let _saveMixTimer = null;
    function _debounceSaveMix() {
        if (_saveMixTimer) clearTimeout(_saveMixTimer);
        _saveMixTimer = setTimeout(_saveMixSettings, 1000);
    }

    async function _saveMixSettings() {
        if (!_currentSession) return;
        const settings = [];
        for (const key of Object.keys(_mixState)) {
            if (key === 'original') continue;
            const s = _mixState[key];
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
            await fetch(`/api/plugins/studio/sessions/${_currentSession.id}/mix-settings`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ settings }),
            });
        } catch (e) {
            console.error('[Studio] Failed to save mix settings:', e);
        }
    }

    // ── Recording ──────────────────────────────────────────────────────

    window.studioToggleRecord = function () {
        if (_isRecording) {
            _stopRecording();
        } else {
            _startRecording();
        }
    };

    async function _startRecording() {
        const ctx = _getAudioCtx();
        if (ctx.state === 'suspended') await ctx.resume();

        // Get audio input
        const deviceSelect = document.getElementById('studio-input-device');
        const deviceId = deviceSelect ? deviceSelect.value : '';
        if (deviceId) _selectedDeviceId = deviceId;
        _saveSettings();

        const constraints = { audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false } };
        if (deviceId) constraints.audio.deviceId = { exact: deviceId };

        try {
            _mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
        } catch (e) {
            console.error('[Studio] Mic access denied:', e);
            alert('Microphone access denied. Please allow mic access and try again.');
            return;
        }

        _recordedChunks = [];

        // Use MediaRecorder with WAV-compatible format
        const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
            ? 'audio/webm;codecs=opus' : 'audio/webm';
        _mediaRecorder = new MediaRecorder(_mediaStream, { mimeType });

        _mediaRecorder.ondataavailable = (e) => {
            if (e.data.size > 0) _recordedChunks.push(e.data);
        };

        _mediaRecorder.onstop = () => {
            _uploadRecording();
        };

        _mediaRecorder.start(); // single blob on stop — avoids corrupt webm chunks
        _isRecording = true;
        _recStartTime = Date.now();

        // Update UI
        document.getElementById('studio-recording-bar').classList.remove('hidden');
        const recBtn = document.getElementById('studio-btn-record');
        recBtn.innerHTML = '<span class="w-2.5 h-2.5 rounded-sm bg-red-500"></span> Stop';
        recBtn.classList.add('bg-red-600/40');

        // Start recording timer
        _recInterval = setInterval(() => {
            const elapsed = (Date.now() - _recStartTime) / 1000;
            document.getElementById('studio-rec-time').textContent = _formatTime(elapsed);
        }, 200);

        // Start playback simultaneously so the musician hears the song
        if (!_isPlaying) _play();
    }

    function _stopRecording() {
        _isRecording = false;
        if (_mediaRecorder && _mediaRecorder.state !== 'inactive') {
            _mediaRecorder.stop();
        }
        if (_mediaStream) {
            _mediaStream.getTracks().forEach(t => t.stop());
            _mediaStream = null;
        }
        if (_recInterval) {
            clearInterval(_recInterval);
            _recInterval = null;
        }

        // Update UI
        document.getElementById('studio-recording-bar').classList.add('hidden');
        const recBtn = document.getElementById('studio-btn-record');
        recBtn.innerHTML = '<span class="w-2.5 h-2.5 rounded-full bg-red-500"></span> Record';
        recBtn.classList.remove('bg-red-600/40');
    }

    async function _uploadRecording() {
        if (!_recordedChunks.length || !_currentSession) return;

        const blob = new Blob(_recordedChunks, { type: 'audio/webm' });
        _recordedChunks = [];

        const instrument = document.getElementById('studio-record-trackname').value;
        const formData = new FormData();
        formData.append('file', blob, `recording_${Date.now()}.webm`);
        formData.append('instrument', instrument);
        formData.append('recorded_by', _userName);

        // Show upload progress
        const uploadBar = document.getElementById('studio-upload-bar');
        uploadBar.classList.remove('hidden');

        try {
            const xhr = new XMLHttpRequest();
            xhr.upload.addEventListener('progress', (e) => {
                if (e.lengthComputable) {
                    const pct = Math.round((e.loaded / e.total) * 100);
                    document.getElementById('studio-upload-pct').textContent = pct + '%';
                    document.getElementById('studio-upload-progress').style.width = pct + '%';
                }
            });

            await new Promise((resolve, reject) => {
                xhr.onload = () => {
                    if (xhr.status >= 200 && xhr.status < 300) {
                        resolve(JSON.parse(xhr.responseText));
                    } else {
                        reject(new Error(xhr.responseText));
                    }
                };
                xhr.onerror = () => reject(new Error('Upload failed'));
                xhr.open('POST', `/api/plugins/studio/sessions/${_currentSession.id}/upload`);
                xhr.send(formData);
            });

            // Reload session to show new track
            await _reloadSession();
        } catch (e) {
            console.error('[Studio] Upload error:', e);
            alert('Failed to upload recording.');
        } finally {
            uploadBar.classList.add('hidden');
        }
    }

    // ── Punch-in Recording ───────────────────────────────────────────

    let _punchIn = 0;
    let _punchOut = 0;
    let _punchTrackId = null;
    let _punchRecording = false;
    let _punchMediaStream = null;
    let _punchMediaRecorder = null;
    let _punchChunks = [];
    let _punchAutoStopTimer = null;
    const PUNCH_PREROLL = 3; // seconds before punch-in to start playback

    function _populatePunchTrackSelect() {
        const sel = document.getElementById('studio-punch-track');
        if (!sel || !_currentSession) return;
        sel.innerHTML = '';
        const tracks = _currentSession.tracks || [];
        for (const t of tracks) {
            if (!t.audio_path || t.duration <= 0) continue;
            const name = t.track_name || t.instrument || `Track ${t.id}`;
            const opt = document.createElement('option');
            opt.value = t.id;
            opt.textContent = name;
            sel.appendChild(opt);
        }
    }

    function _parseTimeInput(val) {
        // Parse "M:SS" or "M:SS.ms" or plain seconds
        val = (val || '').trim();
        const match = val.match(/^(\d+):(\d{1,2})(?:\.(\d+))?$/);
        if (match) {
            return parseInt(match[1]) * 60 + parseInt(match[2]) + (match[3] ? parseFloat('0.' + match[3]) : 0);
        }
        const n = parseFloat(val);
        return isNaN(n) ? 0 : n;
    }

    window.studioPunchSetIn = function () {
        const seekBar = document.getElementById('studio-seek-bar');
        const t = parseFloat(seekBar?.value || 0);
        _punchIn = t;
        document.getElementById('studio-punch-in').value = _formatTime(t);
    };

    window.studioPunchSetOut = function () {
        const seekBar = document.getElementById('studio-seek-bar');
        const t = parseFloat(seekBar?.value || 0);
        _punchOut = t;
        document.getElementById('studio-punch-out').value = _formatTime(t);
    };

    window.studioPunchRecord = async function () {
        if (_punchRecording) {
            _stopPunchRecord();
            return;
        }

        _punchIn = _parseTimeInput(document.getElementById('studio-punch-in').value);
        _punchOut = _parseTimeInput(document.getElementById('studio-punch-out').value);
        const sel = document.getElementById('studio-punch-track');
        _punchTrackId = sel ? parseInt(sel.value) : null;

        if (!_punchTrackId) { alert('Select a track to punch into.'); return; }
        if (_punchIn >= _punchOut) { alert('Punch In must be before Punch Out.'); return; }
        if (_punchOut - _punchIn < 0.5) { alert('Punch region too short (min 0.5s).'); return; }

        // Get mic
        const deviceSelect = document.getElementById('studio-input-device');
        const deviceId = deviceSelect ? deviceSelect.value : _selectedDeviceId;
        const constraints = { audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false } };
        if (deviceId) constraints.audio.deviceId = { exact: deviceId };

        try {
            _punchMediaStream = await navigator.mediaDevices.getUserMedia(constraints);
        } catch (e) {
            alert('Microphone access denied.');
            return;
        }

        _punchChunks = [];
        const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
            ? 'audio/webm;codecs=opus' : 'audio/webm';
        _punchMediaRecorder = new MediaRecorder(_punchMediaStream, { mimeType });
        _punchMediaRecorder.ondataavailable = (e) => {
            if (e.data.size > 0) _punchChunks.push(e.data);
        };
        _punchMediaRecorder.onstop = () => { _uploadPunchRecording(); };

        // Start playback from pre-roll point
        const prerollStart = Math.max(0, _punchIn - PUNCH_PREROLL);
        studioSeek(prerollStart);
        _play();

        // Start recorder at the punch-in time
        const delayToRecord = (_punchIn - prerollStart) * 1000;
        setTimeout(() => {
            if (!_punchRecording) return; // cancelled
            _punchMediaRecorder.start();
            console.log(`[Studio] Punch recording started at ${_punchIn}s`);
        }, delayToRecord);

        // Auto-stop at punch-out
        const delayToStop = (_punchOut - prerollStart) * 1000;
        _punchAutoStopTimer = setTimeout(() => {
            _stopPunchRecord();
        }, delayToStop);

        _punchRecording = true;

        // Update button
        const btn = document.getElementById('studio-btn-punch');
        btn.innerHTML = '<span class="w-2 h-2 rounded-sm bg-orange-500"></span> Stop Punch';
        btn.classList.add('bg-orange-600/40');

        // Show recording bar
        const recBar = document.getElementById('studio-recording-bar');
        recBar.classList.remove('hidden');
        recBar.querySelector('span:nth-child(2)').textContent =
            `Punch: ${_formatTime(_punchIn)} → ${_formatTime(_punchOut)}`;
    };

    function _stopPunchRecord() {
        _punchRecording = false;
        if (_punchAutoStopTimer) { clearTimeout(_punchAutoStopTimer); _punchAutoStopTimer = null; }

        if (_punchMediaRecorder && _punchMediaRecorder.state !== 'inactive') {
            _punchMediaRecorder.stop();
        }
        if (_punchMediaStream) {
            _punchMediaStream.getTracks().forEach(t => t.stop());
            _punchMediaStream = null;
        }

        _pause();
        document.getElementById('studio-recording-bar').classList.add('hidden');

        const btn = document.getElementById('studio-btn-punch');
        btn.innerHTML = '<span class="w-2 h-2 rounded-full bg-orange-500"></span> Punch Record';
        btn.classList.remove('bg-orange-600/40');
    }

    async function _uploadPunchRecording() {
        if (!_punchChunks.length || !_punchTrackId) return;

        const blob = new Blob(_punchChunks, { type: 'audio/webm' });
        _punchChunks = [];

        const formData = new FormData();
        formData.append('file', blob, `punch_${Date.now()}.webm`);
        formData.append('punch_in', _punchIn.toFixed(3));
        formData.append('punch_out', _punchOut.toFixed(3));

        const uploadBar = document.getElementById('studio-upload-bar');
        uploadBar.classList.remove('hidden');

        try {
            const xhr = new XMLHttpRequest();
            xhr.upload.addEventListener('progress', (e) => {
                if (e.lengthComputable) {
                    const pct = Math.round((e.loaded / e.total) * 100);
                    document.getElementById('studio-upload-pct').textContent = pct + '%';
                    document.getElementById('studio-upload-progress').style.width = pct + '%';
                }
            });

            await new Promise((resolve, reject) => {
                xhr.onload = () => {
                    if (xhr.status >= 200 && xhr.status < 300) resolve(JSON.parse(xhr.responseText));
                    else reject(new Error(xhr.responseText));
                };
                xhr.onerror = () => reject(new Error('Upload failed'));
                xhr.open('POST', `/api/plugins/studio/tracks/${_punchTrackId}/splice`);
                xhr.send(formData);
            });

            await _reloadSession();
        } catch (e) {
            console.error('[Studio] Punch upload error:', e);
            alert('Punch-in splice failed: ' + e.message);
        } finally {
            uploadBar.classList.add('hidden');
        }
    }

    // ── Practice (open song on highway) ──────────────────────────────

    window.studioPractice = function () {
        if (!_currentSession) return;
        const filename = encodeURIComponent(_currentSession.song_filename);
        if (typeof playSong === 'function') {
            playSong(filename);
        } else {
            alert('Player not available.');
        }
    };

    // ── Highway Recording ──────────────────────────────────────────────
    // Records mic input while the user plays along on the highway/player.
    // Overlay waits for audio to load, then user starts recording in sync.

    let _hwRecording = false;
    let _hwMediaStream = null;
    let _hwMediaRecorder = null;
    let _hwRecordedChunks = [];
    let _hwRecStartTime = 0;
    let _hwRecInterval = null;
    let _hwOverlay = null;
    let _hwDrawHookAdded = false;
    let _hwAudioCtx = null;
    let _hwGainNode = null;
    let _hwAnalyser = null;
    let _hwSourceNode = null;
    let _hwRecDest = null;
    let _hwMeterInterval = null;
    let _hwInputGain = 1.0;
    let _hwInstrument = '';
    let _hwExpectedDuration = 0;  // audio.currentTime at stop — ground truth for drift correction

    window.studioHighwayRecord = async function () {
        if (!_currentSession) return;

        _hwInstrument = document.getElementById('studio-record-trackname').value;
        const deviceSelect = document.getElementById('studio-input-device');
        const deviceId = deviceSelect ? deviceSelect.value : _selectedDeviceId;
        if (deviceId) { _selectedDeviceId = deviceId; _saveSettings(); }

        // Request mic access before navigating away
        const constraints = {
            audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false }
        };
        if (deviceId) constraints.audio.deviceId = { exact: deviceId };

        try {
            _hwMediaStream = await navigator.mediaDevices.getUserMedia(constraints);
        } catch (e) {
            console.error('[Studio] Mic access denied:', e);
            alert('Microphone access denied. Please allow mic access and try again.');
            return;
        }

        // Set up audio graph: mic → gain → destination (for recording)
        //                       mic → gain → analyser (for metering)
        _hwAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
        if (_hwAudioCtx.state === 'suspended') await _hwAudioCtx.resume();
        _hwSourceNode = _hwAudioCtx.createMediaStreamSource(_hwMediaStream);
        _hwGainNode = _hwAudioCtx.createGain();
        _hwGainNode.gain.value = _hwInputGain;
        _hwAnalyser = _hwAudioCtx.createAnalyser();
        _hwAnalyser.fftSize = 256;
        _hwRecDest = _hwAudioCtx.createMediaStreamDestination();

        _hwSourceNode.connect(_hwGainNode);
        _hwGainNode.connect(_hwRecDest);
        _hwGainNode.connect(_hwAnalyser);

        // Open song on the highway
        const filename = encodeURIComponent(_currentSession.song_filename);
        if (typeof playSong !== 'function') {
            alert('Player not available.');
            _cleanupHwAudio();
            return;
        }
        playSong(filename);

        // Show overlay immediately in "waiting" state
        _createHwOverlay('waiting');

        // Wait for the audio element to be ready
        _waitForAudioReady();
    };

    let _hwWaitCancelled = false;

    function _waitForAudioReady() {
        const audio = document.getElementById('audio');
        if (!audio) { setTimeout(_waitForAudioReady, 500); return; }

        _hwWaitCancelled = false;
        const initialSrc = audio.src;

        function checkReady() {
            if (_hwWaitCancelled) return;  // recording started or cancelled
            if (audio.src && audio.src !== initialSrc) {
                if (audio.readyState >= 3) {
                    if (!_hwWaitCancelled) _updateHwOverlay('ready');
                } else {
                    audio.addEventListener('canplay', onCanPlay);
                }
            } else {
                setTimeout(checkReady, 300);
            }
        }

        function onCanPlay() {
            audio.removeEventListener('canplay', onCanPlay);
            if (!_hwWaitCancelled) _updateHwOverlay('ready');
        }

        setTimeout(checkReady, 500);

        // Timeout fallback
        setTimeout(() => {
            audio.removeEventListener('canplay', onCanPlay);
            if (!_hwWaitCancelled && audio.src) {
                _updateHwOverlay('ready');
            }
        }, 30000);
    }

    function _createHwOverlay(state) {
        if (_hwOverlay) _hwOverlay.remove();
        _hwOverlay = document.createElement('div');
        _hwOverlay.id = 'studio-hw-overlay';
        _hwOverlay.className = 'fixed top-4 left-1/2 -translate-x-1/2 z-[300] flex flex-col gap-2 bg-black/90 backdrop-blur-sm border border-red-600/50 rounded-xl px-5 py-3 shadow-2xl min-w-[340px]';
        document.body.appendChild(_hwOverlay);
        _updateHwOverlay(state);
    }

    function _updateHwOverlay(state) {
        if (!_hwOverlay) return;

        if (state === 'waiting') {
            _hwOverlay.innerHTML = `
                <div class="flex items-center gap-3">
                    <span class="w-3 h-3 rounded-full bg-yellow-500 animate-pulse"></span>
                    <span class="text-yellow-300 text-sm font-medium">Waiting for song to load...</span>
                    <button id="studio-hw-cancel-btn" class="ml-auto px-2 py-1 bg-dark-600 hover:bg-dark-500 text-gray-400 rounded-lg text-xs transition-colors">
                        Cancel
                    </button>
                </div>`;
            document.getElementById('studio-hw-cancel-btn').onclick = () => _stopHighwayRecording(true);
        }

        else if (state === 'ready') {
            _hwOverlay.innerHTML = `
                <div class="flex items-center gap-3">
                    <span class="w-3 h-3 rounded-full bg-green-500"></span>
                    <span class="text-green-300 text-sm font-medium">Ready</span>
                    <span class="text-gray-500 text-xs">${_esc(_hwInstrument)}</span>
                    <button id="studio-hw-go-btn" class="ml-auto px-3 py-1 bg-red-600 hover:bg-red-700 text-white rounded-lg text-sm font-medium transition-colors">
                        Start Recording
                    </button>
                    <button id="studio-hw-cancel-btn" class="px-2 py-1 bg-dark-600 hover:bg-dark-500 text-gray-400 rounded-lg text-xs transition-colors">
                        Cancel
                    </button>
                </div>
                <div class="flex items-center gap-2">
                    <label class="text-gray-500 text-xs w-12">Input</label>
                    <input id="studio-hw-gain" type="range" min="0" max="300" value="${Math.round(_hwInputGain * 100)}"
                        class="flex-1 h-1 accent-accent" title="Input gain">
                    <span id="studio-hw-gain-val" class="text-gray-400 text-xs w-10 text-right">${Math.round(_hwInputGain * 100)}%</span>
                    <div id="studio-hw-meter" class="w-24 h-3 bg-dark-800 rounded-full overflow-hidden">
                        <div id="studio-hw-meter-bar" class="h-full bg-green-500 rounded-full transition-all" style="width:0%"></div>
                    </div>
                </div>`;
            document.getElementById('studio-hw-go-btn').onclick = _beginHwRecording;
            document.getElementById('studio-hw-cancel-btn').onclick = () => _stopHighwayRecording(true);
            document.getElementById('studio-hw-gain').oninput = (e) => {
                _hwInputGain = e.target.value / 100;
                if (_hwGainNode) _hwGainNode.gain.value = _hwInputGain;
                document.getElementById('studio-hw-gain-val').textContent = Math.round(_hwInputGain * 100) + '%';
            };

            // Start level metering
            _startHwMeter();
        }

        else if (state === 'recording') {
            _hwOverlay.innerHTML = `
                <div class="flex items-center gap-3">
                    <span class="w-3 h-3 rounded-full bg-red-500 animate-pulse"></span>
                    <span class="text-red-300 text-sm font-medium">Recording</span>
                    <span id="studio-hw-rec-time" class="text-red-400 text-sm font-mono">0:00</span>
                    <span class="text-gray-600 mx-1">|</span>
                    <span class="text-gray-400 text-xs">${_esc(_hwInstrument)}</span>
                    <span id="studio-hw-play-hint" class="text-yellow-400 text-xs animate-pulse">Press Play &#9654; on the highway</span>
                    <button id="studio-hw-stop-btn" class="ml-auto px-3 py-1 bg-red-600 hover:bg-red-700 text-white rounded-lg text-sm font-medium transition-colors">
                        Stop &amp; Save
                    </button>
                    <button id="studio-hw-cancel-btn" class="px-2 py-1 bg-dark-600 hover:bg-dark-500 text-gray-400 rounded-lg text-xs transition-colors">
                        Cancel
                    </button>
                </div>
                <div class="flex items-center gap-2">
                    <label class="text-gray-500 text-xs w-12">Input</label>
                    <input id="studio-hw-gain" type="range" min="0" max="300" value="${Math.round(_hwInputGain * 100)}"
                        class="flex-1 h-1 accent-accent" title="Input gain">
                    <span id="studio-hw-gain-val" class="text-gray-400 text-xs w-10 text-right">${Math.round(_hwInputGain * 100)}%</span>
                    <div id="studio-hw-meter" class="w-24 h-3 bg-dark-800 rounded-full overflow-hidden">
                        <div id="studio-hw-meter-bar" class="h-full bg-green-500 rounded-full transition-all" style="width:0%"></div>
                    </div>
                </div>`;
            document.getElementById('studio-hw-stop-btn').onclick = () => _stopHighwayRecording(false);
            document.getElementById('studio-hw-cancel-btn').onclick = () => _stopHighwayRecording(true);
            document.getElementById('studio-hw-gain').oninput = (e) => {
                _hwInputGain = e.target.value / 100;
                if (_hwGainNode) _hwGainNode.gain.value = _hwInputGain;
                document.getElementById('studio-hw-gain-val').textContent = Math.round(_hwInputGain * 100) + '%';
            };
        }
    }

    function _startHwMeter() {
        if (_hwMeterInterval) clearInterval(_hwMeterInterval);
        _hwMeterInterval = setInterval(() => {
            if (!_hwAnalyser) return;
            const data = new Uint8Array(_hwAnalyser.frequencyBinCount);
            _hwAnalyser.getByteTimeDomainData(data);
            let peak = 0;
            for (let i = 0; i < data.length; i++) {
                const v = Math.abs(data[i] - 128) / 128;
                if (v > peak) peak = v;
            }
            const bar = document.getElementById('studio-hw-meter-bar');
            if (bar) {
                const pct = Math.min(100, Math.round(peak * 100));
                bar.style.width = pct + '%';
                bar.className = 'h-full rounded-full transition-all ' +
                    (peak > 0.9 ? 'bg-red-500' : peak > 0.6 ? 'bg-yellow-500' : 'bg-green-500');
            }
        }, 50);
    }

    let _hwPlayOffset = 0;   // seconds of recording before audio started playing
    let _hwPlayListener = null;

    async function _beginHwRecording() {
        const audio = document.getElementById('audio');
        if (!audio) return;

        // Stop all pending wait/poll logic so it can't overwrite the overlay
        _hwWaitCancelled = true;

        if (_hwAudioCtx && _hwAudioCtx.state === 'suspended') await _hwAudioCtx.resume();

        _hwRecordedChunks = [];
        _hwPlayOffset = 0;
        const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
            ? 'audio/webm;codecs=opus' : 'audio/webm';
        _hwMediaRecorder = new MediaRecorder(_hwMediaStream, { mimeType });

        _hwMediaRecorder.ondataavailable = (e) => {
            if (e.data.size > 0) _hwRecordedChunks.push(e.data);
        };
        _hwMediaRecorder.onstop = () => {
            _hwUploadRecording(_hwInstrument);
        };

        // Start recording immediately. Don't call audio.play() — the highway
        // has its own buffering/play system that conflicts. The user presses
        // Play on the highway controls themselves. We listen for the 'play'
        // event to know when audio actually started, and trim the leading
        // dead time server-side.
        _hwMediaRecorder.start();
        _hwRecording = true;
        _hwRecStartTime = Date.now();

        // Listen for when the user actually starts playback
        _hwPlayListener = () => {
            _hwPlayOffset = (Date.now() - _hwRecStartTime) / 1000;
            audio.removeEventListener('play', _hwPlayListener);
            _hwPlayListener = null;
            // Hide the "press play" hint
            const hint = document.getElementById('studio-hw-play-hint');
            if (hint) hint.remove();
            console.log(`[Studio] Audio play detected, offset: ${_hwPlayOffset.toFixed(2)}s`);
        };
        audio.addEventListener('play', _hwPlayListener);

        // Switch overlay to recording state
        _updateHwOverlay('recording');

        _hwRecInterval = setInterval(() => {
            const el = document.getElementById('studio-hw-rec-time');
            if (el) {
                const elapsed = (Date.now() - _hwRecStartTime) / 1000;
                el.textContent = _formatTime(elapsed);
            }
        }, 200);

        if (typeof highway !== 'undefined' && highway.addDrawHook && !_hwDrawHookAdded) {
            highway.addDrawHook(_hwDrawHook);
            _hwDrawHookAdded = true;
        }
    }

    // Draw hook: red glow border on highway canvas while recording
    function _hwDrawHook(ctx, W, H) {
        if (!_hwRecording) return;
        ctx.save();
        ctx.strokeStyle = 'rgba(239, 68, 68, 0.6)';
        ctx.lineWidth = 4;
        ctx.strokeRect(2, 2, W - 4, H - 4);
        const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 300);
        ctx.globalAlpha = 0.5 + 0.5 * pulse;
        ctx.fillStyle = '#ef4444';
        ctx.beginPath();
        ctx.arc(20, 20, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }

    function _cleanupHwAudio() {
        if (_hwMeterInterval) {
            clearInterval(_hwMeterInterval);
            _hwMeterInterval = null;
        }
        if (_hwMediaStream) {
            _hwMediaStream.getTracks().forEach(t => t.stop());
            _hwMediaStream = null;
        }
        _hwSourceNode = null;
        _hwRecDest = null;
        _hwGainNode = null;
        _hwAnalyser = null;
        if (_hwAudioCtx) {
            _hwAudioCtx.close().catch(() => {});
            _hwAudioCtx = null;
        }
    }

    function _stopHighwayRecording(cancel) {
        _hwRecording = false;
        _hwWaitCancelled = true;

        const audio = document.getElementById('audio');
        _hwExpectedDuration = audio ? audio.currentTime : 0;

        if (_hwPlayListener && audio) {
            audio.removeEventListener('play', _hwPlayListener);
            _hwPlayListener = null;
        }

        if (_hwRecInterval) {
            clearInterval(_hwRecInterval);
            _hwRecInterval = null;
        }
        if (_hwOverlay) {
            _hwOverlay.remove();
            _hwOverlay = null;
        }

        if (cancel) {
            if (_hwMediaRecorder && _hwMediaRecorder.state !== 'inactive') {
                _hwMediaRecorder.ondataavailable = null;
                _hwMediaRecorder.onstop = null;
                _hwMediaRecorder.stop();
            }
            _hwRecordedChunks = [];
            _cleanupHwAudio();
        } else {
            if (_hwMediaRecorder && _hwMediaRecorder.state !== 'inactive') {
                const origOnStop = _hwMediaRecorder.onstop;
                _hwMediaRecorder.onstop = () => {
                    if (origOnStop) origOnStop();
                    _cleanupHwAudio();
                };
                _hwMediaRecorder.stop();
            } else {
                _cleanupHwAudio();
            }
        }
    }

    async function _hwUploadRecording(instrument) {
        if (!_hwRecordedChunks.length || !_currentSession) return;

        const blob = new Blob(_hwRecordedChunks, { type: 'audio/webm' });
        _hwRecordedChunks = [];

        const formData = new FormData();
        formData.append('file', blob, `recording_${Date.now()}.webm`);
        formData.append('instrument', instrument);
        formData.append('recorded_by', _userName);
        if (_hwExpectedDuration > 0) {
            formData.append('expected_duration', _hwExpectedDuration.toFixed(3));
        }
        if (_hwPlayOffset > 0.1) {
            formData.append('trim_start', _hwPlayOffset.toFixed(3));
        }
        if (_hwInputGain !== 1.0) {
            formData.append('input_gain', _hwInputGain.toFixed(3));
        }

        const toast = document.createElement('div');
        toast.className = 'fixed top-4 left-1/2 -translate-x-1/2 z-[300] bg-black/80 backdrop-blur-sm border border-gray-700 rounded-xl px-4 py-2.5 shadow-2xl text-sm';
        toast.innerHTML = '<span class="text-gray-300">Uploading recording...</span> <span id="studio-hw-upload-pct" class="text-accent font-mono">0%</span>';
        document.body.appendChild(toast);

        try {
            const xhr = new XMLHttpRequest();
            xhr.upload.addEventListener('progress', (e) => {
                if (e.lengthComputable) {
                    const pct = Math.round((e.loaded / e.total) * 100);
                    const el = document.getElementById('studio-hw-upload-pct');
                    if (el) el.textContent = pct + '%';
                }
            });

            await new Promise((resolve, reject) => {
                xhr.onload = () => {
                    if (xhr.status >= 200 && xhr.status < 300) resolve();
                    else reject(new Error(xhr.responseText));
                };
                xhr.onerror = () => reject(new Error('Upload failed'));
                xhr.open('POST', `/api/plugins/studio/sessions/${_currentSession.id}/upload`);
                xhr.send(formData);
            });

            toast.innerHTML = '<span class="text-green-400">Recording saved! Returning to mixer...</span>';
            // Navigate back to studio and open the session
            const sessionId = _currentSession.id;
            setTimeout(() => {
                toast.remove();
                showScreen('plugin-studio');
                // studioInit will detect the open session and reload it
                // but also explicitly open it to be sure
                setTimeout(() => studioOpenSession(sessionId), 300);
            }, 1000);
        } catch (e) {
            console.error('[Studio] Highway upload error:', e);
            toast.innerHTML = '<span class="text-red-400">Upload failed.</span>';
            setTimeout(() => toast.remove(), 3000);
        }
    }

    // ── Track Management ───────────────────────────────────────────────

    window.studioAddTrack = async function () {
        if (!_currentSession) return;
        const name = prompt('Track name:', 'New Track');
        if (!name) return;
        try {
            await fetch(`/api/plugins/studio/sessions/${_currentSession.id}/add-track`, {
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
            const t = _currentSession.tracks.find(t => t.id === trackId);
            if (t) t.color = color;
            _renderTracks();
            // Redraw waveforms with new color
            const curTime = _isPlaying ? (_getAudioCtx().currentTime - _startTime) : _pauseOffset;
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
        if (!fileInput.files.length || !_currentSession) return;
        const file = fileInput.files[0];
        const name = Path_stem(file.name) || 'Imported';

        // Create a new track, then import audio into it
        try {
            const resp = await fetch(`/api/plugins/studio/sessions/${_currentSession.id}/add-track`, {
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

    function Path_stem(filename) {
        return filename ? filename.replace(/\.[^.]+$/, '') : '';
    }

    window.studioActivateTake = async function (trackId) {
        try {
            await fetch(`/api/plugins/studio/tracks/${trackId}/activate`, { method: 'POST' });
            await _reloadSession();
        } catch (e) {
            console.error('[Studio] Activate take error:', e);
        }
    };

    window.studioDeleteTrack = async function (trackId) {
        if (!confirm('Delete this track?')) return;
        try {
            await fetch(`/api/plugins/studio/tracks/${trackId}`, { method: 'DELETE' });
            delete _trackBuffers[trackId];
            delete _mixState[trackId];
            await _reloadSession();
        } catch (e) {
            console.error('[Studio] Delete track error:', e);
        }
    };

    async function _reloadSession() {
        if (!_currentSession) return;
        const wasPlaying = _isPlaying;
        if (wasPlaying) _pause();
        try {
            const resp = await fetch(`/api/plugins/studio/sessions/${_currentSession.id}`);
            _currentSession = await resp.json();
            _renderTracks();
            _populatePunchTrackSelect();
            await _loadTrackAudio();
        } catch (e) {
            console.error('[Studio] Reload session error:', e);
        }
    }

    // ── Export ──────────────────────────────────────────────────────────

    window.studioExportMix = async function () {
        if (!_currentSession) return;
        const statusDiv = document.getElementById('studio-export-status');
        const msgSpan = document.getElementById('studio-export-msg');
        const linkEl = document.getElementById('studio-export-link');

        statusDiv.classList.remove('hidden');
        linkEl.classList.add('hidden');
        msgSpan.textContent = 'Mixing tracks on server...';

        const origState = _mixState.original || { volume: 1.0, pan: 0.0, muted: false, solo: false, offset_ms: 0, fade_in_ms: 0, fade_out_ms: 0, eq_low: 0, eq_mid: 0, eq_high: 0, reverb_send: 0, comp_threshold: -24, comp_ratio: 1, comp_attack: 0.003, comp_release: 0.25 };

        try {
            const resp = await fetch(`/api/plugins/studio/sessions/${_currentSession.id}/mix`, {
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

    function _drawWaveform(key, audioBuffer, canvas) {
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        const dpr = window.devicePixelRatio || 1;
        const W = canvas.clientWidth * dpr;
        const H = canvas.clientHeight * dpr;
        canvas.width = W;
        canvas.height = H;

        // Compute peaks normalized to the session's total duration so all
        // waveforms use the same timescale and shorter tracks don't stretch
        // to fill the entire canvas width.
        const channelData = audioBuffer.getChannelData(0);
        const trackDuration = audioBuffer.duration;
        const totalDuration = _duration || trackDuration;
        const peakCount = Math.min(W, 800);
        // How many peaks this track actually fills (proportional to duration)
        const filledPeaks = Math.round(peakCount * (trackDuration / totalDuration));
        const samplesPerPeak = filledPeaks > 0 ? Math.ceil(channelData.length / filledPeaks) : 1;
        const peaks = new Float32Array(peakCount); // full array, unfilled = 0
        for (let i = 0; i < filledPeaks && i < peakCount; i++) {
            const start = i * samplesPerPeak;
            const end = Math.min(start + samplesPerPeak, channelData.length);
            let peak = 0;
            for (let j = start; j < end; j++) {
                peak = Math.max(peak, Math.abs(channelData[j]));
            }
            peaks[i] = peak;
        }
        _waveformPeaks[key] = peaks;

        _redrawWaveform(key, canvas, 0);
    }

    function _redrawWaveform(key, canvas, cursorTime) {
        const peaks = _waveformPeaks[key];
        if (!peaks || !canvas) return;

        const ctx = canvas.getContext('2d');
        const W = canvas.width;
        const H = canvas.height;
        const mid = H / 2;

        ctx.clearRect(0, 0, W, H);

        if (_duration <= 0) return;

        // Visible time window based on zoom
        const visibleDur = _duration / _zoomLevel;
        const visStart = _scrollOffset;
        const visEnd = visStart + visibleDur;

        // Track time offset
        const st = _mixState[key] || {};
        const offsetSec = (st.offset_ms || 0) / 1000;

        // Get track color for waveform tint
        let waveColor = '64, 128, 224'; // default blue
        if (key !== 'original' && _currentSession) {
            const track = _currentSession.tracks.find(t => t.id === key);
            if (track) {
                const hex = _getTrackColor(track);
                const r = parseInt(hex.slice(1, 3), 16);
                const g = parseInt(hex.slice(3, 5), 16);
                const b = parseInt(hex.slice(5, 7), 16);
                waveColor = `${r}, ${g}, ${b}`;
            }
        }

        // Map peak index to time: peaks span the track's portion of total duration
        const peakTimeStep = _duration / peaks.length;

        const barW = Math.max(1, (W / peaks.length) * _zoomLevel);
        for (let i = 0; i < peaks.length; i++) {
            const peakTime = (i * peakTimeStep) + offsetSec;
            if (peakTime < visStart || peakTime > visEnd) continue;
            const x = ((peakTime - visStart) / visibleDur) * W;
            const bh = peaks[i] * (mid - 2);
            const isPast = peakTime < cursorTime;
            ctx.fillStyle = isPast ? `rgba(${waveColor}, 0.7)` : `rgba(${waveColor}, 0.3)`;
            ctx.fillRect(x, mid - bh, Math.max(barW, 1), bh * 2);
        }

        // Draw fade zones as gradient overlays
        const fadeInSec = (st.fade_in_ms || 0) / 1000;
        const fadeOutSec = (st.fade_out_ms || 0) / 1000;
        if (fadeInSec > 0) {
            const fadeStartPx = Math.max(0, ((offsetSec - visStart) / visibleDur) * W);
            const fadeEndPx = ((offsetSec + fadeInSec - visStart) / visibleDur) * W;
            if (fadeEndPx > 0 && fadeStartPx < W) {
                const grad = ctx.createLinearGradient(fadeStartPx, 0, fadeEndPx, 0);
                grad.addColorStop(0, 'rgba(0,0,0,0.6)');
                grad.addColorStop(1, 'rgba(0,0,0,0)');
                ctx.fillStyle = grad;
                ctx.fillRect(fadeStartPx, 0, fadeEndPx - fadeStartPx, H);
            }
        }
        if (fadeOutSec > 0 && _duration > 0) {
            // Fade out starts at track end minus fade duration
            const buf = _trackBuffers[key];
            const trackEnd = offsetSec + (buf ? buf.duration : _duration);
            const fadeStartPx = ((trackEnd - fadeOutSec - visStart) / visibleDur) * W;
            const fadeEndPx = ((trackEnd - visStart) / visibleDur) * W;
            if (fadeEndPx > 0 && fadeStartPx < W) {
                const grad = ctx.createLinearGradient(fadeStartPx, 0, fadeEndPx, 0);
                grad.addColorStop(0, 'rgba(0,0,0,0)');
                grad.addColorStop(1, 'rgba(0,0,0,0.6)');
                ctx.fillStyle = grad;
                ctx.fillRect(fadeStartPx, 0, fadeEndPx - fadeStartPx, H);
            }
        }

        // Draw markers
        if (_currentSession && _currentSession.markers) {
            for (const m of _currentSession.markers) {
                if (m.time >= visStart && m.time <= visEnd) {
                    const mx = ((m.time - visStart) / visibleDur) * W;
                    ctx.fillStyle = m.color || '#e0a030';
                    ctx.globalAlpha = 0.6;
                    ctx.fillRect(mx - 0.5, 0, 1, H);
                    ctx.globalAlpha = 1;
                    // Label (only on first/original track canvas to avoid clutter)
                    if (key === 'original') {
                        ctx.font = `${Math.min(10, H * 0.2)}px Inter, sans-serif`;
                        ctx.fillStyle = m.color || '#e0a030';
                        ctx.fillText(m.name, mx + 3, 10);
                    }
                }
            }
        }

        // Draw cursor
        if (cursorTime >= visStart && cursorTime <= visEnd) {
            const cx = ((cursorTime - visStart) / visibleDur) * W;
            ctx.fillStyle = '#fff';
            ctx.fillRect(cx - 0.5, 0, 1, H);
        }
    }

    function _drawAllCursors(timeSeconds) {
        if (_duration <= 0) return;

        // Auto-scroll: keep cursor visible when playing
        if (_isPlaying) {
            const visibleDur = _duration / _zoomLevel;
            if (timeSeconds < _scrollOffset || timeSeconds > _scrollOffset + visibleDur) {
                _scrollOffset = Math.max(0, timeSeconds - visibleDur * 0.1);
            }
        }

        const origCanvas = document.getElementById('studio-waveform-original');
        _redrawWaveform('original', origCanvas, timeSeconds);

        if (_currentSession && _currentSession.tracks) {
            for (const t of _currentSession.tracks) {
                const canvas = document.getElementById(`studio-waveform-${t.id}`);
                _redrawWaveform(t.id, canvas, timeSeconds);
            }
        }
    }

    // ── Master Bus Controls ──────────────────────────────────────────

    function _startMasterMeter() {
        if (_masterMeterInterval) clearInterval(_masterMeterInterval);
        _masterMeterInterval = setInterval(() => {
            if (!_masterAnalyser) return;
            const data = new Uint8Array(_masterAnalyser.frequencyBinCount);
            _masterAnalyser.getByteTimeDomainData(data);
            let peak = 0;
            for (let i = 0; i < data.length; i++) {
                const v = Math.abs(data[i] - 128) / 128;
                if (v > peak) peak = v;
            }
            const bar = document.getElementById('studio-master-meter-bar');
            if (bar) {
                const pct = Math.min(100, Math.round(peak * 100));
                bar.style.width = pct + '%';
                bar.className = 'h-full rounded-full transition-all ' +
                    (peak > 0.95 ? 'bg-red-500' : peak > 0.7 ? 'bg-yellow-500' : 'bg-green-500');
            }
        }, 50);
    }

    window.studioSetMasterVolume = function (value) {
        _masterVolume = Math.max(0, Math.min(2, parseFloat(value)));
        if (_masterGain) _masterGain.gain.value = _masterVolume;
        const label = document.getElementById('studio-master-vol-label');
        if (label) label.textContent = Math.round(_masterVolume * 100) + '%';
        _debounceSaveMaster();
    };

    window.studioToggleMasterLimiter = function () {
        _masterLimiterOn = !_masterLimiterOn;
        const btn = document.getElementById('studio-master-limiter-btn');
        if (btn) {
            btn.className = 'px-2 py-0.5 rounded text-xs font-medium transition-colors ' +
                (_masterLimiterOn ? 'bg-green-600/30 text-green-400 border border-green-600/30' : 'bg-dark-800 text-gray-500 border border-gray-700');
            btn.textContent = _masterLimiterOn ? 'Limiter ON' : 'Limiter OFF';
        }
        _debounceSaveMaster();
    };

    let _saveMasterTimer = null;
    function _debounceSaveMaster() {
        if (_saveMasterTimer) clearTimeout(_saveMasterTimer);
        _saveMasterTimer = setTimeout(async () => {
            if (!_currentSession) return;
            try {
                await fetch(`/api/plugins/studio/sessions/${_currentSession.id}/master`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ master_volume: _masterVolume, master_limiter: _masterLimiterOn }),
                });
            } catch (e) { /* ignore */ }
        }, 1000);
    }

    // ── Zoom & Scroll ───────────────────────────────────────────────────

    window.studioZoomIn = function () {
        const maxZoom = Math.max(1, _duration / 2); // min 2 seconds visible
        _zoomLevel = Math.min(maxZoom, _zoomLevel * 1.5);
        _clampScroll();
        _drawAllCursors(_pauseOffset);
    };

    window.studioZoomOut = function () {
        _zoomLevel = Math.max(1, _zoomLevel / 1.5);
        _clampScroll();
        _drawAllCursors(_pauseOffset);
    };

    window.studioZoomFit = function () {
        _zoomLevel = 1;
        _scrollOffset = 0;
        _drawAllCursors(_pauseOffset);
    };

    window.studioScrollTimeline = function (val) {
        _scrollOffset = parseFloat(val);
        _clampScroll();
        const curTime = _isPlaying ? (_getAudioCtx().currentTime - _startTime) : _pauseOffset;
        _drawAllCursors(curTime);
    };

    function _clampScroll() {
        const visibleDur = _duration / _zoomLevel;
        _scrollOffset = Math.max(0, Math.min(_duration - visibleDur, _scrollOffset));
        // Update scroll bar
        const bar = document.getElementById('studio-scroll-bar');
        if (bar) {
            bar.max = Math.max(0, _duration - visibleDur);
            bar.value = _scrollOffset;
            bar.step = visibleDur / 100;
        }
        // Update zoom display
        const zoomLabel = document.getElementById('studio-zoom-label');
        if (zoomLabel) zoomLabel.textContent = _zoomLevel <= 1 ? 'Fit' : _zoomLevel.toFixed(1) + 'x';
    }

    function _initWaveformWheelZoom() {
        const container = document.getElementById('studio-tracks-container');
        if (!container || container._wheelZoomInit) return;
        container._wheelZoomInit = true;
        container.addEventListener('wheel', (e) => {
            if (!e.ctrlKey && !e.metaKey) {
                // Plain scroll = horizontal pan
                if (_zoomLevel > 1) {
                    const visibleDur = _duration / _zoomLevel;
                    _scrollOffset += (e.deltaY > 0 ? 1 : -1) * visibleDur * 0.1;
                    _clampScroll();
                    const curTime = _isPlaying ? (_getAudioCtx().currentTime - _startTime) : _pauseOffset;
                    _drawAllCursors(curTime);
                    e.preventDefault();
                }
                return;
            }
            // Ctrl+scroll = zoom
            e.preventDefault();
            const maxZoom = Math.max(1, _duration / 2);
            if (e.deltaY < 0) {
                _zoomLevel = Math.min(maxZoom, _zoomLevel * 1.2);
            } else {
                _zoomLevel = Math.max(1, _zoomLevel / 1.2);
            }
            _clampScroll();
            const curTime = _isPlaying ? (_getAudioCtx().currentTime - _startTime) : _pauseOffset;
            _drawAllCursors(curTime);
        }, { passive: false });
    }

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
                if (d.deviceId === _selectedDeviceId) opt.selected = true;
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

        const state = _mixState[trackId];
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
            startVal = _mixState[trackId]?.[knob.key] ?? knob.default;
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
            const currentVal = _mixState[trackId]?.[knob.key] ?? knob.default;
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
        if (!_mixState[trackId]) return;
        _pushUndo();
        _mixState[trackId][knob.key] = value;

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
        const ts = _trackSources[trackId];
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
    function _describeArc(cx, cy, r, startAngle, endAngle) {
        const start = _polarToCartesian(cx, cy, r, endAngle - 90);
        const end = _polarToCartesian(cx, cy, r, startAngle - 90);
        const largeArc = endAngle - startAngle <= 180 ? '0' : '1';
        return `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} 0 ${end.x} ${end.y}`;
    }

    function _polarToCartesian(cx, cy, r, angleDeg) {
        const rad = angleDeg * Math.PI / 180;
        return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
    }

    // ── Markers ────────────────────────────────────────────────────────

    function _renderMarkers() {
        const container = document.getElementById('studio-markers-list');
        if (!container || !_currentSession) return;
        const markers = _currentSession.markers || [];
        if (!markers.length) {
            container.innerHTML = '<span class="text-gray-600 text-xs italic">No markers</span>';
            return;
        }
        container.innerHTML = markers.map(m => `
            <button onclick="studioSeek(${m.time}); document.getElementById('studio-seek-bar').value=${m.time};"
                class="px-1.5 py-0.5 rounded text-xs transition-colors hover:brightness-125"
                style="background: ${m.color || '#e0a030'}20; color: ${m.color || '#e0a030'}; border: 1px solid ${m.color || '#e0a030'}40"
                title="${_formatTime(m.time)}"
                ondblclick="event.stopPropagation(); studioRenameMarker(${m.id}, this)">
                ${_esc(m.name)}
                <span onclick="event.stopPropagation(); studioDeleteMarker(${m.id})"
                    class="ml-0.5 opacity-40 hover:opacity-100 cursor-pointer">&times;</span>
            </button>
        `).join('');
    }

    window.studioAddMarker = async function () {
        if (!_currentSession) return;
        const seekBar = document.getElementById('studio-seek-bar');
        const t = parseFloat(seekBar?.value || 0);
        const name = prompt('Marker name:', 'Marker');
        if (!name) return;
        try {
            const resp = await fetch(`/api/plugins/studio/sessions/${_currentSession.id}/markers`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ time: t, name }),
            });
            const marker = await resp.json();
            if (!_currentSession.markers) _currentSession.markers = [];
            _currentSession.markers.push(marker);
            _currentSession.markers.sort((a, b) => a.time - b.time);
            _renderMarkers();
            const curTime = _isPlaying ? (_getAudioCtx().currentTime - _startTime) : _pauseOffset;
            _drawAllCursors(curTime);
        } catch (e) {
            console.error('[Studio] Add marker error:', e);
        }
    };

    window.studioDeleteMarker = async function (id) {
        try {
            await fetch(`/api/plugins/studio/markers/${id}`, { method: 'DELETE' });
            if (_currentSession && _currentSession.markers) {
                _currentSession.markers = _currentSession.markers.filter(m => m.id !== id);
            }
            _renderMarkers();
            const curTime = _isPlaying ? (_getAudioCtx().currentTime - _startTime) : _pauseOffset;
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
            const m = _currentSession.markers.find(m => m.id === id);
            if (m) m.name = newName;
            _renderMarkers();
        } catch (e) {
            console.error('[Studio] Rename marker error:', e);
        }
    };

    window.studioImportSongMarkers = async function () {
        if (!_currentSession) return;
        try {
            const resp = await fetch(`/api/plugins/studio/sessions/${_currentSession.id}/import-markers`, {
                method: 'POST',
            });
            const data = await resp.json();
            if (data.error) { alert(data.error); return; }
            // Reload to get updated markers
            const sessionResp = await fetch(`/api/plugins/studio/sessions/${_currentSession.id}`);
            const session = await sessionResp.json();
            _currentSession.markers = session.markers || [];
            _renderMarkers();
            const curTime = _isPlaying ? (_getAudioCtx().currentTime - _startTime) : _pauseOffset;
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
        if (!_currentSession) return;
        const statusEl = document.getElementById('studio-demucs-extract-status');
        statusEl.textContent = 'Sending to Demucs server...';
        statusEl.className = 'ml-2 text-purple-300 text-xs';

        // Build the slopsmith base URL so the demucs server can fetch audio directly
        const slopsmithUrl = window.location.origin;

        try {
            const resp = await fetch(`/api/plugins/studio/sessions/${_currentSession.id}/extract-drums`, {
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
        _currentSession = null;
        _songBuffer = null;
        _trackBuffers = {};
        _waveformPeaks = {};
        _mixState = { original: { volume: 1.0, pan: 0.0, muted: false, solo: false, offset_ms: 0, fade_in_ms: 0, fade_out_ms: 0, eq_low: 0, eq_mid: 0, eq_high: 0, reverb_send: 0, comp_threshold: -24, comp_ratio: 1, comp_attack: 0.003, comp_release: 0.25 } };
        _duration = 0;
        _pauseOffset = 0;
    }

    // ── Helpers ────────────────────────────────────────────────────────

    function _formatTime(s) {
        if (!s || isNaN(s)) return '0:00';
        const m = Math.floor(s / 60);
        const sec = Math.floor(s % 60);
        return m + ':' + (sec < 10 ? '0' : '') + sec;
    }

    function _formatDate(iso) {
        if (!iso) return '';
        try {
            const d = new Date(iso + 'Z');
            return d.toLocaleDateString();
        } catch (e) {
            return iso;
        }
    }

    function _esc(str) {
        if (!str) return '';
        return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    window.__slopsmithStudioHooksInstalling = true;
    try {
        // ── Keyboard shortcuts ───────────────────────────────────────────
        document.addEventListener('keydown', (e) => {
            // Only handle when studio screen is visible
            const studioRoot = document.getElementById('studio-root');
            if (!studioRoot || studioRoot.offsetParent === null) return;
            if (!_currentSession) return;

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
