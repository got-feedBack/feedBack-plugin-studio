// Unit tests for src/prefs.js — localStorage settings persistence via the shared
// S container. Real ES-module import against an in-memory localStorage stub.
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
};

const { S } = await import('../src/state.js');
const { _loadSettings, _saveSettings } = await import('../src/prefs.js');

beforeEach(() => {
    store.clear();
    S.userName = '';
    S.selectedDeviceId = '';
});

test('_saveSettings then _loadSettings round-trips userName + deviceId through S', () => {
    S.userName = 'Byron';
    S.selectedDeviceId = 'mic-42';
    _saveSettings();
    S.userName = ''; S.selectedDeviceId = '';   // clear, then reload from storage
    _loadSettings();
    assert.equal(S.userName, 'Byron');
    assert.equal(S.selectedDeviceId, 'mic-42');
});

test('_loadSettings is a no-op when nothing is stored', () => {
    _loadSettings();
    assert.equal(S.userName, '');
    assert.equal(S.selectedDeviceId, '');
});

test('_loadSettings tolerates corrupt JSON', () => {
    store.set('slopsmith_studio', '{not json');
    assert.doesNotThrow(_loadSettings);
    assert.equal(S.userName, '');
});

test('_loadSettings applies an empty deviceId (deviceId !== undefined) but skips missing userName', () => {
    store.set('slopsmith_studio', JSON.stringify({ deviceId: '' }));
    S.selectedDeviceId = 'stale';
    _loadSettings();
    assert.equal(S.selectedDeviceId, '');   // '' is applied (!== undefined)
    assert.equal(S.userName, '');           // absent userName left as-is
});
