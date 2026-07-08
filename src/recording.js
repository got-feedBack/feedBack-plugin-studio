// Recording: main-track capture, punch-in/out re-record, and live "highway"
// recording (MediaRecorder + upload). The window.studio* methods self-register
// (inline-handler + user-action targets). Reaches session reload via an injected
// seam (main owns _reloadSession, which also calls _populatePunchTrackSelect here).
import { S } from './state.js';
import { _esc, _formatTime, _parseTimeInput } from './util.js';
import { _play, _pause, _getAudioCtx } from './audio-graph.js';
import { _saveSettings } from './prefs.js';

let reloadSession = async () => {};
export function configureRecording(h = {}) {
    if (typeof h.reloadSession === 'function') reloadSession = h.reloadSession;
    // Register the command handlers on window HERE (not at module top level) so a
    // fresh module re-eval that skips main's guarded IIFE can't clobber the prior
    // handlers with an unconfigured (no-op reloadSession) set — honours §V.
    window.studioToggleRecord = studioToggleRecord;
    window.studioPunchSetIn = studioPunchSetIn;
    window.studioPunchSetOut = studioPunchSetOut;
    window.studioPunchRecord = studioPunchRecord;
    window.studioHighwayRecord = studioHighwayRecord;
    window.studioActivateTake = studioActivateTake;
}

const PUNCH_PREROLL = 3; // seconds before punch-in to start playback

function studioToggleRecord() {
    if (S.isRecording) {
        _stopRecording();
    } else {
        _startRecording();
    }
}

async function _startRecording() {
    const ctx = _getAudioCtx();
    if (ctx.state === 'suspended') await ctx.resume();

    // Get audio input
    const deviceSelect = document.getElementById('studio-input-device');
    const deviceId = deviceSelect ? deviceSelect.value : '';
    if (deviceId) S.selectedDeviceId = deviceId;
    _saveSettings();

    const constraints = { audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false } };
    if (deviceId) constraints.audio.deviceId = { exact: deviceId };

    try {
        S.mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (e) {
        console.error('[Studio] Mic access denied:', e);
        alert('Microphone access denied. Please allow mic access and try again.');
        return;
    }

    S.recordedChunks = [];

    // Use MediaRecorder with WAV-compatible format
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus' : 'audio/webm';
    S.mediaRecorder = new MediaRecorder(S.mediaStream, { mimeType });

    S.mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) S.recordedChunks.push(e.data);
    };

    S.mediaRecorder.onstop = () => {
        _uploadRecording();
    };

    S.mediaRecorder.start(); // single blob on stop — avoids corrupt webm chunks
    S.isRecording = true;
    S.recStartTime = Date.now();

    // Update UI
    document.getElementById('studio-recording-bar').classList.remove('hidden');
    const recBtn = document.getElementById('studio-btn-record');
    recBtn.innerHTML = '<span class="w-2.5 h-2.5 rounded-sm bg-red-500"></span> Stop';
    recBtn.classList.add('bg-red-600/40');

    // Start recording timer
    S.recInterval = setInterval(() => {
        const elapsed = (Date.now() - S.recStartTime) / 1000;
        document.getElementById('studio-rec-time').textContent = _formatTime(elapsed);
    }, 200);

    // Start playback simultaneously so the musician hears the song
    if (!S.isPlaying) _play();
}

export function _stopRecording() {
    S.isRecording = false;
    if (S.mediaRecorder && S.mediaRecorder.state !== 'inactive') {
        S.mediaRecorder.stop();
    }
    if (S.mediaStream) {
        S.mediaStream.getTracks().forEach(t => t.stop());
        S.mediaStream = null;
    }
    if (S.recInterval) {
        clearInterval(S.recInterval);
        S.recInterval = null;
    }

    // Update UI
    document.getElementById('studio-recording-bar').classList.add('hidden');
    const recBtn = document.getElementById('studio-btn-record');
    recBtn.innerHTML = '<span class="w-2.5 h-2.5 rounded-full bg-red-500"></span> Record';
    recBtn.classList.remove('bg-red-600/40');
}

export function _populatePunchTrackSelect() {
    const sel = document.getElementById('studio-punch-track');
    if (!sel || !S.currentSession) return;
    sel.innerHTML = '';
    const tracks = S.currentSession.tracks || [];
    for (const t of tracks) {
        if (!t.audio_path || t.duration <= 0) continue;
        const name = t.track_name || t.instrument || `Track ${t.id}`;
        const opt = document.createElement('option');
        opt.value = t.id;
        opt.textContent = name;
        sel.appendChild(opt);
    }
}

function studioPunchSetIn() {
    const seekBar = document.getElementById('studio-seek-bar');
    const t = parseFloat(seekBar?.value || 0);
    S.punchIn = t;
    document.getElementById('studio-punch-in').value = _formatTime(t);
}

function studioPunchSetOut() {
    const seekBar = document.getElementById('studio-seek-bar');
    const t = parseFloat(seekBar?.value || 0);
    S.punchOut = t;
    document.getElementById('studio-punch-out').value = _formatTime(t);
}

async function studioPunchRecord() {
    if (S.punchRecording) {
        _stopPunchRecord();
        return;
    }

    S.punchIn = _parseTimeInput(document.getElementById('studio-punch-in').value);
    S.punchOut = _parseTimeInput(document.getElementById('studio-punch-out').value);
    const sel = document.getElementById('studio-punch-track');
    S.punchTrackId = sel ? parseInt(sel.value) : null;

    if (!S.punchTrackId) { alert('Select a track to punch into.'); return; }
    if (S.punchIn >= S.punchOut) { alert('Punch In must be before Punch Out.'); return; }
    if (S.punchOut - S.punchIn < 0.5) { alert('Punch region too short (min 0.5s).'); return; }

    // Get mic
    const deviceSelect = document.getElementById('studio-input-device');
    const deviceId = deviceSelect ? deviceSelect.value : S.selectedDeviceId;
    const constraints = { audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false } };
    if (deviceId) constraints.audio.deviceId = { exact: deviceId };

    try {
        S.punchMediaStream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (e) {
        alert('Microphone access denied.');
        return;
    }

    S.punchChunks = [];
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus' : 'audio/webm';
    S.punchMediaRecorder = new MediaRecorder(S.punchMediaStream, { mimeType });
    S.punchMediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) S.punchChunks.push(e.data);
    };
    S.punchMediaRecorder.onstop = () => { _uploadPunchRecording(); };

    // Start playback from pre-roll point
    const prerollStart = Math.max(0, S.punchIn - PUNCH_PREROLL);
    window.studioSeek(prerollStart);
    _play();

    // Start recorder at the punch-in time
    const delayToRecord = (S.punchIn - prerollStart) * 1000;
    setTimeout(() => {
        if (!S.punchRecording) return; // cancelled
        S.punchMediaRecorder.start();
        console.log(`[Studio] Punch recording started at ${S.punchIn}s`);
    }, delayToRecord);

    // Auto-stop at punch-out
    const delayToStop = (S.punchOut - prerollStart) * 1000;
    S.punchAutoStopTimer = setTimeout(() => {
        _stopPunchRecord();
    }, delayToStop);

    S.punchRecording = true;

    // Update button
    const btn = document.getElementById('studio-btn-punch');
    btn.innerHTML = '<span class="w-2 h-2 rounded-sm bg-orange-500"></span> Stop Punch';
    btn.classList.add('bg-orange-600/40');

    // Show recording bar
    const recBar = document.getElementById('studio-recording-bar');
    recBar.classList.remove('hidden');
    recBar.querySelector('span:nth-child(2)').textContent =
        `Punch: ${_formatTime(S.punchIn)} → ${_formatTime(S.punchOut)}`;
}

function _stopPunchRecord() {
    S.punchRecording = false;
    if (S.punchAutoStopTimer) { clearTimeout(S.punchAutoStopTimer); S.punchAutoStopTimer = null; }

    if (S.punchMediaRecorder && S.punchMediaRecorder.state !== 'inactive') {
        S.punchMediaRecorder.stop();
    }
    if (S.punchMediaStream) {
        S.punchMediaStream.getTracks().forEach(t => t.stop());
        S.punchMediaStream = null;
    }

    _pause();
    document.getElementById('studio-recording-bar').classList.add('hidden');

    const btn = document.getElementById('studio-btn-punch');
    btn.innerHTML = '<span class="w-2 h-2 rounded-full bg-orange-500"></span> Punch Record';
    btn.classList.remove('bg-orange-600/40');
}

async function _uploadPunchRecording() {
    if (!S.punchChunks.length || !S.punchTrackId) return;

    const blob = new Blob(S.punchChunks, { type: 'audio/webm' });
    S.punchChunks = [];

    const formData = new FormData();
    formData.append('file', blob, `punch_${Date.now()}.webm`);
    formData.append('punch_in', S.punchIn.toFixed(3));
    formData.append('punch_out', S.punchOut.toFixed(3));

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
            xhr.open('POST', `/api/plugins/studio/tracks/${S.punchTrackId}/splice`);
            xhr.send(formData);
        });

        await reloadSession();
    } catch (e) {
        console.error('[Studio] Punch upload error:', e);
        alert('Punch-in splice failed: ' + e.message);
    } finally {
        uploadBar.classList.add('hidden');
    }
}

async function studioHighwayRecord() {
    if (!S.currentSession) return;

    S.hwInstrument = document.getElementById('studio-record-trackname').value;
    const deviceSelect = document.getElementById('studio-input-device');
    const deviceId = deviceSelect ? deviceSelect.value : S.selectedDeviceId;
    if (deviceId) { S.selectedDeviceId = deviceId; _saveSettings(); }

    // Request mic access before navigating away
    const constraints = {
        audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false }
    };
    if (deviceId) constraints.audio.deviceId = { exact: deviceId };

    try {
        S.hwMediaStream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (e) {
        console.error('[Studio] Mic access denied:', e);
        alert('Microphone access denied. Please allow mic access and try again.');
        return;
    }

    // Set up audio graph: mic → gain → destination (for recording)
    //                       mic → gain → analyser (for metering)
    S.hwAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (S.hwAudioCtx.state === 'suspended') await S.hwAudioCtx.resume();
    S.hwSourceNode = S.hwAudioCtx.createMediaStreamSource(S.hwMediaStream);
    S.hwGainNode = S.hwAudioCtx.createGain();
    S.hwGainNode.gain.value = S.hwInputGain;
    S.hwAnalyser = S.hwAudioCtx.createAnalyser();
    S.hwAnalyser.fftSize = 256;
    S.hwRecDest = S.hwAudioCtx.createMediaStreamDestination();

    S.hwSourceNode.connect(S.hwGainNode);
    S.hwGainNode.connect(S.hwRecDest);
    S.hwGainNode.connect(S.hwAnalyser);

    // Open song on the highway
    const filename = encodeURIComponent(S.currentSession.song_filename);
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
}

function _waitForAudioReady() {
    const audio = document.getElementById('audio');
    if (!audio) { setTimeout(_waitForAudioReady, 500); return; }

    S.hwWaitCancelled = false;
    const initialSrc = audio.src;

    function checkReady() {
        if (S.hwWaitCancelled) return;  // recording started or cancelled
        if (audio.src && audio.src !== initialSrc) {
            if (audio.readyState >= 3) {
                if (!S.hwWaitCancelled) _updateHwOverlay('ready');
            } else {
                audio.addEventListener('canplay', onCanPlay);
            }
        } else {
            setTimeout(checkReady, 300);
        }
    }

    function onCanPlay() {
        audio.removeEventListener('canplay', onCanPlay);
        if (!S.hwWaitCancelled) _updateHwOverlay('ready');
    }

    setTimeout(checkReady, 500);

    // Timeout fallback
    setTimeout(() => {
        audio.removeEventListener('canplay', onCanPlay);
        if (!S.hwWaitCancelled && audio.src) {
            _updateHwOverlay('ready');
        }
    }, 30000);
}

function _createHwOverlay(state) {
    if (S.hwOverlay) S.hwOverlay.remove();
    S.hwOverlay = document.createElement('div');
    S.hwOverlay.id = 'studio-hw-overlay';
    S.hwOverlay.className = 'fixed top-4 left-1/2 -translate-x-1/2 z-[300] flex flex-col gap-2 bg-black/90 backdrop-blur-sm border border-red-600/50 rounded-xl px-5 py-3 shadow-2xl min-w-[340px]';
    document.body.appendChild(S.hwOverlay);
    _updateHwOverlay(state);
}

function _updateHwOverlay(state) {
    if (!S.hwOverlay) return;

    if (state === 'waiting') {
        S.hwOverlay.innerHTML = `
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
        S.hwOverlay.innerHTML = `
            <div class="flex items-center gap-3">
                <span class="w-3 h-3 rounded-full bg-green-500"></span>
                <span class="text-green-300 text-sm font-medium">Ready</span>
                <span class="text-gray-500 text-xs">${_esc(S.hwInstrument)}</span>
                <button id="studio-hw-go-btn" class="ml-auto px-3 py-1 bg-red-600 hover:bg-red-700 text-white rounded-lg text-sm font-medium transition-colors">
                    Start Recording
                </button>
                <button id="studio-hw-cancel-btn" class="px-2 py-1 bg-dark-600 hover:bg-dark-500 text-gray-400 rounded-lg text-xs transition-colors">
                    Cancel
                </button>
            </div>
            <div class="flex items-center gap-2">
                <label class="text-gray-500 text-xs w-12">Input</label>
                <input id="studio-hw-gain" type="range" min="0" max="300" value="${Math.round(S.hwInputGain * 100)}"
                    class="flex-1 h-1 accent-accent" title="Input gain">
                <span id="studio-hw-gain-val" class="text-gray-400 text-xs w-10 text-right">${Math.round(S.hwInputGain * 100)}%</span>
                <div id="studio-hw-meter" class="w-24 h-3 bg-dark-800 rounded-full overflow-hidden">
                    <div id="studio-hw-meter-bar" class="h-full bg-green-500 rounded-full transition-all" style="width:0%"></div>
                </div>
            </div>`;
        document.getElementById('studio-hw-go-btn').onclick = _beginHwRecording;
        document.getElementById('studio-hw-cancel-btn').onclick = () => _stopHighwayRecording(true);
        document.getElementById('studio-hw-gain').oninput = (e) => {
            S.hwInputGain = e.target.value / 100;
            if (S.hwGainNode) S.hwGainNode.gain.value = S.hwInputGain;
            document.getElementById('studio-hw-gain-val').textContent = Math.round(S.hwInputGain * 100) + '%';
        };

        // Start level metering
        _startHwMeter();
    }

    else if (state === 'recording') {
        S.hwOverlay.innerHTML = `
            <div class="flex items-center gap-3">
                <span class="w-3 h-3 rounded-full bg-red-500 animate-pulse"></span>
                <span class="text-red-300 text-sm font-medium">Recording</span>
                <span id="studio-hw-rec-time" class="text-red-400 text-sm font-mono">0:00</span>
                <span class="text-gray-600 mx-1">|</span>
                <span class="text-gray-400 text-xs">${_esc(S.hwInstrument)}</span>
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
                <input id="studio-hw-gain" type="range" min="0" max="300" value="${Math.round(S.hwInputGain * 100)}"
                    class="flex-1 h-1 accent-accent" title="Input gain">
                <span id="studio-hw-gain-val" class="text-gray-400 text-xs w-10 text-right">${Math.round(S.hwInputGain * 100)}%</span>
                <div id="studio-hw-meter" class="w-24 h-3 bg-dark-800 rounded-full overflow-hidden">
                    <div id="studio-hw-meter-bar" class="h-full bg-green-500 rounded-full transition-all" style="width:0%"></div>
                </div>
            </div>`;
        document.getElementById('studio-hw-stop-btn').onclick = () => _stopHighwayRecording(false);
        document.getElementById('studio-hw-cancel-btn').onclick = () => _stopHighwayRecording(true);
        document.getElementById('studio-hw-gain').oninput = (e) => {
            S.hwInputGain = e.target.value / 100;
            if (S.hwGainNode) S.hwGainNode.gain.value = S.hwInputGain;
            document.getElementById('studio-hw-gain-val').textContent = Math.round(S.hwInputGain * 100) + '%';
        };
    }
}

function _startHwMeter() {
    if (S.hwMeterInterval) clearInterval(S.hwMeterInterval);
    S.hwMeterInterval = setInterval(() => {
        if (!S.hwAnalyser) return;
        const data = new Uint8Array(S.hwAnalyser.frequencyBinCount);
        S.hwAnalyser.getByteTimeDomainData(data);
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

// Draw hook: red glow border on highway canvas while recording
function _hwDrawHook(ctx, W, H) {
    if (!S.hwRecording) return;
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
    if (S.hwMeterInterval) {
        clearInterval(S.hwMeterInterval);
        S.hwMeterInterval = null;
    }
    if (S.hwMediaStream) {
        S.hwMediaStream.getTracks().forEach(t => t.stop());
        S.hwMediaStream = null;
    }
    S.hwSourceNode = null;
    S.hwRecDest = null;
    S.hwGainNode = null;
    S.hwAnalyser = null;
    if (S.hwAudioCtx) {
        S.hwAudioCtx.close().catch(() => {});
        S.hwAudioCtx = null;
    }
}

function _stopHighwayRecording(cancel) {
    S.hwRecording = false;
    S.hwWaitCancelled = true;

    const audio = document.getElementById('audio');
    S.hwExpectedDuration = audio ? audio.currentTime : 0;

    if (S.hwPlayListener && audio) {
        audio.removeEventListener('play', S.hwPlayListener);
        S.hwPlayListener = null;
    }

    if (S.hwRecInterval) {
        clearInterval(S.hwRecInterval);
        S.hwRecInterval = null;
    }
    if (S.hwOverlay) {
        S.hwOverlay.remove();
        S.hwOverlay = null;
    }

    if (cancel) {
        if (S.hwMediaRecorder && S.hwMediaRecorder.state !== 'inactive') {
            S.hwMediaRecorder.ondataavailable = null;
            S.hwMediaRecorder.onstop = null;
            S.hwMediaRecorder.stop();
        }
        S.hwRecordedChunks = [];
        _cleanupHwAudio();
    } else {
        if (S.hwMediaRecorder && S.hwMediaRecorder.state !== 'inactive') {
            const origOnStop = S.hwMediaRecorder.onstop;
            S.hwMediaRecorder.onstop = () => {
                if (origOnStop) origOnStop();
                _cleanupHwAudio();
            };
            S.hwMediaRecorder.stop();
        } else {
            _cleanupHwAudio();
        }
    }
}

async function studioActivateTake(trackId) {
    try {
        await fetch(`/api/plugins/studio/tracks/${trackId}/activate`, { method: 'POST' });
        await reloadSession();
    } catch (e) {
        console.error('[Studio] Activate take error:', e);
    }
}

async function _uploadRecording() {
    if (!S.recordedChunks.length || !S.currentSession) return;

    const blob = new Blob(S.recordedChunks, { type: 'audio/webm' });
    S.recordedChunks = [];

    const instrument = document.getElementById('studio-record-trackname').value;
    const formData = new FormData();
    formData.append('file', blob, `recording_${Date.now()}.webm`);
    formData.append('instrument', instrument);
    formData.append('recorded_by', S.userName);

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
            xhr.open('POST', `/api/plugins/studio/sessions/${S.currentSession.id}/upload`);
            xhr.send(formData);
        });

        // Reload session to show new track
        await reloadSession();
    } catch (e) {
        console.error('[Studio] Upload error:', e);
        alert('Failed to upload recording.');
    } finally {
        uploadBar.classList.add('hidden');
    }
}

async function _beginHwRecording() {
    const audio = document.getElementById('audio');
    if (!audio) return;

    // Stop all pending wait/poll logic so it can't overwrite the overlay
    S.hwWaitCancelled = true;

    if (S.hwAudioCtx && S.hwAudioCtx.state === 'suspended') await S.hwAudioCtx.resume();

    S.hwRecordedChunks = [];
    S.hwPlayOffset = 0;
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus' : 'audio/webm';
    S.hwMediaRecorder = new MediaRecorder(S.hwMediaStream, { mimeType });

    S.hwMediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) S.hwRecordedChunks.push(e.data);
    };
    S.hwMediaRecorder.onstop = () => {
        _hwUploadRecording(S.hwInstrument);
    };

    // Start recording immediately. Don't call audio.play() — the highway
    // has its own buffering/play system that conflicts. The user presses
    // Play on the highway controls themselves. We listen for the 'play'
    // event to know when audio actually started, and trim the leading
    // dead time server-side.
    S.hwMediaRecorder.start();
    S.hwRecording = true;
    S.hwRecStartTime = Date.now();

    // Listen for when the user actually starts playback
    S.hwPlayListener = () => {
        S.hwPlayOffset = (Date.now() - S.hwRecStartTime) / 1000;
        audio.removeEventListener('play', S.hwPlayListener);
        S.hwPlayListener = null;
        // Hide the "press play" hint
        const hint = document.getElementById('studio-hw-play-hint');
        if (hint) hint.remove();
        console.log(`[Studio] Audio play detected, offset: ${S.hwPlayOffset.toFixed(2)}s`);
    };
    audio.addEventListener('play', S.hwPlayListener);

    // Switch overlay to recording state
    _updateHwOverlay('recording');

    S.hwRecInterval = setInterval(() => {
        const el = document.getElementById('studio-hw-rec-time');
        if (el) {
            const elapsed = (Date.now() - S.hwRecStartTime) / 1000;
            el.textContent = _formatTime(elapsed);
        }
    }, 200);

    if (typeof highway !== 'undefined' && highway.addDrawHook && !S.hwDrawHookAdded) {
        highway.addDrawHook(_hwDrawHook);
        S.hwDrawHookAdded = true;
    }
}

async function _hwUploadRecording(instrument) {
    if (!S.hwRecordedChunks.length || !S.currentSession) return;

    const blob = new Blob(S.hwRecordedChunks, { type: 'audio/webm' });
    S.hwRecordedChunks = [];

    const formData = new FormData();
    formData.append('file', blob, `recording_${Date.now()}.webm`);
    formData.append('instrument', instrument);
    formData.append('recorded_by', S.userName);
    if (S.hwExpectedDuration > 0) {
        formData.append('expected_duration', S.hwExpectedDuration.toFixed(3));
    }
    if (S.hwPlayOffset > 0.1) {
        formData.append('trim_start', S.hwPlayOffset.toFixed(3));
    }
    if (S.hwInputGain !== 1.0) {
        formData.append('input_gain', S.hwInputGain.toFixed(3));
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
            xhr.open('POST', `/api/plugins/studio/sessions/${S.currentSession.id}/upload`);
            xhr.send(formData);
        });

        toast.innerHTML = '<span class="text-green-400">Recording saved! Returning to mixer...</span>';
        // Navigate back to studio and open the session
        const sessionId = S.currentSession.id;
        setTimeout(() => {
            toast.remove();
            showScreen('plugin-studio');
            // studioInit will detect the open session and reload it
            // but also explicitly open it to be sure
            setTimeout(() => window.studioOpenSession(sessionId), 300);
        }, 1000);
    } catch (e) {
        console.error('[Studio] Highway upload error:', e);
        toast.innerHTML = '<span class="text-red-400">Upload failed.</span>';
        setTimeout(() => toast.remove(), 3000);
    }
}
