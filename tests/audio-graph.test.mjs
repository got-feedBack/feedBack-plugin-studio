// Unit tests for src/audio-graph.js's injectable seam + importability. The
// _play/_pause graph itself drives Web Audio + the DOM, so its behaviour is
// covered by the on-device smoke; here we pin the configureAudioGraph contract.
import test from 'node:test';
import assert from 'node:assert/strict';

const mod = await import('../src/audio-graph.js');

test('module exports the engine surface', () => {
    for (const fn of ['_getAudioCtx', '_play', '_pause', '_stopAllSources',
        '_applyMixToLiveAudio', '_applyAllMixToLive', 'configureAudioGraph']) {
        assert.equal(typeof mod[fn], 'function', `missing export ${fn}`);
    }
});

test('configureAudioGraph tolerates no arg / non-function values', () => {
    assert.doesNotThrow(() => mod.configureAudioGraph());
    assert.doesNotThrow(() => mod.configureAudioGraph({}));
    assert.doesNotThrow(() => mod.configureAudioGraph({ startAnimLoop: 'nope', stopAnimLoop: 42 }));
});

test('configureAudioGraph wires the injected hooks (observed via _pause → stopAnimLoop)', async () => {
    const { S } = await import('../src/state.js');
    let stopped = 0;
    mod.configureAudioGraph({ stopAnimLoop: () => { stopped++; } });
    // _pause() tears down + calls stopAnimLoop when playing; stub the ctx + the
    // one DOM node it touches (the play button).
    S.isPlaying = true;
    S.audioCtx = { currentTime: 0, state: 'running' };
    S.trackSources = {};
    S.songSource = null;
    const origDoc = globalThis.document;
    globalThis.document = { getElementById: () => ({ innerHTML: '' }) };
    try {
        mod._pause();
    } finally {
        globalThis.document = origDoc;
    }
    assert.equal(stopped, 1, 'injected stopAnimLoop should fire on _pause');
    assert.equal(S.isPlaying, false);
});
