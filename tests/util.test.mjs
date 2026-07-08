// Unit tests for src/util.js — pure, state-free helpers. Real ES-module import.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    _parseTimeInput, _formatTime, _formatDate, _esc, Path_stem,
    _eqLabel, _compLabel, _polarToCartesian, _describeArc, _getTrackColor,
} from '../src/util.js';

test('_parseTimeInput accepts M:SS, M:SS.ms, and plain seconds', () => {
    assert.equal(_parseTimeInput('1:30'), 90);
    assert.equal(_parseTimeInput('0:05'), 5);
    assert.equal(_parseTimeInput('2:00.5'), 120.5);
    assert.equal(_parseTimeInput('42'), 42);
    assert.equal(_parseTimeInput('  7 '), 7);
    assert.equal(_parseTimeInput('nope'), 0);
    assert.equal(_parseTimeInput(''), 0);
    assert.equal(_parseTimeInput(null), 0);
});

test('_formatTime is the inverse-ish of the M:SS form', () => {
    assert.equal(_formatTime(0), '0:00');
    assert.equal(_formatTime(5), '0:05');
    assert.equal(_formatTime(90), '1:30');
    assert.equal(_formatTime(3599), '59:59');
    assert.equal(_formatTime(NaN), '0:00');
    assert.equal(_formatTime(undefined), '0:00');
});

test('_formatDate returns "" for empty and a string otherwise', () => {
    assert.equal(_formatDate(''), '');
    assert.equal(_formatDate(null), '');
    assert.equal(typeof _formatDate('2026-07-08T12:00:00'), 'string');
});

test('_esc escapes the five HTML-significant characters', () => {
    assert.equal(_esc('<a href="x">&\'</a>'),
        '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
    assert.equal(_esc(''), '');
    assert.equal(_esc(null), '');
});

test('Path_stem strips the extension', () => {
    assert.equal(Path_stem('song.ogg'), 'song');
    assert.equal(Path_stem('a.b.wav'), 'a.b');
    assert.equal(Path_stem('noext'), 'noext');
    assert.equal(Path_stem(''), '');
});

test('_eqLabel / _compLabel summarise mix settings', () => {
    assert.equal(_eqLabel({ eq_low: 0, eq_mid: 0, eq_high: 0 }), 'Flat');
    assert.equal(_eqLabel({ eq_low: 3, eq_mid: -2, eq_high: 0 }), '+3 / -2 / 0 dB');
    assert.equal(_eqLabel({}), 'Flat');
    assert.equal(_compLabel({ comp_ratio: 1 }), 'Off');
    assert.equal(_compLabel({}), 'Off');
    assert.equal(_compLabel({ comp_ratio: 4, comp_threshold: -18 }), '-18dB 4:1');
});

test('_polarToCartesian + _describeArc are deterministic geometry', () => {
    const p = _polarToCartesian(0, 0, 10, 0);
    assert.ok(Math.abs(p.x - 10) < 1e-9 && Math.abs(p.y - 0) < 1e-9);
    const arc = _describeArc(50, 50, 40, 0, 90);
    assert.match(arc, /^M [\d.-]+ [\d.-]+ A 40 40 0 [01] 0 [\d.-]+ [\d.-]+$/);
});

test('_getTrackColor: explicit color wins, else instrument match, else palette by id', () => {
    assert.equal(_getTrackColor({ color: '#abcdef', id: 0 }), '#abcdef');   // explicit wins
    assert.equal(_getTrackColor({ track_name: 'Lead Guitar', id: 3 }), '#4080e0'); // 'lead' match
    assert.equal(_getTrackColor({ instrument: 'Bass', id: 9 }), '#40c070');        // 'bass' match
    // no color, no instrument match → palette cycles by id % 10
    const c0 = _getTrackColor({ id: 0 });
    const c10 = _getTrackColor({ id: 10 });
    assert.equal(c0, c10);                    // wraps at 10 colours
    assert.match(c0, /^#[0-9a-f]{6}$/);
});
