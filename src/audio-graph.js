// Web Audio playback engine. The graph is rebuilt each _play() and torn down on
// _pause() (constitution §III). Reads/writes the shared S container; the
// per-frame playhead loop + master meter are injected (they live with the
// animation/render layer in main.js) to keep this the lower audio layer.
import { S } from './state.js';

// Injected animation/meter seams (main.js wires these once at boot).
let startAnimLoop = () => {};
let stopAnimLoop = () => {};
let startMasterMeter = () => {};
export function configureAudioGraph(h = {}) {
    if (typeof h.startAnimLoop === 'function') startAnimLoop = h.startAnimLoop;
    if (typeof h.stopAnimLoop === 'function') stopAnimLoop = h.stopAnimLoop;
    if (typeof h.startMasterMeter === 'function') startMasterMeter = h.startMasterMeter;
}

export function _getAudioCtx() {
    if (!S.audioCtx) {
        S.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    return S.audioCtx;
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
    S.reverbNode = ctx.createConvolver();
    S.reverbNode.buffer = impulse;
    S.reverbGain = ctx.createGain();
    S.reverbGain.gain.value = 0.7; // master wet level
    const reverbDest = S.masterGain || ctx.destination;
    S.reverbNode.connect(S.reverbGain).connect(reverbDest);
}

export function _play() {
    if (S.isPlaying) return;
    const ctx = _getAudioCtx();
    if (ctx.state === 'suspended') { const p = ctx.resume(); if (p && p.catch) p.catch(() => {}); }

    S.isPlaying = true;
    S.startTime = ctx.currentTime - S.pauseOffset;

    // Create master bus: gain → limiter → analyser → destination
    S.masterGain = ctx.createGain();
    S.masterGain.gain.value = S.masterVolume;
    S.masterAnalyser = ctx.createAnalyser();
    S.masterAnalyser.fftSize = 256;

    if (S.masterLimiterOn) {
        S.masterLimiter = ctx.createDynamicsCompressor();
        S.masterLimiter.threshold.value = -1;  // limit at ~0dBFS
        S.masterLimiter.knee.value = 0;
        S.masterLimiter.ratio.value = 20;      // hard limiting
        S.masterLimiter.attack.value = 0.003;
        S.masterLimiter.release.value = 0.05;
        S.masterGain.connect(S.masterLimiter).connect(S.masterAnalyser).connect(ctx.destination);
    } else {
        S.masterGain.connect(S.masterAnalyser).connect(ctx.destination);
    }

    // Create shared reverb bus (feeds into master)
    _createReverbBus(ctx);

    // Start master meter
    startMasterMeter();

    // Determine which tracks should be audible
    const hasSolo = _hasSoloActive();

    // Play original song
    if (S.songBuffer) {
        S.songSource = ctx.createBufferSource();
        S.songSource.buffer = S.songBuffer;
        S.songGain = ctx.createGain();
        S.songPan = ctx.createStereoPanner();

        const origState = S.mixState.original || { volume: 1.0, pan: 0.0, muted: false, solo: false, offset_ms: 0, fade_in_ms: 0, fade_out_ms: 0, eq_low: 0, eq_mid: 0, eq_high: 0, reverb_send: 0, comp_threshold: -24, comp_ratio: 1, comp_attack: 0.003, comp_release: 0.25 };
        S.songGain.gain.value = origState.muted ? 0 : (hasSolo && !origState.solo ? 0 : origState.volume);
        S.songPan.pan.value = origState.pan;

        S.songSource.connect(S.songGain).connect(S.songPan).connect(S.masterGain);
        S.songSource.start(0, S.pauseOffset);
    }

    // Play recorded tracks
    if (S.currentSession && S.currentSession.tracks) {
        for (const t of S.currentSession.tracks) {
            const buf = S.trackBuffers[t.id];
            if (!buf) continue;

            const source = ctx.createBufferSource();
            source.buffer = buf;

            const st = S.mixState[t.id] || { volume: 1.0, pan: 0.0, muted: false, solo: false, offset_ms: 0, fade_in_ms: 0, fade_out_ms: 0, eq_low: 0, eq_mid: 0, eq_high: 0, reverb_send: 0, comp_threshold: -24, comp_ratio: 1, comp_attack: 0.003, comp_release: 0.25 };

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
                source.connect(eqLow).connect(eqMid).connect(eqHigh).connect(comp).connect(gain).connect(pan).connect(S.masterGain);
            } else {
                source.connect(eqLow).connect(eqMid).connect(eqHigh).connect(gain).connect(pan).connect(S.masterGain);
            }

            // Apply time offset: positive = delay (start later), negative = trim start
            const offsetSec = (st.offset_ms || 0) / 1000;
            const trackPauseOffset = S.pauseOffset - offsetSec;
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
            if (sendLevel > 0 && S.reverbNode) {
                reverbSend = ctx.createGain();
                reverbSend.gain.value = sendLevel;
                eqHigh.connect(reverbSend);
                reverbSend.connect(S.reverbNode);
            }

            S.trackSources[t.id] = { source, gain, pan, eqLow, eqMid, eqHigh, comp, reverbSend };
        }
    }

    document.getElementById('studio-btn-play').innerHTML = '&#9646;&#9646; Pause';
    startAnimLoop();
}

export function _pause() {
    if (!S.isPlaying) return;
    const ctx = _getAudioCtx();
    S.pauseOffset = ctx.currentTime - S.startTime;
    _stopAllSources();
    S.isPlaying = false;
    document.getElementById('studio-btn-play').innerHTML = '&#9654; Play';
    stopAnimLoop();
}

export function _stopAllSources() {
    try { if (S.songSource) S.songSource.stop(); } catch (e) { /* ignore */ }
    S.songSource = null;
    for (const key of Object.keys(S.trackSources)) {
        try { S.trackSources[key].source.stop(); } catch (e) { /* ignore */ }
    }
    S.trackSources = {};
    S.reverbNode = null;
    S.reverbGain = null;
    S.masterGain = null;
    S.masterLimiter = null;
    S.masterAnalyser = null;
    if (S.masterMeterInterval) { clearInterval(S.masterMeterInterval); S.masterMeterInterval = null; }
}

function _hasSoloActive() {
    for (const key of Object.keys(S.mixState)) {
        if (S.mixState[key].solo) return true;
    }
    return false;
}

export function _applyMixToLiveAudio(trackKey) {
    const hasSolo = _hasSoloActive();
    if (trackKey === 'original') {
        if (S.songGain && S.songPan) {
            const st = S.mixState.original || { volume: 1.0, pan: 0.0, muted: false, solo: false };
            S.songGain.gain.value = st.muted ? 0 : (hasSolo && !st.solo ? 0 : st.volume);
            S.songPan.pan.value = st.pan;
        }
    } else if (S.trackSources[trackKey]) {
        const st = S.mixState[trackKey] || { volume: 1.0, pan: 0.0, muted: false, solo: false, offset_ms: 0, fade_in_ms: 0, fade_out_ms: 0, eq_low: 0, eq_mid: 0, eq_high: 0, reverb_send: 0, comp_threshold: -24, comp_ratio: 1, comp_attack: 0.003, comp_release: 0.25 };
        S.trackSources[trackKey].gain.gain.value = st.muted ? 0 : (hasSolo && !st.solo ? 0 : st.volume);
        S.trackSources[trackKey].pan.pan.value = st.pan;
    }
}

export function _applyAllMixToLive() {
    const hasSolo = _hasSoloActive();
    // Original
    if (S.songGain && S.songPan) {
        const st = S.mixState.original || { volume: 1.0, pan: 0.0, muted: false, solo: false, offset_ms: 0, fade_in_ms: 0, fade_out_ms: 0, eq_low: 0, eq_mid: 0, eq_high: 0, reverb_send: 0, comp_threshold: -24, comp_ratio: 1, comp_attack: 0.003, comp_release: 0.25 };
        S.songGain.gain.value = st.muted ? 0 : (hasSolo && !st.solo ? 0 : st.volume);
        S.songPan.pan.value = st.pan;
    }
    // Tracks
    for (const key of Object.keys(S.trackSources)) {
        const st = S.mixState[key] || { volume: 1.0, pan: 0.0, muted: false, solo: false, offset_ms: 0, fade_in_ms: 0, fade_out_ms: 0, eq_low: 0, eq_mid: 0, eq_high: 0, reverb_send: 0, comp_threshold: -24, comp_ratio: 1, comp_attack: 0.003, comp_release: 0.25 };
        S.trackSources[key].gain.gain.value = st.muted ? 0 : (hasSolo && !st.solo ? 0 : st.volume);
        S.trackSources[key].pan.pan.value = st.pan;
    }
}
