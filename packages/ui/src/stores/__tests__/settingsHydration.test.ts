/**
 * Hydration tests for the settings store's single boot-time load
 * (settingsStoreHydration.ts, Phase 1/5 of the settings-store migration).
 *
 * The store seeds synchronously from the localStorage mirror at module load,
 * then the one boot load reconciles the authoritative Tauri-storage values.
 * These tests pin down:
 *
 *   - storage is authoritative (a stored theme wins over the mirror seed),
 *   - missing/undefined values keep the store's defaults (never null),
 *   - corrupted shapes are rejected so a mismatched blob can't hydrate in,
 *   - localStorage is the fallback when Tauri storage has no data,
 *   - the one-time timeshift migration persists its flag exactly once.
 *
 * Environment: node (no DOM needed — the applier no-ops without `document`,
 * and the store's persist helpers no-op without a real bridge).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock bridge ──────────────────────────────────────────────────────────────
// A tiny plugin-store stand-in: updateSettings merges into an in-memory map
// (the same semantics Bridge.updateSettings has against the Rust backend) and
// mirrors to localStorage (Bridge does this for synchronous seeding).
const storageBackend: Record<string, unknown> = {};

const mockUpdate = vi.fn(async (patch: Record<string, unknown>) => {
  Object.assign(storageBackend, patch);
  try {
    const existing = JSON.parse(localStorage.getItem('app-settings') || '{}');
    localStorage.setItem('app-settings', JSON.stringify({ ...existing, ...patch }));
  } catch (e) {
    /* ignore */
  }
});

const mockGet = vi.fn(async () => ({ success: true, data: { ...storageBackend } }));

Object.defineProperty(globalThis, 'window', {
  value: {
    storage: {
      getSettings: mockGet,
      updateSettings: mockUpdate,
      debouncedUpdateSettings: mockUpdate,
    },
    dispatchEvent: () => true,
  },
  configurable: true,
  writable: true,
});

type StoreModule = typeof import('../settingsStore');
type HydrationModule = typeof import('../settingsStoreHydration');
let useSettingsStore: StoreModule['useSettingsStore'];
let ensureSettingsHydration: HydrationModule['ensureSettingsHydration'];

function seedLocalStorage(obj: Record<string, unknown>): void {
  localStorage.setItem('app-settings', JSON.stringify(obj));
}

beforeEach(async () => {
  Object.keys(storageBackend).forEach((k) => delete storageBackend[k]);
  mockGet.mockClear();
  mockUpdate.mockClear();
  localStorage.clear();
  // Fresh store per test: module-level state (store, applier subscription,
  // hydration latch) must not leak between cases.
  vi.resetModules();
  ({ useSettingsStore } = await import('../settingsStore'));
  ({ ensureSettingsHydration } = await import('../settingsStoreHydration'));
});

describe('settings store hydration', () => {
  it('reconciles authoritative storage values into the store', async () => {
    seedLocalStorage({ theme: 'dark-cyan' });
    storageBackend.theme = 'dark-crimson';
    storageBackend.language = 'fr';
    storageBackend.oledBlack = true;
    storageBackend.channelLogoSize = 60;

    await ensureSettingsHydration();
    // Let the async load settle.
    await vi.waitFor(() => expect(useSettingsStore.getState().layoutSettingsLoaded).toBe(true));

    const s = useSettingsStore.getState();
    expect(s.theme).toBe('dark-crimson'); // storage beats the localStorage seed
    expect(s.language).toBe('fr');
    expect(s.oledBlack).toBe(true);
    expect(s.channelLogoSize).toBe(60);
  });

  it('keeps store defaults for missing values (no null leaks into state)', async () => {
    // Storage exists but is sparse — like a fresh install or partial import.
    storageBackend.theme = 'dark';
    await ensureSettingsHydration();
    await vi.waitFor(() => expect(useSettingsStore.getState().layoutSettingsLoaded).toBe(true));

    const s = useSettingsStore.getState();
    expect(s.channelLogoSize).toBe(42);
    expect(s.oledBlack).toBe(false);
    expect(s.timeshiftEnabled).toBe(true);
    expect(s.maxSearchResults).toBe(200);
    expect(s.language).toBe('en');
  });

  it('rejects corrupted shapes instead of hydrating them in', async () => {
    // Corrupted persisted values must not take over the store.
    storageBackend.theme = { not: 'a string' } as unknown as string;
    storageBackend.oledBlack = 'yes' as unknown as boolean;
    storageBackend.channelLogoSize = 'huge' as unknown as number;
    storageBackend.language = 'klingon'; // not a supported locale

    await ensureSettingsHydration();
    await vi.waitFor(() => expect(useSettingsStore.getState().layoutSettingsLoaded).toBe(true));

    const s = useSettingsStore.getState();
    // theme falls back to the localStorage mirror, else the default
    expect(s.theme).toBe('dark-cyan');
    expect(s.oledBlack).toBe(false);
    expect(s.channelLogoSize).toBe(42);
    expect(s.language).toBe('en');
  });

  it('falls back to the localStorage mirror when storage has no data', async () => {
    seedLocalStorage({
      theme: 'dark-purple',
      savedLayoutState: { activeView: 'livetv' },
      customThemeConfig: { accentColor: '#ff00ff' },
      appFontFamily: 'switzer',
    });

    await ensureSettingsHydration();
    await vi.waitFor(() => expect(useSettingsStore.getState().layoutSettingsLoaded).toBe(true));

    const s = useSettingsStore.getState();
    expect(s.theme).toBe('dark-purple');
    expect(s.savedLayoutState).toEqual({ activeView: 'livetv' });
    expect(s.customThemeConfig).toEqual({ accentColor: '#ff00ff' });
    expect(s.appFontFamily).toBe('switzer');
  });

  it('runs the one-time timeshift migration and persists its flag exactly once', async () => {
    // Storage exists without the migration flag → the migration should write
    // the flag back exactly once.
    storageBackend.timeshiftEnabled = false;
    await ensureSettingsHydration();
    await vi.waitFor(() => expect(useSettingsStore.getState().layoutSettingsLoaded).toBe(true));

    expect(useSettingsStore.getState().timeshiftEnabled).toBe(true);
    expect(useSettingsStore.getState().timeshiftCacheBytes).toBe(268_435_456);

    const flagWrites = mockUpdate.mock.calls.filter(([patch]) => (patch as Record<string, unknown>).timeshiftMigrationCheck === true);
    expect(flagWrites).toHaveLength(1);

    // A second boot with the flag present must not re-run the migration.
    mockUpdate.mockClear();
    storageBackend.timeshiftMigrationCheck = true;
    storageBackend.timeshiftEnabled = false;
    vi.resetModules();
    ({ useSettingsStore } = await import('../settingsStore'));
    ({ ensureSettingsHydration } = await import('../settingsStoreHydration'));
    await ensureSettingsHydration();
    await vi.waitFor(() => expect(useSettingsStore.getState().layoutSettingsLoaded).toBe(true));

    expect(useSettingsStore.getState().timeshiftEnabled).toBe(false); // untouched
    const secondFlagWrites = mockUpdate.mock.calls.filter(([patch]) => (patch as Record<string, unknown>).timeshiftMigrationCheck === true);
    expect(secondFlagWrites).toHaveLength(0);
  });

  it('is idempotent: calling ensureSettingsHydration twice performs one load', async () => {
    storageBackend.theme = 'dark';
    await ensureSettingsHydration();
    await ensureSettingsHydration();
    await vi.waitFor(() => expect(useSettingsStore.getState().layoutSettingsLoaded).toBe(true));
    expect(mockGet).toHaveBeenCalledTimes(1);
  });
});
