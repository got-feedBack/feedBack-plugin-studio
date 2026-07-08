// localStorage-backed studio settings (user name + selected input device).
// Reads/writes flow through the shared S container. Real-import tested against
// an in-memory localStorage stub in tests/prefs.test.mjs.
import { S } from './state.js';

const STORAGE_KEY = 'slopsmith_studio';

export function _loadSettings() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return;
        const s = JSON.parse(raw);
        if (s.userName) S.userName = s.userName;
        if (s.deviceId !== undefined) S.selectedDeviceId = s.deviceId;
    } catch (e) { /* ignore */ }
}

export function _saveSettings() {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
            userName: S.userName,
            deviceId: S.selectedDeviceId,
        }));
    } catch (e) { /* ignore */ }
}
