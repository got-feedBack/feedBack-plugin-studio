// Shared, reassigned module state → one container object `S`. ES imports are
// read-only bindings, so a plain `export let x` can't be reassigned from main.js,
// but `S.x = …` can. Every former module-scope `_foo` scalar becomes `S.foo`.
// (Never-reassigned constants like MAX_UNDO stay in main.js.)
export const S = {
    // ── Session + playback clock ──
    currentSession: null,        // full session object from API
    audioCtx: null,              // Web Audio context
    songBuffer: null,            // decoded AudioBuffer for original song
    trackBuffers: {},            // track_id -> AudioBuffer
    isPlaying: false,
    startTime: 0,                // audioCtx.currentTime when play began
    pauseOffset: 0,              // seconds into the song when paused
    duration: 0,                 // total duration in seconds
    animFrame: null,

    // ── Zoom + scroll ──
    zoomLevel: 1,                // 1 = fit entire song, 2 = 2x zoom, etc.
    scrollOffset: 0,             // start time (s) of the visible window

    // ── Audio graph (recreated each play) ──
    songSource: null,
    songGain: null,
    songPan: null,
    trackSources: {},            // track_id -> {source, gain, pan, ...}
    reverbNode: null,            // shared ConvolverNode
    reverbGain: null,            // master reverb wet level
    masterGain: null,            // master bus gain
    masterLimiter: null,         // master bus limiter (DynamicsCompressor)
    masterAnalyser: null,        // for level meter
    masterMeterInterval: null,
    masterVolume: 1.0,
    masterLimiterOn: true,

    // ── Mix state (client-side, synced to server) ──
    mixState: {
        original: { volume: 1.0, pan: 0.0, muted: false, solo: false, offset_ms: 0, fade_in_ms: 0, fade_out_ms: 0, eq_low: 0, eq_mid: 0, eq_high: 0, reverb_send: 0, comp_threshold: -24, comp_ratio: 1, comp_attack: 0.003, comp_release: 0.25 },
        // track_id -> {volume, pan, muted, solo}
    },

    // ── Undo/redo ──
    undoStack: [],
    redoStack: [],
    undoDebounceTimer: null,

    // ── Recording (main track upload) ──
    isRecording: false,
    mediaStream: null,
    mediaRecorder: null,
    recordedChunks: [],
    recStartTime: 0,
    recInterval: null,
    waveformPeaks: {},           // key -> Float32Array

    // ── Persisted settings (localStorage) ──
    userName: '',
    selectedDeviceId: '',

    // ── Debounced server saves ──
    saveMixTimer: null,
    saveMasterTimer: null,

    // ── Punch-in recording ──
    punchIn: 0,
    punchOut: 0,
    punchTrackId: null,
    punchRecording: false,
    punchMediaStream: null,
    punchMediaRecorder: null,
    punchChunks: [],
    punchAutoStopTimer: null,

    // ── Highway (live) recording ──
    hwRecording: false,
    hwMediaStream: null,
    hwMediaRecorder: null,
    hwRecordedChunks: [],
    hwRecStartTime: 0,
    hwRecInterval: null,
    hwOverlay: null,
    hwDrawHookAdded: false,
    hwAudioCtx: null,
    hwGainNode: null,
    hwAnalyser: null,
    hwSourceNode: null,
    hwRecDest: null,
    hwMeterInterval: null,
    hwInputGain: 1.0,
    hwInstrument: '',
    hwExpectedDuration: 0,       // audio.currentTime at stop — ground truth for drift correction
    hwWaitCancelled: false,
    hwPlayOffset: 0,             // seconds of recording before audio started playing
    hwPlayListener: null,
};
