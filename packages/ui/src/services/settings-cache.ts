/**
 * Settings Cache — thin promise-cache over window.storage.getSettings()
 *
 * At startup, several hooks (useAutoSync, App.tsx badge loader, useChannels EPG
 * logos) all call window.storage.getSettings() within the same ~200 ms window.
 * Each call is a serialised Tauri IPC round-trip to SQLite, so they queue behind
 * each other and collectively block the JS thread.
 *
 * This module caches the in-flight (or recently resolved) promise so that all
 * parallel callers share a single round-trip.  The cache is intentionally
 * short-lived (CACHE_TTL_MS) so that any subsequent calls — e.g. after a
 * settings save — always get fresh data.
 *
 * NOTE: the settings store (stores/settingsStore.ts) is the canonical settings
 * loader and continues to call
 * window.storage.getSettings() directly so it always gets authoritative data.
 * Secondary callers (auto-sync, badge loader, channel query) use this helper.
 */

const CACHE_TTL_MS = 10_000; // 10 seconds

let _cachedPromise: Promise<any> | null = null;
let _cacheTimestamp = 0;

/**
 * Returns a cached promise for getSettings().
 * Multiple callers within CACHE_TTL_MS share the same promise, collapsing
 * parallel IPC calls into one.
 */
export function getCachedSettings(): Promise<any> {
    const now = Date.now();
    if (_cachedPromise && (now - _cacheTimestamp) < CACHE_TTL_MS) {
        return _cachedPromise;
    }
    if (!window.storage) {
        return Promise.resolve({ data: null });
    }
    _cachedPromise = window.storage.getSettings();
    _cacheTimestamp = now;
    return _cachedPromise;
}

