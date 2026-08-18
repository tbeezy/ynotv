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

  it('setHardwareAcceleration awaits persistence (restart-safe save)', async () => {
    const store = useSettingsStore;
    // Defer the bridge write so we can prove the setter's returned promise
    // does NOT settle before the write lands — the Optimization restart flow
    // relies on this to avoid relaunching before the disk save completes.
    let resolveWrite!: () => void;
    mockUpdate.mockImplementationOnce(async (patch: Record<string, unknown>) => {
      Object.assign(storageBackend, patch);
      await new Promise<void>((r) => (resolveWrite = r));
    });

    const pending = store.getState().setHardwareAcceleration(false);

    // State updates optimistically...
    expect(store.getState().hardwareAcceleration).toBe(false);

    // ...but the returned promise stays pending until the write resolves.
    let settled = false;
    void Promise.resolve(pending).then(() => (settled = true));
    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(false);

    resolveWrite();
    await pending;
    expect(storageBackend.hardwareAcceleration).toBe(false);
  });

  it('setShortcuts persists through the queue (Phase 4 fix)', async () => {
    const store = useSettingsStore;
    const shortcuts = { togglePlay: { key: 'Space' } };
    store.getState().setShortcuts(shortcuts as any);

    expect(store.getState().shortcuts).toEqual(shortcuts);
    expect(storageBackend.shortcuts).toEqual(shortcuts);
    expect(JSON.parse(localStorage.getItem('app-settings')!).shortcuts).toEqual(shortcuts);
  });

  it('setTraktSettings clears fields when logout passes undefined (in-check contract)', () => {
    const store = useSettingsStore;
    // Seed a logged-in state.
    store.getState().setTraktSettings({
      traktEnabled: true,
      traktAccessToken: 'token-abc',
      traktScrobbleEnabled: true,
      traktSyncEnabled: true,
      traktCatalogsEnabled: { netflix: true },
      traktEnabledLists: [{ id: 'my-list', name: 'My List' }],
    });
    expect(store.getState().traktCatalogsEnabled).toEqual({ netflix: true });

    // Mirrors scrobbler.ts logout: undefined wipes catalogs/lists, null wipes
    // the token, false disables. The `in`-check must NOT skip these keys.
    store.getState().setTraktSettings({
      traktEnabled: false,
      traktAccessToken: null,
      traktRefreshToken: null,
      traktTokenExpiresAt: null,
      traktScrobbleEnabled: false,
      traktSyncEnabled: false,
      traktCatalogsEnabled: undefined,
      traktCatalogOrder: undefined,
      traktCatalogsBeforeAddon: undefined,
      traktEnabledLists: undefined,
      traktNuvioCatalogsEnabled: undefined,
      traktNuvioCatalogOrder: undefined,
      traktNuvioCatalogsBeforeAddon: undefined,
      traktNuvioEnabledLists: undefined,
    });

    // State cleared to defaults.
    expect(store.getState().traktEnabled).toBe(false);
    expect(store.getState().traktAccessToken).toBeNull();
    expect(store.getState().traktCatalogsEnabled).toEqual({});
    expect(store.getState().traktCatalogOrder).toEqual([]);
    expect(store.getState().traktEnabledLists).toEqual([]);
    expect(store.getState().traktNuvioCatalogsEnabled).toEqual({});
    expect(store.getState().traktNuvioEnabledLists).toEqual([]);

    // Persisted through the queue with the same defaults.
    expect(storageBackend.traktCatalogsEnabled).toEqual({});
    expect(storageBackend.traktEnabledLists).toEqual([]);
    expect(storageBackend.traktAccessToken).toBeNull();
  });

  it('setCategorySettings dispatches the legacy category-settings-changed event', () => {
    const store = useSettingsStore;
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
    store.getState().setCategorySettings({ favoritesMode: 'perSource', showFavorites: true });

    expect(store.getState().favoritesMode).toBe('perSource');
    expect(store.getState().showFavorites).toBe(true);
    const dispatched = dispatchSpy.mock.calls.find((c) =>
      (c[0] as CustomEvent).type === 'ynotv:category-settings-changed'
    );
    expect(dispatched).toBeTruthy();
    const detail = (dispatched![0] as CustomEvent).detail;
    expect(detail.favoritesMode).toBe('perSource');
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
