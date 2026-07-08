// Visualisation layer: the requestAnimationFrame playhead loop, waveform canvas
// rendering + zoom/scroll, and the master level meter. Upper layer over the
// audio engine — imports _getAudioCtx from audio-graph.js and _formatTime from
// util.js; reaches the transport-stop action via the window.studioStop global.
import { _formatTime, _getTrackColor } from './util.js';
import { _getAudioCtx } from './audio-graph.js';
import { S } from './state.js';

export function _startAnimLoop() {
    _stopAnimLoop();
    function tick() {
        if (!S.isPlaying) return;
        const ctx = _getAudioCtx();
        const elapsed = ctx.currentTime - S.startTime;
        document.getElementById('studio-time-current').textContent = _formatTime(elapsed);
        document.getElementById('studio-seek-bar').value = elapsed;
        _drawAllCursors(elapsed);
        if (elapsed >= S.duration) {
            window.studioStop();
            return;
        }
        S.animFrame = requestAnimationFrame(tick);
    }
    S.animFrame = requestAnimationFrame(tick);
}

export function _stopAnimLoop() {
    if (S.animFrame) {
        cancelAnimationFrame(S.animFrame);
        S.animFrame = null;
    }
}

export function _drawWaveform(key, audioBuffer, canvas) {
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
    const totalDuration = S.duration || trackDuration;
    const peakCount = Math.floor(Math.min(W, 800));   // integer: Float32Array length must be integral
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
    S.waveformPeaks[key] = peaks;

    _redrawWaveform(key, canvas, 0);
}

function _redrawWaveform(key, canvas, cursorTime) {
    const peaks = S.waveformPeaks[key];
    if (!peaks || !canvas) return;

    const ctx = canvas.getContext('2d');
    const W = canvas.width;
    const H = canvas.height;
    const mid = H / 2;

    ctx.clearRect(0, 0, W, H);

    if (S.duration <= 0) return;

    // Visible time window based on zoom
    const visibleDur = S.duration / S.zoomLevel;
    const visStart = S.scrollOffset;
    const visEnd = visStart + visibleDur;

    // Track time offset
    const st = S.mixState[key] || {};
    const offsetSec = (st.offset_ms || 0) / 1000;

    // Get track color for waveform tint
    let waveColor = '64, 128, 224'; // default blue
    if (key !== 'original' && S.currentSession) {
        const track = S.currentSession.tracks.find(t => t.id === key);
        if (track) {
            const hex = _getTrackColor(track);
            const r = parseInt(hex.slice(1, 3), 16);
            const g = parseInt(hex.slice(3, 5), 16);
            const b = parseInt(hex.slice(5, 7), 16);
            waveColor = `${r}, ${g}, ${b}`;
        }
    }

    // Map peak index to time: peaks span the track's portion of total duration
    const peakTimeStep = S.duration / peaks.length;

    const barW = Math.max(1, (W / peaks.length) * S.zoomLevel);
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
    if (fadeOutSec > 0 && S.duration > 0) {
        // Fade out starts at track end minus fade duration
        const buf = S.trackBuffers[key];
        const trackEnd = offsetSec + (buf ? buf.duration : S.duration);
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
    if (S.currentSession && S.currentSession.markers) {
        for (const m of S.currentSession.markers) {
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

export function _drawAllCursors(timeSeconds) {
    if (S.duration <= 0) return;

    // Auto-scroll: keep cursor visible when playing
    if (S.isPlaying) {
        const visibleDur = S.duration / S.zoomLevel;
        if (timeSeconds < S.scrollOffset || timeSeconds > S.scrollOffset + visibleDur) {
            S.scrollOffset = Math.max(0, timeSeconds - visibleDur * 0.1);
        }
    }

    const origCanvas = document.getElementById('studio-waveform-original');
    _redrawWaveform('original', origCanvas, timeSeconds);

    if (S.currentSession && S.currentSession.tracks) {
        for (const t of S.currentSession.tracks) {
            const canvas = document.getElementById(`studio-waveform-${t.id}`);
            _redrawWaveform(t.id, canvas, timeSeconds);
        }
    }
}

export function _startMasterMeter() {
    if (S.masterMeterInterval) clearInterval(S.masterMeterInterval);
    S.masterMeterInterval = setInterval(() => {
        if (!S.masterAnalyser) return;
        const data = new Uint8Array(S.masterAnalyser.frequencyBinCount);
        S.masterAnalyser.getByteTimeDomainData(data);
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

export function _debounceSaveMaster() {
    if (S.saveMasterTimer) clearTimeout(S.saveMasterTimer);
    S.saveMasterTimer = setTimeout(async () => {
        if (!S.currentSession) return;
        try {
            await fetch(`/api/plugins/studio/sessions/${S.currentSession.id}/master`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ master_volume: S.masterVolume, master_limiter: S.masterLimiterOn }),
            });
        } catch (e) { /* ignore */ }
    }, 1000);
}

export function _clampScroll() {
    const visibleDur = S.duration / S.zoomLevel;
    S.scrollOffset = Math.max(0, Math.min(S.duration - visibleDur, S.scrollOffset));
    // Update scroll bar
    const bar = document.getElementById('studio-scroll-bar');
    if (bar) {
        bar.max = Math.max(0, S.duration - visibleDur);
        bar.value = S.scrollOffset;
        bar.step = visibleDur / 100;
    }
    // Update zoom display
    const zoomLabel = document.getElementById('studio-zoom-label');
    if (zoomLabel) zoomLabel.textContent = S.zoomLevel <= 1 ? 'Fit' : S.zoomLevel.toFixed(1) + 'x';
}

export function _initWaveformWheelZoom() {
    const container = document.getElementById('studio-tracks-container');
    if (!container || container._wheelZoomInit) return;
    container._wheelZoomInit = true;
    container.addEventListener('wheel', (e) => {
        if (!e.ctrlKey && !e.metaKey) {
            // Plain scroll = horizontal pan
            if (S.zoomLevel > 1) {
                const visibleDur = S.duration / S.zoomLevel;
                S.scrollOffset += (e.deltaY > 0 ? 1 : -1) * visibleDur * 0.1;
                _clampScroll();
                const curTime = S.isPlaying ? (_getAudioCtx().currentTime - S.startTime) : S.pauseOffset;
                _drawAllCursors(curTime);
                e.preventDefault();
            }
            return;
        }
        // Ctrl+scroll = zoom
        e.preventDefault();
        const maxZoom = Math.max(1, S.duration / 2);
        if (e.deltaY < 0) {
            S.zoomLevel = Math.min(maxZoom, S.zoomLevel * 1.2);
        } else {
            S.zoomLevel = Math.max(1, S.zoomLevel / 1.2);
        }
        _clampScroll();
        const curTime = S.isPlaying ? (_getAudioCtx().currentTime - S.startTime) : S.pauseOffset;
        _drawAllCursors(curTime);
    }, { passive: false });
}
