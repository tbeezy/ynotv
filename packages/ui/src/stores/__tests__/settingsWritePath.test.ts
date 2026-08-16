/**
 * Write-path tests for the settings store (Phase 2 of the settings-store
 * migration). Setters are optimistic state writes + persistence through the
 * bridge (which serializes writes in tauri-bridge.ts) — no DOM writes, no
 * stamp guards (Phase 5 removed them).
 *
 * These tests pin down:
 *   - a setter updates store state immediately (optimistic UI),
 *   - the same setter persists through the bridge / mirrors to localStorage,
 *   - setters never write to the DOM themselves (the applier owns that),
 *   - persistence is queued through the serialized write queue surface
 *     (window.storage.updateSettings / debouncedUpdateSettings).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

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

const mockDebounced = vi.fn(async (patch: Record<string, unknown>) => {
  Object.assign(storageBackend, patch);
});

Object.defineProperty(globalThis, 'window', {
  value: {
    storage: {
      getSettings: vi.fn(async () => ({ success: true, data: { ...storageBackend } })),
      updateSettings: mockUpdate,
      debouncedUpdateSettings: mockDebounced,
    },
    dispatchEvent: () => true,
  },
  configurable: true,
  writable: true,
});

type StoreModule = typeof import('../settingsStore');
let useSettingsStore: StoreModule['useSettingsStore'];

beforeEach(async () => {
  Object.keys(storageBackend).forEach((k) => delete storageBackend[k]);
  mockUpdate.mockClear();
  mockDebounced.mockClear();
  localStorage.clear();
  vi.resetModules();
  ({ useSettingsStore } = await import('../settingsStore'));
});

describe('settings store write path', () => {
  it('updates state optimistically before persistence settles', () => {
    const store = useSettingsStore;
    store.getState().setTheme('dark-crimson');
    // Immediate — no await needed.
    expect(store.getState().theme).toBe('dark-crimson');
    expect(storageBackend.theme).toBe('dark-crimson');
  });

  it('persists through the bridge and mirrors to localStorage', async () => {
    const store = useSettingsStore;
    store.getState().setCategorySortOrder('alphabetical');

    expect(mockUpdate).toHaveBeenCalledWith({ categorySortOrder: 'alphabetical' });
    expect(storageBackend.categorySortOrder).toBe('alphabetical');
    expect(JSON.parse(localStorage.getItem('app-settings')!).categorySortOrder).toBe('alphabetical');
  });

  it('uses the debounced surface for high-frequency setters', () => {
    const store = useSettingsStore;
    store.getState().setCustomScrollbarWidth(14);

    expect(mockDebounced).toHaveBeenCalledWith({ customScrollbarWidth: 14 });
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('merges partial config updates instead of replacing the whole config', () => {
    const store = useSettingsStore;
    // updateCustomThemeConfig takes a Partial<CustomThemeConfig>; seed the
    // store with the partial shape the setter merge operates on.
    store.setState({ customThemeConfig: { accentColor: '#00d4ff' } as any });
    store.getState().updateCustomThemeConfig({ backgroundColor: '#101010' });

    expect(store.getState().customThemeConfig).toEqual({
      accentColor: '#00d4ff',
      backgroundColor: '#101010',
    });
    expect(storageBackend.customThemeConfig).toEqual({
      accentColor: '#00d4ff',
      backgroundColor: '#101010',
    });
  });

  it('setShortcuts persists through the queue (Phase 4 fix)', async () => {
    const store = useSettingsStore;
    const shortcuts = { togglePlay: { key: 'Space' } };
    store.getState().setShortcuts(shortcuts as any);

    expect(store.getState().shortcuts).toEqual(shortcuts);
    expect(storageBackend.shortcuts).toEqual(shortcuts);
    expect(JSON.parse(localStorage.getItem('app-settings')!).shortcuts).toEqual(shortcuts);
  });

  it('does not touch the DOM from a setter (applier owns all DOM writes)', () => {
    // Node has no document; a setter that wrote to the DOM would throw on
    // `document.documentElement`. Reaching this assertion means the setter
    // stayed pure.
    const store = useSettingsStore;
    store.getState().setTheme('dark-blue');
    store.getState().setChannelInfoOverlayFontSize(20);
    store.getState().setEnableCustomScrollbarWidth(true);
    expect(store.getState().theme).toBe('dark-blue');
  });
});
