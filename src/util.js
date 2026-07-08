// Pure, state-free helpers (no module state / no DOM) — real-import tested in
// tests/util.test.mjs. Names keep their original `_`-prefix so main.js call
// sites are unchanged.

// "M:SS" / "M:SS.ms" / plain seconds → seconds.
export function _parseTimeInput(val) {
    val = (val || '').trim();
    const match = val.match(/^(\d+):(\d{1,2})(?:\.(\d+))?$/);
    if (match) {
        return parseInt(match[1]) * 60 + parseInt(match[2]) + (match[3] ? parseFloat('0.' + match[3]) : 0);
    }
    const n = parseFloat(val);
    return isNaN(n) ? 0 : n;
}

// seconds → "M:SS".
export function _formatTime(s) {
    if (!s || isNaN(s)) return '0:00';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return m + ':' + (sec < 10 ? '0' : '') + sec;
}

// ISO timestamp → locale date string (UTC-anchored); passes the input back on error.
export function _formatDate(iso) {
    if (!iso) return '';
    try {
        const d = new Date(iso + 'Z');
        return d.toLocaleDateString();
    } catch (e) {
        return iso;
    }
}

// HTML-escape for interpolation into innerHTML.
export function _esc(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Strip a filename's extension.
export function Path_stem(filename) {
    return filename ? filename.replace(/\.[^.]+$/, '') : '';
}

// Per-band EQ summary from a track's mix settings.
export function _eqLabel(st) {
    const l = st.eq_low || 0, m = st.eq_mid || 0, h = st.eq_high || 0;
    if (l === 0 && m === 0 && h === 0) return 'Flat';
    return `${l > 0 ? '+' : ''}${l} / ${m > 0 ? '+' : ''}${m} / ${h > 0 ? '+' : ''}${h} dB`;
}

// Compressor summary from a track's mix settings.
export function _compLabel(st) {
    const r = st.comp_ratio ?? 1;
    if (r <= 1) return 'Off';
    return `${st.comp_threshold ?? -24}dB ${r}:1`;
}

// Polar → cartesian (SVG knob geometry).
export function _polarToCartesian(cx, cy, r, angleDeg) {
    const rad = angleDeg * Math.PI / 180;
    return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

// SVG arc path between two angles (used by the FX knob arcs).
export function _describeArc(cx, cy, r, startAngle, endAngle) {
    const start = _polarToCartesian(cx, cy, r, endAngle - 90);
    const end = _polarToCartesian(cx, cy, r, startAngle - 90);
    const largeArc = endAngle - startAngle <= 180 ? '0' : '1';
    return `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} 0 ${end.x} ${end.y}`;
}
