/**
 * Prune service tests: the rules are pure (`utils/globalEpgSourcePrune`), so
 * what is pinned down here is the plumbing — what gets written to the settings
 * store and the settings file, and the guards that keep a bad playlist read
 * from detaching every Global EPG link.
 *
 * The last block is the wiring contract: no jsdom here, so the fact that each
 * entry point actually calls the sweep is checked against the sources.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import type { GlobalEpgLink } from '../../types/app';

const storageBackend: Record<string, unknown> = {};
const updateSettings = vi.fn(async (patch: Record<string, unknown>) => {
  Object.assign(storageBackend, patch);
});

let sourcesRead: { success: boolean; data?: Array<{ id: string }> } = { success: true, data: [] };
let getSourcesThrows = false;

Object.defineProperty(globalThis.window, 'storage', {
  value: {
    getSettings: async () => ({ success: true, data: { ...storageBackend } }),
    updateSettings,
    getSources: async () => {
      if (getSourcesThrows) throw new Error('bridge unavailable');
      return sourcesRead;
    },
  },
  configurable: true,
  writable: true,
});

type StoreModule = typeof import('../../stores/settingsStore');
type ServiceModule = typeof import('../globalEpgSourcePrune');

let useSettingsStore: StoreModule['useSettingsStore'];
let dropDeletedGlobalEpgSourceRefs: ServiceModule['dropDeletedGlobalEpgSourceRefs'];
let pruneStaleGlobalEpgSources: ServiceModule['pruneStaleGlobalEpgSources'];
let pruneStaleGlobalEpgSourcesFromStoredSources: ServiceModule['pruneStaleGlobalEpgSourcesFromStoredSources'];

function link(overrides: Partial<GlobalEpgLink> = {}): GlobalEpgLink {
  return {
    id: 'link-1',
    name: 'www.open-epg.com',
    url: 'https://www.open-epg.com/files/guide.xml',
    sourceIds: ['live-a'],
    ...overrides,
  };
}

beforeEach(async () => {
  Object.keys(storageBackend).forEach((key) => delete storageBackend[key]);
  updateSettings.mockClear();
  sourcesRead = { success: true, data: [] };
  getSourcesThrows = false;
  vi.resetModules();
  ({ useSettingsStore } = await import('../../stores/settingsStore'));
  ({
    dropDeletedGlobalEpgSourceRefs,
    pruneStaleGlobalEpgSources,
    pruneStaleGlobalEpgSourcesFromStoredSources,
  } = await import('../globalEpgSourcePrune'));
});

describe('dropDeletedGlobalEpgSourceRefs', () => {
  it('removes the deleted playlist from the store and persists the pruned links', () => {
    useSettingsStore.setState({
      globalEpgLinks: [link({ sourceIds: ['live-a', 'gone-1'] })],
    });

    const changed = dropDeletedGlobalEpgSourceRefs(new Set(['gone-1']));

    expect(changed).toBe(1);
    expect(useSettingsStore.getState().globalEpgLinks[0].sourceIds).toEqual(['live-a']);
    expect(updateSettings).toHaveBeenCalledWith({
      globalEpgLinks: [expect.objectContaining({ sourceIds: ['live-a'] })],
    });
  });

  it('clears the deleted playlist from the per-source run state too', () => {
    useSettingsStore.setState({
      globalEpgLinks: [
        link({
          sourceIds: ['live-a', 'gone-1'],
          lastSyncResult: {
            timestamp: 1,
            totalInserted: 3,
            perSource: { 'live-a': 1, 'gone-1': 2 },
            perSourceChannels: { 'live-a': 4, 'gone-1': 1 },
            perSourceSyncedAt: { 'live-a': 100, 'gone-1': 200 },
          },
        }),
      ],
    });

    dropDeletedGlobalEpgSourceRefs(new Set(['gone-1']));

    const run = useSettingsStore.getState().globalEpgLinks[0].lastSyncResult;
    expect(run?.perSource).toEqual({ 'live-a': 1 });
    expect(run?.perSourceChannels).toEqual({ 'live-a': 4 });
    expect(run?.perSourceSyncedAt).toEqual({ 'live-a': 100 });
  });

  it('writes nothing when no link referenced the deleted playlist', () => {
    const links = [link()];
    useSettingsStore.setState({ globalEpgLinks: links });

    expect(dropDeletedGlobalEpgSourceRefs(new Set(['gone-1']))).toBe(0);
    expect(useSettingsStore.getState().globalEpgLinks).toBe(links);
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it('writes nothing for an empty deleted set', () => {
    useSettingsStore.setState({ globalEpgLinks: [link()] });

    expect(dropDeletedGlobalEpgSourceRefs(new Set())).toBe(0);
    expect(updateSettings).not.toHaveBeenCalled();
  });
});

describe('pruneStaleGlobalEpgSources', () => {
  it('drops every attachment that is not a live playlist', () => {
    useSettingsStore.setState({
      globalEpgLinks: [link({ sourceIds: ['live-a', 'gone-1', 'gone-2'] })],
    });

    const changed = pruneStaleGlobalEpgSources(new Set(['live-a']));

    expect(changed).toBe(1);
    expect(useSettingsStore.getState().globalEpgLinks[0].sourceIds).toEqual(['live-a']);
    expect(updateSettings).toHaveBeenCalledTimes(1);
  });
});

describe('pruneStaleGlobalEpgSourcesFromStoredSources', () => {
  it('prunes against the stored playlist list', async () => {
    sourcesRead = { success: true, data: [{ id: 'live-a' }, { id: 'live-b' }] };
    useSettingsStore.setState({
      globalEpgLinks: [link({ sourceIds: ['live-a', 'gone-1'] })],
    });

    expect(await pruneStaleGlobalEpgSourcesFromStoredSources()).toBe(1);
    expect(useSettingsStore.getState().globalEpgLinks[0].sourceIds).toEqual(['live-a']);
  });

  it('leaves the links alone when the playlist list cannot be read', async () => {
    // A failed read looks exactly like "no playlists exist" — pruning on it
    // would detach every link in the app.
    sourcesRead = { success: false };
    const links = [link({ sourceIds: ['live-a', 'gone-1'] })];
    useSettingsStore.setState({ globalEpgLinks: links });

    expect(await pruneStaleGlobalEpgSourcesFromStoredSources()).toBe(0);
    expect(useSettingsStore.getState().globalEpgLinks).toBe(links);
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it('leaves the links alone when the storage bridge throws', async () => {
    getSourcesThrows = true;
    const links = [link({ sourceIds: ['live-a', 'gone-1'] })];
    useSettingsStore.setState({ globalEpgLinks: links });

    expect(await pruneStaleGlobalEpgSourcesFromStoredSources()).toBe(0);
    expect(useSettingsStore.getState().globalEpgLinks).toBe(links);
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it('does nothing when the playlist list is empty and no link has attachments', async () => {
    sourcesRead = { success: true, data: [] };
    const links = [link({ sourceIds: [] })];
    useSettingsStore.setState({ globalEpgLinks: links });

    expect(await pruneStaleGlobalEpgSourcesFromStoredSources()).toBe(0);
    expect(useSettingsStore.getState().globalEpgLinks).toBe(links);
  });
});

describe('prune wiring (source contracts)', () => {
  const sourcesTabSrc = readFileSync(
    new URL('../../components/settings/SourcesTab.tsx', import.meta.url),
    'utf8'
  );
  const settingsSrc = readFileSync(new URL('../../components/Settings.tsx', import.meta.url), 'utf8');
  const dataRefreshSrc = readFileSync(
    new URL('../../components/settings/DataRefreshTab.tsx', import.meta.url),
    'utf8'
  );
  const syncSrc = readFileSync(new URL('../../db/sync.ts', import.meta.url), 'utf8');

  /** The source from `marker` on — keeps an assertion scoped to one function. */
  function after(src: string, marker: string): string {
    const at = src.indexOf(marker);
    expect(at, `expected to find ${marker}`).toBeGreaterThanOrEqual(0);
    return src.slice(at);
  }

  it('prunes the deleted playlist when a source is deleted', () => {
    const confirmDelete = after(sourcesTabSrc, 'async function confirmDelete()');
    const drop = confirmDelete.indexOf('dropDeletedGlobalEpgSourceRefs(new Set([id]))');
    const removed = confirmDelete.indexOf('await window.storage.deleteSource(id)');

    expect(drop).toBeGreaterThanOrEqual(0);
    expect(removed).toBeGreaterThanOrEqual(0);
    // The config is rewritten only once the playlist is actually gone.
    expect(drop).toBeGreaterThan(removed);
  });

  it('prunes against the freshly loaded playlist list when Settings opens', () => {
    const loadSources = after(settingsSrc, 'async function loadSources()');
    const swept = loadSources.indexOf('pruneStaleGlobalEpgSources(new Set(result.data.map');
    const stored = loadSources.indexOf('setSources(result.data)');

    expect(swept).toBeGreaterThanOrEqual(0);
    // Same freshly-read list the UI is about to render — never a snapshot.
    expect(swept).toBeGreaterThan(stored);
  });

  it('prunes before the EPG cache clear rewrites the links', () => {
    const clearEpg = after(syncSrc, 'export async function clearEpgCacheOnly()');
    const swept = clearEpg.indexOf('await pruneStaleGlobalEpgSourcesFromStoredSources()');
    const read = clearEpg.indexOf('useSettingsStore.getState().globalEpgLinks');

    expect(swept).toBeGreaterThanOrEqual(0);
    // The reset below must write the pruned links back, not the stale ones.
    expect(read).toBeGreaterThan(swept);
  });

  it('prunes after the full cache clear', () => {
    const handleClear = after(dataRefreshSrc, 'async function handleClearCache()');
    const cleared = handleClear.indexOf('await clearAllCachedData()');
    const swept = handleClear.indexOf('await pruneStaleGlobalEpgSourcesFromStoredSources()');

    expect(cleared).toBeGreaterThanOrEqual(0);
    expect(swept).toBeGreaterThan(cleared);
  });
});
