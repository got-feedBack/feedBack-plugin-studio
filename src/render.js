// View layer: build the session-list, track-mixer, and marker DOM. Pure-ish
// rendering — reads the S container + util formatters, emits HTML whose inline
// on* handlers call the window.studio* command surface (string output, no code
// coupling back to main).
import { S } from './state.js';
import { _esc, _formatDate, _formatTime, _eqLabel, _compLabel, _getTrackColor } from './util.js';

export function _renderSessionList(sessions) {
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

export function _renderTracks() {
    const container = document.getElementById('studio-recorded-tracks');
    if (!container || !S.currentSession) return;   // no session (e.g. after _cleanup) → nothing to render
    const tracks = S.currentSession.tracks || [];

    let html = '';
    for (const t of tracks) {
        const state = S.mixState[t.id] || { volume: 1.0, pan: 0.0, muted: false, solo: false, offset_ms: 0, fade_in_ms: 0, fade_out_ms: 0, eq_low: 0, eq_mid: 0, eq_high: 0, reverb_send: 0, comp_threshold: -24, comp_ratio: 1, comp_attack: 0.003, comp_release: 0.25 };
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

export function _renderMarkers() {
    const container = document.getElementById('studio-markers-list');
    if (!container || !S.currentSession) return;
    const markers = S.currentSession.markers || [];
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
